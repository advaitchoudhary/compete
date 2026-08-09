-- AllSports — Push Tokens & Notifications
-- Migration: 016_push_notifications
-- Run order: 16
--
-- The backend/src/modules/notifications/ directory has existed empty since the
-- project started. This is the first storage behind it.
--
-- A weekly-cadence product has no way to pull anyone back without push: a player
-- opens the app on match day and not otherwise. See spec §3.8.

-- ── Expo push tokens ────────────────────────────────────────────────────────
-- One row per device. The token is the unique key, not (user, device): the same
-- physical device can be handed to a different user, and Expo reissues tokens.
CREATE TABLE IF NOT EXISTS push_tokens (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token       TEXT NOT NULL UNIQUE,
  platform    TEXT CHECK (platform IN ('ios', 'android', 'web')),
  device_id   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON push_tokens(user_id);

-- ── In-app notification history ─────────────────────────────────────────────
-- Every push is also persisted, so the app has a list to show and a delivery
-- failure doesn't mean the player never learns what happened.
CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'fixtures_published' | 'match_next' | 'rating_ready'
  type        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  -- Deep-link payload, e.g. { "event_id": "…" } or { "match_id": "…" }
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON notifications(user_id) WHERE read_at IS NULL;
