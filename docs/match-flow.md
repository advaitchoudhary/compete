# End-to-End Match Flow

A complete walkthrough of a match from creation to final rating update.

---

## Overview

```
Organizer creates match
        │
        ▼
Match is scheduled (status: 'scheduled')
        │
        ▼
Scorer starts match (status: 'live')
        │
        ▼
Players submit stats → REST API or SQLite buffer
        │
        ▼
Home captain confirms ──────────────┐
Away captain confirms               │
        │                           │
        ▼                           │
Both confirmed → match completed ◄──┘
        │
        ▼
SQS message: { match_id, sport_id }
        │
        ▼
Rating engine processes match async
        │
        ▼
Ratings updated → Redis notification → app displays new rating
```

---

## Phase 1: Match Creation

**Endpoint:** `POST /v1/matches`

**Who:** Event organizer or team captain.

**Request body:**
```json
{
  "event_id": "uuid (optional — null for casual match)",
  "home_team_id": "uuid",
  "away_team_id": "uuid",
  "sport_id": "uuid",
  "venue": "DY Patil Stadium, Pune",
  "scheduled_at": "2024-03-15T09:00:00Z"
}
```

**What happens:**
- Match row inserted with `status = 'scheduled'`
- `home_confirmed = false`, `away_confirmed = false`
- `winner_team_id = null`

**Database state after:**
```sql
matches
  id:             "match-uuid"
  status:         'scheduled'
  home_confirmed: false
  away_confirmed: false
  started_at:     null
  completed_at:   null
```

---

## Phase 2: Match Goes Live

**Endpoint:** `POST /v1/matches/:id/start`

**Who:** Home team captain or event organizer.

**What happens:**
- `status` updated to `'live'`
- `started_at` set to `NOW()`
- Redis publishes: `match:{id}` → `{ type: 'match_started' }`
- All Socket.IO clients in the match room receive the event

**Mobile app response:**
- `LiveScorecard.tsx` receives `match_update` event
- UI transitions to active scoring mode
- Offline banner hidden (assuming connectivity)

---

## Phase 3: Stat Entry

This is where the offline-first design matters most.

### Online Path

```
Scorer taps "Submit" on LiveScorecard
        │
        ▼
generateUUID() → client_event_id
new Date().toISOString() → client_timestamp
        │
        ▼
POST /v1/matches/:id/stats
{
  user_id: "player-uuid",
  team_id: "team-uuid",
  stats: { goals: 1, assists: 0, passes: 42, tackles: 5 },
  client_event_id: "device-generated-uuid"
}
        │
        ▼
Backend: INSERT INTO match_player_stats
  ON CONFLICT (match_id, user_id) DO UPDATE SET stats = ...
        │
        ▼
Redis PUBLISH match:{id} →
  { type: 'stats_update', player_id: '...', stats: {...} }
        │
        ▼
Socket.IO broadcasts to all clients in room
        │
        ▼
All watching devices update live ticker
```

### Offline Path

```
Network is unavailable
        │
        ▼
queueStatEntry({
  match_id, user_id, team_id,
  stats_json: JSON.stringify(stats),
  client_event_id,
  client_timestamp
})
        │
        ▼
INSERT OR IGNORE INTO pending_stats (SQLite on device)
  — client_event_id UNIQUE ensures no double-queue
        │
        ▼
Amber banner: "OFFLINE — stats will sync when reconnected"
User continues scoring normally — UX identical
```

### Reconnection & Sync

```
Network restored → NetInfo fires isConnected: true
        │
        ▼
syncPendingStats() runs
        │
        ▼
getAllUnsyncedMatches() → [ 'match-uuid-1', ... ]
        │
        ▼
For each match:
  getPendingEntries(matchId) — ordered by client_timestamp
        │
        ▼
POST /v1/matches/:id/stats/batch
{
  entries: [
    { user_id, team_id, stats, client_event_id, client_timestamp },
    ...
  ]
}
        │
        ▼
Backend: sorted by client_timestamp, bulk INSERT
  ON CONFLICT (client_event_id) DO NOTHING
  → returns { synced: N, skipped: M }
        │
        ▼
markSynced(clientEventIds) — update SQLite rows
        │
        ▼
Banner clears: "Synced ✓"
```

**Idempotency guarantee:** If the batch request succeeds server-side but the response times out (flaky connection), the app will retry on next reconnect. The `client_event_id` UNIQUE constraint silently ignores duplicates — `skipped` count increments, no error thrown.

---

## Phase 4: Captain Confirmation

Both team captains must confirm the scorecard before ratings are processed. This is the anti-fraud gate.

### Home Captain Confirms

**Endpoint:** `POST /v1/matches/:id/confirm`

**Auth check:** The middleware verifies the requesting user is a `captain` or `vice_captain` in either team, or the team's `organizer_id`.

**What happens:**
```sql
UPDATE matches SET home_confirmed = true WHERE id = :matchId
```

**Response:**
```json
{
  "confirmed": true,
  "both_confirmed": false,
  "rating_computation_queued": false
}
```

Match status is still `'live'`. Away captain still needs to confirm.

### Away Captain Confirms

Same endpoint, same auth check. This time `both_confirmed` becomes true.

**What happens in the backend (all in one transaction):**

```
1. SET away_confirmed = true

2. Both confirmed? → yes

3. UPDATE matches SET
     status = 'completed',
     completed_at = NOW()

4. UPDATE match_player_stats SET
     confirmed_by_captain = true
   WHERE match_id = :matchId
   -- All submitted stats are now "official"

5. enqueueRatingJob({ match_id, sport_id, triggered_at })
   → SQS FIFO message

6. updateTeamStats(db, match)
   → INCREMENT wins/losses/draws on teams table

7. For each player in match_player_stats:
   a. emitFeedEvent({ actor_id: user_id, action_type: 'match_completed', ... })
   b. checkAchievements(user_id, sport_id, match_id)  ← fire-and-forget

8. Redis PUBLISH match:{id} → { type: 'match_completed' }
```

**Response:**
```json
{
  "confirmed": true,
  "both_confirmed": true,
  "rating_computation_queued": true
}
```

The SQS enqueue is the last critical action. If it fails, ratings are not computed. The endpoint returns an error — the captain can retry.

---

## Phase 5: Rating Computation (Async)

Happens independently of the API. The rating engine's SQS consumer picks up the message within seconds.

### SQS Consumer Loop

```python
while True:
    response = sqs.receive_message(
        QueueUrl=queue_url,
        MaxNumberOfMessages=5,
        WaitTimeSeconds=20,   # long poll
        VisibilityTimeout=120
    )
    for msg in messages:
        process_match(match_id, sport_id, db, redis)
        sqs.delete_message(ReceiptHandle=msg['ReceiptHandle'])
```

If `process_match` raises an exception, `delete_message` is NOT called. The message reappears after 120 seconds (VisibilityTimeout) and is retried automatically.

### `process_match` Step-by-Step

**Input:** `match_id`, `sport_id`

**Step 1: Load sport schema**
```sql
SELECT slug, stat_schema FROM sports WHERE id = :sport_id
```
`stat_schema` JSON defines weights for this sport's stats.

**Step 2: Load all player stats**
```sql
SELECT mps.user_id, mps.stats, mps.team_id,
       sp.current_rating, sp.matches_played, sp.wins,
       t.avg_rating as team_avg_rating
FROM match_player_stats mps
JOIN teams t ON t.id = mps.team_id
LEFT JOIN sport_profiles sp ON sp.user_id = mps.user_id AND sp.sport_id = :sport_id
WHERE mps.match_id = :match_id AND mps.confirmed_by_captain = true
```

Only `confirmed_by_captain = true` rows are processed. Stats submitted but not confirmed (e.g., entered after both captains confirmed) are ignored.

**Step 3: Compute team averages**
```python
team_ratings = {}
for row in player_rows:
    team_ratings.setdefault(row['team_id'], []).append(row['current_rating'] or 50.0)
team_avg = { tid: mean(rs) for tid, rs in team_ratings.items() }
```

**Step 4: For each player, compute rating**

```python
# Identify opponent team
opponent_team_id = the team that is not this player's team
opponent_avg = team_avg[opponent_team_id]  # defaults to 50.0

# Sport-specific preprocessing
# Cricket: adds strike_rate_bonus, economy_bonus
# Basketball: derives fg_percentage, three_percentage
processed_stats = preprocess_stats(sport_slug, raw_stats)

# Win bonus: 1-point flag in stats if player's team won
if match['winner_team_id'] == team_id:
    processed_stats['team_win_bonus'] = 1

# Performance score (0-100)
perf_score = compute_performance_score(processed_stats, stat_schema, opponent_avg)

# New overall rating (Elo-like)
new_rating = compute_new_rating(old_rating, perf_score, matches_played)

# Form rating (last 5 matches, exponential decay weighted)
recent_scores = last 4 from rating_history + current perf_score
form = compute_form_rating(recent_scores)
```

**Step 5: Write results**

```sql
-- Upsert sport profile
INSERT INTO sport_profiles (user_id, sport_id, current_rating, form_rating,
                             matches_played, wins, career_stats)
VALUES (:uid, :sid, :new_rating, :form, 1, :won, :career_json)
ON CONFLICT (user_id, sport_id) DO UPDATE SET
  current_rating  = :new_rating,
  form_rating     = :form,
  matches_played  = sport_profiles.matches_played + 1,
  wins            = sport_profiles.wins + :won,
  career_stats    = :career_json,
  updated_at      = NOW()

-- Immutable audit log (never updated)
INSERT INTO rating_history (user_id, sport_id, match_id,
                             rating_before, rating_after, performance_score)
VALUES (:uid, :sid, :mid, :old_rating, :new_rating, :perf_score)

-- Match rating (0-10 scale, displayed on scorecard)
UPDATE match_player_stats
SET match_rating = :perf_score / 10
WHERE match_id = :mid AND user_id = :uid
```

**Step 6: Notify via Redis**

```python
redis.publish(f"rating:{user_id}", json.dumps({
    "user_id":      user_id,
    "sport_id":     sport_id,
    "old_rating":   old_rating,
    "new_rating":   new_rating,
    "delta":        round(new_rating - old_rating, 2),
    "match_rating": round(perf_score / 10, 1),
}))

# Invalidate cached profile
redis.delete(f"sp:{user_id}:{sport_id}")
```

**Step 7: Database commit**

All updates for all players in the match are committed in a single transaction. If any write fails, the entire batch rolls back and the SQS message is retried.

---

## Phase 6: Live Notification (Mobile)

After Redis publishes `rating:{user_id}`:

```
Redis PUBLISH rating:{user_id} → { user_id, old_rating, new_rating, delta, match_rating }
        │
        ▼
Realtime service (psubscribe 'rating:*') receives message
        │
        ▼
Emits to Socket.IO room 'rating:{user_id}'
  event: 'rating_update'
  data:  { old_rating, new_rating, delta, match_rating }
        │
        ▼
Mobile app: onRatingUpdate handler fires
        │
        ▼
RatingCard animates: old rating → new rating
  (react-native-reanimated spring animation)
Delta displayed: "+4.2" in green / "-2.1" in red
        │
        ▼
If achievement unlocked:
  AchievementCard slides up
  User taps Share → react-native-view-shot captures card
  Native share sheet: Instagram Stories / WhatsApp Status
```

---

## Phase 7: Achievement Check (Async)

`checkAchievements` runs fire-and-forget after match completion. For each player:

```typescript
const profile = await db.selectFrom('sport_profiles')
  .selectAll()
  .where('user_id', '=', userId)
  .where('sport_id', '=', sportId)
  .executeTakeFirst()

// Check milestone thresholds
const checks = [
  { type: 'first_match',  condition: profile.matches_played === 1 },
  { type: 'matches_10',   condition: profile.matches_played === 10 },
  { type: 'matches_50',   condition: profile.matches_played === 50 },
  { type: 'matches_100',  condition: profile.matches_played === 100 },
  { type: 'first_win',    condition: profile.wins === 1 },
  { type: 'rating_60',    condition: profile.current_rating >= 60 },
  { type: 'rating_70',    condition: profile.current_rating >= 70 },
  { type: 'rating_80',    condition: profile.current_rating >= 80 },
  { type: 'rating_90',    condition: profile.current_rating >= 90 },
]

for (const { type, condition } of checks) {
  if (!condition) continue
  await db.insertInto('achievements')
    .values({ user_id: userId, sport_id: sportId, type, match_id: matchId })
    .onConflict((oc) => oc.doNothing())  // partial unique index prevents duplicates
    .execute()

  await emitFeedEvent({ actor_id: userId, action_type: 'achievement_earned', ... })
}
```

The `onConflict doNothing` is backed by a partial unique index on `(user_id, sport_id, type)` for milestone achievement types. A player can never earn "Rating 80" twice.

---

## Complete Timeline

```
T+0s   Scorer taps submit → POST /matches/:id/stats
T+0.1s Stat saved to Postgres
T+0.1s Redis PUBLISH match:{id}
T+0.2s Socket.IO broadcasts to all match room clients
T+0.2s All phones show live score update

[Match ends — coaches review scorecards]

T+Xm   Home captain taps Confirm → POST /matches/:id/confirm
T+Xm   Away captain taps Confirm → POST /matches/:id/confirm
T+Xm   Both confirmed:
         - Match status = 'completed'
         - SQS message enqueued (< 10ms)
         - Team records updated
         - Feed events written
T+Xm+2s SQS consumer picks up message (long poll, up to 20s delay)
T+Xm+5s Rating engine processes all players
T+Xm+6s Redis PUBLISH rating:{user_id} for each player
T+Xm+6s Realtime service emits rating_update to each player's room
T+Xm+6s Players see their new rating animate on screen
T+Xm+7s Achievement cards appear for unlocked milestones
```

---

## Error Scenarios

### Captain can't confirm — who can?

Any of:
- User with `role = 'captain'` or `'vice_captain'` in either team
- User who is `organizer_id` of either team

This handles real-world situations where the captain left their phone at home.

### Rating engine crashes mid-match

SQS `VisibilityTimeout = 120s`. After 2 minutes, the message reappears. The consumer retries. DB writes are transactional — a partial failure rolls back completely, so no partial ratings are written.

### Network drops during batch sync

Client retries on next reconnect. `client_event_id` deduplication makes all retries safe. The worst case is a player's stats arrive slightly delayed — they're still counted accurately.

### Both captains confirm simultaneously

Postgres handles this correctly. The `UPDATE matches SET home_confirmed = true` and `UPDATE matches SET away_confirmed = true` run as separate queries. The second captain to confirm reads `home_confirmed = true` back and triggers match completion. No race condition — Postgres row-level locking ensures both updates apply before the completion check reads the row.

### Match already completed — late stat submission

The `POST /matches/:id/stats` endpoint checks `match.status === 'completed'` and returns `409 Conflict`. Stats can only be submitted during `'live'` status.
