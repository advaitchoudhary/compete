# Team Self-Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give tournaments a tier that cannot be inflated, then let a captain register their whole squad into one in a single call — typing in players who have no account, because at a turf tournament most of them don't.

**Architecture:** Two halves. First, **tier authority**: `events.tier` plus the rule that it may never exceed the lowest `referee_tier` among the event's assigned referees, enforced when setting the tier, when the roster changes, and (in Phase 3) per-match at fixture generation. This is the anti-fraud mechanism the whole rating ladder rests on — see spec §3.1.1. Second, **registration**: one composite endpoint, `POST /v1/events/:id/register`, creating the team, its `team_members`, any guest `users` rows and the `event_teams` row in a single transaction, with guests as the primary path. Plus `events.match_format` so squad minimums are checked against the real a-side format, and a roster-returning `GET /v1/events/:id/teams` so an organizer can verify squads before Phase 3 generates fixtures.

**Tech Stack:** Fastify 4, Kysely 0.27 (Postgres), Zod, Vitest, raw-SQL migrations run by node-pg-migrate.

## Global Constraints

- Continue on branch **`feat/organizer-foundation`** — Phase 1 and Phase 2 will be merged to `main` together. Do not merge or open a PR.
- Migrations are plain SQL in `backend/migrations/`, named `NNN_snake_case.sql`. Phase 1 added `009` and `010`; this plan adds **`011`**. Every statement must be idempotent.
- Backend runs from the repo root as an npm workspace: `npm --workspace backend run <script>`.
- `npx tsc --noEmit` (from `backend/`) must report 0 errors before any commit.
- Vitest integration tests using `app.inject()` against a real Postgres. Local test DB: `postgresql://allsports:password@localhost:5433/allsports_test`.
- **Test cleanup must run in both `beforeAll` and `afterAll`, deleting children before parents.** A mid-test assertion failure otherwise leaves FK-blocking rows that poison every later run — this bit us in Phase 1.
- Apply new migrations to the dev DB **by hand** (`docker exec -i allsports_postgres psql -U allsports -d allsports_dev -q < backend/migrations/NNN.sql`). `allsports_dev` has no `pgmigrations` table, so `db:migrate` there would re-run everything.

## Product decisions (confirmed 2026-07-29)

| Decision | Choice |
|---|---|
| Who may register a team | Any authenticated user. They become that team's captain. |
| One player on two teams in the same event | **Blocked** — it corrupts ratings and the bracket. |
| Squad size | Enforced minimum per a-side format. |
| Opening registration | The organizer flips `events.status` to `registration` explicitly via the existing `PATCH /events/:id/status`. |
| Duplicate team names within one event | Rejected, compared case-insensitively after trimming. |

---

### Task 1: `events.tier` and `events.match_format`

**Files:**
- Create: `backend/migrations/011_event_tier_and_format.sql`
- Modify: `backend/src/shared/db/types.ts`
- Modify: `backend/src/modules/events/events.routes.ts` (accept `match_format` on create)

**Interfaces:**
- Consumes: nothing.
- Produces: `events.tier` (NOT NULL DEFAULT `'amateur'`, one of the four `MatchTier` values) and `events.match_format` (nullable, one of `'5-a-side' | '7-a-side' | '11-a-side'`); `EventTable.tier: Generated<MatchTier>` and `EventTable.match_format: MatchFormat | null`; exported `export type MatchFormat = '5-a-side' | '7-a-side' | '11-a-side'`; `POST /v1/events` accepts an optional `match_format`.

**Why `events.tier` matters most:** tier drives rating weight (amateur 1.0 → legends 3.0 in the blended overall Elo), so whoever controls tier controls the ladder. Today that authority sits with referees — `matches.routes.ts:41-53` refuses any match above the creating referee's own tier. Phase 3's generator creates matches on the *organizer's* command, and organizers have no tier, so without this column and the rules in Task 2 an organizer could declare a `legends` tournament and inflate 80 players at 3.0× weight. See spec §3.1.1.

**Why `events.match_format` is needed:** `events.format` is the *tournament structure* (`knockout`, `group_knockout`, …), not how many players per side. Nothing currently records that a tournament is 5-a-side, so a squad minimum cannot be enforced. The spec originally assumed this lived inside the `events.rules` JSON blob; a real column is validated, queryable and typed.

**Note:** `tier` is deliberately **not** accepted by `POST /events`. A brand-new event has no referees, so nothing above `amateur` could ever be authorised at creation time — accepting it there would be a guaranteed-fail path. It is set afterwards via `PATCH /events/:id/tier` (Task 2).

- [ ] **Step 1: Write migration 011**

Create `backend/migrations/011_event_tier_and_format.sql`:

```sql
-- AllSports — Event Tier & Match Format
-- Migration: 011_event_tier_and_format
-- Run order: 11
--
-- events.tier is the competition grade of the whole tournament, and every match
-- generated for it inherits this tier. Tier drives rating weight (amateur 1.0 →
-- legends 3.0), so this column is the lever the anti-fraud rules protect:
-- an event's tier may not exceed the LOWEST referee_tier among its assigned
-- referees. See spec §3.1.1. Defaults to 'amateur' so an unspecified tournament
-- is always the lowest-weight one, never the highest.
--
-- events.match_format records players per side, which events.format does NOT —
-- that column holds the tournament structure (knockout / group_knockout / …).
-- Needed to enforce a minimum squad size at registration, and later to stamp
-- matches.format for rating match-weight.

ALTER TABLE events ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'amateur'
  CHECK (tier IN ('amateur', 'semi_pro', 'pro', 'legends'));

CREATE INDEX IF NOT EXISTS idx_events_tier ON events(tier, status);

-- Nullable because existing events predate it; registration falls back to the
-- most permissive minimum when it is NULL.
ALTER TABLE events ADD COLUMN IF NOT EXISTS match_format TEXT
  CHECK (match_format IN ('5-a-side', '7-a-side', '11-a-side'));
```

- [ ] **Step 2: Apply to both databases and verify**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
DATABASE_URL="postgresql://allsports:password@localhost:5433/allsports_test" npm --workspace backend run db:migrate
docker exec -i allsports_postgres psql -U allsports -d allsports_dev -q < backend/migrations/011_event_tier_and_format.sql
docker exec allsports_postgres psql -U allsports -d allsports_test -tAc \
  "SELECT conname||' => '||pg_get_constraintdef(oid) FROM pg_constraint WHERE conname IN ('events_tier_check','events_match_format_check');"
docker exec allsports_postgres psql -U allsports -d allsports_test -tAc \
  "SELECT column_name||' default='||COALESCE(column_default,'NONE') FROM information_schema.columns WHERE table_name='events' AND column_name IN ('tier','match_format');"
```

Expected: migrate log shows `### MIGRATION 011_event_tier_and_format (UP) ###` then `Migrations complete!`; both constraints print; and `tier` shows `default='amateur'::text` while `match_format` shows `default=NONE`.

- [ ] **Step 3: Add the Kysely types**

In `backend/src/shared/db/types.ts`, add next to the other exported unions (after `EventStatus`):

```ts
export type MatchFormat = '5-a-side' | '7-a-side' | '11-a-side'
```

And in `EventTable`, add after the `format` line:

```ts
  // Competition grade of the whole tournament; every generated match inherits it.
  // Capped by the lowest referee_tier among assigned referees — see spec §3.1.1.
  tier: Generated<MatchTier>
  // Players per side — distinct from `format`, which is the tournament structure.
  match_format: MatchFormat | null
```

`MatchTier` is already imported at the top of this file (`import type { MatchTier } from '../tiers'`), so no new import is needed.

- [ ] **Step 4: Accept it when creating an event**

In `backend/src/modules/events/events.routes.ts`, add to `CreateEventBody` after the `format` line:

```ts
  match_format: z.enum(['5-a-side', '7-a-side', '11-a-side']).optional(),
```

And in the `.values({ ... })` of the insert, after the `format` line:

```ts
        match_format: body.data.match_format ?? null,
```

- [ ] **Step 5: Verify types and existing tests**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports/backend && npx tsc --noEmit
cd /Users/advaitchoudhary/Documents/compete/allsports
DATABASE_URL="postgresql://allsports:password@localhost:5433/allsports_test" \
  REDIS_URL="redis://localhost:6380" npm --workspace backend run test
```

Expected: 0 type errors; 25 tests still pass (3 files).

- [ ] **Step 6: Commit**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
git add backend/migrations/011_event_tier_and_format.sql backend/src/shared/db/types.ts backend/src/modules/events/events.routes.ts
git commit -m "feat(events): add events.tier and events.match_format"
```

---

### Task 2: Tier authority — the anti-fraud enforcement

**Files:**
- Create: `backend/src/modules/events/event-tier.ts`
- Create: `backend/src/modules/events/event-tier.routes.ts`
- Modify: `backend/src/modules/events/event-referees.routes.ts` (re-check tier when the roster changes)
- Modify: `backend/src/app.ts`
- Create: `backend/src/tests/event-tier.test.ts`

**Interfaces:**
- Consumes: `events.tier` from Task 1; `event_referees` from Phase 1; `MATCH_TIERS`, `TIER_RANK`, `canOfficiate` from `shared/tiers`.
- Produces:
  - `export async function maxTierForEvent(eventId: string): Promise<MatchTier>` — the highest tier an event's current referee roster can support.
  - `export async function assertTierSupported(eventId: string, tier: MatchTier): Promise<{ ok: true } | { ok: false; reason: string }>`
  - `export async function eventTierRoutes(app: FastifyInstance)` registering `PATCH /events/:id/tier`.

**The rule (spec §3.1.1):** an event's tier may not exceed the **lowest** `referee_tier` among its assigned referees. Every match in a pro tournament must be officiated at pro level, so the weakest assigned referee constrains the whole tournament. Assigned admins are unrestricted and excluded from the floor. An event with **zero** assigned referees supports `amateur` only. Tier freezes once any match exists for the event.

- [ ] **Step 1: Write the failing test**

Create `backend/src/tests/event-tier.test.ts`:

```ts
/**
 * Integration tests — event tier authority (spec §3.1.1).
 *
 * These are the highest-value tests in the codebase: tier drives rating weight
 * (amateur 1.0 → legends 3.0), so a hole here lets an organizer inflate the
 * whole ladder. The rule: an event's tier may not exceed the LOWEST referee_tier
 * among its assigned referees.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.mock('../shared/queue/ratings.stream', () => ({
  enqueueRatingJob: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../modules/auth/auth.service', () => ({
  initFirebase: vi.fn(),
  verifyFirebaseToken: vi.fn().mockResolvedValue({
    uid: 'test-tier-uid',
    phone_number: '+919999999004',
    email: undefined,
  }),
  issueJwt: vi.fn().mockReturnValue('test-jwt-token'),
}))

import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import { eventTierRoutes } from '../modules/events/event-tier.routes'
import { eventRefereesRoutes } from '../modules/events/event-referees.routes'
import { getDb } from '../shared/db/client'

const TEST_JWT_SECRET = 'test-jwt-secret-minimum-32-chars-long'

const ORGANIZER_ID = '550e8400-e29b-41d4-a716-4466554404d1'
const REF_AMATEUR_ID = '550e8400-e29b-41d4-a716-4466554404d2'
const REF_PRO_ID = '550e8400-e29b-41d4-a716-4466554404d3'
const REF_LEGENDS_ID = '550e8400-e29b-41d4-a716-4466554404d4'

const ALL_TEST_USERS = [ORGANIZER_ID, REF_AMATEUR_ID, REF_PRO_ID, REF_LEGENDS_ID]

let eventId: string

async function buildTestApp() {
  const app = Fastify({ logger: false })
  await app.register(jwt, { secret: TEST_JWT_SECRET })
  await app.register(eventTierRoutes, { prefix: '/v1' })
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

async function cleanupTestData() {
  const db = getDb()
  const events = await db
    .selectFrom('events')
    .select('id')
    .where('organizer_id', 'in', ALL_TEST_USERS)
    .execute()
  const eventIds = events.map((e) => e.id)
  if (eventIds.length > 0) {
    await db.deleteFrom('matches').where('event_id', 'in', eventIds).execute()
    await db.deleteFrom('event_referees').where('event_id', 'in', eventIds).execute()
    await db.deleteFrom('event_teams').where('event_id', 'in', eventIds).execute()
    await db.deleteFrom('events').where('id', 'in', eventIds).execute()
  }
  await db.deleteFrom('event_referees').where('user_id', 'in', ALL_TEST_USERS).execute()
  await db.deleteFrom('organizer_scores').where('user_id', 'in', ALL_TEST_USERS).execute()
  await db.deleteFrom('users').where('id', 'in', ALL_TEST_USERS).execute()
}

async function setReferees(
  app: any,
  refs: Array<{ user_id: string; pitch_label?: string }>
) {
  return app.inject({
    method: 'POST',
    url: `/v1/events/${eventId}/referees`,
    headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
    payload: { referees: refs },
  })
}

async function setTier(app: any, tier: string) {
  return app.inject({
    method: 'PATCH',
    url: `/v1/events/${eventId}/tier`,
    headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
    payload: { tier },
  })
}

describe('Event tier authority', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>

  beforeAll(async () => {
    app = await buildTestApp()
    await app.ready()
    await cleanupTestData()

    await seedUser(ORGANIZER_ID, 'Turf Owner', 'organizer')
    await seedUser(REF_AMATEUR_ID, 'Amateur Ref', 'referee', 'amateur')
    await seedUser(REF_PRO_ID, 'Pro Ref', 'referee', 'pro')
    await seedUser(REF_LEGENDS_ID, 'Legends Ref', 'referee', 'legends')

    const db = getDb()
    const sport = await db
      .selectFrom('sports')
      .select('id')
      .where('slug', '=', 'football')
      .executeTakeFirstOrThrow()

    const event = await db
      .insertInto('events')
      .values({
        name: 'Tier Authority Cup',
        sport_id: sport.id,
        organizer_id: ORGANIZER_ID,
        format: 'knockout',
        city: 'Mumbai',
        status: 'registration',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    eventId = event.id
  })

  afterAll(async () => {
    await cleanupTestData()
    await app.close()
  })

  it('a new event defaults to amateur', async () => {
    const row = await getDb()
      .selectFrom('events')
      .select('tier')
      .where('id', '=', eventId)
      .executeTakeFirstOrThrow()
    expect(row.tier).toBe('amateur')
  })

  it('with no referees assigned, only amateur is allowed', async () => {
    const res = await setTier(app, 'pro')
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('amateur')

    const ok = await setTier(app, 'amateur')
    expect(ok.statusCode).toBe(200)
  })

  it('rejects an invalid tier value', async () => {
    const res = await setTier(app, 'superstar')
    expect(res.statusCode).toBe(400)
  })

  it('cannot exceed the lowest assigned referee tier', async () => {
    // A pro and an amateur referee: the amateur is the floor, so pro is refused.
    const assign = await setReferees(app, [
      { user_id: REF_PRO_ID, pitch_label: 'Pitch 1' },
      { user_id: REF_AMATEUR_ID, pitch_label: 'Pitch 2' },
    ])
    expect(assign.statusCode).toBe(200)

    const res = await setTier(app, 'pro')
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('amateur')
  })

  it('allows the tier once every assigned referee qualifies', async () => {
    const assign = await setReferees(app, [
      { user_id: REF_PRO_ID, pitch_label: 'Pitch 1' },
      { user_id: REF_LEGENDS_ID, pitch_label: 'Pitch 2' },
    ])
    expect(assign.statusCode).toBe(200)

    // Floor is now 'pro' (legends outranks it), so pro is allowed.
    const res = await setTier(app, 'pro')
    expect(res.statusCode).toBe(200)
    expect(res.json().tier).toBe('pro')
  })

  it('still refuses a tier above the floor', async () => {
    // Floor is 'pro', so legends must be refused.
    const res = await setTier(app, 'legends')
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('pro')
  })

  it('refuses a referee swap that would undercut the current tier', async () => {
    // Event is 'pro'. Swapping in the amateur referee would drop the floor
    // below it — the exact loophole this check exists to close.
    const res = await setReferees(app, [{ user_id: REF_AMATEUR_ID, pitch_label: 'Pitch 1' }])
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('pro')

    // The roster must be unchanged.
    const rows = await getDb()
      .selectFrom('event_referees')
      .select('user_id')
      .where('event_id', '=', eventId)
      .execute()
    expect(rows).toHaveLength(2)
  })

  it('lowering the tier first then swapping referees is allowed', async () => {
    const down = await setTier(app, 'amateur')
    expect(down.statusCode).toBe(200)

    const res = await setReferees(app, [{ user_id: REF_AMATEUR_ID, pitch_label: 'Pitch 1' }])
    expect(res.statusCode).toBe(200)
  })

  it('freezes the tier once a match exists for the event', async () => {
    const db = getDb()
    const sport = await db
      .selectFrom('sports')
      .select('id')
      .where('slug', '=', 'football')
      .executeTakeFirstOrThrow()
    const teams = await db.selectFrom('teams').select('id').limit(2).execute()
    // Requires at least two teams to exist in the test DB (the seed provides them).
    expect(teams.length).toBeGreaterThanOrEqual(2)

    await db
      .insertInto('matches')
      .values({
        event_id: eventId,
        sport_id: sport.id,
        home_team_id: teams[0].id,
        away_team_id: teams[1].id,
        status: 'scheduled',
        tier: 'amateur',
        referee_id: REF_AMATEUR_ID,
      })
      .execute()

    const res = await setTier(app, 'semi_pro')
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('fixtures')
  })

  it('only the event owner may change the tier', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/events/${eventId}/tier`,
      headers: { authorization: makeAuthHeader(REF_PRO_ID, app) },
      payload: { tier: 'amateur' },
    })
    // A referee isn't an organizer at all, so this is a role rejection.
    expect(res.statusCode).toBe(403)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
DATABASE_URL="postgresql://allsports:password@localhost:5433/allsports_test" \
  REDIS_URL="redis://localhost:6380" \
  npm --workspace backend run test -- event-tier
```

Expected: FAIL — `Failed to load url ../modules/events/event-tier.routes`.

- [ ] **Step 3: Write the tier helper**

Create `backend/src/modules/events/event-tier.ts`:

```ts
import { getDb } from '../../shared/db/client'
import { TIER_RANK, type MatchTier } from '../../shared/tiers'

/**
 * The highest tier an event's current referee roster can support.
 *
 * Every match in a pro tournament must be officiated at pro level, so the
 * WEAKEST assigned referee constrains the whole event. Assigned admins are
 * unrestricted and excluded from the floor. An event with no assigned referees
 * supports 'amateur' only. See spec §3.1.1.
 */
export async function maxTierForEvent(eventId: string): Promise<MatchTier> {
  const assigned = await getDb()
    .selectFrom('event_referees as er')
    .innerJoin('users as u', 'u.id', 'er.user_id')
    .select(['u.role', 'u.referee_tier'])
    .where('er.event_id', '=', eventId)
    .execute()

  // Admins bypass tier gating everywhere else, so they don't constrain the floor.
  const constraining = assigned.filter((a) => a.role !== 'admin')

  if (constraining.length === 0) {
    // Either nobody is assigned, or only admins are. Neither justifies a raised
    // tier on its own — a tournament needs verified officials to be graded.
    return 'amateur'
  }

  let floor: MatchTier = 'legends'
  for (const ref of constraining) {
    // A null referee_tier cannot officiate at all, so it pins the event to amateur.
    const tier = ref.referee_tier ?? 'amateur'
    if (TIER_RANK[tier] < TIER_RANK[floor]) floor = tier
  }
  return floor
}

/**
 * Whether an event may hold the given tier, and why not if it may not.
 * Used by PATCH /events/:id/tier and by referee assignment.
 */
export async function assertTierSupported(
  eventId: string,
  tier: MatchTier
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const max = await maxTierForEvent(eventId)
  if (TIER_RANK[tier] <= TIER_RANK[max]) return { ok: true }
  return {
    ok: false,
    reason: `This event's referees only support '${max}' — a '${tier}' tournament needs every assigned referee at '${tier}' or above`,
  }
}

/** True once any match exists for the event, after which the tier is frozen. */
export async function eventHasFixtures(eventId: string): Promise<boolean> {
  const match = await getDb()
    .selectFrom('matches')
    .select('id')
    .where('event_id', '=', eventId)
    .executeTakeFirst()
  return Boolean(match)
}
```

- [ ] **Step 4: Write the tier endpoint**

Create `backend/src/modules/events/event-tier.routes.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireRole } from '../../shared/middleware/auth'
import { getDb } from '../../shared/db/client'
import { MATCH_TIERS } from '../../shared/tiers'
import { assertTierSupported, eventHasFixtures, maxTierForEvent } from './event-tier'

const SetTierBody = z.object({ tier: z.enum(MATCH_TIERS) })

export async function eventTierRoutes(app: FastifyInstance) {
  /**
   * PATCH /events/:id/tier
   *
   * Sets the competition grade of a tournament. Capped by the lowest
   * referee_tier among assigned referees, and frozen once fixtures exist so a
   * finished amateur event cannot be re-declared 'legends' to retroactively
   * reweight ratings. See spec §3.1.1.
   */
  app.patch(
    '/events/:id/tier',
    { preHandler: requireRole('organizer', 'admin') },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const body = SetTierBody.safeParse(request.body)
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() })

      const db = getDb()
      const event = await db
        .selectFrom('events')
        .select(['id', 'organizer_id', 'tier'])
        .where('id', '=', id)
        .executeTakeFirst()

      if (!event) return reply.code(404).send({ error: 'Event not found' })
      if (event.organizer_id !== request.userId && request.userRole !== 'admin') {
        return reply.code(403).send({ error: 'Forbidden — not your event' })
      }

      if (await eventHasFixtures(id)) {
        return reply.code(409).send({
          error: 'Tier is locked once fixtures have been generated',
        })
      }

      const supported = await assertTierSupported(id, body.data.tier)
      if (!supported.ok) return reply.code(409).send({ error: supported.reason })

      const updated = await db
        .updateTable('events')
        .set({ tier: body.data.tier })
        .where('id', '=', id)
        .returning(['id', 'tier'])
        .executeTakeFirstOrThrow()

      return { event_id: updated.id, tier: updated.tier, max_supported: await maxTierForEvent(id) }
    }
  )
}
```

- [ ] **Step 5: Close the referee-swap loophole**

In `backend/src/modules/events/event-referees.routes.ts`, add the import:

```ts
import { maxTierForEvent } from './event-tier'
import { TIER_RANK } from '../../shared/tiers'
```

Change the event lookup in the POST handler to also select the tier:

```ts
      const event = await db
        .selectFrom('events')
        .select(['id', 'organizer_id', 'tier'])
        .where('id', '=', id)
        .executeTakeFirst()
```

Then, immediately **before** the `db.transaction()` call, insert:

```ts
      // Closing the loophole: an organizer could set 'pro' with pro referees and
      // then swap them for amateurs. Simulate the resulting roster and refuse if
      // it would no longer support the event's current tier. See spec §3.1.1.
      const wouldBeFloor = await (async () => {
        const nominees = await db
          .selectFrom('users')
          .select(['role', 'referee_tier'])
          .where('id', 'in', ids)
          .execute()
        const constraining = nominees.filter((n) => n.role !== 'admin')
        if (constraining.length === 0) return 'amateur' as const
        let floor: 'amateur' | 'semi_pro' | 'pro' | 'legends' = 'legends'
        for (const n of constraining) {
          const t = n.referee_tier ?? 'amateur'
          if (TIER_RANK[t] < TIER_RANK[floor]) floor = t
        }
        return floor
      })()

      if (TIER_RANK[wouldBeFloor] < TIER_RANK[event.tier]) {
        return reply.code(409).send({
          error: `This roster only supports '${wouldBeFloor}' but the event is '${event.tier}' — lower the event tier first, or assign referees at '${event.tier}' or above`,
        })
      }
```

- [ ] **Step 6: Register the routes**

In `backend/src/app.ts`, add the import after `eventRefereesRoutes`:

```ts
import { eventTierRoutes } from './modules/events/event-tier.routes'
```

And register it after `eventRefereesRoutes`:

```ts
  await app.register(eventTierRoutes, { prefix: V1_PREFIX })
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
DATABASE_URL="postgresql://allsports:password@localhost:5433/allsports_test" \
  REDIS_URL="redis://localhost:6380" \
  npm --workspace backend run test -- event-tier
```

Expected: PASS — 10 tests in `event-tier.test.ts`.

- [ ] **Step 8: Verify types and the full suite twice**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports/backend && npx tsc --noEmit
cd /Users/advaitchoudhary/Documents/compete/allsports
for i in 1 2; do
  DATABASE_URL="postgresql://allsports:password@localhost:5433/allsports_test" \
    REDIS_URL="redis://localhost:6380" npm --workspace backend run test 2>&1 | grep -E "Test Files|Tests "
done
```

Expected: 0 type errors; 4 files, 35 tests passing both times (25 from Phase 1 + 10 here).

- [ ] **Step 9: Commit**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
git add backend/src/modules/events/event-tier.ts backend/src/modules/events/event-tier.routes.ts backend/src/modules/events/event-referees.routes.ts backend/src/app.ts backend/src/tests/event-tier.test.ts
git commit -m "feat(events): cap event tier by the weakest assigned referee"
```

---

### Task 3: `POST /events/:id/register` — squad registration with guests

**Files:**
- Create: `backend/src/modules/events/event-registration.routes.ts`
- Modify: `backend/src/app.ts`
- Create: `backend/src/tests/event-registration.test.ts`

**Interfaces:**
- Consumes: `MatchFormat` and `events.match_format` from Task 1.
- Produces: `export async function eventRegistrationRoutes(app: FastifyInstance)` registering `POST /events/:id/register`. Body: `{ team_name: string; city?: string; players: Array<{ user_id?: string; name?: string }> }` where each player carries **exactly one** of `user_id` or `name`. Returns 201 `{ team_id, event_id, team_name, roster: Array<{ user_id, name, is_guest, role }> }`. Also exports `MIN_SQUAD: Record<MatchFormat, number>` for reuse by Phase 3's generator.

- [ ] **Step 1: Write the failing test**

Create `backend/src/tests/event-registration.test.ts`:

```ts
/**
 * Integration tests — a captain registers their whole squad into a tournament.
 * Guest players are the primary path: at a turf tournament most of a roster has
 * no account, so the captain simply types names.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.mock('../shared/queue/ratings.stream', () => ({
  enqueueRatingJob: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../modules/auth/auth.service', () => ({
  initFirebase: vi.fn(),
  verifyFirebaseToken: vi.fn().mockResolvedValue({
    uid: 'test-reg-uid',
    phone_number: '+919999999003',
    email: undefined,
  }),
  issueJwt: vi.fn().mockReturnValue('test-jwt-token'),
}))

import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import { eventRegistrationRoutes } from '../modules/events/event-registration.routes'
import { getDb } from '../shared/db/client'

const TEST_JWT_SECRET = 'test-jwt-secret-minimum-32-chars-long'

const ORGANIZER_ID = '550e8400-e29b-41d4-a716-4466554403c1'
const CAPTAIN_A_ID = '550e8400-e29b-41d4-a716-4466554403c2'
const CAPTAIN_B_ID = '550e8400-e29b-41d4-a716-4466554403c3'
const KNOWN_PLAYER_ID = '550e8400-e29b-41d4-a716-4466554403c4'

const ALL_TEST_USERS = [ORGANIZER_ID, CAPTAIN_A_ID, CAPTAIN_B_ID, KNOWN_PLAYER_ID]

let openEventId: string
let closedEventId: string
let footballSportId: string

async function buildTestApp() {
  const app = Fastify({ logger: false })
  await app.register(jwt, { secret: TEST_JWT_SECRET })
  await app.register(eventRegistrationRoutes, { prefix: '/v1' })
  return app
}

function makeAuthHeader(userId: string, app: any): string {
  return `Bearer ${app.jwt.sign({ sub: userId }, { expiresIn: '1h' })}`
}

async function seedUser(id: string, name: string, role: string) {
  await getDb()
    .insertInto('users')
    .values({ id, name, role: role as any })
    .onConflict((oc) => oc.column('id').doUpdateSet({ role: role as any }))
    .execute()
}

/**
 * Children before parents. Also removes guest users created by these tests and
 * any teams they produced, which would otherwise block deleting the captains.
 */
async function cleanupTestData() {
  const db = getDb()

  const events = await db
    .selectFrom('events')
    .select('id')
    .where('organizer_id', 'in', ALL_TEST_USERS)
    .execute()
  const eventIds = events.map((e) => e.id)

  const teams = await db
    .selectFrom('teams')
    .select('id')
    .where('organizer_id', 'in', ALL_TEST_USERS)
    .execute()
  const teamIds = teams.map((t) => t.id)

  const guests = await db
    .selectFrom('users')
    .select('id')
    .where('created_by', 'in', ALL_TEST_USERS)
    .execute()
  const guestIds = guests.map((g) => g.id)

  if (eventIds.length > 0) {
    await db.deleteFrom('event_teams').where('event_id', 'in', eventIds).execute()
    await db.deleteFrom('event_referees').where('event_id', 'in', eventIds).execute()
  }
  if (teamIds.length > 0) {
    await db.deleteFrom('event_teams').where('team_id', 'in', teamIds).execute()
    await db.deleteFrom('team_members').where('team_id', 'in', teamIds).execute()
  }
  if (guestIds.length > 0) {
    await db.deleteFrom('team_members').where('user_id', 'in', guestIds).execute()
  }
  await db.deleteFrom('team_members').where('user_id', 'in', ALL_TEST_USERS).execute()
  if (teamIds.length > 0) {
    await db.deleteFrom('teams').where('id', 'in', teamIds).execute()
  }
  if (eventIds.length > 0) {
    await db.deleteFrom('events').where('id', 'in', eventIds).execute()
  }
  if (guestIds.length > 0) {
    await db.deleteFrom('users').where('id', 'in', guestIds).execute()
  }
  await db.deleteFrom('organizer_scores').where('user_id', 'in', ALL_TEST_USERS).execute()
  await db.deleteFrom('users').where('id', 'in', ALL_TEST_USERS).execute()
}

describe('Team self-registration', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>

  beforeAll(async () => {
    app = await buildTestApp()
    await app.ready()

    await cleanupTestData()

    await seedUser(ORGANIZER_ID, 'Turf Owner', 'organizer')
    await seedUser(CAPTAIN_A_ID, 'Captain A', 'player')
    await seedUser(CAPTAIN_B_ID, 'Captain B', 'player')
    await seedUser(KNOWN_PLAYER_ID, 'Known Player', 'player')

    const db = getDb()
    const sport = await db
      .selectFrom('sports')
      .select('id')
      .where('slug', '=', 'football')
      .executeTakeFirstOrThrow()
    footballSportId = sport.id

    const open = await db
      .insertInto('events')
      .values({
        name: 'Open Registration Cup',
        sport_id: footballSportId,
        organizer_id: ORGANIZER_ID,
        format: 'group_knockout',
        match_format: '5-a-side',
        city: 'Mumbai',
        status: 'registration',
        max_teams: 2,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    openEventId = open.id

    const closed = await db
      .insertInto('events')
      .values({
        name: 'Not Yet Open Cup',
        sport_id: footballSportId,
        organizer_id: ORGANIZER_ID,
        format: 'knockout',
        match_format: '5-a-side',
        city: 'Mumbai',
        status: 'upcoming',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    closedEventId = closed.id
  })

  afterAll(async () => {
    await cleanupTestData()
    await app.close()
  })

  it('requires authentication', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${openEventId}/register`,
      payload: { team_name: 'Anon FC', players: [{ name: 'Someone' }] },
    })
    expect(res.statusCode).toBe(401)
  })

  it('returns 404 for an unknown event', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/events/550e8400-e29b-41d4-a716-4466554403ff/register',
      headers: { authorization: makeAuthHeader(CAPTAIN_A_ID, app) },
      payload: { team_name: 'Ghost FC', players: [{ name: 'A' }] },
    })
    expect(res.statusCode).toBe(404)
  })

  it('refuses registration when the organizer has not opened it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${closedEventId}/register`,
      headers: { authorization: makeAuthHeader(CAPTAIN_A_ID, app) },
      payload: {
        team_name: 'Too Early FC',
        players: [{ name: 'P1' }, { name: 'P2' }, { name: 'P3' }, { name: 'P4' }],
      },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('not accepting registrations')
  })

  it('rejects a player entry carrying both user_id and name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${openEventId}/register`,
      headers: { authorization: makeAuthHeader(CAPTAIN_A_ID, app) },
      payload: {
        team_name: 'Confused FC',
        players: [{ user_id: KNOWN_PLAYER_ID, name: 'Also A Name' }],
      },
    })
    expect(res.statusCode).toBe(400)
  })

  it('enforces the minimum squad size for the a-side format', async () => {
    // 5-a-side needs 5. Captain counts as one, so 3 more is only 4.
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${openEventId}/register`,
      headers: { authorization: makeAuthHeader(CAPTAIN_A_ID, app) },
      payload: {
        team_name: 'Short Squad FC',
        players: [{ name: 'P1' }, { name: 'P2' }, { name: 'P3' }],
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('at least 5')
  })

  it('registers a squad that is mostly guests', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${openEventId}/register`,
      headers: { authorization: makeAuthHeader(CAPTAIN_A_ID, app) },
      payload: {
        team_name: 'Powai Strikers',
        city: 'Mumbai',
        players: [
          { user_id: KNOWN_PLAYER_ID },
          { name: 'Rohit Sharma' },
          { name: 'Imran Khan' },
          { name: 'Sunil Chhetri' },
        ],
      },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.team_name).toBe('Powai Strikers')
    // captain + 4 = 5
    expect(body.roster).toHaveLength(5)
    expect(body.roster.filter((r: any) => r.is_guest)).toHaveLength(3)
    expect(body.roster.find((r: any) => r.user_id === CAPTAIN_A_ID).role).toBe('captain')

    // The guests are real users rows, attributed to the captain who typed them.
    const guests = await getDb()
      .selectFrom('users')
      .select(['name', 'is_guest', 'created_by', 'phone'])
      .where('created_by', '=', CAPTAIN_A_ID)
      .execute()
    expect(guests).toHaveLength(3)
    for (const g of guests) {
      expect(g.is_guest).toBe(true)
      expect(g.phone).toBeNull()
    }
  })

  it('rejects a duplicate team name in the same event, case-insensitively', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${openEventId}/register`,
      headers: { authorization: makeAuthHeader(CAPTAIN_B_ID, app) },
      payload: {
        team_name: '  powai strikers ',
        players: [{ name: 'Q1' }, { name: 'Q2' }, { name: 'Q3' }, { name: 'Q4' }],
      },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('already registered')
  })

  it('blocks a player from joining a second team in the same event', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${openEventId}/register`,
      headers: { authorization: makeAuthHeader(CAPTAIN_B_ID, app) },
      payload: {
        team_name: 'Poachers FC',
        players: [
          { user_id: KNOWN_PLAYER_ID },
          { name: 'R1' },
          { name: 'R2' },
          { name: 'R3' },
        ],
      },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('already registered in this event')
  })

  it('blocks the same captain from registering twice in one event', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${openEventId}/register`,
      headers: { authorization: makeAuthHeader(CAPTAIN_A_ID, app) },
      payload: {
        team_name: 'Second Team FC',
        players: [{ name: 'S1' }, { name: 'S2' }, { name: 'S3' }, { name: 'S4' }],
      },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('already registered in this event')
  })

  it('refuses an unknown user_id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${openEventId}/register`,
      headers: { authorization: makeAuthHeader(CAPTAIN_B_ID, app) },
      payload: {
        team_name: 'Phantom FC',
        players: [
          { user_id: '550e8400-e29b-41d4-a716-4466554403fe' },
          { name: 'T1' },
          { name: 'T2' },
          { name: 'T3' },
        ],
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('unknown user_id')
  })

  it('enforces max_teams capacity', async () => {
    // max_teams is 2 and Powai Strikers took the first slot. Fill the second.
    const second = await app.inject({
      method: 'POST',
      url: `/v1/events/${openEventId}/register`,
      headers: { authorization: makeAuthHeader(CAPTAIN_B_ID, app) },
      payload: {
        team_name: 'Galacticos B',
        players: [{ name: 'U1' }, { name: 'U2' }, { name: 'U3' }, { name: 'U4' }],
      },
    })
    expect(second.statusCode).toBe(201)

    // A third team must be turned away.
    const third = await app.inject({
      method: 'POST',
      url: `/v1/events/${openEventId}/register`,
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
      payload: {
        team_name: 'One Too Many FC',
        players: [{ name: 'V1' }, { name: 'V2' }, { name: 'V3' }, { name: 'V4' }],
      },
    })
    expect(third.statusCode).toBe(409)
    expect(third.json().error).toContain('full')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
DATABASE_URL="postgresql://allsports:password@localhost:5433/allsports_test" \
  REDIS_URL="redis://localhost:6380" \
  npm --workspace backend run test -- event-registration
```

Expected: FAIL — `Failed to load url ../modules/events/event-registration.routes`.

- [ ] **Step 3: Write the implementation**

Create `backend/src/modules/events/event-registration.routes.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAuth } from '../../shared/middleware/auth'
import { getDb } from '../../shared/db/client'
import type { MatchFormat } from '../../shared/db/types'

/**
 * Minimum players a squad must have, by a-side format. The captain counts as
 * one. Exported because Phase 3's fixture generator needs the same numbers.
 */
export const MIN_SQUAD: Record<MatchFormat, number> = {
  '5-a-side': 5,
  '7-a-side': 7,
  '11-a-side': 11,
}

/** Fallback when an event predates events.match_format — the most permissive. */
const DEFAULT_MIN_SQUAD = 5

/** Squad cap = minimum plus a bench. Keeps a roster from being a mailing list. */
const BENCH_ALLOWANCE = 7

const PlayerEntry = z
  .object({
    user_id: z.string().uuid().optional(),
    name: z.string().min(2).max(80).optional(),
  })
  .refine((p) => Boolean(p.user_id) !== Boolean(p.name), {
    message: 'each player needs exactly one of user_id or name',
  })

const RegisterBody = z.object({
  team_name: z.string().min(2).max(60),
  city: z.string().max(50).optional(),
  players: z.array(PlayerEntry).min(1).max(30),
})

export async function eventRegistrationRoutes(app: FastifyInstance) {
  /**
   * POST /events/:id/register
   *
   * A captain registers their whole squad in one call. Players are either an
   * existing user_id (found via GET /users/search) or a bare name, which becomes
   * a guest — the primary path, since most players at a turf tournament have no
   * account. Team, members, guests and the event_teams row are all created in a
   * single transaction so a partial squad can never be left behind.
   *
   * Guests are created inline rather than through POST /users/guest, which is
   * referee/admin-only. That keeps a general-purpose "invent users" endpoint away
   * from ordinary players while still letting a captain type in their mates.
   */
  app.post('/events/:id/register', { preHandler: requireAuth }, async (request, reply) => {
    const { id: eventId } = request.params as { id: string }
    const body = RegisterBody.safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() })

    const db = getDb()

    const event = await db
      .selectFrom('events')
      .select(['id', 'status', 'max_teams', 'sport_id', 'match_format'])
      .where('id', '=', eventId)
      .executeTakeFirst()

    if (!event) return reply.code(404).send({ error: 'Event not found' })

    // The organizer opens registration explicitly via PATCH /events/:id/status.
    if (event.status !== 'registration') {
      return reply.code(409).send({
        error: `Event is not accepting registrations (status: ${event.status})`,
      })
    }

    // ── Squad size ───────────────────────────────────────────────────────────
    // The captain is always part of the squad, so they count toward the minimum.
    const existingIds = body.data.players
      .filter((p) => p.user_id)
      .map((p) => p.user_id as string)
    const namedPlayers = body.data.players.filter((p) => p.name).map((p) => p.name as string)

    // A captain who also lists themselves shouldn't be counted or inserted twice.
    const otherExistingIds = [...new Set(existingIds)].filter((id) => id !== request.userId)
    const squadSize = 1 + otherExistingIds.length + namedPlayers.length

    const minSquad = event.match_format
      ? MIN_SQUAD[event.match_format]
      : DEFAULT_MIN_SQUAD
    if (squadSize < minSquad) {
      return reply.code(400).send({
        error: `A ${event.match_format ?? 'football'} squad needs at least ${minSquad} players (got ${squadSize}, including you as captain)`,
      })
    }
    if (squadSize > minSquad + BENCH_ALLOWANCE) {
      return reply.code(400).send({
        error: `A squad may have at most ${minSquad + BENCH_ALLOWANCE} players (got ${squadSize})`,
      })
    }

    // ── Duplicate team name in this event (case-insensitive) ─────────────────
    // Compared in JS rather than with a SQL lower(): an event holds at most 16
    // teams, so fetching the names is trivial and avoids a functional index.
    const teamName = body.data.team_name.trim()
    const existingTeams = await db
      .selectFrom('event_teams as et')
      .innerJoin('teams as t', 't.id', 'et.team_id')
      .select('t.name')
      .where('et.event_id', '=', eventId)
      .execute()

    const clash = existingTeams.some(
      (t) => t.name.trim().toLowerCase() === teamName.toLowerCase()
    )
    if (clash) {
      return reply.code(409).send({ error: `A team named "${teamName}" is already registered` })
    }

    // ── Capacity ─────────────────────────────────────────────────────────────
    if (event.max_teams) {
      const { count } = await db
        .selectFrom('event_teams')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('event_id', '=', eventId)
        .executeTakeFirstOrThrow()
      if (Number(count) >= event.max_teams) {
        return reply.code(409).send({ error: `Event is full (${event.max_teams} teams)` })
      }
    }

    // ── Existing players must exist ──────────────────────────────────────────
    if (otherExistingIds.length > 0) {
      const found = await db
        .selectFrom('users')
        .select('id')
        .where('id', 'in', otherExistingIds)
        .where('is_active', '=', true)
        .execute()
      const foundIds = new Set(found.map((u) => u.id))
      const missing = otherExistingIds.filter((id) => !foundIds.has(id))
      if (missing.length > 0) {
        return reply.code(400).send({ error: `unknown user_id: ${missing.join(', ')}` })
      }
    }

    // ── Nobody may play for two teams in the same event ──────────────────────
    const squadUserIds = [request.userId, ...otherExistingIds]
    const alreadyIn = await db
      .selectFrom('event_teams as et')
      .innerJoin('team_members as tm', 'tm.team_id', 'et.team_id')
      .innerJoin('users as u', 'u.id', 'tm.user_id')
      .select(['u.id', 'u.name'])
      .where('et.event_id', '=', eventId)
      .where('tm.user_id', 'in', squadUserIds)
      .execute()

    if (alreadyIn.length > 0) {
      const names = alreadyIn.map((u) => u.name).join(', ')
      return reply.code(409).send({
        error: `already registered in this event with another team: ${names}`,
      })
    }

    // ── Create everything atomically ─────────────────────────────────────────
    const result = await db.transaction().execute(async (trx) => {
      const team = await trx
        .insertInto('teams')
        .values({
          name: teamName,
          sport_id: event.sport_id,
          city: body.data.city ?? null,
          organizer_id: request.userId,
        })
        .returning(['id', 'name'])
        .executeTakeFirstOrThrow()

      await trx
        .insertInto('team_members')
        .values({ team_id: team.id, user_id: request.userId, role: 'captain' })
        .execute()

      // Guests are real users with no credentials, attributed to the captain who
      // entered them. They accumulate ratings and are claimable later (Phase 6).
      const guestIds: string[] = []
      for (const name of namedPlayers) {
        const guest = await trx
          .insertInto('users')
          .values({
            name,
            city: body.data.city ?? null,
            phone: null,
            firebase_uid: null,
            is_guest: true,
            created_by: request.userId,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
        guestIds.push(guest.id)
      }

      const memberIds = [...otherExistingIds, ...guestIds]
      if (memberIds.length > 0) {
        await trx
          .insertInto('team_members')
          .values(
            memberIds.map((uid) => ({
              team_id: team.id,
              user_id: uid,
              role: 'player' as const,
            }))
          )
          .execute()
      }

      await trx
        .insertInto('event_teams')
        .values({ event_id: eventId, team_id: team.id })
        .execute()

      const roster = await trx
        .selectFrom('team_members as tm')
        .innerJoin('users as u', 'u.id', 'tm.user_id')
        .select(['u.id as user_id', 'u.name', 'u.is_guest', 'tm.role'])
        .where('tm.team_id', '=', team.id)
        .execute()

      return { team, roster }
    })

    return reply.code(201).send({
      team_id: result.team.id,
      event_id: eventId,
      team_name: result.team.name,
      roster: result.roster,
    })
  })
}
```

- [ ] **Step 4: Register the routes**

In `backend/src/app.ts`, add the import after the `eventRefereesRoutes` import:

```ts
import { eventRegistrationRoutes } from './modules/events/event-registration.routes'
```

And register it after `eventRefereesRoutes`:

```ts
  await app.register(eventRegistrationRoutes, { prefix: V1_PREFIX })
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
DATABASE_URL="postgresql://allsports:password@localhost:5433/allsports_test" \
  REDIS_URL="redis://localhost:6380" \
  npm --workspace backend run test -- event-registration
```

Expected: PASS — 11 tests in `event-registration.test.ts`.

- [ ] **Step 6: Verify types, the full suite, and idempotency**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports/backend && npx tsc --noEmit
cd /Users/advaitchoudhary/Documents/compete/allsports
for i in 1 2; do
  DATABASE_URL="postgresql://allsports:password@localhost:5433/allsports_test" \
    REDIS_URL="redis://localhost:6380" npm --workspace backend run test 2>&1 | grep -E "Test Files|Tests "
done
```

Expected: 0 type errors; 5 files, 46 tests passing — **both times**. Running twice proves the cleanup handles guest users and teams correctly.

- [ ] **Step 7: Commit**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
git add backend/src/modules/events/event-registration.routes.ts backend/src/app.ts backend/src/tests/event-registration.test.ts
git commit -m "feat(events): captain registers a full squad with guest players"
```

---

### Task 4: `GET /events/:id/teams` — registered squads with rosters

**Files:**
- Modify: `backend/src/modules/events/event-registration.routes.ts`
- Modify: `backend/src/tests/event-registration.test.ts`

**Interfaces:**
- Consumes: the `event_teams` / `team_members` rows written by Task 3.
- Produces: `GET /events/:id/teams` returning `{ event_id, count, teams: Array<{ team_id, name, seed, group_no, players: Array<{ user_id, name, is_guest, role }> }> }`.

**Why this is needed:** `GET /events/:id` already returns registered team rows, but **without rosters** — so an organizer cannot check whether squads are complete before generating fixtures in Phase 3, and no screen can show who is actually playing.

- [ ] **Step 1: Write the failing test**

Append inside the `describe('Team self-registration', ...)` block in `backend/src/tests/event-registration.test.ts`:

```ts
  it('GET /v1/events/:id/teams returns every squad with its roster', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/events/${openEventId}/teams`,
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.count).toBe(2)

    const strikers = body.teams.find((t: any) => t.name === 'Powai Strikers')
    expect(strikers).toBeDefined()
    expect(strikers.players).toHaveLength(5)
    expect(strikers.players.filter((p: any) => p.is_guest)).toHaveLength(3)
    expect(strikers.players.find((p: any) => p.role === 'captain').user_id).toBe(CAPTAIN_A_ID)
  })

  it('GET /v1/events/:id/teams requires authentication', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/events/${openEventId}/teams`,
    })
    expect(res.statusCode).toBe(401)
  })

  it('GET /v1/events/:id/teams 404s for an unknown event', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/events/550e8400-e29b-41d4-a716-4466554403fd/teams',
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
    })
    expect(res.statusCode).toBe(404)
  })
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
DATABASE_URL="postgresql://allsports:password@localhost:5433/allsports_test" \
  REDIS_URL="redis://localhost:6380" \
  npm --workspace backend run test -- event-registration
```

Expected: FAIL — the roster test gets 404 because the route does not exist yet.

- [ ] **Step 3: Write the implementation**

Append inside `eventRegistrationRoutes` in `backend/src/modules/events/event-registration.routes.ts`, after the POST handler:

```ts
  /**
   * GET /events/:id/teams
   *
   * Every registered squad with its full roster. GET /events/:id returns the
   * team rows but no players, so this is what lets an organizer confirm squads
   * are complete before generating fixtures, and what a team-list screen renders.
   */
  app.get('/events/:id/teams', { preHandler: requireAuth }, async (request, reply) => {
    const { id: eventId } = request.params as { id: string }
    const db = getDb()

    const event = await db
      .selectFrom('events')
      .select('id')
      .where('id', '=', eventId)
      .executeTakeFirst()

    if (!event) return reply.code(404).send({ error: 'Event not found' })

    const teams = await db
      .selectFrom('event_teams as et')
      .innerJoin('teams as t', 't.id', 'et.team_id')
      .select([
        'et.team_id',
        't.name',
        't.avatar_url',
        'et.seed',
        'et.group_no',
        'et.points',
      ])
      .where('et.event_id', '=', eventId)
      .orderBy('et.seed', 'asc')
      .orderBy('t.name', 'asc')
      .execute()

    if (teams.length === 0) {
      return { event_id: eventId, count: 0, teams: [] }
    }

    // One query for every roster, then grouped in memory — avoids N+1.
    const members = await db
      .selectFrom('team_members as tm')
      .innerJoin('users as u', 'u.id', 'tm.user_id')
      .select(['tm.team_id', 'u.id as user_id', 'u.name', 'u.is_guest', 'tm.role'])
      .where(
        'tm.team_id',
        'in',
        teams.map((t) => t.team_id)
      )
      .execute()

    const byTeam = new Map<string, typeof members>()
    for (const m of members) {
      const list = byTeam.get(m.team_id) ?? []
      list.push(m)
      byTeam.set(m.team_id, list)
    }

    return {
      event_id: eventId,
      count: teams.length,
      teams: teams.map((t) => ({
        ...t,
        players: (byTeam.get(t.team_id) ?? []).map(({ team_id, ...p }) => p),
      })),
    }
  })
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
DATABASE_URL="postgresql://allsports:password@localhost:5433/allsports_test" \
  REDIS_URL="redis://localhost:6380" \
  npm --workspace backend run test -- event-registration
```

Expected: PASS — 14 tests in `event-registration.test.ts`.

- [ ] **Step 5: Verify types and the full suite twice**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports/backend && npx tsc --noEmit
cd /Users/advaitchoudhary/Documents/compete/allsports
for i in 1 2; do
  DATABASE_URL="postgresql://allsports:password@localhost:5433/allsports_test" \
    REDIS_URL="redis://localhost:6380" npm --workspace backend run test 2>&1 | grep -E "Test Files|Tests "
done
```

Expected: 0 type errors; 5 files, 49 tests passing both times.

- [ ] **Step 6: Verify live against the running app**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
docker compose restart backend
# p05 is already an organizer in dev from Phase 1
TOKEN=$(curl -s -X POST http://localhost:13000/v1/auth/dev-token -H 'Content-Type: application/json' \
  -d '{"key":"p05"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
EV=$(curl -s -X POST http://localhost:13000/v1/events -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Reg Test Cup","sport_slug":"football","format":"knockout","match_format":"5-a-side","city":"Mumbai","max_teams":4}' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
curl -s -X PATCH "http://localhost:13000/v1/events/$EV/status" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"status":"registration"}' > /dev/null
CAP=$(curl -s -X POST http://localhost:13000/v1/auth/dev-token -H 'Content-Type: application/json' \
  -d '{"key":"p07"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
curl -s -X POST "http://localhost:13000/v1/events/$EV/register" -H "Authorization: Bearer $CAP" \
  -H 'Content-Type: application/json' \
  -d '{"team_name":"Sunday Legends","players":[{"name":"Guest One"},{"name":"Guest Two"},{"name":"Guest Three"},{"name":"Guest Four"}]}'
curl -s "http://localhost:13000/v1/events/$EV/teams" -H "Authorization: Bearer $CAP"
```

Expected: the register call returns 201 with a 5-player roster (captain + 4 guests, `is_guest: true`), and the teams call lists one team with those 5 players.

- [ ] **Step 7: Commit**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
git add backend/src/modules/events/event-registration.routes.ts backend/src/tests/event-registration.test.ts
git commit -m "feat(events): list registered squads with full rosters"
```

---

## Done criteria

1. Migration `011` applied to both the test and dev databases.
2. `npx tsc --noEmit` reports 0 errors.
3. 49 tests pass across 5 files, twice in a row.
4. A captain can register a squad of mostly guests in one call; the guests exist as real `users` rows with `is_guest = true` and `created_by` set to the captain.
5. Registration is refused when: the organizer hasn't opened it, the squad is under the format minimum, the team name clashes, the event is full, a `user_id` is unknown, or any squad member already plays for another team in that event.
6. `GET /events/:id/teams` returns every squad with its full roster.

## Out of scope

Per the spec's build order: `event_fixtures` and the generator/resolver/standings (Phase 3), fast scoring and rating match-weight (Phase 4), the public bracket page (Phase 5), guest claiming (Phase 6), push notifications (Phase 7). No mobile UI — backend only. Team *editing* after registration (swapping a player who didn't show) is deliberately deferred; nothing in Phase 3 needs it.

## Gaps discovered while planning

- **`events.tier` — RESOLVED in this plan.** The gap was real and serious: spec §3.3 stamped matches with `tier` "from the event" while `events` had no such column, and Phase 3's generator would have created matches on an organizer's command with no tier authority at all. Tasks 1 and 2 add the column and the referee-derived cap. **Phase 3 still owes the third enforcement point:** every generated match must pass `canOfficiate(assignedReferee.referee_tier, match.tier)` or the whole generation transaction is refused.
- **Spec §3.3 assumed `format` and `duration_minutes` live inside `events.rules` (JSON).** Task 1 makes `match_format` a real column instead — validated, typed and queryable. Phase 3/4 should add `events.match_duration_minutes` the same way rather than reading the JSON blob.
- **Tier lock uses "any match exists for this event" as its proxy for "fixtures generated".** That is correct today because nothing else creates event matches, but once Phase 3 introduces `event_fixtures` the check should move to that table, which is the more direct signal.
- **`POST /events/:id/teams` (the pre-existing endpoint) accepts events in status `upcoming` OR `registration`**, whereas the new `POST /events/:id/register` requires `registration` exactly, per the confirmed decision that organizers open registration explicitly. The two endpoints now disagree. Worth reconciling — most likely by tightening the old one — but out of scope here since nothing calls it yet.
