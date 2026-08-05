import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAuth, requireRole } from '../../shared/middleware/auth'
import { getDb } from '../../shared/db/client'
import type { MatchFormat } from '../../shared/db/types'

/**
 * Minimum players a squad must have, by a-side format. The captain counts as
 * one. Exported because Phase 3's fixture generator needs the same numbers.
 */
export const MIN_SQUAD: Record<MatchFormat, number> = {
  '5-a-side': 5,
  '7-a-side': 7,
  '11-a-side': 11,
}

/** Fallback when an event predates events.match_format — the most permissive. */
const DEFAULT_MIN_SQUAD = 5

/** Squad cap = minimum plus a bench. Keeps a roster from being a mailing list. */
const BENCH_ALLOWANCE = 7

const PlayerEntry = z
  .object({
    user_id: z.string().uuid().optional(),
    name: z.string().min(2).max(80).optional(),
  })
  .refine((p) => Boolean(p.user_id) !== Boolean(p.name), {
    message: 'each player needs exactly one of user_id or name',
  })

const RegisterBody = z.object({
  team_name: z.string().min(2).max(60),
  city: z.string().max(50).optional(),
  players: z.array(PlayerEntry).min(1).max(30),
})

export async function eventRegistrationRoutes(app: FastifyInstance) {
  /**
   * POST /events/:id/register
   *
   * A captain registers their whole squad in one call. Players are either an
   * existing user_id (found via GET /users/search) or a bare name, which becomes
   * a guest — the primary path, since most players at a turf tournament have no
   * account. Team, members, guests and the event_teams row are all created in a
   * single transaction so a partial squad can never be left behind.
   *
   * Guests are created inline rather than through POST /users/guest, which is
   * referee/admin-only. That keeps a general-purpose "invent users" endpoint away
   * from ordinary players while still letting a captain type in their mates.
   */
  app.post('/events/:id/register', { preHandler: requireAuth }, async (request, reply) => {
    const { id: eventId } = request.params as { id: string }
    const body = RegisterBody.safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() })

    const db = getDb()

    const event = await db
      .selectFrom('events')
      .select(['id', 'status', 'max_teams', 'sport_id', 'match_format'])
      .where('id', '=', eventId)
      .executeTakeFirst()

    if (!event) return reply.code(404).send({ error: 'Event not found' })

    // The organizer opens registration explicitly via PATCH /events/:id/status.
    if (event.status !== 'registration') {
      return reply.code(409).send({
        error: `Event is not accepting registrations (status: ${event.status})`,
      })
    }

    // ── Squad size ───────────────────────────────────────────────────────────
    // The captain is always part of the squad, so they count toward the minimum.
    const existingIds = body.data.players
      .filter((p) => p.user_id)
      .map((p) => p.user_id as string)
    const namedPlayers = body.data.players.filter((p) => p.name).map((p) => p.name as string)

    // A captain who also lists themselves shouldn't be counted or inserted twice.
    const otherExistingIds = [...new Set(existingIds)].filter((id) => id !== request.userId)
    const squadSize = 1 + otherExistingIds.length + namedPlayers.length

    const minSquad = event.match_format ? MIN_SQUAD[event.match_format] : DEFAULT_MIN_SQUAD
    if (squadSize < minSquad) {
      return reply.code(400).send({
        error: `A ${event.match_format ?? 'football'} squad needs at least ${minSquad} players (got ${squadSize}, including you as captain)`,
      })
    }
    if (squadSize > minSquad + BENCH_ALLOWANCE) {
      return reply.code(400).send({
        error: `A squad may have at most ${minSquad + BENCH_ALLOWANCE} players (got ${squadSize})`,
      })
    }

    // ── Duplicate team name in this event (case-insensitive) ─────────────────
    // Compared in JS rather than with a SQL lower(): an event holds at most 16
    // teams, so fetching the names is trivial and avoids a functional index.
    const teamName = body.data.team_name.trim()
    const existingTeams = await db
      .selectFrom('event_teams as et')
      .innerJoin('teams as t', 't.id', 'et.team_id')
      .select('t.name')
      .where('et.event_id', '=', eventId)
      .execute()

    const clash = existingTeams.some(
      (t) => t.name.trim().toLowerCase() === teamName.toLowerCase()
    )
    if (clash) {
      return reply.code(409).send({ error: `A team named "${teamName}" is already registered` })
    }

    // ── Capacity ─────────────────────────────────────────────────────────────
    if (event.max_teams) {
      const { count } = await db
        .selectFrom('event_teams')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('event_id', '=', eventId)
        .executeTakeFirstOrThrow()
      if (Number(count) >= event.max_teams) {
        return reply.code(409).send({ error: `Event is full (${event.max_teams} teams)` })
      }
    }

    // ── Existing players must exist ──────────────────────────────────────────
    if (otherExistingIds.length > 0) {
      const found = await db
        .selectFrom('users')
        .select('id')
        .where('id', 'in', otherExistingIds)
        .where('is_active', '=', true)
        .execute()
      const foundIds = new Set(found.map((u) => u.id))
      const missing = otherExistingIds.filter((id) => !foundIds.has(id))
      if (missing.length > 0) {
        return reply.code(400).send({ error: `unknown user_id: ${missing.join(', ')}` })
      }
    }

    // ── Nobody may play for two teams in the same event ──────────────────────
    const squadUserIds = [request.userId, ...otherExistingIds]
    const alreadyIn = await db
      .selectFrom('event_teams as et')
      .innerJoin('team_members as tm', 'tm.team_id', 'et.team_id')
      .innerJoin('users as u', 'u.id', 'tm.user_id')
      .select(['u.id', 'u.name'])
      .where('et.event_id', '=', eventId)
      .where('tm.user_id', 'in', squadUserIds)
      .execute()

    if (alreadyIn.length > 0) {
      const names = alreadyIn.map((u) => u.name).join(', ')
      return reply.code(409).send({
        error: `already registered in this event with another team: ${names}`,
      })
    }

    // ── Create everything atomically ─────────────────────────────────────────
    const result = await db.transaction().execute(async (trx) => {
      const team = await trx
        .insertInto('teams')
        .values({
          name: teamName,
          sport_id: event.sport_id,
          city: body.data.city ?? null,
          organizer_id: request.userId,
        })
        .returning(['id', 'name'])
        .executeTakeFirstOrThrow()

      await trx
        .insertInto('team_members')
        .values({ team_id: team.id, user_id: request.userId, role: 'captain' })
        .execute()

      // Guests are real users with no credentials, attributed to the captain who
      // entered them. They accumulate ratings and are claimable later (Phase 6).
      const guestIds: string[] = []
      for (const name of namedPlayers) {
        const guest = await trx
          .insertInto('users')
          .values({
            name,
            city: body.data.city ?? null,
            phone: null,
            firebase_uid: null,
            is_guest: true,
            created_by: request.userId,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
        guestIds.push(guest.id)
      }

      const memberIds = [...otherExistingIds, ...guestIds]
      if (memberIds.length > 0) {
        await trx
          .insertInto('team_members')
          .values(
            memberIds.map((uid) => ({
              team_id: team.id,
              user_id: uid,
              role: 'player' as const,
            }))
          )
          .execute()
      }

      await trx
      // Seed by registration order. Without this the seed stays NULL, and the
      // bracket generator's `ORDER BY seed, team_id` silently falls back to UUID
      // order — which would quietly defeat snake group distribution, byes going
      // to the strongest teams, and the seed-order tie-break. Computed inside the
      // transaction so two simultaneous registrations can't claim the same seed.
      const { registered } = await trx
        .selectFrom('event_teams')
        .select((eb) => eb.fn.countAll<string>().as('registered'))
        .where('event_id', '=', eventId)
        .executeTakeFirstOrThrow()

      await trx
        .insertInto('event_teams')
        .values({ event_id: eventId, team_id: team.id, seed: Number(registered) + 1 })
        .execute()

      const roster = await trx
        .selectFrom('team_members as tm')
        .innerJoin('users as u', 'u.id', 'tm.user_id')
        .select(['u.id as user_id', 'u.name', 'u.is_guest', 'tm.role'])
        .where('tm.team_id', '=', team.id)
        .execute()

      return { team, roster }
    })

    return reply.code(201).send({
      team_id: result.team.id,
      event_id: eventId,
      team_name: result.team.name,
      roster: result.roster,
    })
  })

  /**
   * GET /events/:id/teams
   *
   * Every registered squad with its full roster. GET /events/:id returns the
   * team rows but no players, so this is what lets an organizer confirm squads
   * are complete before generating fixtures, and what a team-list screen renders.
   */
  app.get('/events/:id/teams', { preHandler: requireAuth }, async (request, reply) => {
    const { id: eventId } = request.params as { id: string }
    const db = getDb()

    const event = await db
      .selectFrom('events')
      .select('id')
      .where('id', '=', eventId)
      .executeTakeFirst()

    if (!event) return reply.code(404).send({ error: 'Event not found' })

    const teams = await db
      .selectFrom('event_teams as et')
      .innerJoin('teams as t', 't.id', 'et.team_id')
      .select(['et.team_id', 't.name', 't.avatar_url', 'et.seed', 'et.group_no', 'et.points'])
      .where('et.event_id', '=', eventId)
      .orderBy('et.seed', 'asc')
      .orderBy('t.name', 'asc')
      .execute()

    if (teams.length === 0) {
      return { event_id: eventId, count: 0, teams: [] }
    }

    // One query for every roster, then grouped in memory — avoids N+1.
    const members = await db
      .selectFrom('team_members as tm')
      .innerJoin('users as u', 'u.id', 'tm.user_id')
      .select(['tm.team_id', 'u.id as user_id', 'u.name', 'u.is_guest', 'tm.role'])
      .where(
        'tm.team_id',
        'in',
        teams.map((t) => t.team_id)
      )
      .execute()

    const byTeam = new Map<string, Array<{ user_id: string; name: string; is_guest: boolean; role: string }>>()
    for (const m of members) {
      const list = byTeam.get(m.team_id) ?? []
      list.push({ user_id: m.user_id, name: m.name, is_guest: m.is_guest, role: m.role })
      byTeam.set(m.team_id, list)
    }

    return {
      event_id: eventId,
      count: teams.length,
      teams: teams.map((t) => ({ ...t, players: byTeam.get(t.team_id) ?? [] })),
    }
  })

  /**
   * DELETE /events/:id/teams/:teamId
   *
   * Un-registers a team. Teams withdraw — someone can't get eleven people to a
   * turf on a Sunday — and until now the only way to undo a registration was a
   * manual DELETE in Postgres.
   *
   * This removes the *registration*, not the team: the squad, its guests and
   * their accumulated stats all survive, because that team may well enter the
   * next tournament. Only the `event_teams` row goes.
   *
   * Removing a team invalidates any bracket built from it, so an existing
   * bracket is torn down here and must be regenerated. That is safe only while
   * nothing has kicked off, which is exactly the condition checked below — the
   * same rule POST /events/:id/fixtures uses for regeneration. Once a match has
   * started, the field is fixed and this returns 409.
   *
   * Remaining seeds are resequenced to 1..N. A gap would otherwise leak into the
   * planner, which uses seed order for snake group distribution and bye
   * allocation.
   */
  app.delete(
    '/events/:id/teams/:teamId',
    { preHandler: requireRole('organizer', 'admin') },
    async (request, reply) => {
      const { id: eventId, teamId } = request.params as { id: string; teamId: string }
      const db = getDb()

      const event = await db
        .selectFrom('events')
        .select(['id', 'organizer_id'])
        .where('id', '=', eventId)
        .executeTakeFirst()

      if (!event) return reply.code(404).send({ error: 'Event not found' })
      if (event.organizer_id !== request.userId && request.userRole !== 'admin') {
        return reply.code(403).send({ error: 'Forbidden — not your event' })
      }

      const registration = await db
        .selectFrom('event_teams as et')
        .innerJoin('teams as t', 't.id', 'et.team_id')
        .select(['et.team_id', 't.name'])
        .where('et.event_id', '=', eventId)
        .where('et.team_id', '=', teamId)
        .executeTakeFirst()

      if (!registration) {
        return reply.code(404).send({ error: 'That team is not registered in this event' })
      }

      const started = await db
        .selectFrom('matches')
        .select('id')
        .where('event_id', '=', eventId)
        .where('status', '!=', 'scheduled')
        .executeTakeFirst()

      if (started) {
        return reply.code(409).send({
          error: 'A match has already kicked off — teams can no longer be removed',
        })
      }

      const result = await db.transaction().execute(async (trx) => {
        // Fixtures first: event_fixtures.match_id is ON DELETE SET NULL, so
        // dropping matches first would silently blank the link instead of
        // removing the row.
        const fixtures = await trx
          .deleteFrom('event_fixtures')
          .where('event_id', '=', eventId)
          .executeTakeFirst()

        // Only scheduled matches exist at this point (guarded above).
        // match_player_stats cascades from matches.
        const matches = await trx
          .deleteFrom('matches')
          .where('event_id', '=', eventId)
          .executeTakeFirst()

        await trx
          .deleteFrom('event_teams')
          .where('event_id', '=', eventId)
          .where('team_id', '=', teamId)
          .execute()

        // Resequence so seeds stay 1..N with no hole.
        const remaining = await trx
          .selectFrom('event_teams')
          .select(['team_id', 'seed'])
          .where('event_id', '=', eventId)
          .orderBy('seed', 'asc')
          .orderBy('registered_at', 'asc')
          .execute()

        for (const [i, row] of remaining.entries()) {
          if (row.seed !== i + 1) {
            await trx
              .updateTable('event_teams')
              .set({ seed: i + 1 })
              .where('event_id', '=', eventId)
              .where('team_id', '=', row.team_id)
              .execute()
          }
        }

        // Group assignments came from the bracket we just tore down.
        await trx
          .updateTable('event_teams')
          .set({ group_no: null })
          .where('event_id', '=', eventId)
          .execute()

        return {
          fixtures_cleared: Number(fixtures?.numDeletedRows ?? 0),
          matches_cleared: Number(matches?.numDeletedRows ?? 0),
          teams_remaining: remaining.length,
        }
      })

      return {
        event_id: eventId,
        removed: { team_id: teamId, name: registration.name },
        ...result,
      }
    }
  )
}
