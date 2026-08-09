import type { FastifyInstance } from 'fastify'
import { requireAuth, requireRole } from '../../shared/middleware/auth'
import { getDb } from '../../shared/db/client'
import type { FixtureSource } from '../../shared/db/types'
import { generateFixtures } from './bracket/generator'
import { rankStandings } from './bracket/standings'
import { fixtureLabel, roundLabel } from './bracket/round-label'
import { notifyUsers, eventPlayerIds } from '../notifications/notify.service'

export async function eventFixturesRoutes(app: FastifyInstance) {
  /**
   * POST /events/:id/fixtures
   *
   * Builds the whole tournament: groups, knockout rounds, slots, pitches and
   * referees. One transaction — all of it or none. Re-runnable while nothing has
   * kicked off, so an organizer can re-seed after a team withdraws.
   */
  app.post(
    '/events/:id/fixtures',
    { preHandler: requireRole('organizer', 'admin') },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const event = await getDb()
        .selectFrom('events')
        .select(['id', 'organizer_id', 'name'])
        .where('id', '=', id)
        .executeTakeFirst()

      if (!event) return reply.code(404).send({ error: 'Event not found' })
      if (event.organizer_id !== request.userId && request.userRole !== 'admin') {
        return reply.code(403).send({ error: 'Forbidden — not your event' })
      }

      const result = await generateFixtures(id)
      if (!result.ok) return reply.code(result.code).send({ error: result.error })

      // Tell every registered player the day's schedule exists. notifyUsers never
      // throws, so a push problem cannot fail the generation the organizer just did.
      await notifyUsers({
        userIds: await eventPlayerIds(id),
        type: 'fixtures_published',
        title: 'Fixtures are up',
        body: `${event.name} — ${result.fixtures} matches scheduled. Check your first kick-off.`,
        data: { event_id: id },
      })

      return reply.code(201).send({
        event_id: id,
        fixtures: result.fixtures,
        matches: result.matches,
        fell_back: result.fell_back,
        fallback_reason: result.fallback_reason,
      })
    }
  )

  /**
   * GET /events/:id/fixtures
   *
   * The bracket and the group tables. Unresolved sides come back as readable
   * placeholders ("Winner of semi 1", "Qualifier 3") rather than nulls, which is
   * what a bracket view needs to render — and exactly what Phase 5's public page
   * will consume.
   */
  app.get('/events/:id/fixtures', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const db = getDb()

    const event = await db
      .selectFrom('events')
      .select(['id', 'tier', 'format', 'match_format'])
      .where('id', '=', id)
      .executeTakeFirst()

    if (!event) return reply.code(404).send({ error: 'Event not found' })

    const rows = await db
      .selectFrom('event_fixtures as ef')
      .leftJoin('teams as ht', 'ht.id', 'ef.home_team_id')
      .leftJoin('teams as at', 'at.id', 'ef.away_team_id')
      .leftJoin('users as r', 'r.id', 'ef.referee_id')
      .leftJoin('matches as m', 'm.id', 'ef.match_id')
      .select([
        'ef.id',
        'ef.round',
        'ef.slot_no',
        'ef.pitch_label',
        'ef.scheduled_at',
        'ef.match_id',
        'ef.home_team_id',
        'ef.away_team_id',
        'ef.home_source',
        'ef.away_source',
        'ht.name as home_team_name',
        'at.name as away_team_name',
        'r.name as referee_name',
        'm.status as match_status',
        'm.home_score',
        'm.away_score',
      ])
      .where('ef.event_id', '=', id)
      .orderBy('ef.scheduled_at', 'asc')
      .orderBy('ef.slot_no', 'asc')
      .execute()

    // Round labels are needed to describe a winner_of placeholder in words.
    const roundBySlot = new Map(rows.map((f) => [f.id, fixtureLabel(f.round, f.slot_no)]))

    const label = (source: FixtureSource, teamName: string | null): string => {
      if (teamName) return teamName
      if (source.type === 'team') return 'TBC'
      if (source.type === 'qualifier') return `Qualifier ${source.seed}`
      return `Winner of ${roundBySlot.get(source.fixture_id) ?? 'earlier fixture'}`
    }

    const fixtures = rows.map((f) => ({
      id: f.id,
      round: f.round,
      round_label: roundLabel(f.round),
      slot_no: f.slot_no,
      pitch_label: f.pitch_label,
      scheduled_at: f.scheduled_at,
      referee_name: f.referee_name,
      match_id: f.match_id,
      match_status: f.match_status,
      home_team_id: f.home_team_id,
      away_team_id: f.away_team_id,
      home_label: label(f.home_source as FixtureSource, f.home_team_name),
      away_label: label(f.away_source as FixtureSource, f.away_team_name),
      home_score: f.home_score,
      away_score: f.away_score,
    }))

    const groupRows = await db
      .selectFrom('event_teams')
      .select('group_no')
      .where('event_id', '=', id)
      .where('group_no', 'is not', null)
      .execute()
    const groups = [...new Set(groupRows.map((g) => g.group_no as string))].sort()

    const standings = await Promise.all(
      groups.map(async (g) => ({ group: g, table: await rankStandings(id, g) }))
    )

    return {
      event_id: id,
      tier: event.tier,
      format: event.format,
      match_format: event.match_format,
      fixtures,
      standings,
    }
  })
}
