-- AllSports — Event Referees
-- Migration: 010_event_referees
-- Run order: 10
--
-- Which approved referees are working a given tournament, and on which pitch.
-- The organizer picks from already-approved referees; the fixture generator
-- draws from this pool to stamp referee_id onto each generated match.
-- This is how an organizer schedules without ever gaining scoring rights.

CREATE TABLE IF NOT EXISTS event_referees (
  event_id    UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id),
  -- Keeps a referee on one pitch all day (e.g. 'Pitch 1'). NULL = unassigned.
  pitch_label TEXT,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_event_referees_event ON event_referees(event_id);
CREATE INDEX IF NOT EXISTS idx_event_referees_user ON event_referees(user_id);
