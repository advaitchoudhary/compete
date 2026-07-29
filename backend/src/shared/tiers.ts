/**
 * Match tiers — the skill/competition ladder.
 *
 * A match is graded into a tier; a referee may only officiate at or below their
 * own tier. Higher tiers carry more weight in the blended overall "Elo number".
 */
export const MATCH_TIERS = ['amateur', 'semi_pro', 'pro', 'legends'] as const
export type MatchTier = (typeof MATCH_TIERS)[number]

// Ordering for "can officiate at/below" comparisons
export const TIER_RANK: Record<MatchTier, number> = {
  amateur: 1,
  semi_pro: 2,
  pro: 3,
  legends: 4,
}

// Weight each tier contributes to the blended overall Elo
export const TIER_WEIGHT: Record<MatchTier, number> = {
  amateur: 1.0,
  semi_pro: 1.5,
  pro: 2.0,
  legends: 3.0,
}

export function isMatchTier(value: unknown): value is MatchTier {
  return typeof value === 'string' && (MATCH_TIERS as readonly string[]).includes(value)
}

/** A referee can officiate a match at or below their own tier. Admins bypass. */
export function canOfficiate(refereeTier: MatchTier | null, matchTier: MatchTier): boolean {
  if (!refereeTier) return false
  return TIER_RANK[refereeTier] >= TIER_RANK[matchTier]
}
