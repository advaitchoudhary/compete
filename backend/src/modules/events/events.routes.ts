import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAuth, requireRole } from '../../shared/middleware/auth'
import { getDb } from '../../shared/db/client'
import type { EventStatus } from '../../shared/db/types'

const CreateEventBody = z.object({
  name: z.string().min(3).max(100),
  sport_slug: z.string(),
  format: z.enum(['knockout', 'league', 'round_robin', 'group_knockout', 'casual']),
  // Players per side. `tier` is deliberately NOT accepted here — a new event has
  // no referees yet, so nothing above 'amateur' could be authorised. Set it
  // afterwards via PATCH /events/:id/tier. See spec §3.1.1.
  match_format: z.enum(['5-a-side', '7-a-side', '11-a-side']).optional(),
  match_duration_minutes: z.number().int().min(1).max(180).optional(),
  city: z.string().min(2).max(50),
  venue: z.string().max(100).optional(),
  description: z.string().max(500).optional(),
  starts_at: z.string().datetime().optional(),
  ends_at: z.string().datetime().optional(),
  max_teams: z.number().int().min(2).max(256).optional(),
  entry_fee: z.number().int().min(0).default(0),
  prize_pool: z.number().int().min(0).default(0),
  rules: z.record(z.unknown()).default({}),
})

const RegisterTeamBody = z.object({
  team_id: z.string().uuid(),
  group_no: z.string().optional(),
})

export async function eventsRoutes(app: FastifyInstance) {
  // POST /events — only verified organizers (or admins) may run a tournament.
  app.post('/events', { preHandler: requireRole('organizer', 'admin') }, async (request, reply) => {
    const body = CreateEventBody.safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() })

    const db = getDb()

    const sport = await db
      .selectFrom('sports')
      .select('id')
      .where('slug', '=', body.data.sport_slug)
      .executeTakeFirst()

    if (!sport) return reply.code(404).send({ error: 'Sport not found' })

    const event = await db
      .insertInto('events')
      .values({
        name: body.data.name,
        sport_id: sport.id,
        organizer_id: request.userId,
        format: body.data.format,
        match_format: body.data.match_format ?? null,
        match_duration_minutes: body.data.match_duration_minutes ?? null,
        city: body.data.city,
        venue: body.data.venue ?? null,
        description: body.data.description ?? null,
        starts_at: body.data.starts_at ? new Date(body.data.starts_at) : null,
        ends_at: body.data.ends_at ? new Date(body.data.ends_at) : null,
        max_teams: body.data.max_teams ?? null,
        entry_fee: body.data.entry_fee,
        prize_pool: body.data.prize_pool,
        rules: JSON.stringify(body.data.rules) as unknown as Record<string, unknown>,
        status: 'upcoming',
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    // Initialize organizer score record if not exists
    await db
      .insertInto('organizer_scores')
      .values({ user_id: request.userId })
      .onConflict((oc) => oc.doNothing())
      .execute()

    return reply.code(201).send(event)
  })

  // GET /events — browse with filters
  app.get('/events', async (request, reply) => {
    const query = request.query as {
      sport?: string
      city?: string
      status?: EventStatus
      limit?: string
      cursor?: string
    }
    const limit = Math.min(Number(query.limit ?? 20), 50)
    const db = getDb()

    let q = db
      .selectFrom('events as e')
      .innerJoin('sports as s', 's.id', 'e.sport_id')
      .innerJoin('users as u', 'u.id', 'e.organizer_id')
      .select([
        'e.id', 'e.name', 'e.city', 'e.venue', 'e.format', 'e.status',
        'e.starts_at', 'e.ends_at', 'e.entry_fee', 'e.prize_pool', 'e.cover_url', 'e.max_teams',
        's.name as sport_name', 's.slug as sport_slug',
        'u.name as organizer_name',
      ])
      .orderBy('e.starts_at', 'asc')
      .limit(limit + 1)

    if (query.sport) q = q.where('s.slug', '=', query.sport)
    if (query.city) q = q.where('e.city', '=', query.city)
    if (query.status) q = q.where('e.status', '=', query.status)
    if (query.cursor) q = q.where('e.starts_at', '>', new Date(query.cursor))

    const items = await q.execute()
    const hasMore = items.length > limit
    return {
      items: hasMore ? items.slice(0, limit) : items,
      next_cursor: hasMore ? items[limit - 1].starts_at?.toISOString() : null,
    }
  })

  // GET /events/:id — event detail with teams + bracket
  app.get('/events/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const db = getDb()

    const event = await db
      .selectFrom('events as e')
      .innerJoin('sports as s', 's.id', 'e.sport_id')
      .selectAll('e')
      .select(['s.name as sport_name', 's.slug as sport_slug', 's.stat_schema'])
      .where('e.id', '=', id)
      .executeTakeFirst()

    if (!event) return reply.code(404).send({ error: 'Event not found' })

    // Teams registered
    const teams = await db
      .selectFrom('event_teams as et')
      .innerJoin('teams as t', 't.id', 'et.team_id')
      .select([
        't.id', 't.name', 't.avatar_url', 't.avg_rating',
        'et.seed', 'et.group_no', 'et.points',
      ])
      .where('et.event_id', '=', id)
      .orderBy('et.seed', 'asc')
      .execute()

    // Recent matches
    const matches = await db
      .selectFrom('matches as m')
      .select([
        'm.id', 'm.round', 'm.status', 'm.scheduled_at', 'm.home_score', 'm.away_score',
        'm.home_team_id', 'm.away_team_id', 'm.winner_team_id',
      ])
      .where('m.event_id', '=', id)
      .orderBy('m.scheduled_at', 'asc')
      .execute()

    return { ...event, teams, matches }
  })

  // POST /events/:id/teams — register a team
  app.post('/events/:id/teams', { preHandler: requireAuth }, async (request, reply) => {
    const { id: eventId } = request.params as { id: string }
    const body = RegisterTeamBody.safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() })

    const db = getDb()

    const event = await db
      .selectFrom('events')
      .select(['id', 'max_teams', 'status', 'sport_id'])
      .where('id', '=', eventId)
      .executeTakeFirst()

    if (!event) return reply.code(404).send({ error: 'Event not found' })
    if (!['upcoming', 'registration'].includes(event.status)) {
      return reply.code(409).send({ error: 'Event is not accepting registrations' })
    }

    // Verify caller is team organizer or captain
    const membership = await db
      .selectFrom('team_members')
      .select('role')
      .where('team_id', '=', body.data.team_id)
      .where('user_id', '=', request.userId)
      .where('role', 'in', ['captain', 'vice_captain'])
      .executeTakeFirst()

    const teamRecord = await db
      .selectFrom('teams')
      .select('organizer_id')
      .where('id', '=', body.data.team_id)
      .executeTakeFirst()

    if (!membership && teamRecord?.organizer_id !== request.userId) {
      return reply.code(403).send({ error: 'Only team captain can register' })
    }

    // Check capacity
    if (event.max_teams) {
      const current = await db
        .selectFrom('event_teams')
        .select(db.fn.count('team_id').as('count'))
        .where('event_id', '=', eventId)
        .executeTakeFirst()

      if (Number(current?.count ?? 0) >= event.max_teams) {
        return reply.code(409).send({ error: 'Event is full' })
      }
    }

    await db
      .insertInto('event_teams')
      .values({
        event_id: eventId,
        team_id: body.data.team_id,
        group_no: body.data.group_no ?? null,
      })
      .onConflict((oc) => oc.doNothing())
      .execute()

    return reply.code(204).send()
  })

  // PATCH /events/:id/status — organizer updates event status
  app.patch('/events/:id/status', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { status } = request.body as { status: string }
    const db = getDb()

    const event = await db
      .selectFrom('events')
      .select(['organizer_id', 'status'])
      .where('id', '=', id)
      .executeTakeFirst()

    if (!event) return reply.code(404).send({ error: 'Not found' })
    if (event.organizer_id !== request.userId) return reply.code(403).send({ error: 'Forbidden' })

    await db.updateTable('events').set({ status } as any).where('id', '=', id).execute()
    return reply.code(204).send()
  })
}
