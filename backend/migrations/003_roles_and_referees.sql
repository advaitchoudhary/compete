-- AllSports — Roles & Referee Approval
-- Migration: 003_roles_and_referees
-- Run order: 3
--
-- Adds a global user role (player / referee / admin) and the referee
-- application + approval workflow. Only approved referees can create matches
-- and add players; admins approve referee applications.

-- ============================================================
-- USER ROLE
-- ============================================================
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'player'
    CHECK (role IN ('player', 'referee', 'admin'));

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- ============================================================
-- REFEREE APPLICATIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS referee_applications (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Application details the applicant fills in
  full_name         TEXT NOT NULL,
  city              TEXT NOT NULL,
  phone             TEXT,
  experience_years  INT,
  -- Sport slugs the applicant can officiate, e.g. {'football','cricket'}
  sports            TEXT[],
  certification     TEXT,
  bio               TEXT,
  -- Workflow
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by       UUID REFERENCES users(id),
  reviewed_at       TIMESTAMPTZ,
  review_notes      TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- At most one *pending* application per user (re-applying after rejection is fine)
CREATE UNIQUE INDEX IF NOT EXISTS idx_referee_app_one_pending
  ON referee_applications(user_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_referee_app_status
  ON referee_applications(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_referee_app_user
  ON referee_applications(user_id, created_at DESC);

-- Reuse the shared updated_at trigger function from 001
CREATE TRIGGER trg_referee_applications_updated_at
  BEFORE UPDATE ON referee_applications FOR EACH ROW EXECUTE FUNCTION update_updated_at();
