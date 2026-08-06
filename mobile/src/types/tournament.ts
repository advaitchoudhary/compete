// Tournament / Event types for AllSports
// Backend returns these shapes from /events and /matches endpoints

export interface EventSummary {
  id: string
  name: string
  sport_slug: string
  format: 'knockout' | 'league' | 'round_robin' | 'group_knockout' | 'casual'
  city: string
  venue: string | null
  starts_at: string | null
  ends_at: string | null
  max_teams: number | null
  status: 'upcoming' | 'registration' | 'active' | 'completed' | 'cancelled'
  organizer_id: string
  description: string | null
  entry_fee: number | null    // in paise
  prize_pool: number | null   // in paise
  rules: Record<string, unknown> | null
}

export interface EventTeam {
  id: string
  name: string
  seed: number | null
  group_no: string | null
  points: number
  organizer_id?: string
}

/**
 * GET /events/:id — the event's own columns are returned FLAT, not nested.
 *
 * The backend does `return { ...event, teams, matches }`. This type previously
 * declared `event: EventSummary`, so `data.event` was always undefined and the
 * tournament screen's `if (!eventMeta)` branch fired for every tournament that
 * has ever existed — "Tournament not found." on a 200 response.
 */
export interface EventDetail extends EventSummary {
  tier: string
  match_format: string | null
  match_duration_minutes: number | null
  sport_name: string
  teams: EventTeam[]
  matches: MatchSummary[]
}

export interface MatchSummary {
  id: string
  home_team_id: string
  home_team_name: string | null
  away_team_id: string
  away_team_name: string | null
  /**
   * Goals as plain numbers. The DB column is jsonb (`{ "goals": 2 }`) and this
   * type used to declare `home_score: number`, so interpolating it rendered
   * "[object Object]". The API now resolves the jsonb and sends numbers.
   */
  home_goals: number | null
  away_goals: number | null
  status: 'scheduled' | 'live' | 'completed' | 'cancelled'
  round: string | null
  /** Human form of `round` — "Semi-final", not "semi". */
  round_label: string | null
  scheduled_at: string | null
  event_id: string | null
  sport_slug: string
  venue: string | null
}

export interface PlayerStatEntry {
  user_id: string
  name: string
  avatar_url: string | null
  team_id: string
  stats: Record<string, number | string>
  match_rating: number | null
  confirmed_by_captain: boolean
}

/**
 * GET /matches/:id — a DIFFERENT payload from the match rows inside
 * GET /events/:id, so it deliberately does not extend MatchSummary.
 *
 * Here the scores are the raw jsonb the column stores (`{ goals: 2 }`) and are
 * read through scoreNum(); the event endpoint resolves them to numbers instead.
 * Inheriting one from the other made those two shapes look identical and hid a
 * real mismatch.
 */
export interface MatchDetail {
  id: string
  home_team_id: string
  home_team_name: string
  away_team_id: string
  away_team_name: string
  home_team_avatar: string | null
  away_team_avatar: string | null
  /** Raw jsonb, e.g. `{ goals: 2 }` — not a number. */
  home_score: Record<string, number> | null
  away_score: Record<string, number> | null
  status: 'scheduled' | 'live' | 'completed' | 'cancelled'
  round: string | null
  scheduled_at: string | null
  event_id: string | null
  sport_slug: string
  sport_name: string
  venue: string | null
  started_at: string | null
  completed_at: string | null
  home_confirmed: boolean
  away_confirmed: boolean
  winner_team_id: string | null
  referee_id: string | null
  tier?: string
  // Inherited from the parent event when the fixture generator creates the match.
  // duration_minutes also drives the rating match-weight (a 12-minute 5-a-side
  // must not move Elo like a 90-minute game).
  format?: '5-a-side' | '7-a-side' | '11-a-side' | null
  duration_minutes?: number | null
  player_stats: PlayerStatEntry[]
}

export interface TeamSummary {
  id: string
  name: string
  sport_slug: string
  city: string | null
  organizer_id: string
  wins: number
  losses: number
  draws: number
  avg_rating: number | null
}
