/**
 * Pure bracket planner. No database, no framework — just shape.
 *
 * Turns a seed-ordered team list plus a format into the complete set of fixtures
 * a tournament needs, including how each side of each fixture gets filled in.
 * Kept DB-free so it can be tested exhaustively across every team count.
 */

export type PlannedSource =
  | { type: 'team'; team_id: string }
  | { type: 'winner_of'; ref: string }
  | { type: 'qualifier'; seed: number }

export interface PlannedFixture {
  key: string
  round: string
  slot_no: number
  home: PlannedSource
  away: PlannedSource
}

export interface BracketPlan {
  format: 'knockout' | 'group_knockout'
  fell_back: boolean
  fallback_reason: string | null
  groups: Array<{ group: string; team_ids: string[] }>
  qualifiers: number
  fixtures: PlannedFixture[]
}

/** Smallest group we'll accept — a "group" of two is just a match. */
const MIN_GROUP_SIZE = 3

/** Largest power of two ≤ n. */
function floorPow2(n: number): number {
  let p = 1
  while (p * 2 <= n) p *= 2
  return p
}

/** Round label for a knockout round with `size` teams remaining. */
function roundName(size: number): string {
  if (size === 2) return 'final'
  if (size === 4) return 'semi'
  if (size === 8) return 'quarter'
  return `round_of_${size}`
}

/**
 * Standard bracket positions for a power-of-two field, as 0-based indices into a
 * list held in seed order.
 *
 *   bracketOrder(4) → [0, 3, 1, 2]   (1v4, 2v3)
 *   bracketOrder(8) → [0, 7, 3, 4, 1, 6, 2, 5]   (1v8, 4v5, 2v7, 3v6)
 *
 * Built by the usual reflection: each round, every seed s at position i gains a
 * partner (2n − 1 − s) beside it. The property that matters is that the two best
 * seeds land in opposite halves and so can only meet in the final.
 */
function bracketOrder(size: number): number[] {
  let order = [0]
  while (order.length < size) {
    const n = order.length * 2
    const next: number[] = []
    for (const s of order) {
      next.push(s)
      next.push(n - 1 - s)
    }
    order = next
  }
  return order
}

/**
 * Build the elimination rounds above a set of entry slots.
 *
 * `entries` arrive in SEED order — strongest first — and are placed into standard
 * bracket positions here. Length must be a power of two. Returns fixtures for
 * every round up to the final.
 *
 * Placing them was previously the caller's job and nobody did it: entries were
 * paired adjacently, so an 8-team knockout drew seed 1 against seed 2 in the
 * first round, and a 6-team draw put both bye teams — the top two seeds — against
 * each other in the semi-final. Byes were being handed out as a reward and then
 * immediately cancelled out one round later.
 */
function buildEliminationRounds(entries: PlannedSource[]): PlannedFixture[] {
  const fixtures: PlannedFixture[] = []
  let current = bracketOrder(entries.length).map((i) => entries[i])

  while (current.length > 1) {
    const round = roundName(current.length)
    const next: PlannedSource[] = []

    for (let i = 0; i < current.length; i += 2) {
      const slot = i / 2 + 1
      const key = `${round}:${slot}`
      fixtures.push({
        key,
        round,
        slot_no: slot,
        home: current[i],
        away: current[i + 1],
      })
      next.push({ type: 'winner_of', ref: key })
    }

    current = next
  }

  return fixtures
}

/**
 * Single-elimination for ANY team count.
 *
 * P = largest power of two ≤ N. `N − P` play-in matches are contested by the
 * weakest `2(N − P)` seeds; everyone else receives a bye straight into the round
 * of P. Byes therefore reward the strongest seeds, as in a real cup draw.
 */
function planKnockout(teamIds: string[]): PlannedFixture[] {
  const n = teamIds.length
  const p = floorPow2(n)
  const playInCount = n - p
  const byeCount = n - 2 * playInCount

  const byes = teamIds.slice(0, byeCount)
  const contested = teamIds.slice(byeCount)

  const fixtures: PlannedFixture[] = []
  const entries: PlannedSource[] = byes.map((id) => ({ type: 'team', team_id: id }))

  // Pair strongest remaining against weakest remaining.
  for (let i = 0; i < playInCount; i++) {
    const slot = i + 1
    const key = `play_in:${slot}`
    fixtures.push({
      key,
      round: 'play_in',
      slot_no: slot,
      home: { type: 'team', team_id: contested[i] },
      away: { type: 'team', team_id: contested[contested.length - 1 - i] },
    })
    entries.push({ type: 'winner_of', ref: key })
  }

  return [...fixtures, ...buildEliminationRounds(entries)]
}

/** Round-robin fixtures for one group. */
function planGroup(group: string, teamIds: string[]): PlannedFixture[] {
  const fixtures: PlannedFixture[] = []
  let slot = 1
  for (let i = 0; i < teamIds.length; i++) {
    for (let j = i + 1; j < teamIds.length; j++) {
      fixtures.push({
        key: `group_${group}:${slot}`,
        round: `group_${group}`,
        slot_no: slot,
        home: { type: 'team', team_id: teamIds[i] },
        away: { type: 'team', team_id: teamIds[j] },
      })
      slot++
    }
  }
  return fixtures
}

/**
 * Snake distribution: 1→A, 2→B, 3→B, 4→A, 5→A, … so seeds spread across groups
 * instead of stacking the strong teams together.
 */
function snakeGroups(teamIds: string[], groupCount: number): string[][] {
  const groups: string[][] = Array.from({ length: groupCount }, () => [])
  let idx = 0
  let forward = true
  for (const id of teamIds) {
    groups[idx].push(id)
    if (forward) {
      if (idx === groupCount - 1) forward = false
      else idx++
    } else {
      if (idx === 0) forward = true
      else idx--
    }
  }
  return groups
}

const GROUP_LETTERS = 'abcdefghijklmnopqrstuvwxyz'

export function planBracket(
  teamIds: string[],
  format: 'knockout' | 'group_knockout'
): BracketPlan {
  if (teamIds.length < 2) {
    throw new Error('A tournament needs at least 2 teams')
  }

  if (format === 'knockout') {
    return {
      format: 'knockout',
      fell_back: false,
      fallback_reason: null,
      groups: [],
      qualifiers: 0,
      fixtures: planKnockout(teamIds),
    }
  }

  // ── group_knockout ────────────────────────────────────────────────────────
  const n = teamIds.length
  const groupCount = Math.ceil(n / 4)
  const groupSize = n / groupCount

  // Equal groups are required so that comparing runners-up across groups is
  // fair — see spec §3.3. When that is impossible we do NOT fail; we build a
  // knockout and explain, so no team count is ever turned away.
  const equal = Number.isInteger(groupSize)
  if (!equal || groupSize < MIN_GROUP_SIZE) {
    const reason = !equal
      ? `${n} teams cannot be split into equal groups, so a knockout was generated instead`
      : `${n} teams would make groups of ${groupSize}, below the minimum of ${MIN_GROUP_SIZE}, so a knockout was generated instead`
    return {
      format: 'knockout',
      fell_back: true,
      fallback_reason: reason,
      groups: [],
      qualifiers: 0,
      fixtures: planKnockout(teamIds),
    }
  }

  const distributed = snakeGroups(teamIds, groupCount)
  const groups = distributed.map((team_ids, i) => ({
    group: GROUP_LETTERS[i],
    team_ids,
  }))

  const groupFixtures = groups.flatMap((g) => planGroup(g.group, g.team_ids))

  // Qualifiers: the largest power of two that both groups can supply and the
  // field can fill. Minimum 2 so there is always a final.
  const qualifiers = Math.max(2, floorPow2(Math.min(groupCount * 2, n)))

  // Qualifiers in seed order; buildEliminationRounds places them into standard
  // bracket positions (1 v Q, 2 v Q−1, … with the top seeds in opposite halves).
  // This used to emit the first-round pairs directly, which was right for four
  // qualifiers but put seeds 1 and 2 in the same half once there were eight.
  // Deterministic and explainable; it can pair two teams from one group, which we
  // accept for a single-day event.
  const entries: PlannedSource[] = []
  for (let seed = 1; seed <= qualifiers; seed++) {
    entries.push({ type: 'qualifier', seed })
  }

  return {
    format: 'group_knockout',
    fell_back: false,
    fallback_reason: null,
    groups,
    qualifiers,
    fixtures: [...groupFixtures, ...buildEliminationRounds(entries)],
  }
}
