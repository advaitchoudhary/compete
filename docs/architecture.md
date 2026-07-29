# Architecture

## Overview

AllSports is built as four separate programs that communicate through a shared database and a message bus. No program talks directly to another program — they communicate through data stores.

```
PHONE
  │
  ├──── REST (HTTPS) ─────────────▶  backend/        Node.js + Fastify    port 3000
  ├──── WebSocket ────────────────▶  realtime/       Node.js + Socket.IO  port 3001
  │
BACKEND
  ├──── reads/writes ─────────────▶  PostgreSQL 14   source of truth      port 5432
  ├──── cache + pub/sub ──────────▶  Redis 7         leaderboard cache    port 6379
  └──── enqueues jobs ────────────▶  AWS SQS FIFO    async rating trigger
                                          │
                                          ▼
                                     rating-engine/  Python + FastAPI     port 8000
                                          │
                                          ├──── writes ratings ──▶  PostgreSQL
                                          └──── notifies ────────▶  Redis (→ WebSocket → phone)
```

---

## Why This Structure

### Backend is a Modular Monolith

One deployable Node.js process with eight internal modules (auth, users, sports, teams, events, matches, scores, achievements). Not microservices. Reasons:

- A small team needs speed of iteration, not deployment independence
- All modules share the same database connection pool — cheaper, simpler
- Module boundaries are enforced by TypeScript imports, not network calls
- When a bottleneck is proven, one module can be extracted into a service — but premature extraction is waste

### Rating Engine is Separate from Day One

Three reasons to isolate it:

1. **Language**: Python is better for numerical computation and has scikit-learn/pytorch if we upgrade to ML
2. **Scaling**: Rating computation is CPU-bound and bursty — after a popular tournament ends, dozens of matches complete at once. This service can scale up independently of the REST API
3. **Failure isolation**: If the rating engine crashes, matches still complete and stats still save. Ratings just catch up when it recovers

### Real-time Service is Separate

WebSocket connections scale differently from HTTP. HTTP is stateless — any server can handle any request. WebSocket is stateful — a client is pinned to the server it connected to. Keeping it separate means you can put the WebSocket service behind a different load balancer (with sticky sessions) without affecting the REST API.

---

## Service Communication Map

```
┌─────────────────────────────────────────────────────────────────────┐
│                              CLIENTS                                │
│           React Native (iOS + Android)  ·  Web Dashboard           │
└────────────────────┬───────────────────────────┬────────────────────┘
                     │ HTTPS REST                 │ WebSocket
                     ▼                            ▼
       ┌─────────────────────┐       ┌─────────────────────┐
       │      Backend        │       │    Real-time Svc     │
       │  Node.js / Fastify  │       │  Node.js / Socket.IO │
       │      port 3000      │       │       port 3001      │
       └──────┬──────────────┘       └────────────┬────────┘
              │                                   │
         reads/writes                        subscribes
              │                                   │
              ▼                                   ▼
       ┌─────────────┐                   ┌────────────────┐
       │  PostgreSQL  │                   │     Redis      │
       │  port 5432   │◀── writes ───────│   port 6379    │◀── publishes
       └─────────────┘         (ratings) └────────────────┘   (backend)
                                                 ▲
                                                 │ publishes
                                        ┌────────┴────────┐
                                        │  Rating Engine   │
                                        │ Python / FastAPI │
                                        │    port 8000     │
                                        └────────┬────────┘
                                                 │ consumes
                                                 ▼
                                           ┌──────────┐
                                           │ AWS SQS  │
                                           │  (FIFO)  │
                                           └──────────┘
                                                 ▲
                                                 │ enqueues
                                             Backend
                                        (on match confirm)
```

---

## Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Mobile | React Native + Expo | Single codebase for iOS + Android. Expo handles OTA updates |
| Backend framework | Fastify (Node.js) | 2–3× faster than Express, plugin architecture, TypeScript-first |
| Query builder | Kysely | Type-safe SQL — wrong column names caught at compile time |
| Real-time | Socket.IO v4 | Handles reconnection, rooms, fallback to polling |
| Rating engine | Python + FastAPI | Best ecosystem for numerical computation, ML-upgradeable |
| Database | PostgreSQL 14 | JSONB for sport-agnostic stats, strong ACID guarantees |
| Cache | Redis 7 | Leaderboard caching (sorted sets), Pub/Sub, session data |
| Message queue | AWS SQS FIFO | Managed, exactly-once delivery, decouples rating from API |
| Auth | Firebase Phone Auth | Handles SMS OTP delivery in India. Firebase Admin SDK verifies |
| JWT | @fastify/jwt | Short-lived JWTs issued after Firebase verification |
| State (mobile) | Zustand + React Query | Zustand for UI state, React Query for server-state caching |
| Offline DB | expo-sqlite | Persistent SQLite on device for scorecard buffer |
| Storage | MMKV | 10× faster than AsyncStorage for token persistence |
| Infrastructure | AWS ECS Fargate | Serverless containers — no EC2 management |
| Region | ap-south-1 (Mumbai) | Lowest latency for India |

---

## Key Design Decisions

### JSONB for Sport-Specific Stats

Each sport tracks different statistics. A football player has goals and assists. A cricket player has runs and wickets. A basketball player has points and rebounds.

**Option considered: separate table per sport**
Clean schema but requires a migration every time a new sport is added. Inflexible.

**Option chosen: JSONB column in `match_player_stats`**
```
cricket: {"runs":45,"balls_faced":38,"fours":4,"sixes":1,"wickets":2}
football: {"goals":1,"assists":0,"passes":42,"tackles":5}
basketball: {"points":18,"rebounds":7,"assists":4,"fg_made":7,"fg_attempted":14}
```
Adding a new sport means inserting one row in the `sports` table with a `stat_schema` definition. Zero migrations. Zero code changes in the backend. The rating engine handles new sports automatically via the schema.

### Offline-First Scoring

A scorer at a cricket ground in Surat may have intermittent 4G. The match cannot depend on connectivity.

**Solution**: Every stat entry generates a UUID on the device (`client_event_id`) and a timestamp. Online: submit immediately. Offline: save to SQLite. On reconnect: batch sync with idempotency guaranteed by `client_event_id` — the database's unique constraint silently ignores duplicates.

### Dual Captain Confirmation (Anti-Fraud)

Player ratings are meaningful only if the underlying data is trustworthy. Without a verification step, a scorer could inflate their own stats.

**Solution**: Both team captains must confirm the scorecard before any rating job is dispatched. The rating engine only processes `confirmed_by_captain = true` stats. An organizer's `trust_score` in the `organizer_scores` table decrements if their events produce flagged data.

### SQS-Decoupled Ratings

Rating computation is not instant. It involves database reads, algorithmic computation per player, multiple database writes, and cache invalidation. Running this synchronously on the confirm endpoint would add 500ms–2s latency to a user action.

**Solution**: The confirm endpoint sends one SQS message (near-instant) and returns. The rating engine processes it asynchronously. The player's phone receives the rating update via WebSocket push when computation is done. From the user's perspective: confirm → see confirmation immediately → receive rating notification a few seconds later.

---

## Data Flow: Stat Submission

```
Phone (online)
  → POST /v1/matches/:id/stats
  → Backend validates + upserts to PostgreSQL
  → Backend publishes to Redis channel match:{id}
  → Real-time service receives from Redis
  → Broadcasts to all phones in match:{id} room
  → Other phones update live scoreboard

Phone (offline)
  → queueStatEntry() → SQLite (expo-sqlite)
  → [connectivity restored]
  → sync.engine.ts detects via NetInfo listener
  → POST /v1/matches/:id/stats/batch (all queued entries)
  → Backend deduplicates by client_event_id
  → Same PostgreSQL upsert as online path
```

## Data Flow: Rating Computation

```
Both captains confirm
  → Backend: match status = 'completed'
  → Backend: SQS.sendMessage({ match_id, sport_id })
  → Backend: feed_events written per player
  → Backend: achievements checked async

[~1–5 seconds later]

Rating Engine (SQS consumer)
  → Reads confirmed match_player_stats
  → Loads sport.stat_schema
  → Computes performance_score per player
  → Computes new_rating via Elo formula
  → Upserts sport_profiles
  → Inserts rating_history (immutable log)
  → Publishes to Redis channel rating:{user_id}

Real-time service
  → Receives from Redis rating:{user_id}
  → Broadcasts to Socket.IO room rating:{user_id}

Player's phone
  → Receives rating_update event
  → RatingCard animates the change
  → Achievement card shows if milestone hit
```

---

## Phase Roadmap

| Phase | Timeline | What ships |
|-------|----------|-----------|
| 1 | Weeks 1–8 | Auth, profiles, teams, events, online scoring, captain confirm |
| 2 | Weeks 9–12 | Rating engine, achievements, shareable cards |
| 3 | Weeks 13–16 | Real-time live scores, activity feed, city leaderboards |
| 4 | Weeks 17–20 | Push notifications, offline sync polish, beta in Pune |
| 5 | Month 6+ | Organizer web dashboard, 10+ cities, trainer marketplace |
