-- AllSports — Event Fixtures (the bracket)
-- Migration: 014_event_fixtures
-- Run order: 14
--
-- A FIXTURE is a slot in a competition structure; a MATCH is a game between two
-- known teams. Different lifecycles: group fixtures know both teams immediately,
-- knockout fixtures resolve over the course of the day. Keeping them apart is
-- what lets matches.home_team_id / away_team_id stay NOT NULL — see spec §3.3,
-- where the nullable alternative was measured at 78 references across 13 files
-- including four innerJoins that would SILENTLY DROP rows.
--
-- home_source / away_source say how each side is filled:
--   {"type":"team","team_id":"…"}           known now (group stage)
--   {"type":"winner_of","fixture_id":"…"}   winner of an earlier fixture
--   {"type":"qualifier","seed":n}           nth-ranked qualifier once groups end

CREATE TABLE IF NOT EXISTS event_fixtures (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_id      UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  -- 'group_a'.. | 'play_in' | 'round_of_16' | 'quarter' | 'semi' | 'final'
  round         TEXT NOT NULL,
  slot_no       INTEGER NOT NULL,
  pitch_label   TEXT,
  scheduled_at  TIMESTAMPTZ,
  referee_id    UUID REFERENCES users(id),

  home_source   JSONB NOT NULL,
  away_source   JSONB NOT NULL,

  home_team_id  UUID REFERENCES teams(id),
  away_team_id  UUID REFERENCES teams(id),

  -- Set once both teams are known. UNIQUE is the guard against the fixtures and
  -- matches tables drifting: one fixture can own at most one match.
  match_id      UUID UNIQUE REFERENCES matches(id) ON DELETE SET NULL,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (event_id, round, slot_no)
);

CREATE INDEX IF NOT EXISTS idx_event_fixtures_event ON event_fixtures(event_id, round, slot_no);
CREATE INDEX IF NOT EXISTS idx_event_fixtures_unresolved
  ON event_fixtures(event_id) WHERE match_id IS NULL;
