import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAuth, requireRole } from '../../shared/middleware/auth'
import { getDb } from '../../shared/db/client'
import { MATCH_TIERS, TIER_RANK, type MatchTier } from '../../shared/tiers'
import { maxTierForEvent } from '../events/event-tier'

const ApplyBody = z.object({
  full_name: z.string().min(2).max(80),
  city: z.string().min(2).max(50),
  // The turf/venue they run tournaments at — the thing that makes them credible.
  venue_name: z.string().min(2).max(120),
  phone: z.string().min(6).max(20).optional(),
  bio: z.string().max(500).optional(),
})

export async function organizerRoutes(app: FastifyInstance) {
  /**
   * POST /organizer/apply
   * A player applies to run tournaments. Creates a pending application that an
   * admin must approve. Reuses referee_applications with request_type
   * 'organizer' so admins triage referees and organizers in one queue.
   */
  app.post('/organizer/apply', { preHandler: requireAuth }, async (request, reply) => {
    const body = ApplyBody.safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() })

    const db = getDb()

    const me = await db
      .selectFrom('users')
      .select('role')
      .where('id', '=', request.userId)
      .executeTakeFirst()

    if (!me) return reply.code(401).send({ error: 'Unauthorized' })
    if (me.role === 'organizer') {
      return reply.code(409).send({ error: 'You are already an organizer' })
    }
    // A referee scores matches and an organizer must never score one. With a
    // single role per user, holding both would break that separation.
    if (me.role === 'referee') {
      return reply.code(409).send({
        error: 'A referee cannot also be an organizer — organizers must never score matches',
      })
    }
    if (me.role === 'admin') {
      return reply.code(409).send({ error: 'Admins can already create events' })
    }

    const pending = await db
      .selectFrom('referee_applications')
      .select('id')
      .where('user_id', '=', request.userId)
      .where('status', '=', 'pending')
      .executeTakeFirst()

    if (pending) {
      return reply.code(409).send({ error: 'You already have a pending application' })
    }

    // venue_name is folded into bio because referee_applications has no venue
    // column; it is a review aid for the admin, not queried data.
    const bio = body.data.bio
      ? `Venue: ${body.data.venue_name}. ${body.data.bio}`
      : `Venue: ${body.data.venue_name}.`

    const application = await db
      .insertInto('referee_applications')
      .values({
        user_id: request.userId,
        full_name: body.data.full_name,
        city: body.data.city,
        phone: body.data.phone ?? null,
        request_type: 'organizer',
        bio,
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    return reply.code(201).send(application)
  })

  /**
   * GET /organizer/me
   * The caller's role plus their latest application, for driving the UI state.
   */
  app.get('/organizer/me', { preHandler: requireAuth }, async (request, reply) => {
    const db = getDb()

    const me = await db
      .selectFrom('users')
      .select(['id', 'name', 'role'])
      .where('id', '=', request.userId)
      .executeTakeFirst()

    if (!me) return reply.code(401).send({ error: 'Unauthorized' })

    const application = await db
      .selectFrom('referee_applications')
      .selectAll()
      .where('user_id', '=', request.userId)
      .where('request_type', '=', 'organizer')
      .orderBy('created_at', 'desc')
      .executeTakeFirst()

    return {
      user_id: me.id,
      name: me.name,
      role: me.role,
      is_organizer: me.role === 'organizer' || me.role === 'admin',
      application: application ?? null,
    }
  })

  /**
   * GET /organizer/events
   *
   * The caller's own tournaments, newest first, each with the counts the
   * dashboard needs to show how far along setup is: teams registered, referees
   * assigned, fixtures generated, matches played.
   *
   * A separate route rather than `GET /events?mine=true` because the public
   * events list is unauthenticated — there is no caller there to scope to.
   */
  app.get(
    '/organizer/events',
    { preHandler: requireRole('organizer', 'admin') },
    async (request, reply) => {
      const db = getDb()

      const events = await db
        .selectFrom('events as e')
        .innerJoin('sports as s', 's.id', 'e.sport_id')
        .select([
          'e.id', 'e.name', 'e.status', 'e.tier', 'e.format', 'e.city', 'e.venue',
          'e.match_format', 'e.match_duration_minutes', 'e.max_teams', 'e.starts_at',
          'e.created_at', 's.slug as sport_slug', 's.name as sport_name',
          // Correlated counts keep this one round-trip regardless of event count.
          (eb) =>
            eb
              .selectFrom('event_teams as et')
              .select((e2) => e2.fn.countAll<string>().as('c'))
              .whereRef('et.event_id', '=', 'e.id')
              .as('teams_count'),
          (eb) =>
            eb
              .selectFrom('event_referees as er')
              .select((e2) => e2.fn.countAll<string>().as('c'))
              .whereRef('er.event_id', '=', 'e.id')
              .as('referees_count'),
          (eb) =>
            eb
              .selectFrom('event_fixtures as ef')
              .select((e2) => e2.fn.countAll<string>().as('c'))
              .whereRef('ef.event_id', '=', 'e.id')
              .as('fixtures_count'),
          (eb) =>
            eb
              .selectFrom('matches as m')
              .select((e2) => e2.fn.countAll<string>().as('c'))
              .whereRef('m.event_id', '=', 'e.id')
              .where('m.status', '=', 'completed')
              .as('completed_count'),
        ])
        .where('e.organizer_id', '=', request.userId)
        .orderBy('e.created_at', 'desc')
        .limit(50)
        .execute()

      return {
        items: events.map((e) => ({
          ...e,
          teams_count: Number(e.teams_count ?? 0),
          referees_count: Number(e.referees_count ?? 0),
          fixtures_count: Number(e.fixtures_count ?? 0),
          completed_count: Number(e.completed_count ?? 0),
        })),
      }
    }
  )

  /**
   * GET /organizer/events/:id/setup
   *
   * Everything the control room needs to decide what the organizer can do next,
   * in one call: the event, its referee roster, the tier ceiling that roster
   * implies, and whether the tier is still editable.
   *
   * The gating rules live in the backend (spec §3.1.1) and this endpoint reports
   * them, rather than the client re-deriving them and drifting out of step.
   */
  app.get(
    '/organizer/events/:id/setup',
    { preHandler: requireRole('organizer', 'admin') },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const db = getDb()

      const event = await db
        .selectFrom('events as e')
        .innerJoin('sports as s', 's.id', 'e.sport_id')
        .select([
          'e.id', 'e.name', 'e.organizer_id', 'e.status', 'e.tier', 'e.format',
          'e.city', 'e.venue', 'e.match_format', 'e.match_duration_minutes',
          'e.max_teams', 'e.starts_at', 's.slug as sport_slug',
        ])
        .where('e.id', '=', id)
        .executeTakeFirst()

      if (!event) return reply.code(404).send({ error: 'Event not found' })
      if (event.organizer_id !== request.userId && request.userRole !== 'admin') {
        return reply.code(403).send({ error: 'Forbidden — not your event' })
      }

      const referees = await db
        .selectFrom('event_referees as er')
        .innerJoin('users as u', 'u.id', 'er.user_id')
        .select(['er.user_id', 'er.pitch_label', 'u.name', 'u.avatar_url', 'u.referee_tier', 'u.role'])
        .where('er.event_id', '=', id)
        .orderBy('er.pitch_label', 'asc')
        .execute()

      const teams = await db
        .selectFrom('event_teams as et')
        .innerJoin('teams as t', 't.id', 'et.team_id')
        .select(['t.id', 't.name', 'et.seed', 'et.group_no'])
        .where('et.event_id', '=', id)
        .orderBy('et.seed', 'asc')
        .execute()

      const fixtures = await db
        .selectFrom('event_fixtures')
        .select((eb) => eb.fn.countAll<string>().as('c'))
        .where('event_id', '=', id)
        .executeTakeFirst()

      const played = await db
        .selectFrom('matches')
        .select((eb) => eb.fn.countAll<string>().as('c'))
        .where('event_id', '=', id)
        .where('status', '!=', 'scheduled')
        .executeTakeFirst()

      const fixturesCount = Number(fixtures?.c ?? 0)
      const playedCount = Number(played?.c ?? 0)
      const maxTier = await maxTierForEvent(id)

      // Distinct pitches come from the referee roster: one referee per pitch is
      // what lets matches run in parallel, so the roster IS the venue capacity.
      const pitches = [...new Set(referees.map((r) => r.pitch_label).filter(Boolean))]

      // What still stands between this event and a generated bracket, phrased for
      // the organizer. These mirror the guards in generateFixtures() so the UI can
      // disable the button and say why, instead of letting them press it and read
      // a 400. The generator remains the authority — this is only a preview of it.
      const blockers: string[] = []
      if (event.format !== 'knockout' && event.format !== 'group_knockout') {
        blockers.push(`'${event.format}' brackets cannot be generated — only knockout and groups+knockout`)
      }
      if (teams.length < 2) {
        blockers.push(`Needs at least 2 registered teams (has ${teams.length})`)
      }
      if (pitches.length === 0) {
        blockers.push('Assign at least one referee to a pitch')
      }
      for (const r of referees) {
        if (!r.pitch_label || r.role === 'admin') continue
        const t = r.referee_tier
        if (!t || TIER_RANK[t] < TIER_RANK[event.tier]) {
          blockers.push(`${r.name} (${t ?? 'no tier'}) cannot officiate a '${event.tier}' match`)
        }
      }
      if (playedCount > 0) {
        blockers.push('A match has already kicked off — the bracket is now fixed')
      }

      return {
        event,
        referees,
        teams,
        fixtures_count: fixturesCount,
        played_count: playedCount,
        pitch_count: pitches.length,
        max_tier: maxTier,
        blockers,
        // Tier is frozen once fixtures exist so a finished amateur event cannot be
        // re-declared 'legends' to retroactively reweight everyone's rating.
        tier_locked: fixturesCount > 0,
        tier_options: MATCH_TIERS.map((t) => ({
          tier: t,
          allowed: TIER_RANK[t] <= TIER_RANK[maxTier],
        })),
        can_generate_fixtures: playedCount === 0,
        can_open_registration: event.status === 'upcoming' || event.status === 'registration',
      }
    }
  )

  /**
   * GET /organizer/referees?q=&tier=&city=
   *
   * The pool of officials an organizer may assign. Only users who already hold
   * the referee role appear — the organizer cannot invent one, and assignment
   * grants no scoring power of its own (see POST /events/:id/referees).
   *
   * `tier` filters to referees who can officiate AT LEAST that tier, which is the
   * question an organizer actually has: "who can run my pro tournament?"
   */
  app.get(
    '/organizer/referees',
    { preHandler: requireRole('organizer', 'admin') },
    async (request, reply) => {
      const query = request.query as { q?: string; tier?: string; city?: string; limit?: string }
      const limit = Math.min(Number(query.limit ?? 50), 100)

      if (query.tier && !MATCH_TIERS.includes(query.tier as MatchTier)) {
        return reply.code(400).send({ error: `tier must be one of ${MATCH_TIERS.join(', ')}` })
      }

      let qb = getDb()
        .selectFrom('users')
        .select(['id', 'name', 'username', 'avatar_url', 'city', 'referee_tier'])
        .where('role', '=', 'referee')
        .where('is_active', '=', true)
        .orderBy('name', 'asc')
        .limit(limit)

      if (query.q && query.q.trim().length > 0) {
        const term = `%${query.q.trim()}%`
        qb = qb.where((eb) => eb.or([eb('name', 'ilike', term), eb('username', 'ilike', term)]))
      }
      if (query.city) qb = qb.where('city', '=', query.city)

      let referees = await qb.execute()

      if (query.tier) {
        const floor = TIER_RANK[query.tier as MatchTier]
        referees = referees.filter((r) => r.referee_tier && TIER_RANK[r.referee_tier] >= floor)
      }

      return { count: referees.length, referees }
    }
  )
}
