import type { PlannedFixture } from './planner'

export interface ScheduledFixture extends PlannedFixture {
  slot_index: number
  pitch_label: string
  scheduled_at: Date
}

export interface ScheduleInput {
  fixtures: PlannedFixture[]
  pitches: string[]
  startsAt: Date
  slotMinutes: number
}

/**
 * Safety valve. If the greedy pass can't place everything within this many slots
 * per fixture, the constraints are unsatisfiable and we fail loudly rather than
 * emitting a schedule that breaks the rest rule.
 */
const MAX_SLOT_FACTOR = 6

/**
 * Assign every fixture a time slot and a pitch.
 *
 * Two rules:
 *   1. Rest — a team never plays twice in one slot, nor in consecutive slots.
 *   2. Dependency — a fixture fed by `winner_of` starts strictly after its feeder.
 *
 * Fixtures are processed in dependency order (group stage first, then each
 * elimination round), and within a stage placed greedily into the earliest slot
 * where every team is rested and a pitch is free.
 */
export function scheduleFixtures(input: ScheduleInput): ScheduledFixture[] {
  const { fixtures, pitches, startsAt, slotMinutes } = input

  if (pitches.length === 0) {
    throw new Error(
      'Scheduling needs at least one pitch — assign referees with pitch labels first'
    )
  }
  if (fixtures.length === 0) return []

  // ── Dependency stages ─────────────────────────────────────────────────────
  // Stage 0 = fixtures with no winner_of dependency (group stage and play-ins).
  // Each later stage depends only on earlier ones, so a longest-path depth over
  // the winner_of edges gives a valid ordering.
  const byKey = new Map(fixtures.map((f) => [f.key, f]))
  const depthCache = new Map<string, number>()

  const depthOf = (key: string): number => {
    const cached = depthCache.get(key)
    if (cached !== undefined) return cached
    const f = byKey.get(key)
    if (!f) throw new Error(`Fixture ${key} references a fixture that does not exist`)
    let d = 0
    for (const side of [f.home, f.away]) {
      if (side.type === 'winner_of') d = Math.max(d, depthOf(side.ref) + 1)
      // A qualifier depends on the ENTIRE group stage, not on one fixture, so it
      // carries no winner_of edge. Without this it would land at depth 0 and be
      // schedulable alongside the group matches that decide it — which is exactly
      // what happened live: semis appeared before the last group game.
      if (side.type === 'qualifier') d = Math.max(d, 1)
    }
    depthCache.set(key, d)
    return d
  }

  const stages = new Map<number, PlannedFixture[]>()
  for (const f of fixtures) {
    const d = depthOf(f.key)
    const list = stages.get(d) ?? []
    list.push(f)
    stages.set(d, list)
  }

  // ── Greedy placement, stage by stage ──────────────────────────────────────
  const teamsIn = (f: PlannedFixture): string[] =>
    [f.home, f.away]
      .filter((s) => s.type === 'team')
      .map((s) => (s as { team_id: string }).team_id)

  const slotTeams = new Map<number, Set<string>>()
  const slotPitches = new Map<number, Set<string>>()
  const placed: ScheduledFixture[] = []
  const maxSlots = fixtures.length * MAX_SLOT_FACTOR

  // The earliest slot a stage may use: strictly after everything before it.
  let stageFloor = 0

  for (const depth of [...stages.keys()].sort((a, b) => a - b)) {
    const stageFixtures = stages.get(depth)!
    let stageMax = stageFloor - 1

    for (const f of stageFixtures) {
      const teams = teamsIn(f)
      let slot = stageFloor

      for (; slot < maxSlots; slot++) {
        const usedPitches = slotPitches.get(slot) ?? new Set()
        if (usedPitches.size >= pitches.length) continue

        // The rest constraint is SYMMETRIC: checking only the previous slot is
        // not enough, because a fixture placed now can land immediately BEFORE
        // one already placed. Look both ways.
        const here = slotTeams.get(slot) ?? new Set()
        const before = slotTeams.get(slot - 1) ?? new Set()
        const after = slotTeams.get(slot + 1) ?? new Set()

        const clash = teams.some((t) => here.has(t) || before.has(t) || after.has(t))
        if (clash) continue
        break
      }

      if (slot >= maxSlots) {
        throw new Error(
          `Cannot schedule fixture ${f.key} without breaking the rest rule — try more pitches or fewer teams`
        )
      }

      const usedPitches = slotPitches.get(slot) ?? new Set<string>()
      const pitch = pitches.find((p) => !usedPitches.has(p))!
      usedPitches.add(pitch)
      slotPitches.set(slot, usedPitches)

      const here = slotTeams.get(slot) ?? new Set<string>()
      for (const t of teams) here.add(t)
      slotTeams.set(slot, here)

      placed.push({
        ...f,
        slot_index: slot,
        pitch_label: pitch,
        scheduled_at: new Date(startsAt.getTime() + slot * slotMinutes * 60_000),
      })

      if (slot > stageMax) stageMax = slot
    }

    // Next stage cannot start until this one has finished.
    stageFloor = stageMax + 1
  }

  return placed.sort(
    (a, b) => a.slot_index - b.slot_index || a.pitch_label.localeCompare(b.pitch_label)
  )
}
