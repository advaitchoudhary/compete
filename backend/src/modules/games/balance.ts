/**
 * Splitting a pool of players into two even sides.
 *
 * This is the thing a WhatsApp poll cannot do, and the reason a player has any
 * reason to care what their rating is. It is pure and database-free so the rule can
 * be tested exhaustively, in the same spirit as bracket/planner.ts.
 *
 * Two passes:
 *
 *   1. A snake draft on rating — 1st and 4th pick to one side, 2nd and 3rd to the
 *      other. The standard way to halve a ranked list, and on a realistic spread it
 *      lands very close on its own.
 *   2. A pairwise-swap improvement. Snake is a heuristic and can leave a few points
 *      on the table; trying every cross-side swap and keeping the ones that narrow
 *      the gap costs nothing at these sizes (at most 22 players) and makes
 *      "balanced by rating" true rather than roughly true.
 *
 * Deterministic throughout: the same input always produces the same sides, so a
 * re-draw cannot quietly reshuffle a game that people have already seen.
 */

export interface Poolable {
  user_id: string
  rating: number
}

export interface Sides {
  a: string[]
  b: string[]
  /** Mean rating of each side, for showing the organizer what they got. */
  averageA: number
  averageB: number
}

const sum = (xs: Poolable[]) => xs.reduce((t, p) => t + p.rating, 0)
const mean = (xs: Poolable[]) => (xs.length === 0 ? 0 : sum(xs) / xs.length)
const round1 = (n: number) => Math.round(n * 10) / 10

export function balanceSides(players: Poolable[]): Sides {
  if (players.length % 2 !== 0) {
    throw new Error(`Cannot split ${players.length} players into two equal sides`)
  }
  if (players.length === 0) return { a: [], b: [], averageA: 0, averageB: 0 }

  // Strongest first. user_id breaks ties so equal ratings never depend on the
  // order rows happened to come back from Postgres.
  const ranked = [...players].sort(
    (x, y) => y.rating - x.rating || x.user_id.localeCompare(y.user_id)
  )

  // ── Pass 1: snake ────────────────────────────────────────────────────────
  const a: Poolable[] = []
  const b: Poolable[] = []
  ranked.forEach((p, i) => {
    // 0→a, 1→b, 2→b, 3→a, 4→a, 5→b, 6→b, 7→a …
    const toA = i % 4 === 0 || i % 4 === 3
    ;(toA ? a : b).push(p)
  })

  // ── Pass 2: swap anything that helps ─────────────────────────────────────
  // Sides stay the same size because we only ever exchange one for one.
  let gap = Math.abs(sum(a) - sum(b))
  let improved = true
  while (improved && gap > 0) {
    improved = false
    for (let i = 0; i < a.length && !improved; i++) {
      for (let j = 0; j < b.length && !improved; j++) {
        const delta = a[i].rating - b[j].rating
        // Swapping moves the difference by twice the players' rating difference.
        const next = Math.abs(sum(a) - sum(b) - 2 * delta)
        if (next < gap) {
          const tmp = a[i]
          a[i] = b[j]
          b[j] = tmp
          gap = next
          improved = true
        }
      }
    }
  }

  return {
    a: a.map((p) => p.user_id),
    b: b.map((p) => p.user_id),
    averageA: round1(mean(a)),
    averageB: round1(mean(b)),
  }
}
