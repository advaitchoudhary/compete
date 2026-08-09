import { getDb } from '../../../shared/db/client'
import type { FixtureSource } from '../../../shared/db/types'
import type { MatchTier } from '../../../shared/tiers'
import { rankStandings } from './standings'

/**
 * Advance the bracket.
 *
 * Fills any fixture whose sources are now known and creates its `matches` row.
 * Two source kinds resolve here:
 *   - `winner_of` — as soon as the feeding fixture's match has a winner
 *   - `qualifier` — once EVERY group match is complete, the whole first knockout
 *     round is filled at once from the ranked qualifier list (group winners
 *     first, then best runners-up), which is how a real draw works
 *
 * Idempotent: a slot that already holds a team is never overwritten, and the
 * UNIQUE constraint on `event_fixtures.match_id` makes a second match impossible
 * for the same fixture.
 */
export async function resolveFixtures(eventId: string): Promise<{ advanced: number }> {
  const db = getDb()

  const event = await db
    .selectFrom('events')
    .select(['id', 'sport_id', 'tier', 'venue', 'match_format', 'match_duration_minutes'])
    .where('id', '=', eventId)
    .executeTakeFirst()
  if (!event) return { advanced: 0 }

  const fixtures = await db
    .selectFrom('event_fixtures')
    .selectAll()
    .where('event_id', '=', eventId)
    .orderBy('scheduled_at', 'asc')
    .execute()

  const pending = fixtures.filter((f) => f.match_id === null)
  if (pending.length === 0) return { advanced: 0 }

  // ── winner_of resolution ──────────────────────────────────────────────────
  const winnerByFixture = new Map<string, string | null>()
  const withMatches = fixtures.filter((f) => f.match_id !== null)
  if (withMatches.length > 0) {
    const results = await db
      .selectFrom('matches')
      .select(['id', 'winner_team_id', 'status'])
      .where(
        'id',
        'in',
        withMatches.map((f) => f.match_id as string)
      )
      .execute()
    const byMatch = new Map(results.map((r) => [r.id, r]))
    for (const f of withMatches) {
      const m = byMatch.get(f.match_id as string)
      if (m && m.status === 'completed') winnerByFixture.set(f.id, m.winner_team_id)
    }
  }

  // ── qualifier resolution ──────────────────────────────────────────────────
  // Only once the entire group stage is done, so the table is final.
  let qualifierList: string[] = []
  const needsQualifiers = pending.some(
    (f) =>
      (f.home_source as FixtureSource).type === 'qualifier' ||
      (f.away_source as FixtureSource).type === 'qualifier'
  )

  if (needsQualifiers) {
    const groupsRemaining = await db
      .selectFrom('matches')
      .select('id')
      .where('event_id', '=', eventId)
      .where('round', 'like', 'group_%')
      .where('status', '!=', 'completed')
      .executeTakeFirst()

    if (!groupsRemaining) {
      const groupRows = await db
        .selectFrom('event_teams')
        .select('group_no')
        .where('event_id', '=', eventId)
        .where('group_no', 'is not', null)
        .execute()
      const groups = [...new Set(groupRows.map((g) => g.group_no as string))].sort()

      const tables = await Promise.all(groups.map((g) => rankStandings(eventId, g)))

      // Winners in table order first, then runners-up, then third places — each
      // band internally ordered by the same points/GD/GF comparison. Comparing
      // across groups is fair because group sizes are equal.
      const bands: Array<Array<{ team_id: string; points: number; gd: number; gf: number }>> = []
      const deepest = Math.max(...tables.map((t) => t.length), 0)
      for (let pos = 0; pos < deepest; pos++) {
        const band = tables
          .map((t) => t[pos])
          .filter((r): r is NonNullable<typeof r> => Boolean(r))
          .sort((a, b) => b.points - a.points || b.gd - a.gd || b.gf - a.gf)
        bands.push(band)
      }
      qualifierList = bands.flat().map((r) => r.team_id)
    }
  }

  // ── Fill and create ───────────────────────────────────────────────────────
  const resolveSide = (source: FixtureSource, current: string | null): string | null => {
    if (current) return current
    if (source.type === 'team') return source.team_id
    if (source.type === 'winner_of') return winnerByFixture.get(source.fixture_id) ?? null
    if (source.type === 'qualifier') return qualifierList[source.seed - 1] ?? null
    return null
  }

  let advanced = 0

  for (const f of pending) {
    const home = resolveSide(f.home_source as FixtureSource, f.home_team_id)
    const away = resolveSide(f.away_source as FixtureSource, f.away_team_id)

    if (home === f.home_team_id && away === f.away_team_id) continue

    const created = await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('event_fixtures')
        .set({ home_team_id: home, away_team_id: away, updated_at: new Date() })
        .where('id', '=', f.id)
        .execute()

      // A fixture only becomes a match once BOTH sides are known.
      if (!home || !away) return false

      // Re-read under the transaction: another concurrent resolve may have won.
      const fresh = await trx
        .selectFrom('event_fixtures')
        .select('match_id')
        .where('id', '=', f.id)
        .executeTakeFirstOrThrow()
      if (fresh.match_id) return false

      const match = await trx
        .insertInto('matches')
        .values({
          event_id: eventId,
          sport_id: event.sport_id,
          home_team_id: home,
          away_team_id: away,
          venue: event.venue,
          round: f.round,
          scheduled_at: f.scheduled_at,
          status: 'scheduled',
          tier: event.tier as MatchTier,
          format: event.match_format,
          duration_minutes: event.match_duration_minutes,
          referee_id: f.referee_id,
        })
        .returning('id')
        .executeTakeFirstOrThrow()

      await trx
        .updateTable('event_fixtures')
        .set({ match_id: match.id, updated_at: new Date() })
        .where('id', '=', f.id)
        .execute()

      return true
    })

    if (created) advanced++
  }

  return { advanced }
}
