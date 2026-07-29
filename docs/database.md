# Database

PostgreSQL 14. All migrations live in `backend/migrations/`.

Run migrations:
```bash
cd backend && npm run db:migrate
```

---

## Migration Files

| File | What it does |
|------|-------------|
| `001_initial_schema.sql` | Creates all 14 tables, indexes, and triggers |
| `002_seed_sports.sql` | Inserts Cricket, Football, Badminton, Basketball with full stat schemas |

---

## Tables

### `sports`

The sport registry. One row per sport. Adding a new sport requires only inserting here — no code changes.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Primary key, auto-generated |
| `name` | TEXT | Display name: "Cricket", "Football" |
| `slug` | TEXT UNIQUE | URL-safe: "cricket", "football" |
| `stat_schema` | JSONB | Defines trackable stats, weights, positions — see below |
| `icon_url` | TEXT | Optional sport icon |
| `active` | BOOLEAN | Soft-disable a sport without deleting |
| `created_at` | TIMESTAMPTZ | Auto-set |

**`stat_schema` structure:**

```json
{
  "score_format": "goals",
  "match_stats": ["goals", "assists", "passes", "tackles", "saves"],
  "primary_metrics": {
    "goals": 3.0,
    "assists": 1.5,
    "clean_sheet": 2.0,
    "saves": 0.5
  },
  "penalty_metrics": {
    "yellow_cards": -0.5,
    "red_cards": -2.0
  },
  "efficiency_metrics": {},
  "positions": ["GK", "CB", "LB", "RB", "CDM", "CM", "CAM", "LW", "RW", "ST"],
  "max_stat_thresholds": {
    "goals": 15,
    "assists": 10,
    "saves": 20
  },
  "formats": ["5-a-side", "7-a-side", "11-a-side"]
}
```

The `primary_metrics` weights are what the rating algorithm uses. `max_stat_thresholds` define the normalization ceiling — a player with 15 goals gets a 1.0 (max) contribution from goals. `penalty_metrics` weights subtract from the score.

---

### `users`

One row per person. The identity anchor for the entire system.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Primary key |
| `phone` | TEXT UNIQUE | Phone number (from Firebase) |
| `name` | TEXT | Display name |
| `username` | TEXT UNIQUE | Optional — lowercase, numbers, underscores only |
| `avatar_url` | TEXT | Profile photo URL (S3) |
| `city` | TEXT | Used for leaderboard filtering |
| `bio` | TEXT | Short bio, max 200 chars |
| `firebase_uid` | TEXT UNIQUE | Links to Firebase Auth |
| `is_active` | BOOLEAN | Soft delete |
| `created_at` / `updated_at` | TIMESTAMPTZ | Auto-managed |

**Indexes:**
- `idx_users_username` — GIN trigram index for partial-name search
- `idx_users_city` — for filtering leaderboards by city

---

### `sport_profiles`

A player's identity within one specific sport. A user who plays football and cricket has two rows. This is where ratings live.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Primary key |
| `user_id` | UUID FK → users | |
| `sport_id` | UUID FK → sports | |
| `position` | TEXT | e.g., "ST" for football, "Bowler" for cricket |
| `current_rating` | NUMERIC(5,2) | 0–100, default 50. Written by rating engine |
| `form_rating` | NUMERIC(5,2) | Rolling average of last 5 match performance scores |
| `matches_played` | INT | Career match count |
| `wins` | INT | Career win count |
| `career_stats` | JSONB | Running totals: `{"goals": 42, "assists": 18, ...}` |
| `created_at` / `updated_at` | TIMESTAMPTZ | |

**Constraint:** `UNIQUE(user_id, sport_id)` — one profile per player per sport.

**Indexes:**
- `idx_sport_profiles_user` — look up all sports for a player
- `idx_sport_profiles_rating` — leaderboard query: ORDER BY rating DESC per sport

---

### `teams`

A team belongs to one sport and one organizer. Aggregated win/loss counters are cached here (not computed on-the-fly) so the team card renders fast.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | Primary key |
| `name` | TEXT | |
| `sport_id` | UUID FK → sports | |
| `city` | TEXT | |
| `organizer_id` | UUID FK → users | The team creator |
| `avatar_url` | TEXT | Team logo |
| `cover_url` | TEXT | Team banner |
| `founded_at` | DATE | Optional |
| `wins` / `losses` / `draws` | INT | Incremented on match confirm |
| `avg_rating` | NUMERIC(5,2) | Cached average of players' current_rating. Used as opposition strength input in rating algorithm |

---

### `team_members`

Junction table. Links users to teams.

| Column | Type | Notes |
|--------|------|-------|
| `team_id` | UUID FK → teams | |
| `user_id` | UUID FK → users | |
| `role` | TEXT | `captain` · `vice_captain` · `player` · `coach` |
| `jersey_no` | SMALLINT | Optional |
| `joined_at` | TIMESTAMPTZ | |
| `is_active` | BOOLEAN | Soft-remove from team |

**Constraint:** `PRIMARY KEY (team_id, user_id)`
**Role constraint:** `CHECK (role IN ('captain','vice_captain','player','coach'))`

---

### `events`

A tournament, league, or casual event.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | |
| `name` | TEXT | |
| `sport_id` | UUID FK → sports | |
| `organizer_id` | UUID FK → users | |
| `format` | TEXT | `knockout` · `league` · `round_robin` · `group_knockout` · `casual` |
| `city` | TEXT | |
| `venue` | TEXT | Optional |
| `status` | TEXT | `upcoming` → `registration` → `active` → `completed` |
| `starts_at` / `ends_at` | TIMESTAMPTZ | |
| `max_teams` | INT | Capacity cap. NULL = unlimited |
| `entry_fee` | INT | In paise. 0 = free. 50000 = ₹500 |
| `prize_pool` | INT | In paise |
| `rules` | JSONB | Format-specific config (points per win, group sizes, etc.) |

**Paise** (not rupees): Prevents floating point money bugs. ₹500 entry fee stored as `50000`.

---

### `event_teams`

Registers teams into events.

| Column | Type | Notes |
|--------|------|-------|
| `event_id` | UUID FK → events | |
| `team_id` | UUID FK → teams | |
| `seed` | INT | For bracket seeding |
| `group_no` | TEXT | e.g., "A", "B" for group stage |
| `points` | INT | League format standings points |

**Constraint:** `PRIMARY KEY (event_id, team_id)` — a team can only register once per event.

---

### `matches`

Each game. Can be attached to an event or be standalone.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | |
| `event_id` | UUID FK → events | NULL for casual matches |
| `sport_id` | UUID FK → sports | |
| `home_team_id` / `away_team_id` | UUID FK → teams | |
| `venue` | TEXT | Optional |
| `round` | TEXT | "QF", "SF", "Final", "Group A", etc. |
| `scheduled_at` | TIMESTAMPTZ | |
| `started_at` | TIMESTAMPTZ | Set when status → live |
| `completed_at` | TIMESTAMPTZ | Set when both captains confirm |
| `status` | TEXT | `scheduled` → `live` → `completed` |
| `home_score` | JSONB | `{"runs":145,"wickets":6}` or `{"goals":2}` |
| `away_score` | JSONB | |
| `winner_team_id` | UUID FK → teams | NULL for draws |
| `home_confirmed` | BOOLEAN | Home captain signed off |
| `away_confirmed` | BOOLEAN | Away captain signed off |

**Critical:** Ratings only process when BOTH `home_confirmed` AND `away_confirmed` are `true`.

---

### `match_player_stats` ← Most Important Table

One row per player per match. All sport stats live here as JSONB.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | |
| `match_id` | UUID FK → matches | |
| `user_id` | UUID FK → users | |
| `team_id` | UUID FK → teams | |
| `sport_id` | UUID FK → sports | Denormalized for query performance |
| `stats` | JSONB | All sport-specific stats |
| `match_rating` | NUMERIC(4,2) | 0–10 match rating, written by rating engine after computation |
| `confirmed_by_captain` | BOOLEAN | Flipped to true when both captains confirm |
| `entered_by` | UUID FK → users | Who submitted the stats (scorer) |
| `client_event_id` | UUID UNIQUE | Device-generated UUID — idempotency key for offline sync |

**Constraint:** `UNIQUE(match_id, user_id)` — one stat row per player per match.
**Idempotency:** The `client_event_id` unique constraint means the same offline entry submitted twice is silently ignored.

**Example stats by sport:**
```json
// Cricket
{"runs":45,"balls_faced":38,"fours":4,"sixes":1,"out":true,"dismissal":"caught",
 "overs_bowled":"4.0","wickets":2,"runs_conceded":28,"maidens":0}

// Football
{"goals":1,"assists":0,"shots":3,"passes":42,"tackles":5,"yellow_cards":0}

// Basketball
{"points":18,"rebounds":7,"assists":4,"steals":2,"blocks":1,
 "turnovers":2,"fg_made":7,"fg_attempted":14}

// Badminton
{"points_won":42,"points_lost":38,"aces":5,"smashes":12,"errors":8,"sets_won":2,"sets_lost":1}
```

---

### `rating_history`

An immutable append-only audit log of every rating change. Never updated, only inserted.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | |
| `user_id` | UUID FK → users | |
| `sport_id` | UUID FK → sports | |
| `match_id` | UUID FK → matches | Which match caused this change |
| `rating_before` | NUMERIC(5,2) | Rating before the match |
| `rating_after` | NUMERIC(5,2) | Rating after the match |
| `performance_score` | NUMERIC(5,2) | The 0–100 score for this match |
| `delta` | NUMERIC(5,2) GENERATED | `rating_after - rating_before`, computed by PostgreSQL |

**Immutable by design.** No UPDATE is ever run on this table. It's the source of truth for "how has this player's rating changed over time" and powers the sparkline chart.

---

### `achievements`

Badges earned by players. Milestone-based — first match, 100 matches, rating reaching 70, 80, 90, etc.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | |
| `user_id` | UUID FK → users | |
| `sport_id` | UUID FK → sports | NULL for cross-sport achievements |
| `type` | TEXT | `first_match`, `matches_100`, `rating_80`, `first_win`, etc. |
| `data` | JSONB | Achievement-specific context |
| `match_id` | UUID FK → matches | The match that triggered this achievement |

**Partial unique index:**
```sql
CREATE UNIQUE INDEX idx_achievements_unique_type
  ON achievements(user_id, sport_id, type)
  WHERE type IN ('first_match','first_win','100_matches','rating_60','rating_70','rating_80','rating_90');
```
This prevents duplicate one-time achievements at the database level. Even if `checkAchievements` runs twice, the second insert silently fails.

---

### `follows`

Follow graph. Simple junction table.

| Column | Type | Notes |
|--------|------|-------|
| `follower_id` | UUID FK → users | Who is following |
| `following_id` | UUID FK → users | Who is being followed |

**Constraint:** `CHECK (follower_id != following_id)` — prevents self-follow at the database level.

---

### `feed_events`

Activity feed storage. Uses fan-out-on-write: when something happens, one row is inserted per event. Reads are then a simple `SELECT WHERE actor_id IN (following_ids)`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | |
| `actor_id` | UUID FK → users | Who performed the action |
| `action_type` | TEXT | `match_completed` · `achievement_earned` · `rating_milestone` |
| `entity_type` | TEXT | `match` · `achievement` · `sport_profile` |
| `entity_id` | UUID | The ID of the referenced entity |
| `payload` | JSONB | Pre-rendered display data — avoids joins on feed reads |

The `payload` blob is intentionally pre-populated at write time so the feed API doesn't need to join multiple tables per item at read time.

---

### `organizer_scores`

Anti-fraud layer. Tracks reputation score per organizer.

| Column | Type | Notes |
|--------|------|-------|
| `user_id` | UUID PK | One row per organizer |
| `trust_score` | NUMERIC(4,2) | 0–100. Starts at 80. Decrements on fraud flags |
| `total_events` | INT | How many events they've run |
| `flagged_events` | INT | Events flagged for suspicious data |

Future use: low-trust organizer events are held for manual review before affecting ratings.

---

## Indexes Summary

| Table | Index | Purpose |
|-------|-------|---------|
| `users` | `gin(username gin_trgm_ops)` | Partial-name search |
| `sport_profiles` | `(sport_id, current_rating DESC)` | Leaderboard query |
| `matches` | `(status, scheduled_at)` | Browse active matches |
| `matches` | `(home_team_id, away_team_id)` | Team history |
| `match_player_stats` | `(match_id)` | Load all stats for a match |
| `match_player_stats` | `(user_id, sport_id)` | Player career history |
| `rating_history` | `(user_id, sport_id, created_at DESC)` | Sparkline chart |
| `feed_events` | `(actor_id, created_at DESC)` | Feed pagination |

---

## Triggers

Five tables have an `updated_at` trigger:

```sql
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

Applied to: `users`, `sport_profiles`, `teams`, `events`, `matches`. Any UPDATE on these tables automatically stamps `updated_at = NOW()` without the application code needing to set it.

---

## Entity Relationship Summary

```
users
  ├── sport_profiles (one per sport)
  │     └── rating_history (one per match)
  ├── team_members → teams
  │                    └── event_teams → events
  ├── matches (as home/away team member)
  │     └── match_player_stats (one per player)
  ├── achievements
  ├── follows (follower ↔ following)
  ├── feed_events (activity log)
  └── organizer_scores (anti-fraud)
```
