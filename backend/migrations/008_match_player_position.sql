-- AllSports — Per-Match Player Position
-- Migration: 008_match_player_position
-- Run order: 8
--
-- The referee records each player's position for THAT match (a player may play
-- CB one game, CM the next). Used to baseline the star rating by role
-- (GK 5, defenders 4) since position can't be reliably inferred from stats.

ALTER TABLE match_player_stats
  ADD COLUMN IF NOT EXISTS position TEXT;
