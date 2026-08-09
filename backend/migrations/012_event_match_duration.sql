-- AllSports — Event Match Duration
-- Migration: 012_event_match_duration
-- Run order: 12
--
-- Slot length for the fixture generator (match + changeover), and the input
-- Phase 4 needs to weight ratings: a 12-minute 5-a-side must not move Elo like a
-- 90-minute match. Nullable because existing events predate it; the generator
-- falls back to a default when NULL.

ALTER TABLE events ADD COLUMN IF NOT EXISTS match_duration_minutes INTEGER
  CHECK (match_duration_minutes > 0 AND match_duration_minutes <= 180);
