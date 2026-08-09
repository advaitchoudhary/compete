-- AllSports — Match Format & Duration
-- Migration: 015_match_duration
-- Run order: 15
--
-- Copied from the parent event when a tournament match is created, so the rating
-- engine can weight a short game correctly: a 12-minute 5-a-side must not move
-- Elo like a 90-minute match. See spec §3.5.
--
-- Both nullable. A NULL duration is treated as 90 minutes (weight 1.0) by the
-- engine, so every match created before this migration keeps its current Elo
-- behaviour exactly.

ALTER TABLE matches ADD COLUMN IF NOT EXISTS format TEXT
  CHECK (format IN ('5-a-side', '7-a-side', '11-a-side'));

ALTER TABLE matches ADD COLUMN IF NOT EXISTS duration_minutes INTEGER
  CHECK (duration_minutes > 0 AND duration_minutes <= 180);
