import { getDb } from '../../shared/db/client'
import { emitFeedEvent } from '../feed/feed.service'

// Achievement type definitions
const ACHIEVEMENT_MILESTONES = [
  { type: 'first_match', check: (matches: number) => matches === 1 },
  { type: 'matches_10', check: (matches: number) => matches === 10 },
  { type: 'matches_50', check: (matches: number) => matches === 50 },
  { type: 'matches_100', check: (matches: number) => matches === 100 },
  { type: 'matches_200', check: (matches: number) => matches === 200 },
  { type: 'first_win', check: (_m: number, wins: number) => wins === 1 },
  { type: 'wins_10', check: (_m: number, wins: number) => wins === 10 },
] as const

const RATING_MILESTONES = [60, 70, 75, 80, 85, 90, 95]

export async function checkAchievements(
  userId: string,
  sportId: string,
  matchId: string
): Promise<void> {
  const db = getDb()

  // Fetch updated sport profile
  const profile = await db
    .selectFrom('sport_profiles')
    .select(['matches_played', 'wins', 'current_rating'])
    .where('user_id', '=', userId)
    .where('sport_id', '=', sportId)
    .executeTakeFirst()

  if (!profile) return

  const toAward: Array<{ type: string; data: Record<string, unknown> }> = []

  // Match count milestones
  for (const m of ACHIEVEMENT_MILESTONES) {
    if (m.check(profile.matches_played, profile.wins)) {
      toAward.push({ type: m.type, data: { matches: profile.matches_played, wins: profile.wins } })
    }
  }

  // Rating milestones
  for (const threshold of RATING_MILESTONES) {
    if (profile.current_rating >= threshold) {
      toAward.push({ type: `rating_${threshold}`, data: { rating: profile.current_rating } })
    }
  }

  for (const achievement of toAward) {
    try {
      await db
        .insertInto('achievements')
        .values({
          user_id: userId,
          sport_id: sportId,
          type: achievement.type,
          data: JSON.stringify(achievement.data) as unknown as Record<string, unknown>,
          match_id: matchId,
        })
        .onConflict((oc) => oc.doNothing())  // unique index prevents duplicates
        .execute()

      // Emit to feed
      await emitFeedEvent({
        actor_id: userId,
        action_type: 'achievement_earned',
        entity_type: 'achievement',
        entity_id: userId,
        payload: { type: achievement.type, sport_id: sportId, data: achievement.data },
      })
    } catch {
      // Achievement already exists — silently skip
    }
  }
}

export async function getUserAchievements(userId: string, sportSlug?: string) {
  const db = getDb()

  let q = db
    .selectFrom('achievements as a')
    .leftJoin('sports as s', 's.id', 'a.sport_id')
    .select([
      'a.id', 'a.type', 'a.data', 'a.match_id', 'a.created_at',
      's.name as sport_name', 's.slug as sport_slug',
    ])
    .where('a.user_id', '=', userId)
    .orderBy('a.created_at', 'desc')

  if (sportSlug) {
    q = q.where('s.slug', '=', sportSlug)
  }

  return q.execute()
}
