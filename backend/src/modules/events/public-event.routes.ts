import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getDb } from '../../shared/db/client'
import type { FixtureSource } from '../../shared/db/types'
import { rankStandings } from './bracket/standings'
import { fixtureLabel, roundLabel } from './bracket/round-label'

/**
 * The public tournament page — the only unauthenticated surface in the API.
 *
 * This is the acquisition loop: ~80 players and a few hundred sideline spectators
 * converge on one URL, no login, no download. So the shape of this response is a
 * security decision, not just a convenience. It is built by explicitly listing
 * what goes OUT rather than filtering what comes in, because a future column added
 * to `events` or `users` must not silently become world-readable.
 *
 * Exposed: names, team names, scores, times, pitch labels, standings, top scorers.
 * Never exposed: phone numbers, firebase uids, emails, organizer identity, user
 * ids for anyone other than a scorer (whose id the claim link needs in Phase 6).
 */

/** A cancelled tournament is treated as non-existent — 404, not 403, so nothing leaks. */
const HIDDEN_STATUSES = new Set(['cancelled'])

/** Rate limit for the public page: generous for a crowd, bounded for a scraper. */
const PUBLIC_RATE_LIMIT = { max: 240, timeWindow: '1 minute' }

const goalsOf = (score: unknown): number | null => {
  if (!score || typeof score !== 'object') return null
  const v = (score as Record<string, unknown>).goals
  if (v === undefined || v === null) return null
  return Number(v) || 0
}

export async function publicEventRoutes(app: FastifyInstance) {
  /**
   * GET /public/events/:id — no authentication.
   */
  app.get(
    '/public/events/:id',
    { config: { rateLimit: PUBLIC_RATE_LIMIT } },
    async (request, reply) => {
      const parsed = z.string().uuid().safeParse((request.params as { id: string }).id)
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid event id' })
      const id = parsed.data

      const db = getDb()

      const event = await db
        .selectFrom('events as e')
        .innerJoin('sports as s', 's.id', 'e.sport_id')
        .select([
          'e.id',
          'e.name',
          'e.status',
          'e.format',
          'e.match_format',
          'e.tier',
          'e.city',
          'e.venue',
          'e.starts_at',
          'e.entry_fee',
          'e.prize_pool',
          'e.description',
          's.slug as sport_slug',
        ])
        .where('e.id', '=', id)
        .executeTakeFirst()

      if (!event || HIDDEN_STATUSES.has(event.status)) {
        return reply.code(404).send({ error: 'Tournament not found' })
      }

      // ── Bracket ─────────────────────────────────────────────────────────────
      const fixtureRows = await db
        .selectFrom('event_fixtures as ef')
        .leftJoin('teams as ht', 'ht.id', 'ef.home_team_id')
        .leftJoin('teams as at', 'at.id', 'ef.away_team_id')
        .leftJoin('matches as m', 'm.id', 'ef.match_id')
        .select([
          'ef.id',
          'ef.round',
          'ef.slot_no',
          'ef.pitch_label',
          'ef.scheduled_at',
          'ef.match_id',
          'ef.home_source',
          'ef.away_source',
          'ht.name as home_team_name',
          'at.name as away_team_name',
          'm.status as match_status',
          'm.home_score',
          'm.away_score',
        ])
        .where('ef.event_id', '=', id)
        .orderBy('ef.scheduled_at', 'asc')
        .orderBy('ef.slot_no', 'asc')
        .execute()

      const roundBySlot = new Map(fixtureRows.map((f) => [f.id, fixtureLabel(f.round, f.slot_no)]))

      const label = (source: FixtureSource, teamName: string | null): string => {
        if (teamName) return teamName
        if (source.type === 'team') return 'TBC'
        if (source.type === 'qualifier') return `Qualifier ${source.seed}`
        return `Winner of ${roundBySlot.get(source.fixture_id) ?? 'earlier fixture'}`
      }

      const fixtures = fixtureRows.map((f) => ({
        round: f.round,
        round_label: roundLabel(f.round),
        slot_no: f.slot_no,
        pitch_label: f.pitch_label,
        scheduled_at: f.scheduled_at,
        match_id: f.match_id,
        match_status: f.match_status,
        home_label: label(f.home_source as FixtureSource, f.home_team_name),
        away_label: label(f.away_source as FixtureSource, f.away_team_name),
        home_goals: goalsOf(f.home_score),
        away_goals: goalsOf(f.away_score),
      }))

      // ── Teams and standings ─────────────────────────────────────────────────
      const teams = await db
        .selectFrom('event_teams as et')
        .innerJoin('teams as t', 't.id', 'et.team_id')
        .select(['t.name', 'et.group_no', 'et.seed'])
        .where('et.event_id', '=', id)
        .orderBy('et.seed', 'asc')
        .execute()

      const groupNames = [
        ...new Set(teams.map((t) => t.group_no).filter((g): g is string => Boolean(g))),
      ].sort()

      // rankStandings returns team ids; map them to names so no ids go out.
      const teamNameById = new Map(
        (
          await db
            .selectFrom('event_teams as et')
            .innerJoin('teams as t', 't.id', 'et.team_id')
            .select(['et.team_id', 't.name'])
            .where('et.event_id', '=', id)
            .execute()
        ).map((r) => [r.team_id, r.name])
      )

      const standings = await Promise.all(
        groupNames.map(async (g) => ({
          group: g,
          table: (await rankStandings(id, g)).map((row, i) => ({
            position: i + 1,
            team_name: teamNameById.get(row.team_id) ?? 'Unknown',
            points: row.points,
            goal_difference: row.gd,
            goals_for: row.gf,
          })),
        }))
      )

      // ── Top scorers ─────────────────────────────────────────────────────────
      // user_id IS included here: it is what a guest's claim link needs in Phase 6.
      const scorerRows = await db
        .selectFrom('match_player_stats as mps')
        .innerJoin('matches as m', 'm.id', 'mps.match_id')
        .innerJoin('users as u', 'u.id', 'mps.user_id')
        .innerJoin('teams as t', 't.id', 'mps.team_id')
        .select(['mps.user_id', 'u.name', 'u.is_guest', 't.name as team_name', 'mps.stats'])
        .where('m.event_id', '=', id)
        .execute()

      const tally = new Map<
        string,
        { user_id: string; name: string; is_guest: boolean; team_name: string; goals: number; assists: number }
      >()
      for (const r of scorerRows) {
        const stats = (r.stats ?? {}) as Record<string, unknown>
        const goals = Number(stats.goals ?? 0) || 0
        const assists = Number(stats.assists ?? 0) || 0
        const row = tally.get(r.user_id) ?? {
          user_id: r.user_id,
          name: r.name,
          is_guest: r.is_guest,
          team_name: r.team_name,
          goals: 0,
          assists: 0,
        }
        row.goals += goals
        row.assists += assists
        tally.set(r.user_id, row)
      }

      const topScorers = [...tally.values()]
        .filter((r) => r.goals > 0 || r.assists > 0)
        .sort((a, b) => b.goals - a.goals || b.assists - a.assists || a.name.localeCompare(b.name))
        .slice(0, 20)

      return {
        id: event.id,
        name: event.name,
        status: event.status,
        format: event.format,
        match_format: event.match_format,
        tier: event.tier,
        sport_slug: event.sport_slug,
        city: event.city,
        venue: event.venue,
        starts_at: event.starts_at,
        entry_fee: event.entry_fee,
        prize_pool: event.prize_pool,
        description: event.description,
        teams: teams.map((t) => ({ name: t.name, group: t.group_no })),
        fixtures,
        standings,
        top_scorers: topScorers,
      }
    }
  )
}
