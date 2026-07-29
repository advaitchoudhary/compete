-- AllSports — Match Tiers & Per-Tier Elo Ladders
-- Migration: 006_match_tiers
-- Run order: 6
--
-- Matches are graded into tiers (amateur → legends). A referee may only
-- officiate at or below their own tier (anti-fraud + a progression ladder).
-- Each player has a separate Elo per (sport, tier); the headline "Elo number"
-- is a tier-weighted blend of those, stored on sport_profiles.current_rating.

-- ── Match tier ────────────────────────────────────────────────────────────
ALTER TABLE matches ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'amateur'
  CHECK (tier IN ('amateur', 'semi_pro', 'pro', 'legends'));

CREATE INDEX IF NOT EXISTS idx_matches_tier ON matches(tier, status);

-- ── Referee tier (highest tier this referee may officiate) ──────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS referee_tier TEXT
  CHECK (referee_tier IN ('amateur', 'semi_pro', 'pro', 'legends'));

-- ── Referee applications double as tier-upgrade requests ────────────────────
ALTER TABLE referee_applications ADD COLUMN IF NOT EXISTS request_type TEXT NOT NULL DEFAULT 'initial'
  CHECK (request_type IN ('initial', 'upgrade'));
ALTER TABLE referee_applications ADD COLUMN IF NOT EXISTS requested_tier TEXT
  CHECK (requested_tier IN ('amateur', 'semi_pro', 'pro', 'legends'));

-- ── Per-tier Elo ladders ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tier_ratings (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sport_id        UUID NOT NULL REFERENCES sports(id),
  tier            TEXT NOT NULL CHECK (tier IN ('amateur', 'semi_pro', 'pro', 'legends')),
  rating          NUMERIC(5,2) NOT NULL DEFAULT 50.00,
  matches_played  INT NOT NULL DEFAULT 0,
  wins            INT NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, sport_id, tier)
);

-- Per-tier leaderboard lookups
CREATE INDEX IF NOT EXISTS idx_tier_ratings_ladder ON tier_ratings(sport_id, tier, rating DESC);
CREATE INDEX IF NOT EXISTS idx_tier_ratings_user ON tier_ratings(user_id, sport_id);
