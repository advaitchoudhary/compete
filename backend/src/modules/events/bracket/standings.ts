import { getDb } from '../../../shared/db/client'

const WIN_POINTS = 3
const DRAW_POINTS = 1

/** Goals out of a match score jsonb, which is shaped `{ goals: n }` for football. */
export function goalsOf(score: unknown): number {
  if (!score || typeof score !== 'object') return 0
  const value = (score as Record<string, unknown>).goals
  return typeof value === 'number' ? value : Number(value ?? 0) || 0
}

/**
 * Recompute an event's whole group table from its completed group matches.
 *
 * Deliberately a full recompute rather than an increment. Incrementing is O(1)
 * but not idempotent, which made two things unsafe:
 *
 *   - `finalizeMatch` is NOT transactional (it never was — the rating enqueue,
 *     team stats, feed and achievements are all sequential too). If the process
 *     died between `status='completed'` and the standings update, the table would
 *     be permanently wrong, and the 409 "already completed" guard would block any
 *     retry. A recompute self-heals on the next completed match.
 *   - Any accidental double-invocation would double-count points.
 *
 * An event has at most ~30 matches, so recomputing costs nothing. Teams with no
 * completed matches are reset to zero, which also keeps regeneration clean.
 *
 * Knockout results are excluded — they don't belong in a group table.
 */
export async function recomputeStandings(eventId: string): Promise<void> {
  const db = getDb()

  const teams = await db
    .selectFrom('event_teams')
    .select('team_id')
    .where('event_id', '=', eventId)
    .execute()
  if (teams.length === 0) return

  const matches = await db
    .selectFrom('matches')
    .select(['home_team_id', 'away_team_id', 'home_score', 'away_score'])
    .where('event_id', '=', eventId)
    .where('status', '=', 'completed')
    .where('round', 'like', 'group_%')
    .execute()

  type Tally = {
    played: number
    won: number
    drawn: number
    lost: number
    goals_for: number
    goals_against: number
    points: number
  }
  const blank = (): Tally => ({
    played: 0,
    won: 0,
    drawn: 0,
    lost: 0,
    goals_for: 0,
    goals_against: 0,
    points: 0,
  })

  const tally = new Map<string, Tally>(teams.map((t) => [t.team_id, blank()]))

  const record = (teamId: string, gf: number, ga: number) => {
    const row = tally.get(teamId)
    if (!row) return // a team that has since been removed from the event
    row.played += 1
    row.goals_for += gf
    row.goals_against += ga
    if (gf > ga) {
      row.won += 1
      row.points += WIN_POINTS
    } else if (gf === ga) {
      row.drawn += 1
      row.points += DRAW_POINTS
    } else {
      row.lost += 1
    }
  }

  for (const m of matches) {
    const homeGoals = goalsOf(m.home_score)
    const awayGoals = goalsOf(m.away_score)
    record(m.home_team_id, homeGoals, awayGoals)
    record(m.away_team_id, awayGoals, homeGoals)
  }

  // One transaction so the table is never observed half-updated.
  await db.transaction().execute(async (trx) => {
    for (const [teamId, row] of tally) {
      await trx
        .updateTable('event_teams')
        .set(row)
        .where('event_id', '=', eventId)
        .where('team_id', '=', teamId)
        .execute()
    }
  })
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
