import { getDb } from '../../shared/db/client'
import { TIER_RANK, type MatchTier } from '../../shared/tiers'

/**
 * The lowest tier among a set of nominated referees — the ceiling they can
 * collectively support.
 *
 * Admins are excluded because they bypass tier gating everywhere else. A null
 * referee_tier cannot officiate at all (canOfficiate returns false for null), so
 * it pins the ceiling to 'amateur'.
 */
export function floorTier(
  referees: Array<{ role: string; referee_tier: MatchTier | null }>
): MatchTier {
  const constraining = referees.filter((r) => r.role !== 'admin')

  // Either nobody is assigned, or only admins are. Neither justifies a raised
  // tier on its own — a graded tournament needs verified officials.
  if (constraining.length === 0) return 'amateur'

  let floor: MatchTier = 'legends'
  for (const ref of constraining) {
    const tier = ref.referee_tier ?? 'amateur'
    if (TIER_RANK[tier] < TIER_RANK[floor]) floor = tier
  }
  return floor
}

/**
 * The highest tier an event's CURRENT referee roster can support.
 *
 * Every match in a pro tournament must be officiated at pro level, so the
 * WEAKEST assigned referee constrains the whole event. See spec §3.1.1 — this is
 * the anti-fraud mechanism the rating ladder rests on.
 */
export async function maxTierForEvent(eventId: string): Promise<MatchTier> {
  const assigned = await getDb()
    .selectFrom('event_referees as er')
    .innerJoin('users as u', 'u.id', 'er.user_id')
    .select(['u.role', 'u.referee_tier'])
    .where('er.event_id', '=', eventId)
    .execute()

  return floorTier(assigned)
}

/**
 * Whether an event may hold the given tier, and why not if it may not.
 * Used by PATCH /events/:id/tier and by referee assignment.
 */
export async function assertTierSupported(
  eventId: string,
  tier: MatchTier
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const max = await maxTierForEvent(eventId)
  if (TIER_RANK[tier] <= TIER_RANK[max]) return { ok: true }
  return {
    ok: false,
    reason: `This event's referees only support '${max}' — a '${tier}' tournament needs every assigned referee at '${tier}' or above`,
  }
}

/**
 * True once any match exists for the event, after which the tier is frozen.
 *
 * Uses matches as the proxy for "fixtures generated", which is correct while
 * nothing else creates event matches. Once Phase 3 adds event_fixtures this
 * should check that table instead — it is the more direct signal.
 */
export async function eventHasFixtures(eventId: string): Promise<boolean> {
  const match = await getDb()
    .selectFrom('matches')
    .select('id')
    .where('event_id', '=', eventId)
    .executeTakeFirst()
  return Boolean(match)
}
