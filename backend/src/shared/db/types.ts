import type { ColumnType, Generated } from 'kysely'
import type { MatchTier } from '../tiers'

// Kysely table type definitions — mirrors the SQL schema exactly

/**
 * A jsonb column that we read as parsed JSON and also write as a plain object.
 *
 * Kysely's own `JSONColumnType<T>` types the insert/update side as `string`,
 * which is correct only when you hand the driver a pre-stringified value.
 * node-postgres already serialises plain objects for json/jsonb parameters, so
 * for this stack `T` is the accurate write type. The select type is unchanged,
 * so reads behave exactly as before.
 */
type JsonbColumn<T> = ColumnType<T, T, T>

/**
 * A jsonb column that also carries a DB-side `DEFAULT '{}'::jsonb`, so it may be
 * omitted on insert and Postgres fills it in.
 *
 * These columns currently have that default and could use this type too:
 * `sports.stat_schema`, `sport_profiles.career_stats`, `match_player_stats.stats`,
 * `achievements.data`, `feed_events.payload`. They are left as required for now
 * so this change stays scoped; converting them is safe whenever each is touched.
 */
type JsonbColumnWithDefault<T> = ColumnType<T, T | undefined, T>

export interface SportTable {
  id: Generated<string>
  name: string
  slug: string
  stat_schema: JsonbColumn<SportStatSchema>
  icon_url: string | null
  active: Generated<boolean>
  created_at: Generated<Date>
}

export interface SportStatSchema {
  score_format: string
  match_stats: string[]
  primary_metrics?: Record<string, number>
  batting_metrics?: Record<string, number>
  bowling_metrics?: Record<string, number>
  fielding_metrics?: Record<string, number>
  penalty_metrics?: Record<string, number>
  efficiency_metrics?: Record<string, number>
  positions: string[]
  max_stat_thresholds: Record<string, number>
  formats: string[]
  event_types?: string[]
}

export type UserRole = 'player' | 'referee' | 'organizer' | 'admin'
export type MatchStatus = 'scheduled' | 'live' | 'completed' | 'cancelled'
export type EventStatus = 'upcoming' | 'registration' | 'active' | 'completed' | 'cancelled'
export type MatchFormat = '5-a-side' | '7-a-side' | '11-a-side'

/** How one side of a fixture gets filled in. Stored as jsonb. */
export type FixtureSource =
  | { type: 'team'; team_id: string }
  | { type: 'winner_of'; fixture_id: string }
  | { type: 'qualifier'; seed: number }

export interface UserTable {
  id: Generated<string>
  phone: string | null
  name: string
  username: string | null
  avatar_url: string | null
  city: string | null
  bio: string | null
  firebase_uid: string | null
  role: Generated<UserRole>
  // Highest tier this user may officiate (set when they become a referee)
  referee_tier: MatchTier | null
  // Guest = identity with no login credentials yet, created by a referee.
  is_guest: Generated<boolean>
  created_by: string | null
  claimed_at: Date | null
  is_active: Generated<boolean>
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface RefereeApplicationTable {
  id: Generated<string>
  user_id: string
  full_name: string
  city: string
  phone: string | null
  experience_years: number | null
  sports: string[] | null
  certification: string | null
  bio: string | null
  status: Generated<'pending' | 'approved' | 'rejected'>
  // 'initial' = becoming a referee; 'upgrade' = higher tier; 'organizer' = run tournaments
  request_type: Generated<'initial' | 'upgrade' | 'organizer'>
  requested_tier: MatchTier | null
  reviewed_by: string | null
  reviewed_at: Date | null
  review_notes: string | null
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface TierRatingTable {
  id: Generated<string>
  user_id: string
  sport_id: string
  tier: MatchTier
  rating: Generated<number>
  matches_played: Generated<number>
  wins: Generated<number>
  updated_at: Generated<Date>
}

export interface SportProfileTable {
  id: Generated<string>
  user_id: string
  sport_id: string
  position: string | null
  current_rating: Generated<number>
  form_rating: number | null
  matches_played: Generated<number>
  wins: Generated<number>
  career_stats: JsonbColumn<Record<string, number>>
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface TeamTable {
  id: Generated<string>
  name: string
  sport_id: string
  city: string | null
  organizer_id: string
  avatar_url: string | null
  cover_url: string | null
  founded_at: Date | null
  wins: Generated<number>
  losses: Generated<number>
  draws: Generated<number>
  avg_rating: number | null
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface TeamMemberTable {
  team_id: string
  user_id: string
  role: 'captain' | 'vice_captain' | 'player' | 'coach'
  jersey_no: number | null
  joined_at: Generated<Date>
  is_active: Generated<boolean>
}

export interface EventTable {
  id: Generated<string>
  name: string
  sport_id: string
  organizer_id: string
  format: 'knockout' | 'league' | 'round_robin' | 'group_knockout' | 'casual'
  // Competition grade of the whole tournament; every generated match inherits it.
  // Capped by the lowest referee_tier among assigned referees — see spec §3.1.1.
  tier: Generated<MatchTier>
  // Players per side — distinct from `format`, which is the tournament structure.
  match_format: MatchFormat | null
  // Slot length for the generator; also Phase 4's rating match-weight input.
  match_duration_minutes: number | null
  city: string
  venue: string | null
  description: string | null
  status: EventStatus
  starts_at: Date | null
  ends_at: Date | null
  max_teams: number | null
  entry_fee: Generated<number>
  prize_pool: Generated<number>
  rules: JsonbColumnWithDefault<Record<string, unknown>>
  cover_url: string | null
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface EventTeamTable {
  event_id: string
  team_id: string
  seed: number | null
  group_no: string | null
  points: Generated<number>
  played: Generated<number>
  won: Generated<number>
  drawn: Generated<number>
  lost: Generated<number>
  goals_for: Generated<number>
  goals_against: Generated<number>
  registered_at: Generated<Date>
}

export interface EventFixtureTable {
  id: Generated<string>
  event_id: string
  round: string
  slot_no: number
  pitch_label: string | null
  scheduled_at: Date | null
  referee_id: string | null
  home_source: JsonbColumn<FixtureSource>
  away_source: JsonbColumn<FixtureSource>
  home_team_id: string | null
  away_team_id: string | null
  match_id: string | null
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface EventRefereeTable {
  event_id: string
  user_id: string
  // Pins a referee to one pitch for the day (e.g. 'Pitch 1'). NULL = unassigned.
  pitch_label: string | null
  added_at: Generated<Date>
}

export interface MatchTable {
  id: Generated<string>
  event_id: string | null
  sport_id: string
  home_team_id: string
  away_team_id: string
  venue: string | null
  round: string | null
  scheduled_at: Date | null
  started_at: Date | null
  completed_at: Date | null
  status: MatchStatus
  tier: Generated<MatchTier>
  // Copied from the parent event at creation; drives the rating match-weight.
  format: MatchFormat | null
  duration_minutes: number | null
  referee_id: string | null
  home_score: JsonbColumn<Record<string, unknown>> | null
  away_score: JsonbColumn<Record<string, unknown>> | null
  winner_team_id: string | null
  home_confirmed: Generated<boolean>
  away_confirmed: Generated<boolean>
  created_at: Generated<Date>
  updated_at: Generated<Date>
}

export interface MatchPlayerStatsTable {
  id: Generated<string>
  match_id: string
  user_id: string
  team_id: string
  sport_id: string
  stats: JsonbColumn<Record<string, unknown>>
  position: string | null              // player's position for this match (for role baselines)
  match_rating: number | null          // final 0–10 star (referee-approved or algo)
  suggested_rating: number | null      // algo's 0–10 suggestion (audit)
  rating_overridden: Generated<boolean>
  confirmed_by_captain: Generated<boolean>
  entered_by: string | null
  client_event_id: string | null
  created_at: Generated<Date>
}

export interface RatingHistoryTable {
  id: Generated<string>
  user_id: string
  sport_id: string
  match_id: string
  rating_before: number
  rating_after: number
  performance_score: number
  delta: ColumnType<number, never, never>   // generated column, read-only
  created_at: Generated<Date>
}

export interface AchievementTable {
  id: Generated<string>
  user_id: string
  sport_id: string | null
  type: string
  data: JsonbColumn<Record<string, unknown>>
  match_id: string | null
  created_at: Generated<Date>
}

export interface FollowTable {
  follower_id: string
  following_id: string
  created_at: Generated<Date>
}

export interface FeedEventTable {
  id: Generated<string>
  actor_id: string
  action_type: string
  entity_type: string
  entity_id: string
  payload: JsonbColumn<Record<string, unknown>>
  created_at: Generated<Date>
}

export interface OrganizerScoreTable {
  user_id: string
  trust_score: Generated<number>
  total_events: Generated<number>
  flagged_events: Generated<number>
  updated_at: Generated<Date>
}

// The full Database interface — every table
export interface Database {
  sports: SportTable
  users: UserTable
  sport_profiles: SportProfileTable
  teams: TeamTable
  team_members: TeamMemberTable
  events: EventTable
  event_teams: EventTeamTable
  event_referees: EventRefereeTable
  event_fixtures: EventFixtureTable
  matches: MatchTable
  match_player_stats: MatchPlayerStatsTable
  rating_history: RatingHistoryTable
  achievements: AchievementTable
  follows: FollowTable
  feed_events: FeedEventTable
  organizer_scores: OrganizerScoreTable
  referee_applications: RefereeApplicationTable
  tier_ratings: TierRatingTable
}
