# Deployment Design — Early Public (Fly.io)

Status: **proposed** · Author: restart planning · Supersedes the deploy target in
[infrastructure.md](infrastructure.md) for the early-public phase.

This is the reviewable record of the decisions made for the first production cut.
The AWS/ECS estate described in [infrastructure.md](infrastructure.md) is **not**
being deleted — it remains the documented graduation target (see
[Graduation trigger](#graduation-trigger)). The logical topology below ports over
to it unchanged.

---

## Decisions (locked)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Host | **Fly.io**, region `bom` (Mumbai) | Same latency story as `ap-south-1`; far simpler than ECS for one engineer; managed PG + Redis available in-region |
| Job pipeline | **Redis Streams** | Language-agnostic (backend is Node, consumer is Python); durable; reuses the Redis we already run. Replaces SQS **and** LocalStack |
| Realtime fan-out | **Existing Redis pub/sub bridge** (no adapter) + websocket-only | Bridge already fans out across instances; adapter would duplicate. See [§1](#1-realtime-multi-instance--websocket-only-no-redis-adapter) |
| Postgres | Managed (Supabase Mumbai *or* Fly PG) | Supabase ships a pooler + PITR; Fly PG needs PgBouncer added |
| Redis | Managed (Upstash *or* Fly Redis) | Serves cache + pub/sub + streams on one instance |

### Why Redis Streams, not BullMQ

BullMQ is Node-only and its internal key layout isn't cross-language. Our consumer
is Python ([rating-engine/consumer.py](../rating-engine/consumer.py)), so a BullMQ
producer + Python consumer is a non-starter. Redis Streams is the language-neutral,
durable primitive:

- Backend `XADD allsports:ratings * match_id=… sport_id=…` on match-complete
- Python consumer `XREADGROUP` on a consumer group → process → `XACK`
- `XAUTOCLAIM` reclaims messages from a crashed consumer (at-least-once safety net)
- The existing idempotency guard makes redelivery a no-op — see
  [consumer.py:96](../rating-engine/consumer.py#L96) (`SELECT 1 FROM rating_history`)

---

## Target topology (Fly, region `bom`)

| Service | Instances | Notes |
|---------|-----------|-------|
| backend (Fastify) | 2 | stateless, behind Fly proxy, rolling deploys |
| realtime (Socket.IO) | 2 | **requires Redis adapter** |
| rating-engine API (FastAPI `/suggest`, `/preview`) | 1 | |
| rating consumer | 1 | Streams consumer group; scale to N trivially later |
| Postgres | managed | Supabase (Mumbai, pooler + PITR) or Fly PG |
| Redis | managed | Upstash or Fly Redis — pub/sub + streams |

**Split the rating API from the consumer.** Today they share a process —
[main.py](../rating-engine/main.py) starts `run_consumer()` in a daemon thread on
FastAPI startup ([main.py `start_consumer`](../rating-engine/main.py)). For prod,
run them as two Fly process groups (or two apps): independent scaling, and a stuck
consumer doesn't take down the `/suggest` endpoint the referee flow depends on.

---

## Prerequisite code changes

These gate "early public" — not optional. Ordered by the sequence we'll execute.

### 1. Realtime multi-instance — *websocket-only, NO Redis adapter*

**Correction to the original plan.** The initial plan called for a Socket.IO Redis
adapter as "the single most important change." On reading the code, that is wrong
for this service and would introduce a bug:

- The realtime service already has a **Redis pub/sub bridge**
  ([index.ts:73-98](../realtime/src/index.ts#L73-L98)): the backend publishes each
  event to Redis once, and *every* realtime instance `psubscribe`s to
  `match:*`/`rating:*` and relays to its own local sockets. With Socket.IO's default
  in-memory adapter (`io.to(room)` = local sockets only), fan-out is **already
  correct across N instances** — each client gets exactly one copy.
- Adding the Redis adapter makes `io.to()` broadcast across all instances. But every
  instance already received the same pub/sub message and emits independently →
  **every client gets N duplicate copies**. The adapter actively breaks the bridge.

The actual multi-instance gap was the **transport**: the server allowed HTTP
long-polling ([was `['websocket','polling']`](../realtime/src/index.ts#L29)), which
across >1 instance needs sticky sessions. The mobile client already connects
websocket-only ([mobile/src/realtime/socket.ts:13](../mobile/src/realtime/socket.ts#L13)),
so the fix is to set the **server** to `transports: ['websocket']`. No adapter, no
sticky sessions, no duplicate-delivery risk. **Done.**

Verify: 2 instances, score a goal, confirm a client on the *other* instance receives
exactly one `match_update`.

If admin features that need cross-node Socket.IO operations appear later
(`io.fetchSockets()`, cross-node forced disconnect), revisit the adapter — but then
the bridge emits must switch to `io.local.to()` to stay duplicate-free.

### 2. SQS → Redis Streams swap — *deletes LocalStack/SQS*

Producer side — [backend/src/shared/queue/sqs.ts](../backend/src/shared/queue/sqs.ts),
called at [scores.routes.ts:369](../backend/src/modules/scores/scores.routes.ts#L369):
replace `SendMessageCommand` with `XADD allsports:ratings * …`.

Consumer side — [rating-engine/consumer.py](../rating-engine/consumer.py): replace
the `boto3` `receive_message`/`delete_message` long-poll loop
([consumer.py:253-300](../rating-engine/consumer.py#L253-L300)) with a
consumer-group `XREADGROUP` (BLOCK timeout) → process → `XACK`, plus a periodic
`XAUTOCLAIM` to recover messages stranded by a crashed consumer.

Then delete: `localstack` service from docker-compose, `infra/localstack-init.sh`,
`@aws-sdk/client-sqs` from backend deps, `boto3` from
[requirements.txt](../rating-engine/requirements.txt), and all `SQS_*`/`AWS_*`
env vars from both `.env` sets and CI.

**Semantics note:** SQS FIFO gave exactly-once *per match_id*. Streams is
at-least-once. That's fine — the idempotency guard already makes a re-processed
match a no-op — but it's a real change from what [infrastructure.md](infrastructure.md)
("Why SQS FIFO over Standard") documents, so it's called out here on purpose.

### 3. Migration runner — *runs before new code takes traffic*

Partly solved already: backend uses **`node-pg-migrate`**
(`db:migrate` → `node-pg-migrate up`, [backend/package.json](../backend/package.json)),
and CI runs it against test Postgres. The gap is production:

- The `docker-entrypoint-initdb.d` trick in [infrastructure.md](infrastructure.md)
  only fires on *first* container init — it never applies a new migration in prod.
- **Format verified:** the numeric-prefixed `migrations/*.sql` files (`001_`…`008_`)
  apply cleanly with `node-pg-migrate up` — CI already runs `npm run db:migrate`
  before the schema-dependent tests. No reformatting needed.
- `node-pg-migrate` tracks applied migrations in its own `pgmigrations` table, so
  we get `schema_migrations` behavior for free — no custom runner needed.
- **Two packaging fixes were required** for `release_command` to work inside the
  deployed image (both done):
  - `node-pg-migrate` moved from `devDependencies` → `dependencies`, since the
    production image installs with `npm ci --omit=dev`.
  - `COPY migrations ./migrations` added to the production Dockerfile stage — it
    previously copied only `dist/`, so the container had no migrations to run.
- Wiring: set `release_command = "npm run db:migrate"` in the backend `fly.toml`
  (step 4) so migrations apply once before the new release takes traffic, and a
  failed migration aborts the deploy.

### 4. Postgres connection pooling

2 backend instances × pool size must stay under PG `max_connections`. Supabase's
built-in pooler (transaction mode) solves this for free; Fly PG needs PgBouncer
added. Easy to miss until connection exhaustion under load.

---

## CI/CD change

Keep every test/typecheck/build job in [.github/workflows/ci.yml](../.github/workflows/ci.yml)
— they're good. Replace only the `deploy` job:

- **Remove:** `configure-aws-credentials`, `amazon-ecr-login`, the three
  `ecs update-service --force-new-deployment` steps.
- **Add:** `flyctl deploy` per app, gated on `main`, using a `FLY_API_TOKEN` secret.
- Remove the `--target production` ECR image push steps; Fly builds from the
  Dockerfiles directly (the existing multi-stage `production` targets still apply).

---

## Secrets

`fly secrets set` per app — nothing hardcoded in any committed file:
`JWT_SECRET`, `DATABASE_URL`, `REDIS_URL`, and the multiline `FIREBASE_PRIVATE_KEY`.
Drop `AWS_*` and `SQS_*` entirely once step 2 lands.

---

## Cost

Early-public floor: **~$50–80/mo** (2× backend, 2× realtime, 2× rating, managed PG,
managed Redis) — versus the ~$109/mo AWS Phase-1 estate in
[infrastructure.md](infrastructure.md).

## Graduation trigger

Move to the AWS/ECS estate when you outgrow a single Redis/PG primary, need
VPC-private compliance, or pull in AWS-native services (Cognito, SNS push). The
topology above ports over unchanged — not a one-way door.

---

## Execution log

All four steps below are **implemented**:

1. ✅ **Realtime transport → websocket-only** — bridge already fans out correctly,
   no adapter (would have caused duplicate delivery). Added a `/health` endpoint
   for Fly checks.
2. ✅ **SQS → Redis Streams swap** + LocalStack removed
   - Backend producer: [ratings.stream.ts](../backend/src/shared/queue/ratings.stream.ts) (`XADD`); old `sqs.ts` deleted; `@aws-sdk/client-sqs` dropped.
   - Python consumer: [consumer.py](../rating-engine/consumer.py) (`XREADGROUP` + `XAUTOCLAIM`); `boto3` dropped; consumer split from API via `RUN_CONSUMER_IN_API`.
   - Removed: `localstack` compose service, `infra/localstack-init.sh`, all `SQS_*`/`AWS_*` env from compose, `.env.example`, and the CI test job.
3. ✅ **Migration runner** — `node-pg-migrate` format verified; moved to
   `dependencies`; `migrations/` now copied into the production image;
   `release_command` set in the backend `fly.toml`.
4. ✅ **fly.toml × apps + CI deploy rewrite** —
   [backend](../backend/fly.toml), [realtime](../realtime/fly.toml),
   [rating-engine](../rating-engine/fly.toml) (2 process groups); CI `deploy`
   job now runs `flyctl deploy` per app.

### Extra gaps found during implementation (not in the original plan)

- The realtime service had **no `tsconfig.json`**, so its production image build
  (`npm run build` → `tsc`) would emit nothing. Added one mirroring the backend's.
- The backend production image excluded `node-pg-migrate` (devDep) and never
  copied `migrations/` — both fixed (see step 3).

### Still TODO before a real deploy (operator actions, not code)

- Provision managed Postgres + Redis in `bom`; `flyctl secrets set` per app
  (`JWT_SECRET`, `DATABASE_URL`, `REDIS_URL`, `FIREBASE_PRIVATE_KEY`).
- `flyctl apps create` for `allsports-backend`, `allsports-realtime`,
  `allsports-rating`; add `FLY_API_TOKEN` to GitHub Actions secrets.
- Add Postgres connection pooling (§4) before raising backend instance count.
- Verify end-to-end: complete a match → `XADD` → consumer processes → rating
  update reaches a client on the *other* realtime instance exactly once.

## Before pointing a released build at a project

Firebase configuration that is harmless in development is dangerous in production,
and none of it is visible from a working app — the app behaves identically either
way. Run the check rather than trusting memory:

```
firebase_check_production_readiness { "project_id": "allsports-prod" }
```

It flags:

- **Test phone numbers.** These never send an SMS and always accept a fixed code.
  In a live project that is a permanent bypass of phone verification for anyone
  holding — or guessing — that number. `allsports-prod` currently has five,
  registered deliberately for development. **They must be cleared before real
  users.** Clear them by calling `firebase_enable_phone_auth` with an empty
  `test_numbers` object.
- **Anonymous sign-in**, if it ever gets switched on.
- **`localhost` as an authorised domain.**

Also confirm `EXPO_PUBLIC_FIREBASE_DISABLE_APP_VERIFICATION` is absent from the
production environment. It is already double-gated behind `__DEV__`, so a release
build ignores it, but it has no business in a prod env file.
