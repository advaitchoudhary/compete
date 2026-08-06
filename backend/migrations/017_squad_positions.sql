-- AllSports — Squad positions
-- Migration: 017_squad_positions
-- Run order: 17
--
-- The captain declares each squad member's outfield role when registering, so
-- the rating engine can pay the defender baseline and the clean-sheet share that
-- already exist in the model but were unreachable in practice: the scorecard only
-- ever records 'GK', so every outfielder was scored on the default baseline and
-- a centre-back who kept a clean sheet in a 4-0 rated the same as a striker who
-- did nothing.
--
-- Stored per team membership rather than on the user, because the same player is
-- a defender for one side and a forward for another.
--
-- Deliberately coarse — DEF/MID/FWD, not CB/LB/RB/CDM/CM/CAM. A captain typing
-- in six mates on a Sunday morning will not pick from ten positions, and the
-- rating model only distinguishes three tiers of outfield anyway.
--
-- GK is absent on purpose. The referee marks the keeper on match day, which is
-- both more reliable (keepers swap) and outside the captain's control — it is the
-- single largest baseline in the model.
--
-- NULL is allowed and means "not declared", which behaves exactly as today.

ALTER TABLE team_members ADD COLUMN IF NOT EXISTS position TEXT
  CHECK (position IN ('DEF', 'MID', 'FWD'));

COMMENT ON COLUMN team_members.position IS
  'Captain-declared outfield role: DEF, MID or FWD. Feeds match_player_stats.position '
  'when the referee does not record one. GK is set by the referee at match time.';
