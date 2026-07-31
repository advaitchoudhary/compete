import { sql, type Kysely, type Transaction } from 'kysely'
import { getDb } from '../../../shared/db/client'
import type { Database } from '../../../shared/db/types'

const WIN_POINTS = 3
const DRAW_POINTS = 1

/** Goals out of a match score jsonb, which is shaped `{ goals: n }` for football. */
export function goalsOf(score: unknown): number {
  if (!score || typeof score !== 'object') return 0
  const value = (score as Record<string, unknown>).goals
  return typeof value === 'number' ? value : Number(value ?? 0) || 0
}

/**
 * Fold a completed GROUP match into the two teams' standings rows.
 *
 * Knockout results are deliberately excluded — they don't belong in a group
 * table. Runs inside the caller's transaction so a match completing and its
 * table update commit together.
 */
export async function applyStandings(
  trx: Transaction<Database> | Kysely<Database>,
  matchId: string
): Promise<void> {
  const match = await trx
    .selectFrom('matches')
    .select([
      'id',
      'event_id',
      'round',
      'home_team_id',
      'away_team_id',
      'home_score',
      'away_score',
      'status',
    ])
    .where('id', '=', matchId)
    .executeTakeFirst()

  if (!match || !match.event_id) return
  if (match.status !== 'completed') return
  if (!match.round || !match.round.startsWith('group_')) return

  const homeGoals = goalsOf(match.home_score)
  const awayGoals = goalsOf(match.away_score)

  const rows = [
    {
      team_id: match.home_team_id,
      gf: homeGoals,
      ga: awayGoals,
      won: homeGoals > awayGoals ? 1 : 0,
      drawn: homeGoals === awayGoals ? 1 : 0,
      lost: homeGoals < awayGoals ? 1 : 0,
    },
    {
      team_id: match.away_team_id,
      gf: awayGoals,
      ga: homeGoals,
      won: awayGoals > homeGoals ? 1 : 0,
      drawn: homeGoals === awayGoals ? 1 : 0,
      lost: awayGoals < homeGoals ? 1 : 0,
    },
  ]

  for (const r of rows) {
    // sql`col + n` matches the pattern already used in scores.routes.ts, where
    // db.raw was deliberately replaced with it.
    const gained = r.won * WIN_POINTS + r.drawn * DRAW_POINTS
    await trx
      .updateTable('event_teams')
      .set({
        played: sql<number>`played + 1`,
        won: sql<number>`won + ${r.won}`,
        drawn: sql<number>`drawn + ${r.drawn}`,
        lost: sql<number>`lost + ${r.lost}`,
        goals_for: sql<number>`goals_for + ${r.gf}`,
        goals_against: sql<number>`goals_against + ${r.ga}`,
        points: sql<number>`points + ${gained}`,
      })
      .where('event_id', '=', match.event_id)
      .where('team_id', '=', r.team_id)
      .execute()
  }
}

export interface StandingRow {
  team_id: string
  points: number
  gd: number
  gf: number
  seed: number | null
}

/**
 * Ordered group table.
 *
 * points → goal difference → goals for → head-to-head → seed.
 * Head-to-head applies only to a TWO-way tie; three or more teams still level
 * fall back to seed order, which is deterministic and explainable to an
 * organizer standing on the pitch. No coin flips.
 */
export async function rankStandings(eventId: string, group: string): Promise<StandingRow[]> {
  const db = getDb()

  const rows = await db
    .selectFrom('event_teams')
    .select(['team_id', 'points', 'goals_for', 'goals_against', 'seed'])
    .where('event_id', '=', eventId)
    .where('group_no', '=', group)
    .execute()

  const table: StandingRow[] = rows.map((r) => ({
    team_id: r.team_id,
    points: Number(r.points),
    gd: Number(r.goals_for) - Number(r.goals_against),
    gf: Number(r.goals_for),
    seed: r.seed === null ? null : Number(r.seed),
  }))

  // Head-to-head data for breaking two-way ties.
  const played = await db
    .selectFrom('matches')
    .select(['home_team_id', 'away_team_id', 'home_score', 'away_score'])
    .where('event_id', '=', eventId)
    .where('status', '=', 'completed')
    .where('round', 'like', 'group_%')
    .execute()

  const headToHead = (a: string, b: string): number => {
    let aGoals = 0
    let bGoals = 0
    for (const m of played) {
      if (m.home_team_id === a && m.away_team_id === b) {
        aGoals += goalsOf(m.home_score)
        bGoals += goalsOf(m.away_score)
      } else if (m.home_team_id === b && m.away_team_id === a) {
        bGoals += goalsOf(m.home_score)
        aGoals += goalsOf(m.away_score)
      }
    }
    return bGoals - aGoals // negative => a ahead
  }

  const levelCount = (row: StandingRow) =>
    table.filter((t) => t.points === row.points && t.gd === row.gd && t.gf === row.gf).length

  return table.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points
    if (b.gd !== a.gd) return b.gd - a.gd
    if (b.gf !== a.gf) return b.gf - a.gf
    // Only a straight two-way tie is settled head-to-head.
    if (levelCount(a) === 2 && levelCount(b) === 2) {
      const h2h = headToHead(a.team_id, b.team_id)
      if (h2h !== 0) return h2h
    }
    return (a.seed ?? Number.MAX_SAFE_INTEGER) - (b.seed ?? Number.MAX_SAFE_INTEGER)
  })
}
