-- AllSports — Referee Rating Override
-- Migration: 007_rating_override
-- Run order: 7
--
-- The algorithm SUGGESTS a 0–10 star rating; the referee may override it
-- (the eye test) within a bounded range before the match is confirmed. We
-- store both numbers for audit. match_rating (already present) holds the FINAL
-- value used by the Elo nudge.

ALTER TABLE match_player_stats
  ADD COLUMN IF NOT EXISTS suggested_rating NUMERIC(4,2);

ALTER TABLE match_player_stats
  ADD COLUMN IF NOT EXISTS rating_overridden BOOLEAN NOT NULL DEFAULT false;
