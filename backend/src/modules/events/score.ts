/**
 * `matches.home_score` / `away_score` are jsonb — `{ "goals": 2 }` — so that a
 * future sport can record something other than a single number.
 *
 * Every client wants a number. Handing them the raw jsonb under a field named
 * `home_score` invites exactly the bug it caused on the tournament screen, where
 * `${match.home_score}` rendered "[object Object]". Endpoints should read the
 * goals out with this and publish plain numbers.
 */
export function goalsOf(score: unknown): number | null {
  if (!score || typeof score !== 'object') return null
  const v = (score as Record<string, unknown>).goals
  if (v === undefined || v === null) return null
  return Number(v) || 0
}
