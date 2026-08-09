-- AllSports — Organizer Role
-- Migration: 009_organizer_role
-- Run order: 9
--
-- Turf/venue owners who run tournaments get a first-class, admin-verified role.
-- Reuses referee_applications as the review queue via request_type='organizer',
-- so the existing admin approve/reject flow and UI serve both journeys.
--
-- An organizer may create events and schedule matches. An organizer may NEVER
-- score a match — scoring stays gated to the assigned, tier-approved referee.

-- ── Add 'organizer' to the role check ───────────────────────────────────────
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('player', 'referee', 'organizer', 'admin'));

-- ── Applications double as organizer requests ───────────────────────────────
ALTER TABLE referee_applications DROP CONSTRAINT IF EXISTS referee_applications_request_type_check;
ALTER TABLE referee_applications ADD CONSTRAINT referee_applications_request_type_check
  CHECK (request_type IN ('initial', 'upgrade', 'organizer'));

-- Admin queue filters by request_type when triaging organizers vs referees.
CREATE INDEX IF NOT EXISTS idx_referee_applications_request_type
  ON referee_applications(request_type, status, created_at DESC);
