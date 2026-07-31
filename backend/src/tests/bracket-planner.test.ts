/**
 * Unit tests for the bracket planner — a pure function, no database.
 *
 * The planner is the algorithmic heart of Phase 3, so it is tested far more
 * thoroughly than anything touching Postgres could be. The headline requirement
 * (decided 2026-07-31): NO team count is ever rejected.
 */

import { describe, it, expect } from 'vitest'
import { planBracket, type BracketPlan } from '../modules/events/bracket/planner'

const ids = (n: number) => Array.from({ length: n }, (_, i) => `t${i + 1}`)

/** Every fixture a knockout round feeds into must exist in the plan. */
function assertReferentialIntegrity(plan: BracketPlan) {
  const keys = new Set(plan.fixtures.map((f) => f.key))
  for (const f of plan.fixtures) {
    for (const side of [f.home, f.away]) {
      if (side.type === 'winner_of') {
        expect(keys.has(side.ref)).toBe(true)
      }
    }
  }
}

/** Exactly one fixture must be the final. */
function assertSingleFinal(plan: BracketPlan) {
  expect(plan.fixtures.filter((f) => f.round === 'final')).toHaveLength(1)
}

describe('planBracket — knockout for any N', () => {
  it('rejects fewer than two teams', () => {
    expect(() => planBracket(ids(1), 'knockout')).toThrow(/at least 2/i)
    expect(() => planBracket([], 'knockout')).toThrow(/at least 2/i)
  })

  it('two teams is just a final', () => {
    const plan = planBracket(ids(2), 'knockout')
    expect(plan.fixtures).toHaveLength(1)
    expect(plan.fixtures[0].round).toBe('final')
    expect(plan.fixtures[0].home).toEqual({ type: 'team', team_id: 't1' })
    expect(plan.fixtures[0].away).toEqual({ type: 'team', team_id: 't2' })
  })

  it('five teams: one play-in, three byes, then semis and a final', () => {
    const plan = planBracket(ids(5), 'knockout')
    const rounds = plan.fixtures.map((f) => f.round)
    expect(rounds.filter((r) => r === 'play_in')).toHaveLength(1)
    expect(rounds.filter((r) => r === 'semi')).toHaveLength(2)
    expect(rounds.filter((r) => r === 'final')).toHaveLength(1)
    expect(plan.fixtures).toHaveLength(4)
    assertReferentialIntegrity(plan)
    assertSingleFinal(plan)
  })

  it('nine teams: one play-in then quarters, semis, final', () => {
    const plan = planBracket(ids(9), 'knockout')
    const count = (r: string) => plan.fixtures.filter((f) => f.round === r).length
    expect(count('play_in')).toBe(1)
    expect(count('quarter')).toBe(4)
    expect(count('semi')).toBe(2)
    expect(count('final')).toBe(1)
    expect(plan.fixtures).toHaveLength(8)
    assertReferentialIntegrity(plan)
  })

  it('byes go to the strongest seeds', () => {
    // 5 teams → 3 byes. t1..t3 must not appear in the play-in.
    const plan = planBracket(ids(5), 'knockout')
    const playIn = plan.fixtures.find((f) => f.round === 'play_in')!
    const inPlayIn = [playIn.home, playIn.away]
      .filter((s): s is { type: 'team'; team_id: string } => s.type === 'team')
      .map((s) => s.team_id)
    expect(inPlayIn).not.toContain('t1')
    expect(inPlayIn).not.toContain('t2')
    expect(inPlayIn).not.toContain('t3')
  })

  it('every team appears exactly once as a team source', () => {
    for (const n of [2, 3, 5, 6, 7, 8, 9, 11, 13, 16, 17]) {
      const plan = planBracket(ids(n), 'knockout')
      const seen = plan.fixtures
        .flatMap((f) => [f.home, f.away])
        .filter((s) => s.type === 'team')
        .map((s) => (s as { team_id: string }).team_id)
      expect(new Set(seen).size).toBe(n)
      expect(seen).toHaveLength(n)
    }
  })

  it('produces a valid, connected bracket for every count from 2 to 24', () => {
    for (let n = 2; n <= 24; n++) {
      const plan = planBracket(ids(n), 'knockout')
      assertReferentialIntegrity(plan)
      assertSingleFinal(plan)
      // A single-elimination bracket always plays exactly N-1 matches.
      expect(plan.fixtures, `n=${n}`).toHaveLength(n - 1)
    }
  })

  it('powers of two have no play-in round', () => {
    for (const n of [2, 4, 8, 16]) {
      const plan = planBracket(ids(n), 'knockout')
      expect(plan.fixtures.some((f) => f.round === 'play_in')).toBe(false)
    }
  })
})

describe('planBracket — group_knockout', () => {
  it('eight teams: two groups of four, top two to semis', () => {
    const plan = planBracket(ids(8), 'group_knockout')
    expect(plan.fell_back).toBe(false)
    expect(plan.groups).toHaveLength(2)
    expect(plan.groups.every((g) => g.team_ids.length === 4)).toBe(true)
    expect(plan.qualifiers).toBe(4)

    const groupFixtures = plan.fixtures.filter((f) => f.round.startsWith('group_'))
    expect(groupFixtures).toHaveLength(12) // 6 per group of 4
    expect(plan.fixtures.filter((f) => f.round === 'semi')).toHaveLength(2)
    expect(plan.fixtures.filter((f) => f.round === 'final')).toHaveLength(1)
    expect(plan.fixtures).toHaveLength(15) // no third-place match
    assertSingleFinal(plan)
  })

  it('nine teams: three groups of three', () => {
    const plan = planBracket(ids(9), 'group_knockout')
    expect(plan.fell_back).toBe(false)
    expect(plan.groups).toHaveLength(3)
    expect(plan.groups.every((g) => g.team_ids.length === 3)).toBe(true)
    // 2G = 6, largest power of two ≤ 6 is 4 → 3 winners + best runner-up.
    expect(plan.qualifiers).toBe(4)
    expect(plan.fixtures.filter((f) => f.round.startsWith('group_'))).toHaveLength(9)
    expect(plan.fixtures).toHaveLength(12)
  })

  it('sixteen teams: four groups of four, top two to quarters', () => {
    const plan = planBracket(ids(16), 'group_knockout')
    expect(plan.groups).toHaveLength(4)
    expect(plan.qualifiers).toBe(8)
    expect(plan.fixtures.filter((f) => f.round.startsWith('group_'))).toHaveLength(24)
    expect(plan.fixtures.filter((f) => f.round === 'quarter')).toHaveLength(4)
    expect(plan.fixtures).toHaveLength(31)
  })

  it('falls back to knockout for a prime count, and says why', () => {
    const plan = planBracket(ids(5), 'group_knockout')
    expect(plan.fell_back).toBe(true)
    expect(plan.fallback_reason).toMatch(/equal groups/i)
    expect(plan.format).toBe('knockout')
    expect(plan.groups).toHaveLength(0)
    expect(plan.fixtures).toHaveLength(4)
  })

  it('falls back when groups would be smaller than three', () => {
    expect(planBracket(ids(2), 'group_knockout').fell_back).toBe(true)
  })

  it('seeds are snake-distributed so strong teams spread across groups', () => {
    const plan = planBracket(ids(8), 'group_knockout')
    const a = plan.groups[0].team_ids
    const b = plan.groups[1].team_ids
    // Snake for 2 groups: A gets 1,4,5,8 and B gets 2,3,6,7.
    expect(a).toContain('t1')
    expect(b).toContain('t2')
    expect(a).not.toContain('t2')
  })

  it('group fixtures are a full round-robin with no repeats', () => {
    const plan = planBracket(ids(8), 'group_knockout')
    for (const g of plan.groups) {
      const pairs = plan.fixtures
        .filter((f) => f.round === `group_${g.group}`)
        .map((f) => {
          const h = (f.home as { team_id: string }).team_id
          const a = (f.away as { team_id: string }).team_id
          return [h, a].sort().join('|')
        })
      expect(new Set(pairs).size).toBe(pairs.length)
      const n = g.team_ids.length
      expect(pairs).toHaveLength((n * (n - 1)) / 2)
    }
  })

  it('first knockout round consumes each qualifier seed exactly once', () => {
    for (const n of [8, 9, 12, 16]) {
      const plan = planBracket(ids(n), 'group_knockout')
      if (plan.fell_back) continue
      const seeds = plan.fixtures
        .flatMap((f) => [f.home, f.away])
        .filter((s) => s.type === 'qualifier')
        .map((s) => (s as { seed: number }).seed)
      expect(seeds.sort((x, y) => x - y)).toEqual(
        Array.from({ length: plan.qualifiers }, (_, i) => i + 1)
      )
    }
  })

  it('every equal-group count from 4 to 24 produces a connected bracket', () => {
    for (let n = 4; n <= 24; n++) {
      const plan = planBracket(ids(n), 'group_knockout')
      assertReferentialIntegrity(plan)
      assertSingleFinal(plan)
    }
  })
})
