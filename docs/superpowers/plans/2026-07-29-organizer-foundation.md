# Organizer Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give turf-owner organizers a first-class, admin-verified identity that can create tournaments and assign pre-approved referees to them — while making it structurally impossible for an organizer to score a match.

**Architecture:** Adds an `organizer` role to the existing `users.role` check and reuses the `referee_applications` table (via a new `request_type = 'organizer'`) so the admin review queue, approve/reject endpoints and admin UI all serve both flows. Introduces one new table, `event_referees`, holding which approved referees are working an event and on which pitch — the pool that Phase 3's fixture generator will draw from. Closes the current hole where any authenticated player can create a tournament.

**Tech Stack:** Fastify 4, Kysely 0.27 (Postgres), Zod, Vitest, raw-SQL migrations run by node-pg-migrate.

## Global Constraints

- Migrations are plain SQL in `backend/migrations/`, named `NNN_snake_case.sql`, applied by `npm --workspace backend run db:migrate`. Existing files run `001`–`008`; this plan adds `009` and `010`. Every statement must be idempotent (`IF NOT EXISTS` / `DROP CONSTRAINT IF EXISTS`) because they may be re-run against a partially-migrated database.
- Roles after this plan: `player | referee | organizer | admin`. A user has exactly **one** role.
- **Integrity rule (non-negotiable):** an organizer may create events and schedule matches; an organizer may **never** score a match. No task may grant an organizer any scoring capability. Scoring stays gated behind `requireRole('referee','admin')` plus `assertMatchReferee`.
- Backend runs from the repo root as an npm workspace: `npm --workspace backend run <script>`. `npm ci` only works at the root.
- `npx tsc --noEmit` (run from `backend/`) must report 0 errors before any commit.
- Tests are Vitest integration tests using `app.inject()` against a real Postgres, following `backend/src/tests/scores.test.ts`. Local test DB URL: `postgresql://allsports:password@localhost:5433/allsports_test`.
- All routes are registered under the `/v1` prefix in `backend/src/app.ts`.

---

### Task 1: Schema + Kysely types for the organizer role and event referees

**Files:**
- Create: `backend/migrations/009_organizer_role.sql`
- Create: `backend/migrations/010_event_referees.sql`
- Modify: `backend/src/shared/db/types.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `UserRole` widened to `'player' | 'referee' | 'organizer' | 'admin'`; `RefereeApplicationTable.request_type` widened to `'initial' | 'upgrade' | 'organizer'`; new `EventRefereeTable { event_id: string; user_id: string; pitch_label: string | null; added_at: Generated<Date> }` registered on `Database` as `event_referees`.

- [ ] **Step 1: Write migration 009**

Create `backend/migrations/009_organizer_role.sql`:

```sql
-- AllSports — Organizer Role
-- Migration: 009_organizer_role
-- Run order: 9
--
-- Turf/venue owners who run tournaments get a first-class, admin-verified role.
-- Reuses referee_applications as the review queue via request_type='organizer',
-- so the existing admin approve/reject flow and UI serve both journeys.
--
-- An organizer may create events and schedule matches. An organizer may NEVER
-- score a match — scoring stays gated to the assigned, tier-approved referee.

-- ── Add 'organizer' to the role check ───────────────────────────────────────
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('player', 'referee', 'organizer', 'admin'));

-- ── Applications double as organizer requests ───────────────────────────────
ALTER TABLE referee_applications DROP CONSTRAINT IF EXISTS referee_applications_request_type_check;
ALTER TABLE referee_applications ADD CONSTRAINT referee_applications_request_type_check
  CHECK (request_type IN ('initial', 'upgrade', 'organizer'));

-- Admin queue filters by request_type when triaging organizers vs referees.
CREATE INDEX IF NOT EXISTS idx_referee_applications_request_type
  ON referee_applications(request_type, status, created_at DESC);
```

- [ ] **Step 2: Write migration 010**

Create `backend/migrations/010_event_referees.sql`:

```sql
-- AllSports — Event Referees
-- Migration: 010_event_referees
-- Run order: 10
--
-- Which approved referees are working a given tournament, and on which pitch.
-- The organizer picks from already-approved referees; Phase 3's fixture
-- generator draws from this pool to stamp referee_id onto each generated match.
-- This is how an organizer schedules without ever gaining scoring rights.

CREATE TABLE IF NOT EXISTS event_referees (
  event_id    UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id),
  -- Keeps a referee on one pitch all day (e.g. 'Pitch 1'). NULL = unassigned.
  pitch_label TEXT,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_event_referees_event ON event_referees(event_id);
CREATE INDEX IF NOT EXISTS idx_event_referees_user ON event_referees(user_id);
```

- [ ] **Step 3: Run the migrations and verify they applied**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
docker exec allsports_postgres psql -U allsports -d postgres -c "DROP DATABASE IF EXISTS allsports_test;"
docker exec allsports_postgres psql -U allsports -d postgres -c "CREATE DATABASE allsports_test;"
DATABASE_URL="postgresql://allsports:password@localhost:5433/allsports_test" npm --workspace backend run db:migrate
```

Expected: ends with `Migrations complete!` and the log shows `### MIGRATION 009_organizer_role (UP) ###` and `### MIGRATION 010_event_referees (UP) ###`.

Then confirm the constraint and table exist:

```bash
docker exec allsports_postgres psql -U allsports -d allsports_test -tAc \
  "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='users_role_check';"
docker exec allsports_postgres psql -U allsports -d allsports_test -c "\d event_referees"
```

Expected: the check lists `'organizer'`, and `event_referees` has columns `event_id, user_id, pitch_label, added_at`.

- [ ] **Step 4: Widen the Kysely types**

In `backend/src/shared/db/types.ts`, change the `UserRole` line:

```ts
export type UserRole = 'player' | 'referee' | 'organizer' | 'admin'
```

In `RefereeApplicationTable`, change the `request_type` line:

```ts
  // 'initial' = becoming a referee; 'upgrade' = higher tier; 'organizer' = run tournaments
  request_type: Generated<'initial' | 'upgrade' | 'organizer'>
```

Add a new interface immediately after `EventTeamTable`:

```ts
export interface EventRefereeTable {
  event_id: string
  user_id: string
  pitch_label: string | null
  added_at: Generated<Date>
}
```

And register it in the `Database` interface, next to `event_teams`:

```ts
  event_referees: EventRefereeTable
```

- [ ] **Step 5: Verify types compile**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports/backend && npx tsc --noEmit
```

Expected: no output (0 errors).

- [ ] **Step 6: Commit**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
git add backend/migrations/009_organizer_role.sql backend/migrations/010_event_referees.sql backend/src/shared/db/types.ts
git commit -m "feat(organizer): add organizer role and event_referees schema"
```

---

### Task 2: Organizer application endpoint

**Files:**
- Create: `backend/src/modules/organizer/organizer.routes.ts`
- Modify: `backend/src/app.ts`
- Create: `backend/src/tests/organizer.test.ts`

**Interfaces:**
- Consumes: `UserRole` including `'organizer'` and `request_type: 'organizer'` from Task 1.
- Produces: `export async function organizerRoutes(app: FastifyInstance)` registering `POST /organizer/apply` and `GET /organizer/me`. Creates a `referee_applications` row with `request_type = 'organizer'` and `requested_tier = null`.

- [ ] **Step 1: Write the failing test**

Create `backend/src/tests/organizer.test.ts`:

```ts
/**
 * Integration tests — organizer identity:
 * apply → admin approves → role becomes 'organizer' → can create events.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

// Mock the rating-job producer so tests don't touch Redis
vi.mock('../shared/queue/ratings.stream', () => ({
  enqueueRatingJob: vi.fn().mockResolvedValue(undefined),
}))

// Mock Firebase admin
vi.mock('../modules/auth/auth.service', () => ({
  initFirebase: vi.fn(),
  verifyFirebaseToken: vi.fn().mockResolvedValue({
    uid: 'test-organizer-uid',
    phone_number: '+919999999001',
    email: undefined,
  }),
  issueJwt: vi.fn().mockReturnValue('test-jwt-token'),
}))

import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import { organizerRoutes } from '../modules/organizer/organizer.routes'
import { adminRoutes } from '../modules/admin/admin.routes'
import { eventsRoutes } from '../modules/events/events.routes'
import { getDb } from '../shared/db/client'

const TEST_JWT_SECRET = 'test-jwt-secret-minimum-32-chars-long'

const PLAYER_ID = '550e8400-e29b-41d4-a716-4466554401a1'
const ADMIN_ID = '550e8400-e29b-41d4-a716-4466554401a2'
const REFEREE_ID = '550e8400-e29b-41d4-a716-4466554401a3'

async function buildTestApp() {
  const app = Fastify({ logger: false })
  await app.register(jwt, { secret: TEST_JWT_SECRET })
  await app.register(organizerRoutes, { prefix: '/v1' })
  await app.register(adminRoutes, { prefix: '/v1' })
  await app.register(eventsRoutes, { prefix: '/v1' })
  return app
}

function makeAuthHeader(userId: string, app: any): string {
  return `Bearer ${app.jwt.sign({ sub: userId }, { expiresIn: '1h' })}`
}

async function seedUser(id: string, name: string, role: string, refereeTier?: string) {
  await getDb()
    .insertInto('users')
    .values({
      id,
      name,
      role: role as any,
      referee_tier: (refereeTier ?? null) as any,
    })
    .onConflict((oc) =>
      oc.column('id').doUpdateSet({
        role: role as any,
        referee_tier: (refereeTier ?? null) as any,
      })
    )
    .execute()
}

describe('Organizer identity', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>

  beforeAll(async () => {
    app = await buildTestApp()
    await app.ready()

    await seedUser(PLAYER_ID, 'Test Player', 'player')
    await seedUser(ADMIN_ID, 'Test Admin', 'admin')
    await seedUser(REFEREE_ID, 'Test Referee', 'referee', 'amateur')
  })

  afterAll(async () => {
    const db = getDb()
    await db
      .deleteFrom('referee_applications')
      .where('user_id', 'in', [PLAYER_ID, ADMIN_ID, REFEREE_ID])
      .execute()
    await db.deleteFrom('users').where('id', 'in', [PLAYER_ID, ADMIN_ID, REFEREE_ID]).execute()
    await app.close()
  })

  it('POST /v1/organizer/apply requires authentication', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/organizer/apply',
      payload: { full_name: 'Ravi Turf', city: 'Mumbai', venue_name: 'Powai Turf' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('POST /v1/organizer/apply validates the body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/organizer/apply',
      headers: { authorization: makeAuthHeader(PLAYER_ID, app) },
      payload: { full_name: 'R', city: 'M' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('a player can apply to become an organizer', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/organizer/apply',
      headers: { authorization: makeAuthHeader(PLAYER_ID, app) },
      payload: {
        full_name: 'Ravi Kumar',
        city: 'Mumbai',
        venue_name: 'Powai Turf Arena',
        bio: 'I run weekend 5-a-side tournaments.',
      },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.request_type).toBe('organizer')
    expect(body.status).toBe('pending')
    expect(body.requested_tier).toBeNull()
  })

  it('rejects a second pending application', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/organizer/apply',
      headers: { authorization: makeAuthHeader(PLAYER_ID, app) },
      payload: { full_name: 'Ravi Kumar', city: 'Mumbai', venue_name: 'Powai Turf Arena' },
    })
    expect(res.statusCode).toBe(409)
  })

  it('refuses an application from an existing referee', async () => {
    // A referee scores matches; an organizer must never score. One role each,
    // so a referee cannot also become an organizer.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/organizer/apply',
      headers: { authorization: makeAuthHeader(REFEREE_ID, app) },
      payload: { full_name: 'Test Referee', city: 'Delhi', venue_name: 'Any Turf' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('referee')
  })

  it('GET /v1/organizer/me reports role and latest application', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/organizer/me',
      headers: { authorization: makeAuthHeader(PLAYER_ID, app) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.role).toBe('player')
    expect(body.is_organizer).toBe(false)
    expect(body.application.request_type).toBe('organizer')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
DATABASE_URL="postgresql://allsports:password@localhost:5433/allsports_test" \
  REDIS_URL="redis://localhost:6380" \
  npm --workspace backend run test -- organizer
```

Expected: FAIL — `Failed to resolve import "../modules/organizer/organizer.routes"`.

- [ ] **Step 3: Write the implementation**

Create `backend/src/modules/organizer/organizer.routes.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAuth } from '../../shared/middleware/auth'
import { getDb } from '../../shared/db/client'

const ApplyBody = z.object({
  full_name: z.string().min(2).max(80),
  city: z.string().min(2).max(50),
  // The turf/venue they run tournaments at — the thing that makes them credible.
  venue_name: z.string().min(2).max(120),
  phone: z.string().min(6).max(20).optional(),
  bio: z.string().max(500).optional(),
})

export async function organizerRoutes(app: FastifyInstance) {
  /**
   * POST /organizer/apply
   * A player applies to run tournaments. Creates a pending application that an
   * admin must approve. Reuses referee_applications with request_type
   * 'organizer' so admins triage referees and organizers in one queue.
   */
  app.post('/organizer/apply', { preHandler: requireAuth }, async (request, reply) => {
    const body = ApplyBody.safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() })

    const db = getDb()

    const me = await db
      .selectFrom('users')
      .select('role')
      .where('id', '=', request.userId)
      .executeTakeFirst()

    if (!me) return reply.code(401).send({ error: 'Unauthorized' })
    if (me.role === 'organizer') {
      return reply.code(409).send({ error: 'You are already an organizer' })
    }
    // A referee scores matches and an organizer must never score one. With a
    // single role per user, holding both would break that separation.
    if (me.role === 'referee') {
      return reply.code(409).send({
        error: 'A referee cannot also be an organizer — organizers must never score matches',
      })
    }
    if (me.role === 'admin') {
      return reply.code(409).send({ error: 'Admins can already create events' })
    }

    const pending = await db
      .selectFrom('referee_applications')
      .select('id')
      .where('user_id', '=', request.userId)
      .where('status', '=', 'pending')
      .executeTakeFirst()

    if (pending) {
      return reply.code(409).send({ error: 'You already have a pending application' })
    }

    // venue_name is folded into bio because referee_applications has no venue
    // column; it is a review aid for the admin, not queried data.
    const bio = body.data.bio
      ? `Venue: ${body.data.venue_name}. ${body.data.bio}`
      : `Venue: ${body.data.venue_name}.`

    const application = await db
      .insertInto('referee_applications')
      .values({
        user_id: request.userId,
        full_name: body.data.full_name,
        city: body.data.city,
        phone: body.data.phone ?? null,
        request_type: 'organizer',
        bio,
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    return reply.code(201).send(application)
  })

  /**
   * GET /organizer/me
   * The caller's role plus their latest application, for driving the UI state.
   */
  app.get('/organizer/me', { preHandler: requireAuth }, async (request, reply) => {
    const db = getDb()

    const me = await db
      .selectFrom('users')
      .select(['id', 'name', 'role'])
      .where('id', '=', request.userId)
      .executeTakeFirst()

    if (!me) return reply.code(401).send({ error: 'Unauthorized' })

    const application = await db
      .selectFrom('referee_applications')
      .selectAll()
      .where('user_id', '=', request.userId)
      .where('request_type', '=', 'organizer')
      .orderBy('created_at', 'desc')
      .executeTakeFirst()

    return {
      user_id: me.id,
      name: me.name,
      role: me.role,
      is_organizer: me.role === 'organizer' || me.role === 'admin',
      application: application ?? null,
    }
  })
}
```

- [ ] **Step 4: Register the routes**

In `backend/src/app.ts`, add the import after the `refereeRoutes` import:

```ts
import { organizerRoutes } from './modules/organizer/organizer.routes'
```

And register it after `refereeRoutes`:

```ts
  await app.register(organizerRoutes, { prefix: V1_PREFIX })
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
DATABASE_URL="postgresql://allsports:password@localhost:5433/allsports_test" \
  REDIS_URL="redis://localhost:6380" \
  npm --workspace backend run test -- organizer
```

Expected: PASS — 6 tests in `organizer.test.ts`.

- [ ] **Step 6: Verify types and the existing suite still pass**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports/backend && npx tsc --noEmit
cd /Users/advaitchoudhary/Documents/compete/allsports
DATABASE_URL="postgresql://allsports:password@localhost:5433/allsports_test" \
  REDIS_URL="redis://localhost:6380" npm --workspace backend run test
```

Expected: 0 type errors; all test files pass (`scores.test.ts` 6 + `organizer.test.ts` 6).

- [ ] **Step 7: Commit**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
git add backend/src/modules/organizer/organizer.routes.ts backend/src/app.ts backend/src/tests/organizer.test.ts
git commit -m "feat(organizer): add organizer application endpoints"
```

---

### Task 3: Admin approval promotes organizers

**Files:**
- Modify: `backend/src/modules/admin/admin.routes.ts:53-118` (the approve handler)
- Modify: `backend/src/tests/organizer.test.ts`

**Interfaces:**
- Consumes: `request_type: 'organizer'` rows created by Task 2; `UserRole` including `'organizer'` from Task 1.
- Produces: `POST /admin/referee-applications/:id/approve` now sets `role = 'organizer'` (leaving `referee_tier` NULL) when `application.request_type === 'organizer'`, and continues to set `role = 'referee'` with a tier otherwise. `GET /admin/referee-applications` accepts an optional `request_type` filter.

- [ ] **Step 1: Write the failing test**

Append these tests inside the `describe('Organizer identity', ...)` block in `backend/src/tests/organizer.test.ts`, after the `GET /v1/organizer/me` test:

```ts
  it('admin approval promotes the applicant to organizer, not referee', async () => {
    const db = getDb()
    const application = await db
      .selectFrom('referee_applications')
      .select('id')
      .where('user_id', '=', PLAYER_ID)
      .where('request_type', '=', 'organizer')
      .where('status', '=', 'pending')
      .executeTakeFirstOrThrow()

    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/referee-applications/${application.id}/approve`,
      headers: { authorization: makeAuthHeader(ADMIN_ID, app) },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().approved).toBe(true)

    const promoted = await db
      .selectFrom('users')
      .select(['role', 'referee_tier'])
      .where('id', '=', PLAYER_ID)
      .executeTakeFirstOrThrow()

    expect(promoted.role).toBe('organizer')
    // An organizer never officiates, so they must not be granted a referee tier.
    expect(promoted.referee_tier).toBeNull()
  })

  it('GET /v1/admin/referee-applications can filter by request_type', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/referee-applications?status=approved&request_type=organizer',
      headers: { authorization: makeAuthHeader(ADMIN_ID, app) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.applications.length).toBeGreaterThanOrEqual(1)
    for (const a of body.applications) {
      expect(a.request_type).toBe('organizer')
    }
  })

  it('rejects an invalid request_type filter', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/referee-applications?request_type=bogus',
      headers: { authorization: makeAuthHeader(ADMIN_ID, app) },
    })
    expect(res.statusCode).toBe(400)
  })
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
DATABASE_URL="postgresql://allsports:password@localhost:5433/allsports_test" \
  REDIS_URL="redis://localhost:6380" \
  npm --workspace backend run test -- organizer
```

Expected: FAIL — the promotion test reports `expected 'referee' to be 'organizer'`, and the filter tests fail because `request_type` is ignored (returns 200 with mixed types / no 400).

- [ ] **Step 3: Branch the promotion on request_type**

In `backend/src/modules/admin/admin.routes.ts`, replace this block inside the approve transaction:

```ts
        // Promote to referee and set their tier. Initial requests grant
        // 'amateur'; upgrade requests grant the requested tier.
        const grantedTier = application.requested_tier ?? 'amateur'
        await trx
          .updateTable('users')
          .set({ role: 'referee', referee_tier: grantedTier })
          .where('id', '=', application.user_id)
          .execute()
```

with:

```ts
        if (application.request_type === 'organizer') {
          // Organizers schedule; they never officiate. Deliberately leave
          // referee_tier NULL so no scoring capability is implied.
          await trx
            .updateTable('users')
            .set({ role: 'organizer' })
            .where('id', '=', application.user_id)
            .execute()
        } else {
          // Promote to referee and set their tier. Initial requests grant
          // 'amateur'; upgrade requests grant the requested tier.
          const grantedTier = application.requested_tier ?? 'amateur'
          await trx
            .updateTable('users')
            .set({ role: 'referee', referee_tier: grantedTier })
            .where('id', '=', application.user_id)
            .execute()
        }
```

- [ ] **Step 4: Add the request_type filter to the review queue**

In `backend/src/modules/admin/admin.routes.ts`, replace the query-parsing lines in the `GET /admin/referee-applications` handler:

```ts
      const query = request.query as { status?: string; limit?: string; offset?: string }
      const status = query.status ?? 'pending'
      const limit = Math.min(Number(query.limit ?? 50), 100)
      const offset = Number(query.offset ?? 0)

      if (!['pending', 'approved', 'rejected'].includes(status)) {
        return reply.code(400).send({ error: 'Invalid status filter' })
      }
```

with:

```ts
      const query = request.query as {
        status?: string
        request_type?: string
        limit?: string
        offset?: string
      }
      const status = query.status ?? 'pending'
      const limit = Math.min(Number(query.limit ?? 50), 100)
      const offset = Number(query.offset ?? 0)

      if (!['pending', 'approved', 'rejected'].includes(status)) {
        return reply.code(400).send({ error: 'Invalid status filter' })
      }
      if (
        query.request_type &&
        !['initial', 'upgrade', 'organizer'].includes(query.request_type)
      ) {
        return reply.code(400).send({ error: 'Invalid request_type filter' })
      }
```

Then change the query builder so the filter can be applied conditionally. Replace:

```ts
      const applications = await getDb()
        .selectFrom('referee_applications as ra')
```

with:

```ts
      let q = getDb()
        .selectFrom('referee_applications as ra')
```

and replace the tail of that same statement:

```ts
        .where('ra.status', '=', status as 'pending' | 'approved' | 'rejected')
        .orderBy('ra.created_at', 'desc')
        .limit(limit)
        .offset(offset)
        .execute()

      return { status, count: applications.length, applications }
```

with:

```ts
        .where('ra.status', '=', status as 'pending' | 'approved' | 'rejected')
        .orderBy('ra.created_at', 'desc')
        .limit(limit)
        .offset(offset)

      if (query.request_type) {
        q = q.where(
          'ra.request_type',
          '=',
          query.request_type as 'initial' | 'upgrade' | 'organizer'
        )
      }

      const applications = await q.execute()

      return {
        status,
        request_type: query.request_type ?? null,
        count: applications.length,
        applications,
      }
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
DATABASE_URL="postgresql://allsports:password@localhost:5433/allsports_test" \
  REDIS_URL="redis://localhost:6380" \
  npm --workspace backend run test -- organizer
```

Expected: PASS — 9 tests in `organizer.test.ts`.

- [ ] **Step 6: Verify types**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports/backend && npx tsc --noEmit
```

Expected: no output.

- [ ] **Step 7: Commit**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
git add backend/src/modules/admin/admin.routes.ts backend/src/tests/organizer.test.ts
git commit -m "feat(organizer): admin approval promotes organizers and queue filters by request_type"
```

---

### Task 4: Close the POST /events gate

**Files:**
- Modify: `backend/src/modules/events/events.routes.ts:3,28` (import and the `POST /events` preHandler)
- Modify: `backend/src/tests/organizer.test.ts`

**Interfaces:**
- Consumes: `role = 'organizer'` set by Task 3; `requireRole` from `shared/middleware/auth`.
- Produces: `POST /v1/events` requires role `organizer` or `admin`; a `player` receives 403.

- [ ] **Step 1: Write the failing test**

Append to `describe('Organizer identity', ...)` in `backend/src/tests/organizer.test.ts`:

```ts
  it('a plain player cannot create an event', async () => {
    // PLAYER_ID was promoted to organizer earlier in this file, so use a
    // throwaway player seeded just for this check.
    const OUTSIDER_ID = '550e8400-e29b-41d4-a716-4466554401a4'
    await seedUser(OUTSIDER_ID, 'Outsider', 'player')

    const res = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { authorization: makeAuthHeader(OUTSIDER_ID, app) },
      payload: {
        name: 'Unauthorised Cup',
        sport_slug: 'football',
        format: 'knockout',
        city: 'Mumbai',
      },
    })
    expect(res.statusCode).toBe(403)

    await getDb().deleteFrom('users').where('id', '=', OUTSIDER_ID).execute()
  })

  it('an approved organizer can create an event', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { authorization: makeAuthHeader(PLAYER_ID, app) },
      payload: {
        name: 'Sunday Turf Cup',
        sport_slug: 'football',
        format: 'group_knockout',
        city: 'Mumbai',
        venue: 'Powai Turf Arena',
        max_teams: 8,
        entry_fee: 200000,
      },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.organizer_id).toBe(PLAYER_ID)
    expect(body.format).toBe('group_knockout')

    await getDb().deleteFrom('events').where('id', '=', body.id).execute()
  })
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
DATABASE_URL="postgresql://allsports:password@localhost:5433/allsports_test" \
  REDIS_URL="redis://localhost:6380" \
  npm --workspace backend run test -- organizer
```

Expected: FAIL — `expected 201 to be 403` on the player test, because `POST /events` currently only requires authentication.

- [ ] **Step 3: Gate the endpoint**

In `backend/src/modules/events/events.routes.ts`, change the middleware import:

```ts
import { requireAuth, requireRole } from '../../shared/middleware/auth'
```

Then change the `POST /events` registration line:

```ts
  // POST /events — only verified organizers (or admins) may run a tournament.
  app.post('/events', { preHandler: requireRole('organizer', 'admin') }, async (request, reply) => {
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
DATABASE_URL="postgresql://allsports:password@localhost:5433/allsports_test" \
  REDIS_URL="redis://localhost:6380" \
  npm --workspace backend run test -- organizer
```

Expected: PASS — 11 tests in `organizer.test.ts`.

- [ ] **Step 5: Verify types and the whole suite**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports/backend && npx tsc --noEmit
cd /Users/advaitchoudhary/Documents/compete/allsports
DATABASE_URL="postgresql://allsports:password@localhost:5433/allsports_test" \
  REDIS_URL="redis://localhost:6380" npm --workspace backend run test
```

Expected: 0 type errors; every test file passes. `requireAuth` is still imported and used by the other event routes, so no unused-import error.

- [ ] **Step 6: Commit**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
git add backend/src/modules/events/events.routes.ts backend/src/tests/organizer.test.ts
git commit -m "feat(organizer): restrict event creation to organizers and admins"
```

---

### Task 5: Assign referees to an event

**Files:**
- Create: `backend/src/modules/events/event-referees.routes.ts`
- Modify: `backend/src/app.ts`
- Create: `backend/src/tests/event-referees.test.ts`

**Interfaces:**
- Consumes: `event_referees` table and `EventRefereeTable` type from Task 1; `role = 'organizer'` from Task 3.
- Produces: `export async function eventRefereesRoutes(app: FastifyInstance)` registering `POST /events/:id/referees` (body `{ referees: Array<{ user_id: string; pitch_label?: string }> }`, replaces the whole roster) and `GET /events/:id/referees`. This is the pool Phase 3's fixture generator reads to stamp `matches.referee_id`.

- [ ] **Step 1: Write the failing test**

Create `backend/src/tests/event-referees.test.ts`:

```ts
/**
 * Integration tests — assigning referees to an event.
 * The organizer picks from already-approved referees; this is the pool the
 * fixture generator later draws from. The organizer never gains scoring rights.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.mock('../shared/queue/ratings.stream', () => ({
  enqueueRatingJob: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../modules/auth/auth.service', () => ({
  initFirebase: vi.fn(),
  verifyFirebaseToken: vi.fn().mockResolvedValue({
    uid: 'test-eventref-uid',
    phone_number: '+919999999002',
    email: undefined,
  }),
  issueJwt: vi.fn().mockReturnValue('test-jwt-token'),
}))

import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import { eventRefereesRoutes } from '../modules/events/event-referees.routes'
import { getDb } from '../shared/db/client'

const TEST_JWT_SECRET = 'test-jwt-secret-minimum-32-chars-long'

const ORGANIZER_ID = '550e8400-e29b-41d4-a716-4466554402b1'
const OTHER_ORGANIZER_ID = '550e8400-e29b-41d4-a716-4466554402b2'
const REFEREE_A_ID = '550e8400-e29b-41d4-a716-4466554402b3'
const REFEREE_B_ID = '550e8400-e29b-41d4-a716-4466554402b4'
const PLAYER_ID = '550e8400-e29b-41d4-a716-4466554402b5'

let eventId: string

async function buildTestApp() {
  const app = Fastify({ logger: false })
  await app.register(jwt, { secret: TEST_JWT_SECRET })
  await app.register(eventRefereesRoutes, { prefix: '/v1' })
  return app
}

function makeAuthHeader(userId: string, app: any): string {
  return `Bearer ${app.jwt.sign({ sub: userId }, { expiresIn: '1h' })}`
}

async function seedUser(id: string, name: string, role: string, refereeTier?: string) {
  await getDb()
    .insertInto('users')
    .values({ id, name, role: role as any, referee_tier: (refereeTier ?? null) as any })
    .onConflict((oc) =>
      oc.column('id').doUpdateSet({
        role: role as any,
        referee_tier: (refereeTier ?? null) as any,
      })
    )
    .execute()
}

describe('Event referees', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>

  beforeAll(async () => {
    app = await buildTestApp()
    await app.ready()

    await seedUser(ORGANIZER_ID, 'Turf Owner', 'organizer')
    await seedUser(OTHER_ORGANIZER_ID, 'Rival Owner', 'organizer')
    await seedUser(REFEREE_A_ID, 'Referee A', 'referee', 'amateur')
    await seedUser(REFEREE_B_ID, 'Referee B', 'referee', 'semi_pro')
    await seedUser(PLAYER_ID, 'Just A Player', 'player')

    const db = getDb()
    const sport = await db
      .selectFrom('sports')
      .select('id')
      .where('slug', '=', 'football')
      .executeTakeFirstOrThrow()

    const event = await db
      .insertInto('events')
      .values({
        name: 'Referee Assignment Cup',
        sport_id: sport.id,
        organizer_id: ORGANIZER_ID,
        format: 'group_knockout',
        city: 'Mumbai',
        status: 'registration',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    eventId = event.id
  })

  afterAll(async () => {
    const db = getDb()
    await db.deleteFrom('event_referees').where('event_id', '=', eventId).execute()
    await db.deleteFrom('events').where('id', '=', eventId).execute()
    await db
      .deleteFrom('users')
      .where('id', 'in', [
        ORGANIZER_ID,
        OTHER_ORGANIZER_ID,
        REFEREE_A_ID,
        REFEREE_B_ID,
        PLAYER_ID,
      ])
      .execute()
    await app.close()
  })

  it('requires the organizer role', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/referees`,
      headers: { authorization: makeAuthHeader(PLAYER_ID, app) },
      payload: { referees: [{ user_id: REFEREE_A_ID }] },
    })
    expect(res.statusCode).toBe(403)
  })

  it('refuses an organizer who does not own the event', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/referees`,
      headers: { authorization: makeAuthHeader(OTHER_ORGANIZER_ID, app) },
      payload: { referees: [{ user_id: REFEREE_A_ID }] },
    })
    expect(res.statusCode).toBe(403)
  })

  it('returns 404 for an unknown event', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/events/550e8400-e29b-41d4-a716-4466554402ff/referees',
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
      payload: { referees: [{ user_id: REFEREE_A_ID }] },
    })
    expect(res.statusCode).toBe(404)
  })

  it('refuses a user who is not an approved referee', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/referees`,
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
      payload: { referees: [{ user_id: PLAYER_ID }] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('not an approved referee')
  })

  it('assigns referees with pitch labels', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/referees`,
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
      payload: {
        referees: [
          { user_id: REFEREE_A_ID, pitch_label: 'Pitch 1' },
          { user_id: REFEREE_B_ID, pitch_label: 'Pitch 2' },
        ],
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().count).toBe(2)
  })

  it('GET returns the assigned referees with their names and tiers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/events/${eventId}/referees`,
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.count).toBe(2)
    const labels = body.referees.map((r: any) => r.pitch_label).sort()
    expect(labels).toEqual(['Pitch 1', 'Pitch 2'])
    const tiers = body.referees.map((r: any) => r.referee_tier).sort()
    expect(tiers).toEqual(['amateur', 'semi_pro'])
  })

  it('replaces the roster rather than appending', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/referees`,
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
      payload: { referees: [{ user_id: REFEREE_A_ID, pitch_label: 'Pitch 1' }] },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().count).toBe(1)

    const rows = await getDb()
      .selectFrom('event_referees')
      .select('user_id')
      .where('event_id', '=', eventId)
      .execute()
    expect(rows).toHaveLength(1)
    expect(rows[0].user_id).toBe(REFEREE_A_ID)
  })

  it('rejects a duplicate referee in one request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/referees`,
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
      payload: {
        referees: [
          { user_id: REFEREE_A_ID, pitch_label: 'Pitch 1' },
          { user_id: REFEREE_A_ID, pitch_label: 'Pitch 2' },
        ],
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('duplicate')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
DATABASE_URL="postgresql://allsports:password@localhost:5433/allsports_test" \
  REDIS_URL="redis://localhost:6380" \
  npm --workspace backend run test -- event-referees
```

Expected: FAIL — `Failed to resolve import "../modules/events/event-referees.routes"`.

- [ ] **Step 3: Write the implementation**

Create `backend/src/modules/events/event-referees.routes.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireRole } from '../../shared/middleware/auth'
import { getDb } from '../../shared/db/client'

const SetRefereesBody = z.object({
  referees: z
    .array(
      z.object({
        user_id: z.string().uuid(),
        pitch_label: z.string().max(40).optional(),
      })
    )
    .min(1)
    .max(20),
})

export async function eventRefereesRoutes(app: FastifyInstance) {
  /**
   * POST /events/:id/referees
   *
   * The organizer nominates which already-approved referees are working this
   * tournament, and optionally pins each to a pitch. Replaces the whole roster
   * so the client can send the current selection without diffing.
   *
   * This grants the organizer NO scoring ability — it only records who is
   * eligible to be stamped onto generated matches as referee_id. Scoring stays
   * gated behind requireRole('referee','admin') plus assertMatchReferee.
   */
  app.post(
    '/events/:id/referees',
    { preHandler: requireRole('organizer', 'admin') },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const body = SetRefereesBody.safeParse(request.body)
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() })

      const ids = body.data.referees.map((r) => r.user_id)
      if (new Set(ids).size !== ids.length) {
        return reply.code(400).send({ error: 'The same referee appears twice (duplicate user_id)' })
      }

      const db = getDb()

      const event = await db
        .selectFrom('events')
        .select(['id', 'organizer_id'])
        .where('id', '=', id)
        .executeTakeFirst()

      if (!event) return reply.code(404).send({ error: 'Event not found' })
      if (event.organizer_id !== request.userId && request.userRole !== 'admin') {
        return reply.code(403).send({ error: 'Forbidden — not your event' })
      }

      // Every nominee must actually hold the referee role. An organizer cannot
      // smuggle a friend (or themselves) into a scoring position.
      const valid = await db
        .selectFrom('users')
        .select('id')
        .where('id', 'in', ids)
        .where('role', 'in', ['referee', 'admin'])
        .where('is_active', '=', true)
        .execute()

      const validIds = new Set(valid.map((u) => u.id))
      const invalid = ids.filter((uid) => !validIds.has(uid))
      if (invalid.length > 0) {
        return reply.code(400).send({
          error: `not an approved referee: ${invalid.join(', ')}`,
        })
      }

      await db.transaction().execute(async (trx) => {
        await trx.deleteFrom('event_referees').where('event_id', '=', id).execute()
        await trx
          .insertInto('event_referees')
          .values(
            body.data.referees.map((r) => ({
              event_id: id,
              user_id: r.user_id,
              pitch_label: r.pitch_label ?? null,
            }))
          )
          .execute()
      })

      return { event_id: id, count: body.data.referees.length }
    }
  )

  /**
   * GET /events/:id/referees
   * The event's referee roster, with names and tiers so the organizer can see
   * which tiers of match each of them is allowed to officiate.
   */
  app.get(
    '/events/:id/referees',
    { preHandler: requireRole('organizer', 'admin') },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const db = getDb()

      const event = await db
        .selectFrom('events')
        .select(['id', 'organizer_id'])
        .where('id', '=', id)
        .executeTakeFirst()

      if (!event) return reply.code(404).send({ error: 'Event not found' })
      if (event.organizer_id !== request.userId && request.userRole !== 'admin') {
        return reply.code(403).send({ error: 'Forbidden — not your event' })
      }

      const referees = await db
        .selectFrom('event_referees as er')
        .innerJoin('users as u', 'u.id', 'er.user_id')
        .select([
          'er.user_id',
          'er.pitch_label',
          'er.added_at',
          'u.name',
          'u.avatar_url',
          'u.referee_tier',
        ])
        .where('er.event_id', '=', id)
        .orderBy('er.pitch_label', 'asc')
        .execute()

      return { event_id: id, count: referees.length, referees }
    }
  )
}
```

- [ ] **Step 4: Register the routes**

In `backend/src/app.ts`, add the import after the `eventsRoutes` import:

```ts
import { eventRefereesRoutes } from './modules/events/event-referees.routes'
```

And register it immediately after `eventsRoutes`:

```ts
  await app.register(eventRefereesRoutes, { prefix: V1_PREFIX })
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
DATABASE_URL="postgresql://allsports:password@localhost:5433/allsports_test" \
  REDIS_URL="redis://localhost:6380" \
  npm --workspace backend run test -- event-referees
```

Expected: PASS — 8 tests in `event-referees.test.ts`.

- [ ] **Step 6: Verify types and the full suite**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports/backend && npx tsc --noEmit
cd /Users/advaitchoudhary/Documents/compete/allsports
DATABASE_URL="postgresql://allsports:password@localhost:5433/allsports_test" \
  REDIS_URL="redis://localhost:6380" npm --workspace backend run test
```

Expected: 0 type errors; 3 test files pass (`scores.test.ts` 6, `organizer.test.ts` 11, `event-referees.test.ts` 8 = 25 tests).

- [ ] **Step 7: Commit**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
git add backend/src/modules/events/event-referees.routes.ts backend/src/app.ts backend/src/tests/event-referees.test.ts
git commit -m "feat(organizer): assign approved referees to an event"
```

---

## Done criteria

Phase 1 is complete when all of the following hold:

1. `npm --workspace backend run db:migrate` applies `009` and `010` against a fresh database.
2. `npx tsc --noEmit` from `backend/` reports 0 errors.
3. The full Vitest suite passes: 25 tests across 3 files.
4. A player can apply to be an organizer, an admin can approve them, and the promoted user can create an event but still cannot score a match.
5. `POST /v1/events` returns 403 for a plain player.
6. An organizer can set and read their event's referee roster, and cannot touch another organizer's event.

## Out of scope for this plan

Deliberately deferred to later plans, per the spec's build order: team self-registration with guests (Phase 2), `event_fixtures` and the generator/resolver/standings (Phase 3), fast tournament scoring and rating match-weight (Phase 4), the public bracket page (Phase 5), guest claiming (Phase 6), push notifications (Phase 7). No mobile UI is built here — this plan is backend only.

## Deviations from the spec

- **Added `GET /v1/organizer/me`**, which the spec's endpoint table (§5) does not list. It mirrors the existing `GET /v1/referee/me` and exists so the mobile UI can render the right state (apply CTA / pending / approved) without guessing. Additive and consistent with an established pattern, but recording it so the spec and code don't silently diverge.
- **`venue_name` is folded into `bio`** on the application row rather than getting its own column. `referee_applications` has no venue column, and adding one for a single review-aid string isn't worth a migration. If venue ever needs querying, it earns a column then.

## Known follow-ups discovered during planning

- `backend/src/modules/events/events.routes.ts:57` still writes `rules` with `JSON.stringify(...) as unknown as Record<string, unknown>`. That cast became unnecessary when `JsonbColumn<T>` replaced `JSONColumnType<T>`; the object can now be passed directly. Harmless, worth cleaning when next touching that file.
- `backend/Dockerfile` runs `npm ci` with build context `./backend`, where no lockfile exists (this is a workspaces monorepo). The `production` target therefore cannot build, which fails CI's Docker Build Check and would fail a Fly deploy. Independent of this plan, but blocks shipping.
