-- AllSports Initial Schema
-- Migration: 001_initial_schema
-- Run order: 1

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- for text search on names

-- ============================================================
-- SPORTS
-- ============================================================
CREATE TABLE sports (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        TEXT NOT NULL,
  slug        TEXT UNIQUE NOT NULL,
  -- Defines what stats are tracked + how they weight into ratings
  -- Example for football:
  -- {
  --   "match_stats": ["goals","assists","shots_on_target","passes","tackles","saves","yellow_cards","red_cards"],
  --   "primary_metrics": {"goals": 3.0, "assists": 1.5, "clean_sheet": 2.0, "saves": 0.3},
  --   "positions": ["GK","DEF","MID","FWD"],
  --   "score_format": "goals",
  --   "max_stat_thresholds": {"goals": 10, "assists": 5}
  -- }
  stat_schema   JSONB NOT NULL DEFAULT '{}',
  icon_url      TEXT,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- USERS
-- ============================================================
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone         TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  username      TEXT UNIQUE,
  avatar_url    TEXT,
  city          TEXT,
  bio           TEXT,
  firebase_uid  TEXT UNIQUE NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_username ON users USING gin(username gin_trgm_ops);
CREATE INDEX idx_users_city ON users(city);

-- ============================================================
-- SPORT PROFILES  (player's per-sport identity + ratings)
-- ============================================================
CREATE TABLE sport_profiles (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sport_id        UUID NOT NULL REFERENCES sports(id),
  position        TEXT,
  -- Overall career rating (0–100)
  current_rating  NUMERIC(5,2) NOT NULL DEFAULT 50.00,
  -- Rolling average of last 5 match performance scores
  form_rating     NUMERIC(5,2),
  matches_played  INT NOT NULL DEFAULT 0,
  wins            INT NOT NULL DEFAULT 0,
  -- Lifetime aggregated stats (e.g. {"goals": 42, "assists": 18, ...})
  career_stats    JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, sport_id)
);

CREATE INDEX idx_sport_profiles_user ON sport_profiles(user_id);
CREATE INDEX idx_sport_profiles_rating ON sport_profiles(sport_id, current_rating DESC);
CREATE INDEX idx_sport_profiles_city ON sport_profiles(sport_id, current_rating DESC)
  WHERE current_rating IS NOT NULL;

-- ============================================================
-- TEAMS
-- ============================================================
CREATE TABLE teams (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          TEXT NOT NULL,
  sport_id      UUID NOT NULL REFERENCES sports(id),
  city          TEXT,
  organizer_id  UUID NOT NULL REFERENCES users(id),
  avatar_url    TEXT,
  cover_url     TEXT,
  founded_at    DATE,
  -- Aggregate win/loss
  wins          INT NOT NULL DEFAULT 0,
  losses        INT NOT NULL DEFAULT 0,
  draws         INT NOT NULL DEFAULT 0,
  -- Average rating of active players (cached, updated after each match)
  avg_rating    NUMERIC(5,2),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_teams_sport_city ON teams(sport_id, city);
CREATE INDEX idx_teams_organizer ON teams(organizer_id);

CREATE TABLE team_members (
  team_id     UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('captain','vice_captain','player','coach')),
  jersey_no   SMALLINT,
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_active   BOOLEAN NOT NULL DEFAULT true,
  PRIMARY KEY (team_id, user_id)
);

CREATE INDEX idx_team_members_user ON team_members(user_id);

-- ============================================================
-- EVENTS (tournaments / leagues / casual)
-- ============================================================
CREATE TABLE events (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name          TEXT NOT NULL,
  sport_id      UUID NOT NULL REFERENCES sports(id),
  organizer_id  UUID NOT NULL REFERENCES users(id),
  format        TEXT NOT NULL CHECK (format IN ('knockout','league','round_robin','group_knockout','casual')),
  city          TEXT NOT NULL,
  venue         TEXT,
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming','registration','active','completed','cancelled')),
  starts_at     TIMESTAMPTZ,
  ends_at       TIMESTAMPTZ,
  max_teams     INT,
  entry_fee     INT DEFAULT 0,       -- in paise (0 = free)
  prize_pool    INT DEFAULT 0,       -- in paise
  -- Format-specific config (group sizes, points per win, etc.)
  rules         JSONB NOT NULL DEFAULT '{}',
  cover_url     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_events_sport_city ON events(sport_id, city, starts_at);
CREATE INDEX idx_events_organizer ON events(organizer_id);
CREATE INDEX idx_events_status ON events(status, starts_at);

CREATE TABLE event_teams (
  event_id    UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  team_id     UUID NOT NULL REFERENCES teams(id),
  seed        INT,
  group_no    TEXT,
  -- Points in league format
  points      INT NOT NULL DEFAULT 0,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, team_id)
);

-- ============================================================
-- MATCHES
-- ============================================================
CREATE TABLE matches (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_id        UUID REFERENCES events(id),          -- NULL for casual matches
  sport_id        UUID NOT NULL REFERENCES sports(id),
  home_team_id    UUID NOT NULL REFERENCES teams(id),
  away_team_id    UUID NOT NULL REFERENCES teams(id),
  venue           TEXT,
  round           TEXT,                                 -- 'QF', 'SF', 'F', 'Group A'
  scheduled_at    TIMESTAMPTZ,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'scheduled'
                    CHECK (status IN ('scheduled','live','completed','cancelled')),
  -- Sport-agnostic score storage
  -- Cricket: {"runs": 145, "wickets": 6, "overs": "20.0"}
  -- Football: {"goals": 2}
  -- Basketball: {"points": 78, "quarters": [21,18,24,15]}
  home_score      JSONB,
  away_score      JSONB,
  winner_team_id  UUID REFERENCES teams(id),
  -- Both captains must confirm before ratings are processed
  home_confirmed  BOOLEAN NOT NULL DEFAULT false,
  away_confirmed  BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_matches_event ON matches(event_id);
CREATE INDEX idx_matches_status ON matches(status, scheduled_at);
CREATE INDEX idx_matches_teams ON matches(home_team_id, away_team_id);
CREATE INDEX idx_matches_sport ON matches(sport_id, completed_at DESC);

-- ============================================================
-- MATCH PLAYER STATS  (the critical table — all sport stats live here)
-- ============================================================
CREATE TABLE match_player_stats (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  match_id              UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  user_id               UUID NOT NULL REFERENCES users(id),
  team_id               UUID NOT NULL REFERENCES teams(id),
  sport_id              UUID NOT NULL REFERENCES sports(id),
  -- Sport-specific stats as JSONB
  -- Cricket bat: {"runs":45,"balls":38,"fours":4,"sixes":1,"out":true,"dismissal":"caught"}
  -- Cricket bowl: {"overs":"4.0","wickets":2,"runs_conceded":28,"maidens":0}
  -- Football: {"goals":1,"assists":0,"shots":3,"passes":42,"tackles":5,"yellow_cards":0}
  -- Basketball: {"points":18,"rebounds":7,"assists":4,"steals":2,"blocks":1,"turnovers":2,"fg_made":7,"fg_attempted":14}
  stats                 JSONB NOT NULL DEFAULT '{}',
  -- Rating computed by the rating engine for this specific match (0-100)
  match_rating          NUMERIC(4,2),
  confirmed_by_captain  BOOLEAN NOT NULL DEFAULT false,
  entered_by            UUID REFERENCES users(id),
  -- For offline sync: client-generated idempotency key
  client_event_id       UUID UNIQUE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(match_id, user_id)
);

CREATE INDEX idx_mps_match ON match_player_stats(match_id);
CREATE INDEX idx_mps_user ON match_player_stats(user_id, sport_id);
CREATE INDEX idx_mps_team ON match_player_stats(team_id, match_id);

-- ============================================================
-- RATING HISTORY  (immutable audit log — never update, only insert)
-- ============================================================
CREATE TABLE rating_history (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID NOT NULL REFERENCES users(id),
  sport_id          UUID NOT NULL REFERENCES sports(id),
  match_id          UUID NOT NULL REFERENCES matches(id),
  rating_before     NUMERIC(5,2) NOT NULL,
  rating_after      NUMERIC(5,2) NOT NULL,
  performance_score NUMERIC(5,2) NOT NULL,
  delta             NUMERIC(5,2) GENERATED ALWAYS AS (rating_after - rating_before) STORED,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_rating_history_user_sport ON rating_history(user_id, sport_id, created_at DESC);
CREATE INDEX idx_rating_history_match ON rating_history(match_id);

-- ============================================================
-- ACHIEVEMENTS
-- ============================================================
CREATE TABLE achievements (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sport_id    UUID REFERENCES sports(id),        -- NULL = cross-sport achievement
  type        TEXT NOT NULL,
  -- Achievement-specific data
  -- Hat trick: {"match_id": "...", "goals": 3}
  -- 100 matches: {"total_matches": 100}
  -- Rating milestone: {"rating": 75}
  data        JSONB NOT NULL DEFAULT '{}',
  match_id    UUID REFERENCES matches(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_achievements_user ON achievements(user_id, created_at DESC);
CREATE UNIQUE INDEX idx_achievements_unique_type ON achievements(user_id, sport_id, type)
  WHERE type IN ('first_match','first_win','100_matches','200_matches','rating_60','rating_70','rating_80','rating_90');

-- ============================================================
-- SOCIAL: FOLLOWS
-- ============================================================
CREATE TABLE follows (
  follower_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (follower_id, following_id),
  CHECK (follower_id != following_id)
);

CREATE INDEX idx_follows_following ON follows(following_id);

-- ============================================================
-- ACTIVITY FEED
-- ============================================================
CREATE TABLE feed_events (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action_type   TEXT NOT NULL,
  -- 'match_completed'    → entity = match
  -- 'achievement_earned' → entity = achievement
  -- 'rating_milestone'   → entity = sport_profile
  -- 'joined_event'       → entity = event
  -- 'team_win'           → entity = match
  entity_type   TEXT NOT NULL,
  entity_id     UUID NOT NULL,
  -- Pre-serialized display payload for fast feed rendering
  payload       JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_feed_actor ON feed_events(actor_id, created_at DESC);
CREATE INDEX idx_feed_created ON feed_events(created_at DESC);

-- ============================================================
-- ORGANIZER REPUTATION (anti-fraud)
-- ============================================================
CREATE TABLE organizer_scores (
  user_id         UUID PRIMARY KEY REFERENCES users(id),
  trust_score     NUMERIC(4,2) NOT NULL DEFAULT 80.00,  -- 0-100
  total_events    INT NOT NULL DEFAULT 0,
  flagged_events  INT NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- TRIGGERS: auto-update updated_at
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_sport_profiles_updated_at
  BEFORE UPDATE ON sport_profiles FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_teams_updated_at
  BEFORE UPDATE ON teams FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_events_updated_at
  BEFORE UPDATE ON events FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_matches_updated_at
  BEFORE UPDATE ON matches FOR EACH ROW EXECUTE FUNCTION update_updated_at();
