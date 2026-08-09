/**
 * Unit tests for side balancing — pure, no database.
 *
 * The promise on screen is "teams balanced by rating", so these check the promise
 * rather than the implementation: equal sizes, everyone used exactly once, a small
 * gap on realistic spreads, and the same input always giving the same sides.
 */

import { describe, it, expect } from 'vitest'
import { balanceSides, type Poolable } from '../modules/games/balance'

const pool = (ratings: number[]): Poolable[] =>
  ratings.map((rating, i) => ({ user_id: `p${String(i).padStart(2, '0')}`, rating }))

const gapOf = (s: { averageA: number; averageB: number }) =>
  Math.abs(s.averageA - s.averageB)

describe('balanceSides', () => {
  it('refuses an odd pool — there is no even split', () => {
    expect(() => balanceSides(pool([50, 50, 50]))).toThrow(/equal sides/i)
  })

  it('splits every realistic game size evenly and uses each player once', () => {
    // 3v3 through 11v11.
    for (const perSide of [3, 4, 5, 6, 7, 8, 9, 11]) {
      const n = perSide * 2
      const ratings = Array.from({ length: n }, (_, i) => 40 + ((i * 7) % 45))
      const sides = balanceSides(pool(ratings))

      expect(sides.a).toHaveLength(perSide)
      expect(sides.b).toHaveLength(perSide)
      const all = [...sides.a, ...sides.b]
      expect(new Set(all).size).toBe(n)
    }
  })

  it('lands the two averages close on a realistic spread', () => {
    const sides = balanceSides(
      pool([72, 68, 65, 63, 60, 58, 55, 52, 50, 50, 48, 45, 42, 40])
    )
    // A 14-player Tuesday game. Anything above a point would be visible as a
    // one-sided match.
    expect(gapOf(sides)).toBeLessThanOrEqual(1)
  })

  it('beats naive alternate-picking, which is what it exists to improve on', () => {
    const ratings = [95, 60, 58, 57, 56, 55, 54, 20]
    const sides = balanceSides(pool(ratings))

    // Straight alternation would put every other player on one side.
    const ranked = [...ratings].sort((x, y) => y - x)
    const altA = ranked.filter((_, i) => i % 2 === 0).reduce((t, r) => t + r, 0)
    const altB = ranked.filter((_, i) => i % 2 === 1).reduce((t, r) => t + r, 0)
    const alternateGap = Math.abs(altA - altB) / (ratings.length / 2)

    expect(gapOf(sides)).toBeLessThan(alternateGap)
  })

  it('keeps one dominant player from being cancelled out badly', () => {
    // Someone far above everyone else cannot be balanced away, but the rest of the
    // side should compensate as far as it can.
    const sides = balanceSides(pool([99, 50, 50, 50, 50, 50]))
    expect(gapOf(sides)).toBeLessThanOrEqual(99 / 3 - 50 / 3 + 0.1)
    expect(sides.a).toHaveLength(3)
    expect(sides.b).toHaveLength(3)
  })

  it('fixes pools a plain snake draft gets badly wrong', () => {
    // Snake alone puts this 6-a-side out by 17 rating points a side — a visibly
    // one-sided game. Found by sweeping random pools: the swap pass improves ~85%
    // of them, and this is close to its worst case.
    const sides = balanceSides(pool([65, 32, 89, 61, 65, 63]))
    expect(gapOf(sides)).toBeLessThanOrEqual(2)
  })

  it('is deterministic — a re-draw cannot reshuffle a game people have seen', () => {
    const p = pool([70, 65, 60, 55, 50, 45, 40, 35])
    const first = balanceSides(p)
    const again = balanceSides(p)
    expect(again).toEqual(first)

    // And independent of the order rows arrive in.
    const shuffled = [...p].reverse()
    const fromShuffled = balanceSides(shuffled)
    expect(new Set(fromShuffled.a)).toEqual(new Set(first.a))
  })

  it('handles a pool where everybody is unrated', () => {
    // Guests and brand-new players all arrive at the default 50.
    const sides = balanceSides(pool(Array(14).fill(50)))
    expect(sides.averageA).toBe(50)
    expect(sides.averageB).toBe(50)
    expect(sides.a).toHaveLength(7)
  })

  it('reports the averages it actually produced', () => {
    const sides = balanceSides(pool([80, 60, 40, 20]))
    const avg = (ids: string[]) =>
      ids.reduce((t, id) => t + [80, 60, 40, 20][Number(id.slice(1))], 0) / ids.length
    expect(sides.averageA).toBeCloseTo(avg(sides.a), 1)
    expect(sides.averageB).toBeCloseTo(avg(sides.b), 1)
  })
})
