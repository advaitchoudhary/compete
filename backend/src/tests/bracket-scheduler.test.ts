/**
 * Unit tests for the fixture scheduler — pure, no database.
 *
 * Guards the two rules a turf tournament day depends on: nobody plays twice in a
 * row, and knockout rounds happen after the rounds that feed them.
 */

import { describe, it, expect } from 'vitest'
import { planBracket } from '../modules/events/bracket/planner'
import { scheduleFixtures, type ScheduledFixture } from '../modules/events/bracket/scheduler'

const ids = (n: number) => Array.from({ length: n }, (_, i) => `t${i + 1}`)
const START = new Date('2026-08-02T09:00:00.000Z')

function teamsOf(f: ScheduledFixture): string[] {
  return [f.home, f.away]
    .filter((s) => s.type === 'team')
    .map((s) => (s as { team_id: string }).team_id)
}

/** No team plays twice in one slot, or in two consecutive slots. */
function assertRestRule(scheduled: ScheduledFixture[]) {
  const bySlot = new Map<number, string[]>()
  for (const f of scheduled) {
    const list = bySlot.get(f.slot_index) ?? []
    list.push(...teamsOf(f))
    bySlot.set(f.slot_index, list)
  }
  for (const [slot, teams] of bySlot) {
    expect(new Set(teams).size).toBe(teams.length) // not twice in one slot
    const prev = bySlot.get(slot - 1) ?? []
    for (const t of teams) {
      expect(prev).not.toContain(t) // not in consecutive slots
    }
  }
}

describe('scheduleFixtures', () => {
  it('assigns every fixture a slot, a pitch and a time', () => {
    const plan = planBracket(ids(8), 'group_knockout')
    const scheduled = scheduleFixtures({
      fixtures: plan.fixtures,
      pitches: ['Pitch 1', 'Pitch 2'],
      startsAt: START,
      slotMinutes: 15,
    })
    expect(scheduled).toHaveLength(plan.fixtures.length)
    for (const f of scheduled) {
      expect(['Pitch 1', 'Pitch 2']).toContain(f.pitch_label)
      expect(f.slot_index).toBeGreaterThanOrEqual(0)
      expect(f.scheduled_at.getTime()).toBe(START.getTime() + f.slot_index * 15 * 60_000)
    }
  })

  it('honours the rest rule for group stages', () => {
    for (const n of [8, 9, 12, 16]) {
      const plan = planBracket(ids(n), 'group_knockout')
      const scheduled = scheduleFixtures({
        fixtures: plan.fixtures,
        pitches: ['Pitch 1', 'Pitch 2'],
        startsAt: START,
        slotMinutes: 12,
      })
      assertRestRule(scheduled)
    }
  })

  it('never places more fixtures in a slot than there are pitches', () => {
    const plan = planBracket(ids(16), 'group_knockout')
    const scheduled = scheduleFixtures({
      fixtures: plan.fixtures,
      pitches: ['A', 'B', 'C'],
      startsAt: START,
      slotMinutes: 10,
    })
    const perSlot = new Map<number, number>()
    for (const f of scheduled) {
      perSlot.set(f.slot_index, (perSlot.get(f.slot_index) ?? 0) + 1)
    }
    for (const count of perSlot.values()) expect(count).toBeLessThanOrEqual(3)
  })

  it('a pitch never hosts two fixtures in the same slot', () => {
    const plan = planBracket(ids(12), 'group_knockout')
    const scheduled = scheduleFixtures({
      fixtures: plan.fixtures,
      pitches: ['Pitch 1', 'Pitch 2'],
      startsAt: START,
      slotMinutes: 15,
    })
    const seen = new Set<string>()
    for (const f of scheduled) {
      const cell = `${f.slot_index}@${f.pitch_label}`
      expect(seen.has(cell)).toBe(false)
      seen.add(cell)
    }
  })

  it('schedules knockout rounds strictly after the rounds feeding them', () => {
    const plan = planBracket(ids(8), 'group_knockout')
    const scheduled = scheduleFixtures({
      fixtures: plan.fixtures,
      pitches: ['Pitch 1', 'Pitch 2'],
      startsAt: START,
      slotMinutes: 15,
    })
    const byKey = new Map(scheduled.map((f) => [f.key, f]))
    for (const f of scheduled) {
      for (const side of [f.home, f.away]) {
        if (side.type === 'winner_of') {
          expect(f.slot_index).toBeGreaterThan(byKey.get(side.ref)!.slot_index)
        }
      }
    }
    // All group matches finish before the first knockout fixture starts.
    const lastGroup = Math.max(
      ...scheduled.filter((f) => f.round.startsWith('group_')).map((f) => f.slot_index)
    )
    const firstKo = Math.min(
      ...scheduled.filter((f) => !f.round.startsWith('group_')).map((f) => f.slot_index)
    )
    expect(firstKo).toBeGreaterThan(lastGroup)
  })

  it('works with a single pitch', () => {
    const plan = planBracket(ids(8), 'group_knockout')
    const scheduled = scheduleFixtures({
      fixtures: plan.fixtures,
      pitches: ['Only Pitch'],
      startsAt: START,
      slotMinutes: 20,
    })
    expect(scheduled).toHaveLength(15)
    assertRestRule(scheduled)
    // One pitch means one fixture per slot, so slots are all distinct.
    expect(new Set(scheduled.map((f) => f.slot_index)).size).toBe(15)
  })

  it('refuses to schedule with no pitches', () => {
    const plan = planBracket(ids(8), 'knockout')
    expect(() =>
      scheduleFixtures({
        fixtures: plan.fixtures,
        pitches: [],
        startsAt: START,
        slotMinutes: 15,
      })
    ).toThrow(/at least one pitch/i)
  })

  it('pure knockout schedules round by round', () => {
    const plan = planBracket(ids(9), 'knockout')
    const scheduled = scheduleFixtures({
      fixtures: plan.fixtures,
      pitches: ['Pitch 1', 'Pitch 2'],
      startsAt: START,
      slotMinutes: 15,
    })
    assertRestRule(scheduled)
    const byKey = new Map(scheduled.map((f) => [f.key, f]))
    for (const f of scheduled) {
      for (const side of [f.home, f.away]) {
        if (side.type === 'winner_of') {
          expect(f.slot_index).toBeGreaterThan(byKey.get(side.ref)!.slot_index)
        }
      }
    }
  })
})
