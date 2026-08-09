-- AllSports — one way to say how many a side
-- Migration: 019_players_per_side
-- Run order: 19
--
-- Two columns were saying the same thing. Tournaments used `match_format`, a
-- three-value enum of '5-a-side' / '7-a-side' / '11-a-side'; pickup games, added
-- one migration ago, used `players_per_side` as an integer because that enum
-- cannot express 9v9 and a turf owner running 9-a-side pickup needed it to.
--
-- Keeping both would mean every future reader deciding which one to trust. The
-- integer wins: it is the actual quantity, it needs no migration to admit 6v6 or
-- 8v8, and the squad minimum and defender cap both fall out of it arithmetically
-- rather than from a lookup table with one row per size.
--
-- `match_format` survives as a GENERATED column so the many places that read it
-- for display keep working untouched, but it can no longer disagree with the
-- number it is derived from.

-- 1. Carry the existing tournaments across before the source column goes.
UPDATE events
SET players_per_side = CASE match_format
    WHEN '5-a-side'  THEN 5
    WHEN '7-a-side'  THEN 7
    WHEN '11-a-side' THEN 11
  END
WHERE players_per_side IS NULL
  AND match_format IS NOT NULL;

-- 2. Re-create match_format as derived. A generated column cannot be added over an
--    existing one, so it is dropped and rebuilt — safe only because step 1 has
--    already moved the information into players_per_side.
ALTER TABLE events DROP COLUMN match_format;
ALTER TABLE events ADD COLUMN match_format TEXT
  GENERATED ALWAYS AS (players_per_side::text || '-a-side') STORED;

-- 3. matches.format is copied from the event when a fixture is generated, so its
--    CHECK has to admit whatever an event can now be. A pattern rather than a list,
--    so this never needs revisiting for a new size.
ALTER TABLE matches DROP CONSTRAINT IF EXISTS matches_format_check;
ALTER TABLE matches ADD CONSTRAINT matches_format_check
  CHECK (format IS NULL OR format ~ '^(3|4|5|6|7|8|9|10|11)-a-side$');

COMMENT ON COLUMN events.players_per_side IS
  'Players per side, 3-11. The single source of truth for game size: the squad '
  'minimum equals it, the defender cap derives from it, and match_format is '
  'generated from it.';
COMMENT ON COLUMN events.match_format IS
  'Derived from players_per_side for display. Never write to this.';
