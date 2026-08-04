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

export interface EventDetail {
  event: EventSummary
  teams: EventTeam[]
  matches: MatchSummary[]
}

export interface MatchSummary {
  id: string
  home_team_id: string
  home_team_name: string
  away_team_id: string
  away_team_name: string
  home_score: number | null
  away_score: number | null
  status: 'scheduled' | 'live' | 'completed' | 'cancelled'
  round: string | null
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

export interface MatchDetail extends MatchSummary {
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
