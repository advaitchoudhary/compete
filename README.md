# AllSports

Multi-sport amateur league tracking platform for India.
Cricket · Football · Badminton · Basketball

---

## Architecture

```
backend/          Node.js + TypeScript + Fastify (REST API)
realtime/         Node.js + Socket.IO (WebSocket live scores)
rating-engine/    Python + FastAPI + SQS consumer (algorithmic ratings)
mobile/           React Native + Expo (iOS + Android)
infra/            Docker, LocalStack init scripts
.github/          CI/CD (GitHub Actions → AWS ECS)
```

## Quick Start (Local Dev)

**Prerequisites:** Docker Desktop, Node.js 20, Python 3.12

```bash
# 1. Start infrastructure (Postgres, Redis, LocalStack/SQS)
docker compose up postgres redis localstack -d

# 2. Backend
cd backend
cp .env.example .env        # fill in Firebase credentials
npm install
npm run db:migrate
npm run dev                  # → http://localhost:3000

# 3. Real-time service
cd realtime
npm install
npm run dev                  # → ws://localhost:3001

# 4. Rating Engine
cd rating-engine
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp ../.env.example .env
uvicorn main:app --reload    # → http://localhost:8000

# 5. Mobile app
cd mobile
npm install
npx expo start
```

## Run All Services with Docker

```bash
docker compose up --build
```

## Tests

```bash
# Backend
cd backend && npm test

# Rating Engine
cd rating-engine && pytest tests/ -v
```

## API Reference

Base URL: `http://localhost:3000/v1`

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/auth/verify` | Firebase OTP → JWT |
| GET | `/users/:id` | Player profile + ratings |
| GET | `/users/:id/stats/:sport` | Career stats + rating history |
| POST | `/users/:id/follow` | Follow a player |
| GET | `/sports` | List all sports |
| GET | `/leaderboards?sport=&city=` | City leaderboard |
| POST | `/teams` | Create a team |
| GET | `/teams/:id` | Team detail + roster |
| POST | `/events` | Create tournament |
| GET | `/events?sport=&city=` | Browse events |
| POST | `/matches` | Create a match |
| POST | `/matches/:id/stats` | Submit player stats |
| POST | `/matches/:id/stats/batch` | Offline batch sync |
| POST | `/matches/:id/confirm` | Captain confirms → triggers rating |
| GET | `/users/:id/achievements` | Player achievements |

## Rating Engine

The rating algorithm runs after every confirmed match. Formula:

```
performance_score = weighted_stats × opposition_modifier
new_rating = old_rating + K × (performance_score/100 - old_rating/100)
where K = 40 (< 10 matches), 30 (< 30), 20 (< 100), 10 (100+)
```

Each sport defines its own `stat_schema` in the database with weighted metrics.
The algorithm is sport-agnostic — adding a new sport requires only inserting a
new row in the `sports` table with the appropriate `stat_schema`.

## Key Design Decisions

- **Offline-first scoring**: Stats buffered to SQLite on device, synced on reconnect
- **Dual captain confirmation**: Both captains must confirm before ratings are processed
- **JSONB stats**: Sport-specific stats stored as JSONB — no migrations for new sports
- **Modular monolith**: Backend is a single deployable with clear module boundaries
- **SQS-decoupled ratings**: Rating computation is async and never blocks the API
