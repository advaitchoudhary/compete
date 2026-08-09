/**
 * Human labels for the round keys the planner writes.
 *
 * `event_fixtures.round` stores machine keys — `play_in`, `group_a`, `semi`,
 * `round_of_16`. Those are the right thing in the database and the wrong thing on
 * a screen: an organizer reading "Winner of play_in 1" is reading our schema.
 *
 * Lives here, next to the planner that produces the keys, so both the organizer
 * control room and the public spectator page format them the same way.
 */

/** `play_in` → "Play-in", `group_a` → "Group A", `round_of_16` → "Round of 16". */
export function roundLabel(round: string): string {
  if (round === 'final') return 'Final'
  if (round === 'semi') return 'Semi-final'
  if (round === 'quarter') return 'Quarter-final'
  if (round === 'play_in') return 'Play-in'

  const group = /^group_([a-z]+)$/.exec(round)
  if (group) return `Group ${group[1].toUpperCase()}`

  const roundOf = /^round_of_(\d+)$/.exec(round)
  if (roundOf) return `Round of ${roundOf[1]}`

  // Unknown key — better to show it tidied than to show it raw.
  return round.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
}

/**
 * How one fixture is referred to from another: "Semi-final 2", "Play-in 1".
 *
 * The slot number is dropped for a final, since there is only ever one and
 * "Final 1" reads like a typo.
 */
export function fixtureLabel(round: string, slotNo: number): string {
  const base = roundLabel(round)
  if (round === 'final') return base
  return `${base} ${slotNo}`
}
