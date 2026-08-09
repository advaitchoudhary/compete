import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAuth, requireRole } from '../../shared/middleware/auth'
import { sql } from 'kysely'
import { getDb } from '../../shared/db/client'
import { MATCH_TIERS, TIER_RANK } from '../../shared/tiers'
import { roundLabel } from '../events/bracket/round-label'

const ApplyBody = z.object({
  full_name: z.string().min(2).max(80),
  city: z.string().min(2).max(50),
  phone: z.string().min(6).max(20).optional(),
  experience_years: z.number().int().min(0).max(80).optional(),
  // Sport slugs the applicant can officiate
  sports: z.array(z.string()).min(1).max(10).optional(),
  certification: z.string().max(200).optional(),
  bio: z.string().max(500).optional(),
})

export async function refereeRoutes(app: FastifyInstance) {
  /**
   * POST /referee/apply
   * A player applies to become a referee. Creates a pending application
   * that an admin must approve. One pending application at a time.
   */
  app.post('/referee/apply', { preHandler: requireAuth }, async (request, reply) => {
    const body = ApplyBody.safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() })

    const db = getDb()

    const me = await db
      .selectFrom('users')
      .select('role')
      .where('id', '=', request.userId)
      .executeTakeFirst()

    if (!me) return reply.code(401).send({ error: 'Unauthorized' })
    if (me.role === 'referee' || me.role === 'admin') {
      return reply.code(409).send({ error: 'You are already a referee' })
    }

    // Reject if a pending application already exists
    const pending = await db
      .selectFrom('referee_applications')
      .select('id')
      .where('user_id', '=', request.userId)
      .where('status', '=', 'pending')
      .executeTakeFirst()

    if (pending) {
      return reply.code(409).send({ error: 'You already have a pending application' })
    }

    const application = await db
      .insertInto('referee_applications')
      .values({
        user_id: request.userId,
        full_name: body.data.full_name,
        city: body.data.city,
        phone: body.data.phone ?? null,
        experience_years: body.data.experience_years ?? null,
        sports: body.data.sports ?? null,
        certification: body.data.certification ?? null,
        bio: body.data.bio ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    return reply.code(201).send(application)
  })

  /**
   * POST /referee/upgrade
   * An approved referee requests promotion to a higher tier. Creates a pending
   * 'upgrade' application that an admin approves (which bumps referee_tier).
   */
  app.post('/referee/upgrade', { preHandler: requireRole('referee') }, async (request, reply) => {
    const body = z
      .object({ requested_tier: z.enum(MATCH_TIERS), note: z.string().max(500).optional() })
      .safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() })

    const db = getDb()
    const me = await db
      .selectFrom('users')
      .select(['name', 'city', 'referee_tier'])
      .where('id', '=', request.userId)
      .executeTakeFirstOrThrow()

    const current = me.referee_tier ?? 'amateur'
    if (TIER_RANK[body.data.requested_tier] <= TIER_RANK[current]) {
      return reply.code(400).send({
        error: `Requested tier must be higher than your current tier (${current})`,
      })
    }

    const pending = await db
      .selectFrom('referee_applications')
      .select('id')
      .where('user_id', '=', request.userId)
      .where('status', '=', 'pending')
      .executeTakeFirst()
    if (pending) return reply.code(409).send({ error: 'You already have a pending request' })

    const application = await db
      .insertInto('referee_applications')
      .values({
        user_id: request.userId,
        full_name: me.name,
        city: me.city ?? 'Unknown',
        request_type: 'upgrade',
        requested_tier: body.data.requested_tier,
        bio: body.data.note ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    return reply.code(201).send(application)
  })

  /**
   * GET /referee/me
   * Returns the caller's role and their latest referee application (if any).
   */
  app.get('/referee/me', { preHandler: requireAuth }, async (request, reply) => {
    const db = getDb()

    const me = await db
      .selectFrom('users')
      .select(['id', 'name', 'role', 'referee_tier'])
      .where('id', '=', request.userId)
      .executeTakeFirst()

    if (!me) return reply.code(401).send({ error: 'Unauthorized' })

    const application = await db
      .selectFrom('referee_applications')
      .selectAll()
      .where('user_id', '=', request.userId)
      .orderBy('created_at', 'desc')
      .executeTakeFirst()

    return {
      user_id: me.id,
      name: me.name,
      role: me.role,
      is_referee: me.role === 'referee' || me.role === 'admin',
      referee_tier: me.referee_tier,
      application: application ?? null,
    }
  })

  /**
   * GET /referee/matches
   *
   * Every match this referee is on, soonest first. This is the match-day home
   * screen: an official arriving at the turf needs "what am I refereeing, on which
   * pitch, and which one is next" without navigating a tournament they may not
   * even know the name of.
   *
   * Nothing else could answer that. GET /matches filters by status and sport only,
   * and /referee/me returns application state, so the assigned official was the one
   * person in the system with no list of their own fixtures.
   *
   * `scope=upcoming` (default) hides finished matches; `scope=all` keeps them for
   * looking back at a day's work.
   */
  app.get(
    '/referee/matches',
    { preHandler: requireRole('referee', 'admin') },
    async (request, reply) => {
      const query = request.query as { scope?: string; limit?: string }
      const limit = Math.min(Number(query.limit ?? 50), 100)

      let qb = getDb()
        .selectFrom('matches as m')
        .leftJoin('teams as ht', 'ht.id', 'm.home_team_id')
        .leftJoin('teams as at', 'at.id', 'm.away_team_id')
        .leftJoin('events as e', 'e.id', 'm.event_id')
        .leftJoin('event_fixtures as ef', 'ef.match_id', 'm.id')
        .select([
          'm.id', 'm.status', 'm.round', 'm.scheduled_at', 'm.started_at',
          'm.tier', 'm.format', 'm.duration_minutes', 'm.venue',
          'm.home_team_id', 'm.away_team_id',
          'ht.name as home_team_name', 'at.name as away_team_name',
          'e.id as event_id', 'e.name as event_name',
          'ef.pitch_label',
        ])
        .where('m.referee_id', '=', request.userId)
        // A live match comes first whatever its clock says — it is the one the
        // referee is standing on. Casual matches often carry no scheduled_at at
        // all, which sorts them last, and a live one was ending up at the bottom
        // of the list. Then by kick-off, unscheduled last.
        .orderBy(sql`case when m.status = 'live' then 0 else 1 end`, 'asc')
        .orderBy(sql`m.scheduled_at asc nulls last`)
        .limit(limit)

      if (query.scope !== 'all') {
        qb = qb.where('m.status', 'in', ['scheduled', 'live'])
        // A cancelled or wrapped-up tournament leaves its unplayed matches sitting
        // at 'scheduled' forever. Without this they pile up in the duty list and
        // bury the fixture the referee is actually walking to. Casual matches have
        // no event and are always kept.
        qb = qb.where((eb) =>
          eb.or([
            eb('e.id', 'is', null),
            eb('e.status', 'not in', ['cancelled', 'completed']),
          ])
        )
      }

      const rows = await qb.execute()

      return {
        count: rows.length,
        // The one the referee should be walking towards: live if anything is in
        // progress, else the next thing scheduled.
        next_match_id:
          rows.find((r) => r.status === 'live')?.id ??
          rows.find((r) => r.status === 'scheduled')?.id ??
          null,
        matches: rows.map((r) => ({
          ...r,
          round_label: r.round ? roundLabel(r.round) : null,
        })),
      }
    }
  )
}
