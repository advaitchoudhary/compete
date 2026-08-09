-- AllSports — Event Standings
-- Migration: 013_event_standings
-- Run order: 13
--
-- The columns a real group table needs. event_teams.points already exists but
-- nothing ever wrote it. Maintained by the resolver for GROUP-STAGE matches only
-- — knockout results don't belong in a group table.
--
-- Tie-break order: points → goal difference → goals for → head-to-head
-- (two-way only; 3+ way falls back to seed, which is explainable on the pitch).

ALTER TABLE event_teams ADD COLUMN IF NOT EXISTS played        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE event_teams ADD COLUMN IF NOT EXISTS won           INTEGER NOT NULL DEFAULT 0;
ALTER TABLE event_teams ADD COLUMN IF NOT EXISTS drawn         INTEGER NOT NULL DEFAULT 0;
ALTER TABLE event_teams ADD COLUMN IF NOT EXISTS lost          INTEGER NOT NULL DEFAULT 0;
ALTER TABLE event_teams ADD COLUMN IF NOT EXISTS goals_for     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE event_teams ADD COLUMN IF NOT EXISTS goals_against INTEGER NOT NULL DEFAULT 0;
