-- AllSports — Guest Players
-- Migration: 005_guest_players
-- Run order: 5
--
-- A guest is a real `users` identity with NO login credentials yet
-- (phone/firebase_uid are NULL). A referee creates one to record the
-- performance of someone who hasn't signed up. The row accumulates ratings
-- and stats like any user, but is hidden from public leaderboards until a
-- real person "claims" it (attaches credentials → flips is_guest=false).

-- 1. Login credentials become optional (guests have none)
ALTER TABLE users ALTER COLUMN phone DROP NOT NULL;
ALTER TABLE users ALTER COLUMN firebase_uid DROP NOT NULL;

-- 2. Replace the strict UNIQUE constraints with partial-unique indexes so
--    many guests can coexist with NULL phone/firebase_uid, while real users
--    stay unique.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_phone_key;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_firebase_uid_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_unique
  ON users(phone) WHERE phone IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_firebase_uid_unique
  ON users(firebase_uid) WHERE firebase_uid IS NOT NULL;

-- 3. Guest metadata
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_guest BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_is_guest ON users(is_guest) WHERE is_guest = true;
