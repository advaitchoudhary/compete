-- AllSports — Match Referee Ownership
-- Migration: 004_match_referee
-- Run order: 4
--
-- A match is created and officiated by a referee. Only that referee (or an
-- admin) may start it, update its score, and enter player stats. Confirmation
-- remains captain-driven (unchanged).

ALTER TABLE matches
  ADD COLUMN IF NOT EXISTS referee_id UUID REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_matches_referee ON matches(referee_id, status);
