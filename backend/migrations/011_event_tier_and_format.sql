-- AllSports — Event Tier & Match Format
-- Migration: 011_event_tier_and_format
-- Run order: 11
--
-- events.tier is the competition grade of the whole tournament, and every match
-- generated for it inherits this tier. Tier drives rating weight (amateur 1.0 →
-- legends 3.0), so this column is the lever the anti-fraud rules protect:
-- an event's tier may not exceed the LOWEST referee_tier among its assigned
-- referees. See docs/superpowers/specs/2026-07-29-tournament-day-design.md §3.1.1.
-- Defaults to 'amateur' so an unspecified tournament is always the lowest-weight
-- one, never the highest.
--
-- events.match_format records players per side, which events.format does NOT —
-- that column holds the tournament structure (knockout / group_knockout / …).
-- Needed to enforce a minimum squad size at registration, and later to stamp
-- matches.format for rating match-weight.

ALTER TABLE events ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'amateur'
  CHECK (tier IN ('amateur', 'semi_pro', 'pro', 'legends'));

CREATE INDEX IF NOT EXISTS idx_events_tier ON events(tier, status);

-- Nullable because existing events predate it; registration falls back to the
-- most permissive minimum when it is NULL.
ALTER TABLE events ADD COLUMN IF NOT EXISTS match_format TEXT
  CHECK (match_format IN ('5-a-side', '7-a-side', '11-a-side'));
