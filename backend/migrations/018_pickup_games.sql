-- AllSports — Pickup games
-- Migration: 018_pickup_games
-- Run order: 18
--
-- A pickup game is an `events` row with format = 'casual'. That value has existed
-- in the CHECK constraint since 001 and meant nothing: legal to create, rejected by
-- the fixture generator, with no behaviour anywhere. Reusing it gives ownership, the
-- status lifecycle, venue/city/starts_at and organizer scoping for free.
--
-- What tournaments cannot lend is the roster. `event_teams` is keyed by team and
-- carries seeds, groups and standings; a pickup game is a queue of individuals.

-- events.match_format is a three-value enum (5/7/11-a-side) and cannot express 9v9.
-- Pickup stores the number, so any format works. Capacity is always 2x this and is
-- never stored — a stored capacity is a second source of truth waiting to drift.
ALTER TABLE events ADD COLUMN IF NOT EXISTS players_per_side INT
  CHECK (players_per_side BETWEEN 3 AND 11);

-- The two sides drawn for a pickup game are throwaway: created for one match and
-- never played again. Without this flag they collect win/loss records through
-- updateTeamStats and clutter every team listing.
ALTER TABLE teams ADD COLUMN IF NOT EXISTS is_ad_hoc BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS event_players (
  event_id  UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES users(id),

  -- NULL means they joined themselves. Otherwise the signed-in person who brought
  -- them. This is the party key: a party is one joiner plus everyone they added,
  -- and parties join, wait and leave as a unit — the mates were only coming
  -- because of the person who put them down.
  added_by  UUID REFERENCES users(id),

  status    TEXT NOT NULL DEFAULT 'confirmed'
            CHECK (status IN ('confirmed', 'waitlist', 'withdrawn')),

  -- Optional, same vocabulary as team_members.position from 017. GK is absent for
  -- the same reason: the referee assigns the keeper at match time.
  position  TEXT CHECK (position IN ('DEF', 'MID', 'FWD')),

  -- Waitlist order, and the tie-break for who got in first.
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Which side they were drawn onto. NULL until the game is drawn.
  team_id   UUID REFERENCES teams(id),

  PRIMARY KEY (event_id, user_id)
);

-- The promotion query is "confirmed count for this game" and "waitlist in join
-- order", both of which this covers.
CREATE INDEX IF NOT EXISTS idx_event_players_queue
  ON event_players (event_id, status, joined_at);

COMMENT ON TABLE event_players IS
  'Individuals signed up to a pickup game (events.format = ''casual''). Tournaments '
  'use event_teams instead, which is keyed by team and carries standings.';
COMMENT ON COLUMN event_players.added_by IS
  'NULL = joined themselves; otherwise the joiner who brought them. Parties join, '
  'wait and withdraw together.';
