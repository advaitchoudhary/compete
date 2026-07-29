# AllSports — Documentation Index

Multi-sport amateur league tracking platform for India.
Cricket · Football · Badminton · Basketball

---

## Documents

| File | What it covers |
|------|----------------|
| [architecture.md](./architecture.md) | System overview, service map, data flow, tech stack |
| [database.md](./database.md) | Every table, column, index, trigger — explained in full |
| [backend.md](./backend.md) | Node.js/Fastify service — every module and endpoint |
| [rating-engine.md](./rating-engine.md) | Python rating algorithm, SQS consumer, math explained |
| [rating-algorithm-flow.md](./rating-algorithm-flow.md) | Full rating flow + every formula, with a worked example — the go-to reference for rating doubts |
| [realtime.md](./realtime.md) | Socket.IO + Redis Pub/Sub bridge |
| [mobile.md](./mobile.md) | React Native app — offline-first logic, screens, components |
| [infrastructure.md](./infrastructure.md) | Docker Compose, Dockerfiles, CI/CD pipeline (AWS — graduation target) |
| [deployment-fly.md](./deployment-fly.md) | Early-public deploy design: Fly.io + Redis Streams + prerequisite changes |
| [match-flow.md](./match-flow.md) | End-to-end walkthrough of a complete match lifecycle |

---

## Quick Reference — Ports

| Service | Port | Language |
|---------|------|----------|
| Backend API | 3000 | Node.js / TypeScript |
| Real-time (WebSocket) | 3001 | Node.js / TypeScript |
| Rating Engine | 8000 | Python |
| PostgreSQL | 5432 | — |
| Redis | 6379 | — |
| LocalStack (SQS) | 4566 | — |

## Quick Reference — Key Files

| File | Purpose |
|------|---------|
| `backend/migrations/001_initial_schema.sql` | All database tables |
| `backend/migrations/002_seed_sports.sql` | Sport stat schemas |
| `backend/src/app.ts` | Backend entrypoint |
| `backend/src/shared/db/types.ts` | TypeScript ↔ database type contract |
| `backend/src/modules/scores/scores.routes.ts` | Core scoring + confirm logic |
| `rating-engine/algorithms/base.py` | The rating algorithm |
| `rating-engine/consumer.py` | SQS polling + match processing |
| `realtime/src/index.ts` | WebSocket + Redis bridge |
| `mobile/src/offline/scorecard.db.ts` | SQLite offline buffer |
| `mobile/src/offline/sync.engine.ts` | Auto-sync on reconnect |
| `docker-compose.yml` | Full local dev stack |
| `.github/workflows/ci.yml` | CI/CD pipeline |
