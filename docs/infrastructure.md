# Infrastructure & DevOps

Docker · GitHub Actions · Fly.io (Mumbai) · Redis Streams

---

## Current Direction (decided 2026-06-20)

The first production deployment targets **Fly.io (`bom` / Mumbai)**, not the AWS/ECS
estate the original CI `deploy` job assumed. Rationale: solo dev, early-public scale,
already fully containerized, and a live-scores product that needs low-latency
WebSockets to Indian users. AWS ECS remains the documented **graduation target** — the
logical topology below ports over unchanged, so this is not a one-way door.

Key decisions:

- **Host:** Fly.io, region `bom`. Graduate to AWS ECS when we outgrow a single
  Redis/PG primary, need VPC-private compliance, or pull in AWS-native services.
- **Async rating pipeline:** **Redis Streams**, not SQS. BullMQ was rejected because
  the consumer is Python and BullMQ is Node-only. Streams are language-agnostic and
  durable. This deletes SQS *and* LocalStack from the entire stack.
- **Scale target for first cut:** early-public — hundreds–low-thousands of users, dozens
  of concurrent live matches, with redundancy (2 instances) on the stateless tiers.

### Execution order

1. **This doc** — capture the design (done).
2. **SQS → Redis Streams swap** — backend `XADD`, Python `XREADGROUP`/`XACK`/`XAUTOCLAIM`;
   remove LocalStack from `docker-compose.yml`. The keystone change — everything
   downstream simplifies once SQS is gone. Fully verifiable locally.
3. **Socket.IO Redis adapter** — required before running >1 realtime instance.
4. **Migration runner** — apply pending `backend/migrations/*.sql` tracked in a
   `schema_migrations` table, wired as Fly's `release_command`.
5. **`fly.toml` per app + CI deploy rewrite** — replace the ECR/ECS steps with `flyctl deploy`.

> **Sections below marked _(current)_ describe code as it stands today (still on SQS).
> Sections marked _(target)_ describe the Fly/Streams design we are building toward.**

---

## Local Development Stack _(current — loses LocalStack after step 2)_

### `docker-compose.yml`

Six services that mirror production:

```
postgres      → PostgreSQL 14 (database)
redis         → Redis 7 (cache + pub/sub)
localstack    → AWS SQS emulator (queue)
backend       → Node.js Fastify API (port 3000)
realtime      → Socket.IO service (port 3001)
rating-engine → Python FastAPI + SQS consumer (port 8000)
```

**Start everything:**

```bash
docker compose up --build
```

**Start only infrastructure (for local code with hot reload):**

```bash
docker compose up postgres redis localstack -d
```

Then run each service manually for faster iteration:

```bash
cd backend && npm run dev          # ts-node-dev, hot reload
cd realtime && npm run dev         # ts-node-dev, hot reload
cd rating-engine && uvicorn main:app --reload  # uvicorn auto-reload
```

---

### Service Definitions

#### `postgres`

```yaml
image: postgres:14-alpine
environment:
  POSTGRES_DB: allsports
  POSTGRES_USER: allsports
  POSTGRES_PASSWORD: allsports
ports:
  - "5432:5432"
volumes:
  - postgres_data:/var/lib/postgresql/data
  - ./backend/migrations:/docker-entrypoint-initdb.d   # auto-runs on first start
```

The `docker-entrypoint-initdb.d` mount means all `*.sql` migration files run automatically when the container is first created. Migrations are ordered by filename prefix (`001_`, `002_`, etc).

#### `redis`

```yaml
image: redis:7-alpine
ports:
  - "6379:6379"
```

Ephemeral — no persistence volume. Redis is cache + pub/sub; losing it on restart is fine in development.

#### `localstack`

```yaml
image: localstack/localstack:3
environment:
  SERVICES: sqs
  DEFAULT_REGION: ap-south-1
  AWS_ACCESS_KEY_ID: test
  AWS_SECRET_ACCESS_KEY: test
ports:
  - "4566:4566"
volumes:
  - ./infra/localstack-init.sh:/etc/localstack/init/ready.d/init.sh
```

LocalStack emulates AWS SQS locally. The init script runs after LocalStack is ready and creates the queue.

#### `backend`, `realtime`, `rating-engine`

In development mode, each service mounts its `src/` directory as a volume and runs with hot reload. In production mode (when `NODE_ENV=production`), the pre-built image is used.

---

### `infra/localstack-init.sh`

```bash
#!/bin/bash
awslocal sqs create-queue \
  --queue-name allsports-rating-queue.fifo \
  --attributes FifoQueue=true,ContentBasedDeduplication=true \
  --region ap-south-1
```

This creates the FIFO queue that the backend writes to and the rating engine consumes from. Runs once on LocalStack startup via the `ready.d/` hook.

Why FIFO? Guarantees exactly-once delivery per `MessageGroupId` (we use `match_id`). Multiple rating jobs for the same match are deduplicated — important on unstable networks where a captain might double-tap confirm.

---

## Dockerfiles

### Multi-Stage Pattern (Backend & Realtime)

Both Node.js services use the same multi-stage pattern:

```dockerfile
# Stage 1: base — production dependencies only
FROM node:20-alpine AS base
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# Stage 2: development — all dependencies + source mount
FROM base AS development
RUN npm ci
COPY . .
CMD ["npm", "run", "dev"]

# Stage 3: build — compile TypeScript
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build          # tsc → dist/

# Stage 4: production — minimal image, non-root user
FROM node:20-alpine AS production
WORKDIR /app
COPY --from=base /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package*.json ./
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser
EXPOSE 3000
CMD ["node", "dist/app.js"]
```

Why multi-stage?
- **Development** image has full dev dependencies and source code for hot reload
- **Production** image has zero dev dependencies, compiled JS only, non-root user
- Production image is ~200MB vs ~600MB for a naive single-stage build

### Rating Engine Dockerfile

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser
USER appuser
EXPOSE 8000
CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
```

Single-stage (no TypeScript compilation step needed). Non-root user for security.

---

## CI/CD Pipeline

### `.github/workflows/ci.yml`

Four jobs that run on every push and pull request:

```
Push to any branch
       │
       ├──► [backend]       → typecheck + migrate + test
       ├──► [rating-engine] → pytest
       └──► [docker-build]  → build all 3 images
              │
              │ (only on merge to main)
              └──► [deploy] → push images to ECR + update ECS services
```

---

### Job: `backend`

```yaml
services:
  postgres:
    image: postgres:14
    env: { POSTGRES_DB: allsports, POSTGRES_USER: allsports, ... }
    options: --health-cmd pg_isready
  redis:
    image: redis:7
    options: --health-cmd redis-cli ping
```

GitHub Actions spins up real Postgres and Redis as sidecar containers. Steps:

1. `npm ci` — install deps
2. `npm run typecheck` — `tsc --noEmit` (catches type errors before tests)
3. Run migrations against the test Postgres
4. `npm test` — Vitest in CI mode

The health-check options ensure the DB is ready before steps run (avoids race conditions on slow CI runners).

---

### Job: `rating-engine`

```yaml
steps:
  - pip install -r requirements.txt
  - pytest tests/ -v
```

Runs the 16 algorithm unit tests. No external dependencies needed — the tests mock DB/Redis calls and test pure math functions.

---

### Job: `docker-build`

Builds all three Docker images on every push. This catches Dockerfile errors and dependency installation failures early, before they block a deployment.

```yaml
- docker build -f backend/Dockerfile --target production backend/
- docker build -f realtime/Dockerfile --target production realtime/
- docker build -f rating-engine/Dockerfile rating-engine/
```

---

### Job: `deploy` _(current — to be rewritten in step 5)_

> **This job targets a non-existent AWS estate** (cluster `allsports-cluster`, ECR repos,
> ECS services) — there is no IaC creating any of it, so it would fail on first run. Step 5
> replaces these steps with `flyctl deploy` per app, gated on `main`, using a `FLY_API_TOKEN`
> secret. The `backend` / `rating-engine` / `docker-build` jobs stay as-is. Original steps:

Runs only on push to `main`. Steps:

1. **Configure AWS credentials** from GitHub Secrets (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`)
2. **Login to ECR** — Amazon's private Docker registry
3. **Tag images** with the git commit SHA (`ghcr.io/org/allsports-backend:abc1234`)
4. **Push images** to ECR
5. **Update ECS services** — `aws ecs update-service --force-new-deployment` for each of the 3 services (backend, realtime, rating-engine)

ECS Fargate pulls the new image and performs a rolling deployment — zero downtime if health checks pass.

---

## Production Architecture — Fly.io _(target)_

### Region

`bom` (Mumbai) — lowest latency for Indian users and our WebSocket live-scores path
(~20ms vs ~150ms from US regions). Fly's `bom` region matches AWS `ap-south-1`.

### Topology

```
                    ┌─────────────┐
   Expo mobile ───► │   backend   │ Fastify  (HTTP API)
                    │  (2 inst)   │
                    └──────┬──────┘
                           │ XADD on match-complete
              ┌────────────┼─────────────┐
              ▼            ▼              ▼
        ┌──────────┐  ┌─────────┐  ┌──────────────────┐
        │ Postgres │  │  Redis  │  │ Redis Stream     │
        │ (managed)│  │(managed)│  │ allsports:ratings│
        └──────────┘  └────┬────┘  └──────┬───────────┘
                           │ pub/sub      │ XREADGROUP (consumer group)
                    ┌──────▼─────┐  ┌──────▼────────┐
                    │  realtime  │  │ rating-engine │
                    │ Socket.IO  │  │ consumer + API│
                    │  (2 inst)  │  │               │
                    └────────────┘  └───────────────┘
```

### Compute — Fly Machines

| App / process | Instances | Size | Notes |
|---|---|---|---|
| backend (Fastify) | 2 | shared-cpu-1x / 512MB | stateless, rolling deploys |
| realtime (Socket.IO) | 2 | shared-cpu-1x / 512MB | **requires Redis adapter** |
| rating-engine API | 1 | shared-cpu-1x / 512MB | FastAPI `/suggest` |
| rating consumer | 1 | shared-cpu-1x / 512MB | Streams consumer group; scale to N later |

The rating-engine API and consumer split into two Fly process groups (or two apps) so a
stuck consumer never affects the suggestion endpoint, and each scales independently.

### Database — managed Postgres

Supabase (Mumbai) preferred for the solo-dev stage: built-in connection pooler (PgBouncer),
PITR backups, and a dashboard. Fly Postgres is the alternative but needs PgBouncer added
manually. Either way: PostgreSQL 14, ~20 GB to start.

### Cache + Queue — managed Redis (one instance, two roles)

Upstash (Mumbai) or Fly Redis. Serves both **pub/sub** (realtime live-score fan-out) and
the **`allsports:ratings` Stream** (rating pipeline). Watch per-command billing on Upstash
if pub/sub volume gets chatty under load; a dedicated small Redis is the fallback.

### Queue — Redis Streams

```
Stream:         allsports:ratings
Consumer group: rating-workers
```

Backend `XADD allsports:ratings * matchId=… tier=…` on match-complete. The Python consumer
`XREADGROUP`s as part of `rating-workers`, processes, then `XACK`s. `XAUTOCLAIM` reclaims
messages from a crashed consumer (at-least-once). The existing idempotency guard in
`consumer.py` (skips if `rating_history` already has rows for the match) makes redelivery a
no-op — so duplicate delivery is safe without needing FIFO/exactly-once semantics.

### Storage — object storage + CDN

Profile photos and achievement-card images. Fly has no native S3 — use Cloudflare R2
(no egress fees, has a CDN) or keep an S3 bucket on AWS. Defer until the feature ships.

### Auth — Firebase _(unchanged, external)_

Firebase Phone Auth + FCM push. External to the host, so it doesn't constrain the platform
choice. Backend only receives the verified ID token.

### Secrets

`fly secrets set` per app — `JWT_SECRET`, `DATABASE_URL`, `REDIS_URL`, and the multiline
`FIREBASE_PRIVATE_KEY`. Nothing hardcoded in any committed file (compose currently inlines
these for dev only).

### Estimated cost (early-public)

~$50–80/month: 2× backend, 2× realtime, API + consumer, managed Postgres, managed Redis.

---

## Graduation Target — AWS ECS _(future)_

When we outgrow a single Redis/PG primary, need VPC-private compliance, or adopt AWS-native
services (Cognito, SNS push), move to the estate the original CI assumed: ECS Fargate in
`ap-south-1`, RDS PostgreSQL, ElastiCache Redis, ALB (with WebSocket support + sticky
sessions for Socket.IO), ECR, and IaC (Terraform). Indicative Phase-1 sizing kept for
reference:

| Component | Spec | ~Cost/mo |
|---|---|---|
| Backend (Fargate) | 0.5 vCPU / 1 GB | $15 |
| Realtime (Fargate) | 0.25 vCPU / 512 MB | $8 |
| Rating Engine (Fargate) | 0.5 vCPU / 1 GB | $15 |
| RDS PostgreSQL | db.t3.micro / 20GB gp3 | $25 |
| ElastiCache Redis | cache.t3.micro | $15 |
| S3 + CloudFront | assets + CDN | $15 |
| **Total** | | **~$109** |

This is a deliberate step *up* in cost and operational surface (VPC, NAT gateway, ALB, IAM,
Terraform), justified only once scale or compliance demands it.

---

## Environment Variables

> The `AWS_*` / `SQS_*` rows below are _(current)_ and disappear in step 2 (Streams swap),
> replaced by the single `RATING_STREAM` name on a shared `REDIS_URL`.

### Backend (`.env`)

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string (cache, pub/sub, **and** the rating Stream) |
| `RATING_STREAM` | _(target)_ Stream key, e.g. `allsports:ratings` |
| `JWT_SECRET` | Secret for signing JWTs |
| `FIREBASE_PROJECT_ID` | Firebase project for token verification |
| `FIREBASE_PRIVATE_KEY` | Firebase Admin SDK key |
| `RATING_ENGINE_URL` | rating-engine base URL (for `/suggest` proxy) |
| `PORT` | API server port (default 3000) |
| ~~`AWS_REGION` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`~~ | _(current, removed in step 2)_ |
| ~~`SQS_RATING_QUEUE_URL` / `SQS_ENDPOINT`~~ | _(current, removed in step 2)_ |

### Rating Engine (`.env`)

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string (incl. the rating Stream) |
| `RATING_STREAM` | _(target)_ Stream key, e.g. `allsports:ratings` |
| `RATING_CONSUMER_GROUP` | _(target)_ consumer group, e.g. `rating-workers` |
| ~~`AWS_REGION` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`~~ | _(current, removed in step 2)_ |
| ~~`SQS_RATING_QUEUE_URL` / `SQS_ENDPOINT`~~ | _(current, removed in step 2)_ |

### Realtime Service (`.env`)

| Variable | Description |
|----------|-------------|
| `REDIS_URL` | Redis connection string |
| `JWT_SECRET` | Same secret as backend (for token verification) |
| `PORT` | Socket.IO server port (default 3001) |

---

## Scaling Decisions

### Why Fly.io before AWS/ECS?

A minimal ECS estate (VPC + NAT gateway ~$32/mo idle + ALB ~$16/mo + RDS + ElastiCache +
ECR + task defs + IAM) is a ~$150+/mo floor and hundreds of lines of Terraform to maintain
solo — before a single user arrives. Fly runs the existing Dockerfiles as-is, has native
WebSocket support (no ALB sticky-session fiddling), a Mumbai region, and managed PG/Redis,
at ~$50–80/mo. ECS earns its keep at scale and with a platform team; we have neither yet.

### Why Redis Streams over SQS / BullMQ?

- **vs SQS:** we already run Redis for pub/sub. Streams remove an entire managed dependency
  (and LocalStack from local dev). At-least-once + the existing idempotency guard gives the
  same safety FIFO/dedup gave us, without the second system.
- **vs BullMQ:** BullMQ is Node-only and our consumer is Python; its internal key layout
  isn't cross-language. Raw Streams (`XADD`/`XREADGROUP`/`XACK`/`XAUTOCLAIM`) are spoken
  natively by both `ioredis` and `redis-py`.

### Why a separate realtime service (and the Redis adapter)?

Socket.IO holds persistent WebSocket connections — it must be long-lived, and on Fly's proxy
WebSockets are first-class. Running **>1 realtime instance requires `@socket.io/redis-adapter`**:
without it, a goal broadcast on instance A never reaches sockets connected to instance B. This
is the single hard prerequisite before scaling the realtime tier past one machine.

### Database Connection Limits

With 2 backend instances each holding a pool, total connections must stay under the Postgres
limit. Supabase's built-in pooler (PgBouncer in transaction mode) handles this for free;
Fly Postgres needs PgBouncer added explicitly. Cap the app-side pool conservatively and let
the pooler fan out — connection exhaustion is the most likely first scaling failure.
