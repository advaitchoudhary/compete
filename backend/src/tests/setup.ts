import 'dotenv/config'

// Override env for test environment.
//
// The fallbacks must match the host-side ports in docker-compose.yml (5433/6380,
// remapped to avoid clashing with any Postgres/Redis already on the default
// ports), NOT the in-container ones. With 5432/6379 here and no backend/.env to
// override them, `npm test` silently connected to whatever local Postgres was
// listening and failed 10 of 12 files with `role "allsports" does not exist`.
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://allsports:password@localhost:5433/allsports_test'
process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380'
process.env.JWT_SECRET = 'test-jwt-secret-minimum-32-chars-long'
process.env.NODE_ENV = 'test'
