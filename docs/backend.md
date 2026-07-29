# Backend Service

Node.js 20 · TypeScript · Fastify
Location: `backend/`
Port: `3000`

---

## Start

```bash
cd backend
cp .env.example .env    # fill in Firebase credentials
npm install
npm run db:migrate
npm run dev
```

---

## Directory Structure

```
backend/
├── migrations/
│   ├── 001_initial_schema.sql    # all tables
│   └── 002_seed_sports.sql       # sport stat schemas
├── src/
│   ├── app.ts                    # entrypoint
│   ├── modules/
│   │   ├── auth/
│   │   │   ├── auth.routes.ts    # POST /auth/verify
│   │   │   └── auth.service.ts   # Firebase + JWT helpers
│   │   ├── users/
│   │   │   └── users.routes.ts   # GET/PUT profile, follow, feed
│   │   ├── sports/
│   │   │   └── sports.routes.ts  # GET sports, leaderboards
│   │   ├── teams/
│   │   │   └── teams.routes.ts   # CRUD teams + members
│   │   ├── events/
│   │   │   └── events.routes.ts  # CRUD events + registration
│   │   ├── matches/
│   │   │   └── matches.routes.ts # match lifecycle
│   │   ├── scores/
│   │   │   └── scores.routes.ts  # stat entry, offline sync, confirm
│   │   ├── feed/
│   │   │   └── feed.service.ts   # write to activity feed
│   │   └── achievements/
│   │       ├── achievements.routes.ts
│   │       └── achievements.service.ts
│   ├── shared/
│   │   ├── db/
│   │   │   ├── client.ts         # Kysely PostgreSQL pool
│   │   │   └── types.ts          # TypeScript ↔ DB type contract
│   │   ├── redis/
│   │   │   └── client.ts         # Redis + Pub/Sub + key builders
│   │   ├── queue/
│   │   │   └── sqs.ts            # SQS producer
│   │   └── middleware/
│   │       └── auth.ts           # requireAuth preHandler
│   └── tests/
│       ├── setup.ts              # test env setup
│       └── scores.test.ts        # integration tests
├── .env.example
├── Dockerfile                    # multi-stage (dev + production)
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

---

## `app.ts` — Entrypoint

What runs when you start the server.

**Order of operations:**
1. `initFirebase()` — initializes Firebase Admin SDK before any request arrives
2. Creates Fastify instance with structured logging (pretty in dev, JSON in production)
3. Registers security plugins:
   - `@fastify/cors` — controls which origins can call the API
   - `@fastify/helmet` — sets HTTP security headers (XSS, clickjacking protection)
   - `@fastify/jwt` — makes `request.jwtVerify()` available to all route handlers
   - `@fastify/rate-limit` — 100 requests/minute/IP cap
4. Registers `GET /health` — load balancer health check endpoint
5. Registers all eight route modules under `/v1` prefix
6. Sets global error handler — hides internals in production, shows details in dev

---

## `shared/db/client.ts`

Creates a singleton PostgreSQL connection pool using `pg`. Max 20 connections — right for t3.micro RDS.

Returns a **Kysely** query builder instance. Kysely provides type-safe SQL: if you query a column that doesn't exist, TypeScript catches it at compile time.

```typescript
// Example — TypeScript knows exactly what columns exist
const user = await db
  .selectFrom('users')
  .select(['id', 'name', 'current_rating'])  // ← error: 'current_rating' not on users
  .where('id', '=', userId)
  .executeTakeFirst()
```

---

## `shared/db/types.ts`

The type contract between code and database. Every table has a corresponding TypeScript interface.

**Kysely type wrappers:**
- `Generated<T>` — column auto-populated by the database (UUID primary keys, timestamps, defaults). Optional on INSERT, always present on SELECT
- `JSONColumnType<T>` — JSONB column. Can be read as type `T`, written as a string
- `ColumnType<Read, Insert, Update>` — for the `delta` generated column: readable, but never writable

The `Database` interface at the bottom registers all 14 tables so Kysely knows what `.selectFrom('match_player_stats')` means at compile time.

---

## `shared/redis/client.ts`

Manages three Redis connections:
- **`redisClient`** — general cache reads/writes
- **`redisPubClient`** — dedicated publisher
- **`redisSubClient`** — dedicated subscriber

Redis requires separate connections for pub/sub — a subscribed connection cannot run regular commands. This is a Redis protocol constraint, not a design choice.

**`CacheKeys`** — centralized key builder. All cache keys are defined here:
```typescript
CacheKeys.leaderboard('football-uuid', 'Pune', 'week')
// → "lb:football-uuid:Pune:week"
```

**`PubSubChannels`** — centralized channel builder:
```typescript
PubSubChannels.matchUpdate('match-uuid')
// → "match:match-uuid"
```

---

## `shared/queue/sqs.ts`

Produces messages to the rating queue. One function: `enqueueRatingJob`.

```typescript
await enqueueRatingJob({
  match_id: "...",
  sport_id: "...",
  triggered_at: new Date().toISOString()
})
```

Uses FIFO queue features:
- `MessageGroupId: match_id` — all messages for the same match are in the same FIFO group
- `MessageDeduplicationId: "rating-{match_id}"` — if the same match is enqueued twice, SQS drops the duplicate

In local development, points to LocalStack at `http://localhost:4566`.

---

## `shared/middleware/auth.ts`

One function: `requireAuth`. Used as `preHandler` on protected routes.

Calls `request.jwtVerify()`, extracts `sub` from the JWT payload (which is the user's UUID), and attaches it to `request.userId`. Every authenticated handler then reads `request.userId` without needing to decode the JWT again.

```typescript
app.post('/teams', { preHandler: requireAuth }, async (request, reply) => {
  // request.userId is guaranteed to be populated here
  const creatorId = request.userId
})
```

---

## Modules

### `modules/auth/`

**`auth.service.ts`**
- `initFirebase()` — initializes Firebase Admin SDK once using service account env vars
- `verifyFirebaseToken(idToken)` — calls `admin.auth().verifyIdToken()`. Returns UID and phone number if valid, null if invalid
- `issueJwt(app, userId)` — creates our own JWT with `{ sub: userId }` payload using Fastify's JWT plugin

**`auth.routes.ts`** — `POST /v1/auth/verify`

The entire authentication flow in one endpoint:

```
Client (Firebase OTP verified) → sends firebase_id_token
  → verifyFirebaseToken(token) → Firebase Admin SDK validates
  → look up user by firebase_uid
  → if not found: create user (requires name in body)
  → issueJwt(userId)
  → return { access_token, user, is_new_user }
```

The mobile app stores `access_token` and uses it for all subsequent requests. Firebase is never contacted again after this.

---

### `modules/users/`

**`users.routes.ts`**

`GET /users/:id`
Returns public profile + all sport profiles (with ratings) + follower/following counts. Runs follower count queries in parallel with `Promise.all`.

`PUT /users/me`
Update own profile. Validates username uniqueness before saving (checks no other user has the same username). Uses Zod for input validation — `username` must match `/^[a-z0-9_]+$/`.

`GET /users/:id/stats/:sportSlug`
Career stats for one sport. Returns sport profile + last 10 entries from `rating_history` — powers the sparkline chart on the profile screen.

`POST /users/:id/follow` / `DELETE /users/:id/follow`
Follow and unfollow. The insert uses `onConflict doNothing` — following someone you already follow is silently idempotent, not an error.

`GET /users/:id/feed`
Activity feed. Fetches IDs of everyone the user follows, then queries `feed_events` where actor is any of those people (including the user themselves). Cursor-based pagination on `created_at` — more efficient than offset pagination on large feeds.

---

### `modules/sports/`

**`sports.routes.ts`**

`GET /sports`
Lists all active sports. Simple query. Called by the mobile app on startup to populate sport selection.

`GET /sports/:slug`
Returns full sport detail including `stat_schema`. Mobile app calls this to know what stat fields to render on the scorecard entry form.

`GET /leaderboards?sport=&city=&period=`
City leaderboard. The most frequently-read, most expensive query — so it's cached in Redis for 5 minutes. Cache key: `lb:{sport_id}:{city}:{period}`.

Filters: minimum 3 matches played (prevents brand-new players with one lucky game at the top), ordered by `current_rating DESC`. Returns ranked array with `rank` field added.

---

### `modules/teams/`

**`teams.routes.ts`**

`POST /teams`
Creates a team. Wrapped in a database **transaction** — the `teams` insert and the automatic `team_members` insert (adding creator as captain) are atomic. If either fails, neither persists.

`GET /teams/:id`
Team detail with full roster. Joins `team_members` → `users` → `sport_profiles` so each player's current rating appears alongside their role.

`GET /teams?sport=&city=`
Browse teams. Filterable by sport and city.

`POST /teams/:id/members`
Add a player to a team. Authorization checks: requester must be team organizer or a captain/vice-captain. Uses `onConflict doUpdateSet` — re-adding a previously removed player (is_active=false) reactivates them rather than erroring.

---

### `modules/events/`

**`events.routes.ts`**

`POST /events`
Creates a tournament. Validates sport exists. Entry fee and prize pool stored in paise. Initializes an `organizer_scores` row for the creator on first event.

`GET /events?sport=&city=&status=`
Browse events. Cursor pagination on `starts_at`.

`GET /events/:id`
Event detail including registered teams and all matches.

`POST /events/:id/teams`
Register a team. Multiple guards:
- Event must be in `upcoming` or `registration` status
- Requester must be team captain or organizer
- If `max_teams` is set, checks current count before allowing

`PATCH /events/:id/status`
Move event through lifecycle: `upcoming` → `registration` → `active` → `completed`.

---

### `modules/matches/`

**`matches.routes.ts`**

`POST /matches`
Create a match. Can be attached to an event or standalone. Rejects same team playing itself (returns 400).

`GET /matches/:id`
Match detail with all player stats and team info in one response.

`PATCH /matches/:id/start`
Marks match as `live`, records `started_at`. Publishes `match_started` to Redis → real-time service broadcasts to all watching phones.

`PATCH /matches/:id/score`
Updates team score during a live match. Publishes `score_update` to Redis.

**`assertMatchAccess` (private)**
Called by mutation endpoints. Checks the requesting user is organizer of either team, or organizer of the event. Prevents unauthorized match modification.

---

### `modules/scores/` ← Most Important Module

**`scores.routes.ts`**

Three endpoints that handle the complete scoring lifecycle.

---

**`POST /matches/:id/stats`** — Online stat submission

Submit stats for one player.
- Validates match isn't completed
- Upserts to `match_player_stats` — re-submitting overwrites (correcting a mistake is supported)
- After save: publishes to Redis → Socket.IO broadcasts to live match watchers

---

**`POST /matches/:id/stats/batch`** — Offline sync

Receives all stats buffered on device during offline period.
- Sorts entries by `client_timestamp` (ensures chronological order)
- Upserts all entries — `onConflict` on `client_event_id` means the same entry submitted twice is silently ignored (idempotent)
- Returns `{ synced: N, skipped: N }` so the device knows what was new

---

**`POST /matches/:id/confirm`** — Captain confirmation

The trigger point for the entire rating system.

1. Checks requester is a captain, vice-captain, or organizer of either team
2. Updates the appropriate confirmation flag (`home_confirmed` or `away_confirmed`)
3. If **both are now true**:
   - Sets match status to `completed`
   - Sets `confirmed_by_captain = true` on all player stats
   - Sends rating job to SQS
   - Calls `updateTeamStats` (increments wins/losses/draws)
   - Creates `feed_events` for every player
   - Fires `checkAchievements` asynchronously (non-blocking)
   - Publishes `match_completed` to Redis

If only one captain has confirmed, returns immediately and waits for the other.

---

**`updateTeamStats` (private)**
Updates team win/loss/draw counters based on the match winner. Uses `db.raw('wins + 1')` for atomic increments — safe under concurrent requests.

---

### `modules/feed/`

**`feed.service.ts`** — `emitFeedEvent(input)`
Single function. Inserts one row into `feed_events`. Called by the scores module after match completion and by the achievements module when badges are earned. Fan-out-on-write pattern: write at event time, read later cheaply.

---

### `modules/achievements/`

**`achievements.service.ts`**

`checkAchievements(userId, sportId, matchId)`
Called after every confirmed match. Reads the player's updated sport profile. Checks two milestone lists:
- Match count: `first_match`, `matches_10`, `matches_50`, `matches_100`, `matches_200`
- Rating level: 60, 70, 75, 80, 85, 90, 95

For each milestone that now applies, tries to insert. The partial unique index at the database level silently blocks duplicates — the function uses `onConflict doNothing`. For each new badge, also calls `emitFeedEvent`.

`getUserAchievements(userId, sportSlug?)`
Returns all achievements for a player, optionally filtered by sport.

**`achievements.routes.ts`**
`GET /users/:id/achievements?sport=` — Returns achievements list.

---

## API Endpoints Summary

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/v1/auth/verify` | — | Firebase token → JWT |
| GET | `/v1/users/:id` | — | Public profile |
| PUT | `/v1/users/me` | ✓ | Update own profile |
| GET | `/v1/users/:id/stats/:sportSlug` | — | Career stats |
| POST | `/v1/users/:id/follow` | ✓ | Follow player |
| DELETE | `/v1/users/:id/follow` | ✓ | Unfollow |
| GET | `/v1/users/:id/feed` | — | Activity feed |
| GET | `/v1/sports` | — | List sports |
| GET | `/v1/sports/:slug` | — | Sport detail |
| GET | `/v1/leaderboards` | — | City leaderboard |
| POST | `/v1/teams` | ✓ | Create team |
| GET | `/v1/teams/:id` | — | Team + roster |
| GET | `/v1/teams` | — | Browse teams |
| POST | `/v1/teams/:id/members` | ✓ | Add member |
| POST | `/v1/events` | ✓ | Create event |
| GET | `/v1/events` | — | Browse events |
| GET | `/v1/events/:id` | — | Event detail |
| POST | `/v1/events/:id/teams` | ✓ | Register team |
| PATCH | `/v1/events/:id/status` | ✓ | Update event status |
| POST | `/v1/matches` | ✓ | Create match |
| GET | `/v1/matches/:id` | — | Match detail |
| PATCH | `/v1/matches/:id/start` | ✓ | Start match |
| PATCH | `/v1/matches/:id/score` | ✓ | Update score |
| POST | `/v1/matches/:id/stats` | ✓ | Submit player stats (online) |
| POST | `/v1/matches/:id/stats/batch` | ✓ | Batch sync (offline) |
| POST | `/v1/matches/:id/confirm` | ✓ | Captain confirmation |
| GET | `/v1/users/:id/achievements` | — | Player achievements |
| GET | `/health` | — | Health check |

---

## Environment Variables

See `.env.example` for full reference.

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | ✓ | PostgreSQL connection string |
| `REDIS_URL` | ✓ | Redis connection URL |
| `JWT_SECRET` | ✓ | Min 32 characters |
| `FIREBASE_PROJECT_ID` | ✓ | Firebase project ID |
| `FIREBASE_CLIENT_EMAIL` | ✓ | Service account email |
| `FIREBASE_PRIVATE_KEY` | ✓ | Service account private key |
| `SQS_RATING_QUEUE_URL` | ✓ | Full SQS queue URL |
| `AWS_REGION` | ✓ | e.g., `ap-south-1` |
| `PORT` | — | Default: 3000 |
| `NODE_ENV` | — | `development` or `production` |

---

## Tests

```bash
cd backend && npm test
```

Uses **Vitest**. Firebase and SQS are mocked via `vi.mock` so tests run without cloud credentials.

Key test file: `src/tests/scores.test.ts`
- Verifies sports endpoint returns all 4 sports
- Verifies auth creates users
- Verifies unauthenticated requests are rejected
- Verifies same-team matches are rejected
- Documents the offline idempotency behavior
