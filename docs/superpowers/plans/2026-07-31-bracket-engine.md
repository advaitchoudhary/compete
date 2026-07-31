# Bracket Engine Implementation Plan (Phase 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One button turns a list of registered teams into a complete tournament day — every match with a slot, a pitch and a referee — and the bracket then advances itself as results come in.

**Architecture:** The hard logic lives in two **pure, database-free functions**: a `planner` that turns a team count and format into a bracket shape, and a `scheduler` that assigns slots and pitches. Both are exhaustively unit-testable with no Postgres. Thin DB layers sit on top: a `generator` that persists a plan, a `resolver` that advances the bracket on match completion, and a `standings` module. The bracket lives in its own `event_fixtures` table so `matches` is never given nullable team columns (spec §3.3).

**Tech Stack:** Fastify 4, Kysely 0.27 (Postgres), Zod, Vitest, raw-SQL migrations run by node-pg-migrate.

## Global Constraints

- Continue on branch **`feat/organizer-foundation`**. Phases 1–3 merge to `main` together. Do not merge or open a PR.
- Migrations: Phase 1 added `009`/`010`, Phase 2 added `011`. This plan adds **`012`, `013`, `014`**. Every statement idempotent.
- Apply new migrations to the dev DB **by hand**: `docker exec -i allsports_postgres psql -U allsports -d allsports_dev -q < backend/migrations/NNN.sql`. `allsports_dev` has no `pgmigrations` table.
- `npx tsc --noEmit` (from `backend/`) must report 0 errors before any commit.
- Test cleanup runs in **both** `beforeAll` and `afterAll`, children before parents. A mid-test failure otherwise leaves FK-blocking rows.
- Local test DB: `postgresql://allsports:password@localhost:5433/allsports_test`. Test DB has **no seeded teams** — tests create their own.
- Phase 2 finished at **49 tests across 5 files**. Every task states the new running total.

## Product decisions (confirmed 2026-07-31, spec §3.3)

| Decision | Choice |
|---|---|
| Team counts | **Never rejected.** `knockout` works for any N ≥ 2 via a play-in round with byes to top seeds. |
| Groups | `group_knockout` requires **equal group sizes** (a fairness property — unequal groups aren't comparable for best-runner-up). Falls back to `knockout` with an explanation when impossible. |
| Third place | **No third-place match.** |
| Points | 3 win / 1 draw / 0 loss. Group draws allowed; knockout must be decisive (referee records the penalty result as the score). |
| Pitch count | Derived from distinct `pitch_label` on `event_referees` — never stored, so it can't disagree. |
| Slot length | New `events.match_duration_minutes`. |
| Kickoff | Existing `events.starts_at`. |
| Regeneration | Allowed while **every** match for the event is still `scheduled`; deletes those matches and all fixtures, then rebuilds. |
| Tier | **Every generated match must pass `canOfficiate(referee.referee_tier, match.tier)` or the whole transaction is refused** — the third enforcement point of §3.1.1. |

## Deviation from the spec, recorded

The spec sketched a `{"type":"group_position","group":"A","pos":1}` fixture source. This plan uses **`{"type":"qualifier","seed":n}`** instead: when the last group match finishes, the resolver ranks all qualifiers at once (group winners first, then best runners-up) and fills the entire first knockout round in one step.

Why: it mirrors how a real draw works (bracket set after groups conclude), it handles "3 group winners plus the best runner-up" with no extra source type, and it needs one resolver path instead of two. Cross-group comparison is fair precisely because group sizes are equal.

**Accepted simplification:** qualifier pairing is `seed 1 v seed Q`, `2 v Q−1`, … which can pair two teams from the same group in the first knockout round. Real tournaments avoid that; for a single-day turf event it isn't worth the complexity, and it is deterministic and explainable.

---

### Task 1: Schema — duration, standings, fixtures

**Files:**
- Create: `backend/migrations/012_event_match_duration.sql`
- Create: `backend/migrations/013_event_standings.sql`
- Create: `backend/migrations/014_event_fixtures.sql`
- Modify: `backend/src/shared/db/types.ts`
- Modify: `backend/src/modules/events/events.routes.ts`

**Interfaces:**
- Consumes: `events`, `event_teams`, `matches`, `teams` as they stand after Phase 2.
- Produces: `events.match_duration_minutes: number | null`; `event_teams` gains `played/won/drawn/lost/goals_for/goals_against` as `Generated<number>`; new `EventFixtureTable` registered on `Database` as `event_fixtures`; exported `FixtureSource` type; `POST /v1/events` accepts optional `match_duration_minutes`.

- [ ] **Step 1: Write migration 012**

Create `backend/migrations/012_event_match_duration.sql`:

```sql
-- AllSports — Event Match Duration
-- Migration: 012_event_match_duration
-- Run order: 12
--
-- Slot length for the fixture generator (match + changeover), and the input
-- Phase 4 needs to weight ratings: a 12-minute 5-a-side must not move Elo like a
-- 90-minute match. Nullable because existing events predate it; the generator
-- falls back to a default when NULL.

ALTER TABLE events ADD COLUMN IF NOT EXISTS match_duration_minutes INTEGER
  CHECK (match_duration_minutes > 0 AND match_duration_minutes <= 180);
```

- [ ] **Step 2: Write migration 013**

Create `backend/migrations/013_event_standings.sql`:

```sql
-- AllSports — Event Standings
-- Migration: 013_event_standings
-- Run order: 13
--
-- The columns a real group table needs. event_teams.points already exists but
-- nothing ever wrote it. Maintained by the resolver for GROUP-STAGE matches only
-- — knockout results don't belong in a group table.
--
-- Tie-break order: points → goal difference → goals for → head-to-head
-- (two-way only; 3+ way falls back to seed, which is explainable on the pitch).

ALTER TABLE event_teams ADD COLUMN IF NOT EXISTS played        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE event_teams ADD COLUMN IF NOT EXISTS won           INTEGER NOT NULL DEFAULT 0;
ALTER TABLE event_teams ADD COLUMN IF NOT EXISTS drawn         INTEGER NOT NULL DEFAULT 0;
ALTER TABLE event_teams ADD COLUMN IF NOT EXISTS lost          INTEGER NOT NULL DEFAULT 0;
ALTER TABLE event_teams ADD COLUMN IF NOT EXISTS goals_for     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE event_teams ADD COLUMN IF NOT EXISTS goals_against INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 3: Write migration 014**

Create `backend/migrations/014_event_fixtures.sql`:

```sql
-- AllSports — Event Fixtures (the bracket)
-- Migration: 014_event_fixtures
-- Run order: 14
--
-- A FIXTURE is a slot in a competition structure; a MATCH is a game between two
-- known teams. Different lifecycles: group fixtures know both teams immediately,
-- knockout fixtures resolve over the course of the day. Keeping them apart is
-- what lets matches.home_team_id / away_team_id stay NOT NULL — see spec §3.3,
-- where the nullable alternative was measured at 78 references across 13 files
-- including four innerJoins that would SILENTLY DROP rows.
--
-- home_source / away_source say how each side is filled:
--   {"type":"team","team_id":"…"}      known now (group stage)
--   {"type":"winner_of","fixture_id":"…"}  winner of an earlier fixture
--   {"type":"qualifier","seed":n}      nth-ranked qualifier once groups conclude

CREATE TABLE IF NOT EXISTS event_fixtures (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_id      UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  -- 'group_a'.. | 'play_in' | 'round_of_16' | 'quarter' | 'semi' | 'final'
  round         TEXT NOT NULL,
  slot_no       INTEGER NOT NULL,
  pitch_label   TEXT,
  scheduled_at  TIMESTAMPTZ,
  referee_id    UUID REFERENCES users(id),

  home_source   JSONB NOT NULL,
  away_source   JSONB NOT NULL,

  home_team_id  UUID REFERENCES teams(id),
  away_team_id  UUID REFERENCES teams(id),

  -- Set once both teams are known. UNIQUE is the guard against the fixtures and
  -- matches tables drifting: one fixture can own at most one match.
  match_id      UUID UNIQUE REFERENCES matches(id) ON DELETE SET NULL,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (event_id, round, slot_no)
);

CREATE INDEX IF NOT EXISTS idx_event_fixtures_event ON event_fixtures(event_id, round, slot_no);
CREATE INDEX IF NOT EXISTS idx_event_fixtures_unresolved
  ON event_fixtures(event_id) WHERE match_id IS NULL;
```

- [ ] **Step 4: Apply all three and verify**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
DATABASE_URL="postgresql://allsports:password@localhost:5433/allsports_test" npm --workspace backend run db:migrate
for m in 012_event_match_duration 013_event_standings 014_event_fixtures; do
  docker exec -i allsports_postgres psql -U allsports -d allsports_dev -q < backend/migrations/$m.sql
done
docker exec allsports_postgres psql -U allsports -d allsports_test -c "\d event_fixtures"
docker exec allsports_postgres psql -U allsports -d allsports_test -tAc \
  "SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_name='event_teams';"
```

Expected: migrate log shows all three `(UP)` lines then `Migrations complete!`; `event_fixtures` exists with the `UNIQUE` on `match_id`; `event_teams` lists `played, won, drawn, lost, goals_for, goals_against`.

- [ ] **Step 5: Add the Kysely types**

In `backend/src/shared/db/types.ts`, add after the `MatchFormat` export:

```ts
/** How one side of a fixture gets filled in. Stored as jsonb. */
export type FixtureSource =
  | { type: 'team'; team_id: string }
  | { type: 'winner_of'; fixture_id: string }
  | { type: 'qualifier'; seed: number }
```

In `EventTable`, after `match_format`:

```ts
  // Slot length for the generator; also Phase 4's rating match-weight input.
  match_duration_minutes: number | null
```

In `EventTeamTable`, after `points`:

```ts
  played: Generated<number>
  won: Generated<number>
  drawn: Generated<number>
  lost: Generated<number>
  goals_for: Generated<number>
  goals_against: Generated<number>
```

Add a new interface after `EventTeamTable`:

```ts
export interface EventFixtureTable {
  id: Generated<string>
  event_id: string
  round: string
  slot_no: number
  pitch_label: string | null
  scheduled_at: Date | null
  referee_id: string | null
  home_source: JsonbColumn<FixtureSource>
  away_source: JsonbColumn<FixtureSource>
  home_team_id: string | null
  away_team_id: string | null
  match_id: string | null
  created_at: Generated<Date>
  updated_at: Generated<Date>
}
```

And register it on `Database`, after `event_referees`:

```ts
  event_fixtures: EventFixtureTable
```

- [ ] **Step 6: Accept duration when creating an event**

In `backend/src/modules/events/events.routes.ts`, add to `CreateEventBody` after `match_format`:

```ts
  match_duration_minutes: z.number().int().min(1).max(180).optional(),
```

And in the insert `.values({...})` after `match_format`:

```ts
        match_duration_minutes: body.data.match_duration_minutes ?? null,
```

- [ ] **Step 7: Verify**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports/backend && npx tsc --noEmit
cd /Users/advaitchoudhary/Documents/compete/allsports
DATABASE_URL="postgresql://allsports:password@localhost:5433/allsports_test" \
  REDIS_URL="redis://localhost:6380" npm --workspace backend run test 2>&1 | grep -E "Test Files|Tests "
```

Expected: 0 type errors; **49 tests, 5 files** still passing.

- [ ] **Step 8: Commit**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
git add backend/migrations/012_event_match_duration.sql backend/migrations/013_event_standings.sql backend/migrations/014_event_fixtures.sql backend/src/shared/db/types.ts backend/src/modules/events/events.routes.ts
git commit -m "feat(bracket): add event_fixtures, standings columns and match duration"
```

---

### Task 2: The planner — a pure bracket-shape function

**Files:**
- Create: `backend/src/modules/events/bracket/planner.ts`
- Create: `backend/src/tests/bracket-planner.test.ts`

**Interfaces:**
- Consumes: nothing — **no database, no Fastify, no imports beyond types.** This is why it can be tested exhaustively.
- Produces:

```ts
export type PlannedSource =
  | { type: 'team'; team_id: string }
  | { type: 'winner_of'; ref: string }     // planner-local fixture key
  | { type: 'qualifier'; seed: number }

export interface PlannedFixture {
  key: string          // planner-local, e.g. 'group_a:1' | 'semi:2'
  round: string
  slot_no: number
  home: PlannedSource
  away: PlannedSource
}

export interface BracketPlan {
  format: 'knockout' | 'group_knockout'
  fell_back: boolean
  fallback_reason: string | null
  groups: Array<{ group: string; team_ids: string[] }>
  qualifiers: number   // 0 for pure knockout
  fixtures: PlannedFixture[]
}

export function planBracket(
  teamIds: string[],                                  // already in seed order, strongest first
  format: 'knockout' | 'group_knockout'
): BracketPlan
```

`winner_of` carries a planner-local `ref` (another fixture's `key`), which the generator maps to real UUIDs after insert. That keeps the planner free of the database.

- [ ] **Step 1: Write the failing tests**

Create `backend/src/tests/bracket-planner.test.ts`:

```ts
/**
 * Unit tests for the bracket planner — a pure function, no database.
 *
 * The planner is the algorithmic heart of Phase 3, so it is tested far more
 * thoroughly than anything touching Postgres could be. The headline requirement
 * (decided 2026-07-31): NO team count is ever rejected.
 */

import { describe, it, expect } from 'vitest'
import { planBracket, type BracketPlan } from '../modules/events/bracket/planner'

const ids = (n: number) => Array.from({ length: n }, (_, i) => `t${i + 1}`)

/** Every fixture a knockout round feeds into must exist in the plan. */
function assertReferentialIntegrity(plan: BracketPlan) {
  const keys = new Set(plan.fixtures.map((f) => f.key))
  for (const f of plan.fixtures) {
    for (const side of [f.home, f.away]) {
      if (side.type === 'winner_of') {
        expect(keys.has(side.ref)).toBe(true)
      }
    }
  }
}

/** Exactly one fixture must be the final. */
function assertSingleFinal(plan: BracketPlan) {
  expect(plan.fixtures.filter((f) => f.round === 'final')).toHaveLength(1)
}

describe('planBracket — knockout for any N', () => {
  it('rejects fewer than two teams', () => {
    expect(() => planBracket(ids(1), 'knockout')).toThrow(/at least 2/i)
    expect(() => planBracket([], 'knockout')).toThrow(/at least 2/i)
  })

  it('two teams is just a final', () => {
    const plan = planBracket(ids(2), 'knockout')
    expect(plan.fixtures).toHaveLength(1)
    expect(plan.fixtures[0].round).toBe('final')
    expect(plan.fixtures[0].home).toEqual({ type: 'team', team_id: 't1' })
    expect(plan.fixtures[0].away).toEqual({ type: 'team', team_id: 't2' })
  })

  it('five teams: one play-in, three byes, then semis and a final', () => {
    const plan = planBracket(ids(5), 'knockout')
    const rounds = plan.fixtures.map((f) => f.round)
    expect(rounds.filter((r) => r === 'play_in')).toHaveLength(1)
    expect(rounds.filter((r) => r === 'semi')).toHaveLength(2)
    expect(rounds.filter((r) => r === 'final')).toHaveLength(1)
    expect(plan.fixtures).toHaveLength(4)
    assertReferentialIntegrity(plan)
    assertSingleFinal(plan)
  })

  it('nine teams: one play-in then quarters, semis, final', () => {
    const plan = planBracket(ids(9), 'knockout')
    const count = (r: string) => plan.fixtures.filter((f) => f.round === r).length
    expect(count('play_in')).toBe(1)
    expect(count('quarter')).toBe(4)
    expect(count('semi')).toBe(2)
    expect(count('final')).toBe(1)
    expect(plan.fixtures).toHaveLength(8)
    assertReferentialIntegrity(plan)
  })

  it('byes go to the strongest seeds', () => {
    // 5 teams → 3 byes. t1..t3 must not appear in the play-in.
    const plan = planBracket(ids(5), 'knockout')
    const playIn = plan.fixtures.find((f) => f.round === 'play_in')!
    const inPlayIn = [playIn.home, playIn.away]
      .filter((s): s is { type: 'team'; team_id: string } => s.type === 'team')
      .map((s) => s.team_id)
    expect(inPlayIn).not.toContain('t1')
    expect(inPlayIn).not.toContain('t2')
    expect(inPlayIn).not.toContain('t3')
  })

  it('every team appears exactly once as a team source', () => {
    for (const n of [2, 3, 5, 6, 7, 8, 9, 11, 13, 16, 17]) {
      const plan = planBracket(ids(n), 'knockout')
      const seen = plan.fixtures
        .flatMap((f) => [f.home, f.away])
        .filter((s) => s.type === 'team')
        .map((s) => (s as { team_id: string }).team_id)
      expect(new Set(seen).size).toBe(n)
      expect(seen).toHaveLength(n)
    }
  })

  it('produces a valid, connected bracket for every count from 2 to 24', () => {
    for (let n = 2; n <= 24; n++) {
      const plan = planBracket(ids(n), 'knockout')
      assertReferentialIntegrity(plan)
      assertSingleFinal(plan)
      // A single-elimination bracket always plays exactly N-1 matches.
      expect(plan.fixtures).toHaveLength(n - 1)
    }
  })

  it('powers of two have no play-in round', () => {
    for (const n of [2, 4, 8, 16]) {
      const plan = planBracket(ids(n), 'knockout')
      expect(plan.fixtures.some((f) => f.round === 'play_in')).toBe(false)
    }
  })
})

describe('planBracket — group_knockout', () => {
  it('eight teams: two groups of four, top two to semis', () => {
    const plan = planBracket(ids(8), 'group_knockout')
    expect(plan.fell_back).toBe(false)
    expect(plan.groups).toHaveLength(2)
    expect(plan.groups.every((g) => g.team_ids.length === 4)).toBe(true)
    expect(plan.qualifiers).toBe(4)

    const groupFixtures = plan.fixtures.filter((f) => f.round.startsWith('group_'))
    expect(groupFixtures).toHaveLength(12) // 6 per group of 4
    expect(plan.fixtures.filter((f) => f.round === 'semi')).toHaveLength(2)
    expect(plan.fixtures.filter((f) => f.round === 'final')).toHaveLength(1)
    expect(plan.fixtures).toHaveLength(15) // no third-place match
    assertSingleFinal(plan)
  })

  it('nine teams: three groups of three', () => {
    const plan = planBracket(ids(9), 'group_knockout')
    expect(plan.fell_back).toBe(false)
    expect(plan.groups).toHaveLength(3)
    expect(plan.groups.every((g) => g.team_ids.length === 3)).toBe(true)
    // 2G = 6, largest power of two ≤ 6 is 4 → 3 winners + best runner-up.
    expect(plan.qualifiers).toBe(4)
    expect(plan.fixtures.filter((f) => f.round.startsWith('group_'))).toHaveLength(9)
    expect(plan.fixtures).toHaveLength(12)
  })

  it('sixteen teams: four groups of four, top two to quarters', () => {
    const plan = planBracket(ids(16), 'group_knockout')
    expect(plan.groups).toHaveLength(4)
    expect(plan.qualifiers).toBe(8)
    expect(plan.fixtures.filter((f) => f.round.startsWith('group_'))).toHaveLength(24)
    expect(plan.fixtures.filter((f) => f.round === 'quarter')).toHaveLength(4)
    expect(plan.fixtures).toHaveLength(31)
  })

  it('falls back to knockout for a prime count, and says why', () => {
    const plan = planBracket(ids(5), 'group_knockout')
    expect(plan.fell_back).toBe(true)
    expect(plan.fallback_reason).toMatch(/equal groups/i)
    expect(plan.format).toBe('knockout')
    expect(plan.groups).toHaveLength(0)
    expect(plan.fixtures).toHaveLength(4)
  })

  it('falls back when groups would be smaller than three', () => {
    // 3 teams → ceil(3/4)=1 group of 3 is fine; 2 teams → group of 2 is pointless.
    expect(planBracket(ids(2), 'group_knockout').fell_back).toBe(true)
  })

  it('seeds are snake-distributed so strong teams spread across groups', () => {
    const plan = planBracket(ids(8), 'group_knockout')
    const a = plan.groups[0].team_ids
    const b = plan.groups[1].team_ids
    // Snake for 2 groups: A gets 1,4,5,8 and B gets 2,3,6,7.
    expect(a).toContain('t1')
    expect(b).toContain('t2')
    expect(a).not.toContain('t2')
  })

  it('group fixtures are a full round-robin with no repeats', () => {
    const plan = planBracket(ids(8), 'group_knockout')
    for (const g of plan.groups) {
      const pairs = plan.fixtures
        .filter((f) => f.round === `group_${g.group}`)
        .map((f) => {
          const h = (f.home as { team_id: string }).team_id
          const a = (f.away as { team_id: string }).team_id
          return [h, a].sort().join('|')
        })
      expect(new Set(pairs).size).toBe(pairs.length)
      const n = g.team_ids.length
      expect(pairs).toHaveLength((n * (n - 1)) / 2)
    }
  })

  it('first knockout round consumes each qualifier seed exactly once', () => {
    for (const n of [8, 9, 12, 16]) {
      const plan = planBracket(ids(n), 'group_knockout')
      if (plan.fell_back) continue
      const seeds = plan.fixtures
        .flatMap((f) => [f.home, f.away])
        .filter((s) => s.type === 'qualifier')
        .map((s) => (s as { seed: number }).seed)
      expect(seeds.sort((x, y) => x - y)).toEqual(
        Array.from({ length: plan.qualifiers }, (_, i) => i + 1)
      )
    }
  })

  it('every equal-group count from 4 to 24 produces a connected bracket', () => {
    for (let n = 4; n <= 24; n++) {
      const plan = planBracket(ids(n), 'group_knockout')
      assertReferentialIntegrity(plan)
      assertSingleFinal(plan)
    }
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
npm --workspace backend run test -- bracket-planner
```

Expected: FAIL — `Failed to load url ../modules/events/bracket/planner`. (No DB env vars needed: this suite never touches Postgres.)

- [ ] **Step 3: Write the planner**

Create `backend/src/modules/events/bracket/planner.ts`:

```ts
/**
 * Pure bracket planner. No database, no framework — just shape.
 *
 * Turns a seed-ordered team list plus a format into the complete set of fixtures
 * a tournament needs, including how each side of each fixture gets filled in.
 * Kept DB-free so it can be tested exhaustively across every team count.
 */

export type PlannedSource =
  | { type: 'team'; team_id: string }
  | { type: 'winner_of'; ref: string }
  | { type: 'qualifier'; seed: number }

export interface PlannedFixture {
  key: string
  round: string
  slot_no: number
  home: PlannedSource
  away: PlannedSource
}

export interface BracketPlan {
  format: 'knockout' | 'group_knockout'
  fell_back: boolean
  fallback_reason: string | null
  groups: Array<{ group: string; team_ids: string[] }>
  qualifiers: number
  fixtures: PlannedFixture[]
}

/** Smallest group we'll accept — a "group" of two is just a match. */
const MIN_GROUP_SIZE = 3

/** Largest power of two ≤ n. */
function floorPow2(n: number): number {
  let p = 1
  while (p * 2 <= n) p *= 2
  return p
}

/** Round label for a knockout round with `size` teams remaining. */
function roundName(size: number): string {
  if (size === 2) return 'final'
  if (size === 4) return 'semi'
  if (size === 8) return 'quarter'
  return `round_of_${size}`
}

/**
 * Build the elimination rounds above a set of entry slots.
 *
 * `entries` are sources filling the first full round, already in bracket order.
 * Length must be a power of two. Returns fixtures for every round up to the final.
 */
function buildEliminationRounds(entries: PlannedSource[]): PlannedFixture[] {
  const fixtures: PlannedFixture[] = []
  let current = entries

  while (current.length > 1) {
    const round = roundName(current.length)
    const next: PlannedSource[] = []

    for (let i = 0; i < current.length; i += 2) {
      const slot = i / 2 + 1
      const key = `${round}:${slot}`
      fixtures.push({
        key,
        round,
        slot_no: slot,
        home: current[i],
        away: current[i + 1],
      })
      next.push({ type: 'winner_of', ref: key })
    }

    current = next
  }

  return fixtures
}

/**
 * Single-elimination for ANY team count.
 *
 * P = largest power of two ≤ N. `N − P` play-in matches are contested by the
 * weakest `2(N − P)` seeds; everyone else receives a bye straight into the round
 * of P. Byes therefore reward the strongest seeds, as in a real cup draw.
 */
function planKnockout(teamIds: string[]): PlannedFixture[] {
  const n = teamIds.length
  const p = floorPow2(n)
  const playInCount = n - p
  const byeCount = n - 2 * playInCount

  const byes = teamIds.slice(0, byeCount)
  const contested = teamIds.slice(byeCount)

  const fixtures: PlannedFixture[] = []
  const entries: PlannedSource[] = byes.map((id) => ({ type: 'team', team_id: id }))

  // Pair strongest remaining against weakest remaining.
  for (let i = 0; i < playInCount; i++) {
    const slot = i + 1
    const key = `play_in:${slot}`
    fixtures.push({
      key,
      round: 'play_in',
      slot_no: slot,
      home: { type: 'team', team_id: contested[i] },
      away: { type: 'team', team_id: contested[contested.length - 1 - i] },
    })
    entries.push({ type: 'winner_of', ref: key })
  }

  return [...fixtures, ...buildEliminationRounds(entries)]
}

/** Round-robin fixtures for one group. */
function planGroup(group: string, teamIds: string[]): PlannedFixture[] {
  const fixtures: PlannedFixture[] = []
  let slot = 1
  for (let i = 0; i < teamIds.length; i++) {
    for (let j = i + 1; j < teamIds.length; j++) {
      fixtures.push({
        key: `group_${group}:${slot}`,
        round: `group_${group}`,
        slot_no: slot,
        home: { type: 'team', team_id: teamIds[i] },
        away: { type: 'team', team_id: teamIds[j] },
      })
      slot++
    }
  }
  return fixtures
}

/**
 * Snake distribution: 1→A, 2→B, 3→B, 4→A, 5→A, … so seeds spread across groups
 * instead of stacking the strong teams together.
 */
function snakeGroups(teamIds: string[], groupCount: number): string[][] {
  const groups: string[][] = Array.from({ length: groupCount }, () => [])
  let idx = 0
  let forward = true
  for (const id of teamIds) {
    groups[idx].push(id)
    if (forward) {
      if (idx === groupCount - 1) forward = false
      else idx++
    } else {
      if (idx === 0) forward = true
      else idx--
    }
  }
  return groups
}

const GROUP_LETTERS = 'abcdefghijklmnopqrstuvwxyz'

export function planBracket(
  teamIds: string[],
  format: 'knockout' | 'group_knockout'
): BracketPlan {
  if (teamIds.length < 2) {
    throw new Error('A tournament needs at least 2 teams')
  }

  if (format === 'knockout') {
    return {
      format: 'knockout',
      fell_back: false,
      fallback_reason: null,
      groups: [],
      qualifiers: 0,
      fixtures: planKnockout(teamIds),
    }
  }

  // ── group_knockout ────────────────────────────────────────────────────────
  const n = teamIds.length
  const groupCount = Math.ceil(n / 4)
  const groupSize = n / groupCount

  // Equal groups are required so that comparing runners-up across groups is
  // fair — see spec §3.3. When that is impossible we do NOT fail; we build a
  // knockout and explain, so no team count is ever turned away.
  const equal = Number.isInteger(groupSize)
  if (!equal || groupSize < MIN_GROUP_SIZE) {
    const reason = !equal
      ? `${n} teams cannot be split into equal groups, so a knockout was generated instead`
      : `${n} teams would make groups of ${groupSize}, below the minimum of ${MIN_GROUP_SIZE}, so a knockout was generated instead`
    return {
      format: 'knockout',
      fell_back: true,
      fallback_reason: reason,
      groups: [],
      qualifiers: 0,
      fixtures: planKnockout(teamIds),
    }
  }

  const distributed = snakeGroups(teamIds, groupCount)
  const groups = distributed.map((team_ids, i) => ({
    group: GROUP_LETTERS[i],
    team_ids,
  }))

  const groupFixtures = groups.flatMap((g) => planGroup(g.group, g.team_ids))

  // Qualifiers: the largest power of two that both groups can supply and the
  // field can fill. Minimum 2 so there is always a final.
  const qualifiers = Math.max(2, floorPow2(Math.min(groupCount * 2, n)))

  // Standard pairing: 1 v Q, 2 v Q−1, … Deterministic and explainable; it can
  // pair two teams from one group, which we accept for a single-day event.
  const entries: PlannedSource[] = []
  for (let i = 0; i < qualifiers / 2; i++) {
    entries.push({ type: 'qualifier', seed: i + 1 })
    entries.push({ type: 'qualifier', seed: qualifiers - i })
  }

  return {
    format: 'group_knockout',
    fell_back: false,
    fallback_reason: null,
    groups,
    qualifiers,
    fixtures: [...groupFixtures, ...buildEliminationRounds(entries)],
  }
}
```

- [ ] **Step 4: Run the tests**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
npm --workspace backend run test -- bracket-planner
```

Expected: PASS — 17 tests. If the "connected bracket for every count 2–24" test fails, print the failing `n` before changing anything; the bug is almost certainly in `buildEliminationRounds` receiving a non-power-of-two entry list.

- [ ] **Step 5: Verify types and the whole suite**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports/backend && npx tsc --noEmit
cd /Users/advaitchoudhary/Documents/compete/allsports
DATABASE_URL="postgresql://allsports:password@localhost:5433/allsports_test" \
  REDIS_URL="redis://localhost:6380" npm --workspace backend run test 2>&1 | grep -E "Test Files|Tests "
```

Expected: 0 type errors; **66 tests, 6 files**.

- [ ] **Step 6: Commit**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
git add backend/src/modules/events/bracket/planner.ts backend/src/tests/bracket-planner.test.ts
git commit -m "feat(bracket): pure planner handling any team count"
```

---

### Task 3: The scheduler — a pure slot/pitch assignment function

**Files:**
- Create: `backend/src/modules/events/bracket/scheduler.ts`
- Create: `backend/src/tests/bracket-scheduler.test.ts`

**Interfaces:**
- Consumes: `PlannedFixture` from Task 2. Still **no database**.
- Produces:

```ts
export interface ScheduledFixture extends PlannedFixture {
  slot_index: number     // 0-based time slot
  pitch_label: string
  scheduled_at: Date
}

export function scheduleFixtures(input: {
  fixtures: PlannedFixture[]
  pitches: string[]
  startsAt: Date
  slotMinutes: number
}): ScheduledFixture[]
```

Throws when the schedule is impossible rather than emitting one that breaks the rest rule.

**Two rules:** a team never plays two matches in the same slot or in consecutive slots (one full slot of rest); and no knockout round starts until every fixture it could depend on has been slotted.

- [ ] **Step 1: Write the failing tests**

Create `backend/src/tests/bracket-scheduler.test.ts`:

```ts
/**
 * Unit tests for the fixture scheduler — pure, no database.
 *
 * Guards the two rules a turf tournament day depends on: nobody plays twice in a
 * row, and knockout rounds happen after the rounds that feed them.
 */

import { describe, it, expect } from 'vitest'
import { planBracket } from '../modules/events/bracket/planner'
import { scheduleFixtures, type ScheduledFixture } from '../modules/events/bracket/scheduler'

const ids = (n: number) => Array.from({ length: n }, (_, i) => `t${i + 1}`)
const START = new Date('2026-08-02T09:00:00.000Z')

function teamsOf(f: ScheduledFixture): string[] {
  return [f.home, f.away]
    .filter((s) => s.type === 'team')
    .map((s) => (s as { team_id: string }).team_id)
}

/** No team plays twice in one slot, or in two consecutive slots. */
function assertRestRule(scheduled: ScheduledFixture[]) {
  const bySlot = new Map<number, string[]>()
  for (const f of scheduled) {
    const list = bySlot.get(f.slot_index) ?? []
    list.push(...teamsOf(f))
    bySlot.set(f.slot_index, list)
  }
  for (const [slot, teams] of bySlot) {
    expect(new Set(teams).size).toBe(teams.length) // not twice in one slot
    const prev = bySlot.get(slot - 1) ?? []
    for (const t of teams) {
      expect(prev).not.toContain(t) // not in consecutive slots
    }
  }
}

describe('scheduleFixtures', () => {
  it('assigns every fixture a slot, a pitch and a time', () => {
    const plan = planBracket(ids(8), 'group_knockout')
    const scheduled = scheduleFixtures({
      fixtures: plan.fixtures,
      pitches: ['Pitch 1', 'Pitch 2'],
      startsAt: START,
      slotMinutes: 15,
    })
    expect(scheduled).toHaveLength(plan.fixtures.length)
    for (const f of scheduled) {
      expect(['Pitch 1', 'Pitch 2']).toContain(f.pitch_label)
      expect(f.slot_index).toBeGreaterThanOrEqual(0)
      expect(f.scheduled_at.getTime()).toBe(START.getTime() + f.slot_index * 15 * 60_000)
    }
  })

  it('honours the rest rule for group stages', () => {
    for (const n of [8, 9, 12, 16]) {
      const plan = planBracket(ids(n), 'group_knockout')
      const scheduled = scheduleFixtures({
        fixtures: plan.fixtures,
        pitches: ['Pitch 1', 'Pitch 2'],
        startsAt: START,
        slotMinutes: 12,
      })
      assertRestRule(scheduled)
    }
  })

  it('never places more fixtures in a slot than there are pitches', () => {
    const plan = planBracket(ids(16), 'group_knockout')
    const scheduled = scheduleFixtures({
      fixtures: plan.fixtures,
      pitches: ['A', 'B', 'C'],
      startsAt: START,
      slotMinutes: 10,
    })
    const perSlot = new Map<number, number>()
    for (const f of scheduled) {
      perSlot.set(f.slot_index, (perSlot.get(f.slot_index) ?? 0) + 1)
    }
    for (const count of perSlot.values()) expect(count).toBeLessThanOrEqual(3)
  })

  it('a pitch never hosts two fixtures in the same slot', () => {
    const plan = planBracket(ids(12), 'group_knockout')
    const scheduled = scheduleFixtures({
      fixtures: plan.fixtures,
      pitches: ['Pitch 1', 'Pitch 2'],
      startsAt: START,
      slotMinutes: 15,
    })
    const seen = new Set<string>()
    for (const f of scheduled) {
      const cell = `${f.slot_index}@${f.pitch_label}`
      expect(seen.has(cell)).toBe(false)
      seen.add(cell)
    }
  })

  it('schedules knockout rounds strictly after the rounds feeding them', () => {
    const plan = planBracket(ids(8), 'group_knockout')
    const scheduled = scheduleFixtures({
      fixtures: plan.fixtures,
      pitches: ['Pitch 1', 'Pitch 2'],
      startsAt: START,
      slotMinutes: 15,
    })
    const byKey = new Map(scheduled.map((f) => [f.key, f]))
    for (const f of scheduled) {
      for (const side of [f.home, f.away]) {
        if (side.type === 'winner_of') {
          expect(f.slot_index).toBeGreaterThan(byKey.get(side.ref)!.slot_index)
        }
      }
    }
    // All group matches finish before the first knockout fixture starts.
    const lastGroup = Math.max(
      ...scheduled.filter((f) => f.round.startsWith('group_')).map((f) => f.slot_index)
    )
    const firstKo = Math.min(
      ...scheduled.filter((f) => !f.round.startsWith('group_')).map((f) => f.slot_index)
    )
    expect(firstKo).toBeGreaterThan(lastGroup)
  })

  it('works with a single pitch', () => {
    const plan = planBracket(ids(8), 'group_knockout')
    const scheduled = scheduleFixtures({
      fixtures: plan.fixtures,
      pitches: ['Only Pitch'],
      startsAt: START,
      slotMinutes: 20,
    })
    expect(scheduled).toHaveLength(15)
    assertRestRule(scheduled)
    // One pitch means one fixture per slot, so slots are all distinct.
    expect(new Set(scheduled.map((f) => f.slot_index)).size).toBe(15)
  })

  it('refuses to schedule with no pitches', () => {
    const plan = planBracket(ids(8), 'knockout')
    expect(() =>
      scheduleFixtures({
        fixtures: plan.fixtures,
        pitches: [],
        startsAt: START,
        slotMinutes: 15,
      })
    ).toThrow(/at least one pitch/i)
  })

  it('pure knockout schedules round by round', () => {
    const plan = planBracket(ids(9), 'knockout')
    const scheduled = scheduleFixtures({
      fixtures: plan.fixtures,
      pitches: ['Pitch 1', 'Pitch 2'],
      startsAt: START,
      slotMinutes: 15,
    })
    assertRestRule(scheduled)
    const byKey = new Map(scheduled.map((f) => [f.key, f]))
    for (const f of scheduled) {
      for (const side of [f.home, f.away]) {
        if (side.type === 'winner_of') {
          expect(f.slot_index).toBeGreaterThan(byKey.get(side.ref)!.slot_index)
        }
      }
    }
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
npm --workspace backend run test -- bracket-scheduler
```

Expected: FAIL — `Failed to load url ../modules/events/bracket/scheduler`.

- [ ] **Step 3: Write the scheduler**

Create `backend/src/modules/events/bracket/scheduler.ts`:

```ts
import type { PlannedFixture } from './planner'

export interface ScheduledFixture extends PlannedFixture {
  slot_index: number
  pitch_label: string
  scheduled_at: Date
}

export interface ScheduleInput {
  fixtures: PlannedFixture[]
  pitches: string[]
  startsAt: Date
  slotMinutes: number
}

/**
 * Safety valve. If the greedy pass can't place everything within this many slots
 * per fixture, the constraints are unsatisfiable and we fail loudly rather than
 * emitting a schedule that breaks the rest rule.
 */
const MAX_SLOT_FACTOR = 6

/**
 * Assign every fixture a time slot and a pitch.
 *
 * Two rules:
 *   1. Rest — a team never plays twice in one slot, nor in consecutive slots.
 *   2. Dependency — a fixture fed by `winner_of` starts strictly after its feeder.
 *
 * Fixtures are processed in dependency order (group stage first, then each
 * elimination round), and within a stage placed greedily into the earliest slot
 * where every team is rested and a pitch is free.
 */
export function scheduleFixtures(input: ScheduleInput): ScheduledFixture[] {
  const { fixtures, pitches, startsAt, slotMinutes } = input

  if (pitches.length === 0) {
    throw new Error('Scheduling needs at least one pitch — assign referees with pitch labels first')
  }
  if (fixtures.length === 0) return []

  // ── Dependency stages ─────────────────────────────────────────────────────
  // Stage 0 = fixtures with no winner_of dependency (group stage and play-ins).
  // Each later stage depends only on earlier ones, so a simple longest-path
  // depth over the winner_of edges gives a valid ordering.
  const byKey = new Map(fixtures.map((f) => [f.key, f]))
  const depthCache = new Map<string, number>()

  const depthOf = (key: string): number => {
    const cached = depthCache.get(key)
    if (cached !== undefined) return cached
    const f = byKey.get(key)
    if (!f) throw new Error(`Fixture ${key} references a fixture that does not exist`)
    let d = 0
    for (const side of [f.home, f.away]) {
      if (side.type === 'winner_of') d = Math.max(d, depthOf(side.ref) + 1)
    }
    depthCache.set(key, d)
    return d
  }

  const stages = new Map<number, PlannedFixture[]>()
  for (const f of fixtures) {
    const d = depthOf(f.key)
    const list = stages.get(d) ?? []
    list.push(f)
    stages.set(d, list)
  }

  // ── Greedy placement, stage by stage ──────────────────────────────────────
  const teamsIn = (f: PlannedFixture): string[] =>
    [f.home, f.away]
      .filter((s) => s.type === 'team')
      .map((s) => (s as { team_id: string }).team_id)

  const slotTeams = new Map<number, Set<string>>()
  const slotPitches = new Map<number, Set<string>>()
  const placed: ScheduledFixture[] = []
  const maxSlots = fixtures.length * MAX_SLOT_FACTOR

  // The earliest slot a stage may use: strictly after everything before it.
  let stageFloor = 0

  for (const depth of [...stages.keys()].sort((a, b) => a - b)) {
    const stageFixtures = stages.get(depth)!
    let stageMax = stageFloor - 1

    for (const f of stageFixtures) {
      const teams = teamsIn(f)
      let slot = stageFloor

      for (; slot < maxSlots; slot++) {
        const here = slotTeams.get(slot) ?? new Set()
        const before = slotTeams.get(slot - 1) ?? new Set()
        const usedPitches = slotPitches.get(slot) ?? new Set()

        if (usedPitches.size >= pitches.length) continue
        const clash = teams.some((t) => here.has(t) || before.has(t))
        if (clash) continue
        break
      }

      if (slot >= maxSlots) {
        throw new Error(
          `Cannot schedule fixture ${f.key} without breaking the rest rule — try more pitches or fewer teams`
        )
      }

      const usedPitches = slotPitches.get(slot) ?? new Set<string>()
      const pitch = pitches.find((p) => !usedPitches.has(p))!
      usedPitches.add(pitch)
      slotPitches.set(slot, usedPitches)

      const here = slotTeams.get(slot) ?? new Set<string>()
      for (const t of teams) here.add(t)
      slotTeams.set(slot, here)

      placed.push({
        ...f,
        slot_index: slot,
        pitch_label: pitch,
        scheduled_at: new Date(startsAt.getTime() + slot * slotMinutes * 60_000),
      })

      if (slot > stageMax) stageMax = slot
    }

    // Next stage cannot start until this one has finished.
    stageFloor = stageMax + 1
  }

  return placed.sort((a, b) => a.slot_index - b.slot_index || a.pitch_label.localeCompare(b.pitch_label))
}
```

- [ ] **Step 4: Run the tests**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
npm --workspace backend run test -- bracket-scheduler
```

Expected: PASS — 8 tests.

- [ ] **Step 5: Verify types and the whole suite**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports/backend && npx tsc --noEmit
cd /Users/advaitchoudhary/Documents/compete/allsports
DATABASE_URL="postgresql://allsports:password@localhost:5433/allsports_test" \
  REDIS_URL="redis://localhost:6380" npm --workspace backend run test 2>&1 | grep -E "Test Files|Tests "
```

Expected: 0 type errors; **74 tests, 7 files**.

- [ ] **Step 6: Commit**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
git add backend/src/modules/events/bracket/scheduler.ts backend/src/tests/bracket-scheduler.test.ts
git commit -m "feat(bracket): pure scheduler with rest-gap and dependency rules"
```

---

### Task 4: The generator — persist a plan as fixtures and matches

**Files:**
- Create: `backend/src/modules/events/bracket/generator.ts`
- Create: `backend/src/modules/events/event-fixtures.routes.ts`
- Modify: `backend/src/app.ts`
- Create: `backend/src/tests/event-fixtures.test.ts`

**Interfaces:**
- Consumes: `planBracket` (Task 2), `scheduleFixtures` (Task 3), `event_fixtures` (Task 1), `event_referees` and `events.tier` (Phases 1–2), `canOfficiate` from `shared/tiers`.
- Produces:
  - `export async function generateFixtures(eventId: string): Promise<{ ok: true; fixtures: number; matches: number; fell_back: boolean; fallback_reason: string | null } | { ok: false; code: number; error: string }>`
  - `export async function eventFixturesRoutes(app: FastifyInstance)` registering `POST /events/:id/fixtures`.

**Default slot length:** 15 minutes when `events.match_duration_minutes` is NULL. **Default kickoff:** `events.starts_at`, or now when NULL.

- [ ] **Step 1: Write the failing test**

Create `backend/src/tests/event-fixtures.test.ts`:

```ts
/**
 * Integration tests — fixture generation.
 *
 * Covers the third tier-authority enforcement point (spec §3.1.1): every
 * generated match must pass canOfficiate against its own referee, or the whole
 * transaction is refused. That is the backstop making tier inflation impossible.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'

vi.mock('../shared/queue/ratings.stream', () => ({
  enqueueRatingJob: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../modules/auth/auth.service', () => ({
  initFirebase: vi.fn(),
  verifyFirebaseToken: vi.fn().mockResolvedValue({
    uid: 'test-fx-uid',
    phone_number: '+919999999005',
    email: undefined,
  }),
  issueJwt: vi.fn().mockReturnValue('test-jwt-token'),
}))

import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import { eventFixturesRoutes } from '../modules/events/event-fixtures.routes'
import { getDb } from '../shared/db/client'

const TEST_JWT_SECRET = 'test-jwt-secret-minimum-32-chars-long'

const ORGANIZER_ID = '550e8400-e29b-41d4-a716-4466554405e1'
const REF_AMATEUR_ID = '550e8400-e29b-41d4-a716-4466554405e2'
const REF_PRO_ID = '550e8400-e29b-41d4-a716-4466554405e3'
const OUTSIDER_ID = '550e8400-e29b-41d4-a716-4466554405e4'

const ALL_TEST_USERS = [ORGANIZER_ID, REF_AMATEUR_ID, REF_PRO_ID, OUTSIDER_ID]

let footballSportId: string
let eventId: string
let teamIds: string[] = []

async function buildTestApp() {
  const app = Fastify({ logger: false })
  await app.register(jwt, { secret: TEST_JWT_SECRET })
  await app.register(eventFixturesRoutes, { prefix: '/v1' })
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

  const teams = await db
    .selectFrom('teams')
    .select('id')
    .where('organizer_id', 'in', ALL_TEST_USERS)
    .execute()
  const tIds = teams.map((t) => t.id)

  if (eventIds.length > 0) {
    await db.deleteFrom('event_fixtures').where('event_id', 'in', eventIds).execute()
    await db.deleteFrom('matches').where('event_id', 'in', eventIds).execute()
    await db.deleteFrom('event_referees').where('event_id', 'in', eventIds).execute()
    await db.deleteFrom('event_teams').where('event_id', 'in', eventIds).execute()
    await db.deleteFrom('events').where('id', 'in', eventIds).execute()
  }
  if (tIds.length > 0) {
    await db.deleteFrom('matches').where('home_team_id', 'in', tIds).execute()
    await db.deleteFrom('matches').where('away_team_id', 'in', tIds).execute()
    await db.deleteFrom('event_teams').where('team_id', 'in', tIds).execute()
    await db.deleteFrom('team_members').where('team_id', 'in', tIds).execute()
    await db.deleteFrom('teams').where('id', 'in', tIds).execute()
  }
  await db.deleteFrom('event_referees').where('user_id', 'in', ALL_TEST_USERS).execute()
  await db.deleteFrom('organizer_scores').where('user_id', 'in', ALL_TEST_USERS).execute()
  await db.deleteFrom('users').where('id', 'in', ALL_TEST_USERS).execute()
}

/** Fresh event with `teamCount` registered teams, tier `tier`, one pitch per referee. */
async function makeEvent(opts: {
  teamCount: number
  tier?: 'amateur' | 'semi_pro' | 'pro' | 'legends'
  referees?: Array<{ id: string; pitch: string }>
  format?: 'knockout' | 'group_knockout'
}) {
  const db = getDb()
  const event = await db
    .insertInto('events')
    .values({
      name: `Fixture Cup ${Date.now()}`,
      sport_id: footballSportId,
      organizer_id: ORGANIZER_ID,
      format: opts.format ?? 'group_knockout',
      match_format: '5-a-side',
      match_duration_minutes: 12,
      city: 'Mumbai',
      status: 'registration',
      starts_at: new Date('2026-08-02T09:00:00.000Z'),
      tier: (opts.tier ?? 'amateur') as any,
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  teamIds = []
  for (let i = 0; i < opts.teamCount; i++) {
    const t = await db
      .insertInto('teams')
      .values({
        name: `FX Team ${i + 1} ${Date.now()}`,
        sport_id: footballSportId,
        organizer_id: ORGANIZER_ID,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    teamIds.push(t.id)
    await db
      .insertInto('event_teams')
      .values({ event_id: event.id, team_id: t.id, seed: i + 1 })
      .execute()
  }

  for (const r of opts.referees ?? [{ id: REF_AMATEUR_ID, pitch: 'Pitch 1' }]) {
    await db
      .insertInto('event_referees')
      .values({ event_id: event.id, user_id: r.id, pitch_label: r.pitch })
      .execute()
  }

  eventId = event.id
  return event.id
}

describe('Fixture generation', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>

  beforeAll(async () => {
    app = await buildTestApp()
    await app.ready()
    await cleanupTestData()

    await seedUser(ORGANIZER_ID, 'Turf Owner', 'organizer')
    await seedUser(REF_AMATEUR_ID, 'Amateur Ref', 'referee', 'amateur')
    await seedUser(REF_PRO_ID, 'Pro Ref', 'referee', 'pro')
    await seedUser(OUTSIDER_ID, 'Outsider', 'player')

    const sport = await getDb()
      .selectFrom('sports')
      .select('id')
      .where('slug', '=', 'football')
      .executeTakeFirstOrThrow()
    footballSportId = sport.id
  })

  afterEach(async () => {
    // Each test builds its own event; clear between them so counts are exact.
    const db = getDb()
    const events = await db
      .selectFrom('events')
      .select('id')
      .where('organizer_id', '=', ORGANIZER_ID)
      .execute()
    const ids = events.map((e) => e.id)
    if (ids.length > 0) {
      await db.deleteFrom('event_fixtures').where('event_id', 'in', ids).execute()
      await db.deleteFrom('matches').where('event_id', 'in', ids).execute()
      await db.deleteFrom('event_referees').where('event_id', 'in', ids).execute()
      await db.deleteFrom('event_teams').where('event_id', 'in', ids).execute()
      await db.deleteFrom('events').where('id', 'in', ids).execute()
    }
    const teams = await db
      .selectFrom('teams')
      .select('id')
      .where('organizer_id', '=', ORGANIZER_ID)
      .execute()
    const tIds = teams.map((t) => t.id)
    if (tIds.length > 0) {
      await db.deleteFrom('matches').where('home_team_id', 'in', tIds).execute()
      await db.deleteFrom('event_teams').where('team_id', 'in', tIds).execute()
      await db.deleteFrom('teams').where('id', 'in', tIds).execute()
    }
  })

  afterAll(async () => {
    await cleanupTestData()
    await app.close()
  })

  it('requires the organizer role', async () => {
    await makeEvent({ teamCount: 8 })
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/fixtures`,
      headers: { authorization: makeAuthHeader(OUTSIDER_ID, app) },
    })
    expect(res.statusCode).toBe(403)
  })

  it('404s for an unknown event', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/events/550e8400-e29b-41d4-a716-4466554405ff/fixtures',
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
    })
    expect(res.statusCode).toBe(404)
  })

  it('refuses when fewer than two teams are registered', async () => {
    await makeEvent({ teamCount: 1 })
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/fixtures`,
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/at least 2/i)
  })

  it('refuses when no referees are assigned', async () => {
    await makeEvent({ teamCount: 8, referees: [] })
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/fixtures`,
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/pitch|referee/i)
  })

  it('generates 15 fixtures for 8 teams and creates only the group matches', async () => {
    await makeEvent({ teamCount: 8 })
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/fixtures`,
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.fixtures).toBe(15)
    expect(body.matches).toBe(12) // group only; knockout waits for qualifiers

    const db = getDb()
    const fixtures = await db
      .selectFrom('event_fixtures')
      .select(['round', 'match_id', 'referee_id', 'pitch_label', 'scheduled_at'])
      .where('event_id', '=', eventId)
      .execute()

    expect(fixtures).toHaveLength(15)
    expect(fixtures.filter((f) => f.match_id !== null)).toHaveLength(12)
    for (const f of fixtures) {
      expect(f.referee_id).not.toBeNull()
      expect(f.pitch_label).not.toBeNull()
      expect(f.scheduled_at).not.toBeNull()
    }

    // Generated matches inherit the event's tier and format.
    const matches = await db
      .selectFrom('matches')
      .select(['tier', 'status', 'event_id'])
      .where('event_id', '=', eventId)
      .execute()
    expect(matches).toHaveLength(12)
    for (const m of matches) {
      expect(m.tier).toBe('amateur')
      expect(m.status).toBe('scheduled')
    }
  })

  it('falls back to knockout for a prime team count and explains why', async () => {
    await makeEvent({ teamCount: 5 })
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/fixtures`,
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.fell_back).toBe(true)
    expect(body.fallback_reason).toMatch(/equal groups/i)
    expect(body.fixtures).toBe(4)
  })

  it('nine teams becomes three groups of three', async () => {
    await makeEvent({ teamCount: 9 })
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/fixtures`,
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().fixtures).toBe(12)

    const groups = await getDb()
      .selectFrom('event_teams')
      .select('group_no')
      .where('event_id', '=', eventId)
      .execute()
    const counts = new Map<string, number>()
    for (const g of groups) counts.set(g.group_no!, (counts.get(g.group_no!) ?? 0) + 1)
    expect([...counts.values()]).toEqual([3, 3, 3])
  })

  it('REFUSES generation when a referee cannot officiate the event tier', async () => {
    // The third enforcement point of §3.1.1. The event is 'pro' but only an
    // amateur referee is assigned, so no match may legally be created.
    await makeEvent({
      teamCount: 8,
      tier: 'pro',
      referees: [
        { id: REF_PRO_ID, pitch: 'Pitch 1' },
        { id: REF_AMATEUR_ID, pitch: 'Pitch 2' },
      ],
    })
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/fixtures`,
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/cannot officiate/i)

    // Nothing must have been written — the whole transaction is refused.
    const db = getDb()
    const fixtures = await db
      .selectFrom('event_fixtures')
      .select('id')
      .where('event_id', '=', eventId)
      .execute()
    const matches = await db
      .selectFrom('matches')
      .select('id')
      .where('event_id', '=', eventId)
      .execute()
    expect(fixtures).toHaveLength(0)
    expect(matches).toHaveLength(0)
  })

  it('allows generation when every referee clears the tier', async () => {
    await makeEvent({
      teamCount: 8,
      tier: 'pro',
      referees: [{ id: REF_PRO_ID, pitch: 'Pitch 1' }],
    })
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/fixtures`,
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
    })
    expect(res.statusCode).toBe(201)
    const matches = await getDb()
      .selectFrom('matches')
      .select('tier')
      .where('event_id', '=', eventId)
      .execute()
    for (const m of matches) expect(m.tier).toBe('pro')
  })

  it('regenerates while nothing has kicked off', async () => {
    await makeEvent({ teamCount: 8 })
    const first = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/fixtures`,
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
    })
    expect(first.statusCode).toBe(201)

    const again = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/fixtures`,
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
    })
    expect(again.statusCode).toBe(201)

    // Exactly one set of fixtures — the old ones were removed, not duplicated.
    const fixtures = await getDb()
      .selectFrom('event_fixtures')
      .select('id')
      .where('event_id', '=', eventId)
      .execute()
    expect(fixtures).toHaveLength(15)
  })

  it('refuses to regenerate once a match has started', async () => {
    await makeEvent({ teamCount: 8 })
    await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/fixtures`,
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
    })

    const db = getDb()
    const match = await db
      .selectFrom('matches')
      .select('id')
      .where('event_id', '=', eventId)
      .executeTakeFirstOrThrow()
    await db
      .updateTable('matches')
      .set({ status: 'live', started_at: new Date() })
      .where('id', '=', match.id)
      .execute()

    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/fixtures`,
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/already started|kicked off/i)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
DATABASE_URL="postgresql://allsports:password@localhost:5433/allsports_test" \
  REDIS_URL="redis://localhost:6380" npm --workspace backend run test -- event-fixtures
```

Expected: FAIL — `Failed to load url ../modules/events/event-fixtures.routes`.

- [ ] **Step 3: Write the generator**

Create `backend/src/modules/events/bracket/generator.ts`:

```ts
import { getDb } from '../../../shared/db/client'
import { canOfficiate, type MatchTier } from '../../../shared/tiers'
import type { FixtureSource } from '../../../shared/db/types'
import { planBracket, type PlannedSource } from './planner'
import { scheduleFixtures } from './scheduler'

/** Used when the event has no match_duration_minutes set. */
const DEFAULT_SLOT_MINUTES = 15

export type GenerateResult =
  | {
      ok: true
      fixtures: number
      matches: number
      fell_back: boolean
      fallback_reason: string | null
    }
  | { ok: false; code: number; error: string }

/**
 * Turn an event's registered teams into a full set of fixtures, and create the
 * `matches` rows for every fixture whose teams are already known (the group
 * stage, or the first round of a pure knockout).
 *
 * Everything happens in one transaction. In particular, if ANY match would
 * exceed its assigned referee's tier the whole thing is rolled back — the third
 * enforcement point of spec §3.1.1.
 */
export async function generateFixtures(eventId: string): Promise<GenerateResult> {
  const db = getDb()

  const event = await db
    .selectFrom('events')
    .select([
      'id',
      'sport_id',
      'format',
      'tier',
      'match_format',
      'match_duration_minutes',
      'starts_at',
      'venue',
    ])
    .where('id', '=', eventId)
    .executeTakeFirst()

  if (!event) return { ok: false, code: 404, error: 'Event not found' }

  if (event.format !== 'knockout' && event.format !== 'group_knockout') {
    return {
      ok: false,
      code: 400,
      error: `Fixture generation supports 'knockout' and 'group_knockout', not '${event.format}'`,
    }
  }

  // ── Regeneration guard ────────────────────────────────────────────────────
  const started = await db
    .selectFrom('matches')
    .select('id')
    .where('event_id', '=', eventId)
    .where('status', '!=', 'scheduled')
    .executeTakeFirst()

  if (started) {
    return {
      ok: false,
      code: 409,
      error: 'A match has already kicked off — fixtures can no longer be regenerated',
    }
  }

  // ── Inputs ────────────────────────────────────────────────────────────────
  const registered = await db
    .selectFrom('event_teams')
    .select(['team_id', 'seed'])
    .where('event_id', '=', eventId)
    .orderBy('seed', 'asc')
    .orderBy('team_id', 'asc')
    .execute()

  if (registered.length < 2) {
    return {
      ok: false,
      code: 400,
      error: `A tournament needs at least 2 registered teams (got ${registered.length})`,
    }
  }

  const referees = await db
    .selectFrom('event_referees as er')
    .innerJoin('users as u', 'u.id', 'er.user_id')
    .select(['er.user_id', 'er.pitch_label', 'u.role', 'u.referee_tier', 'u.name'])
    .where('er.event_id', '=', eventId)
    .execute()

  const withPitch = referees.filter((r) => r.pitch_label)
  if (withPitch.length === 0) {
    return {
      ok: false,
      code: 400,
      error: 'Assign at least one referee with a pitch label before generating fixtures',
    }
  }

  // ── Tier check, before writing anything ───────────────────────────────────
  // Every generated match inherits events.tier, so every assigned referee must
  // be able to officiate it. Admins bypass, as everywhere else.
  const eventTier = event.tier as MatchTier
  for (const r of withPitch) {
    if (r.role === 'admin') continue
    if (!canOfficiate(r.referee_tier, eventTier)) {
      return {
        ok: false,
        code: 409,
        error: `${r.name} (tier ${r.referee_tier ?? 'none'}) cannot officiate a '${eventTier}' match — lower the event tier or change referees`,
      }
    }
  }

  // ── Plan and schedule ─────────────────────────────────────────────────────
  const plan = planBracket(
    registered.map((r) => r.team_id),
    event.format
  )

  const pitches = [...new Set(withPitch.map((r) => r.pitch_label as string))].sort()
  const refereeByPitch = new Map(withPitch.map((r) => [r.pitch_label as string, r.user_id]))

  let scheduled
  try {
    scheduled = scheduleFixtures({
      fixtures: plan.fixtures,
      pitches,
      startsAt: event.starts_at ?? new Date(),
      slotMinutes: event.match_duration_minutes ?? DEFAULT_SLOT_MINUTES,
    })
  } catch (e) {
    return { ok: false, code: 400, error: (e as Error).message }
  }

  // ── Persist ───────────────────────────────────────────────────────────────
  const written = await db.transaction().execute(async (trx) => {
    // Clear any previous, unstarted bracket. ON DELETE SET NULL on match_id
    // means fixtures must go first, then their matches.
    await trx.deleteFrom('event_fixtures').where('event_id', '=', eventId).execute()
    await trx.deleteFrom('matches').where('event_id', '=', eventId).execute()

    // Record group membership so standings and the UI can group teams.
    await trx
      .updateTable('event_teams')
      .set({ group_no: null })
      .where('event_id', '=', eventId)
      .execute()
    for (const g of plan.groups) {
      await trx
        .updateTable('event_teams')
        .set({ group_no: g.group })
        .where('event_id', '=', eventId)
        .where('team_id', 'in', g.team_ids)
        .execute()
    }

    // Pass 1 — insert every fixture with a placeholder source for winner_of,
    // because the referenced fixture's real UUID isn't known yet.
    const idByKey = new Map<string, string>()
    for (const f of scheduled) {
      const row = await trx
        .insertInto('event_fixtures')
        .values({
          event_id: eventId,
          round: f.round,
          slot_no: f.slot_no,
          pitch_label: f.pitch_label,
          scheduled_at: f.scheduled_at,
          referee_id: refereeByPitch.get(f.pitch_label) ?? null,
          home_source: toStoredSource(f.home, idByKey),
          away_source: toStoredSource(f.away, idByKey),
          home_team_id: f.home.type === 'team' ? f.home.team_id : null,
          away_team_id: f.away.type === 'team' ? f.away.team_id : null,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      idByKey.set(f.key, row.id)
    }

    // Pass 2 — rewrite winner_of sources now that every fixture has a UUID.
    for (const f of scheduled) {
      const needsRewrite = f.home.type === 'winner_of' || f.away.type === 'winner_of'
      if (!needsRewrite) continue
      await trx
        .updateTable('event_fixtures')
        .set({
          home_source: toStoredSource(f.home, idByKey),
          away_source: toStoredSource(f.away, idByKey),
        })
        .where('id', '=', idByKey.get(f.key)!)
        .execute()
    }

    // Pass 3 — create matches for fixtures whose teams are already known.
    let matchCount = 0
    for (const f of scheduled) {
      if (f.home.type !== 'team' || f.away.type !== 'team') continue
      const match = await trx
        .insertInto('matches')
        .values({
          event_id: eventId,
          sport_id: event.sport_id,
          home_team_id: f.home.team_id,
          away_team_id: f.away.team_id,
          venue: event.venue,
          round: f.round,
          scheduled_at: f.scheduled_at,
          status: 'scheduled',
          tier: eventTier,
          referee_id: refereeByPitch.get(f.pitch_label) ?? null,
        })
        .returning('id')
        .executeTakeFirstOrThrow()

      await trx
        .updateTable('event_fixtures')
        .set({ match_id: match.id, updated_at: new Date() })
        .where('id', '=', idByKey.get(f.key)!)
        .execute()
      matchCount++
    }

    return { fixtures: scheduled.length, matches: matchCount }
  })

  return {
    ok: true,
    fixtures: written.fixtures,
    matches: written.matches,
    fell_back: plan.fell_back,
    fallback_reason: plan.fallback_reason,
  }
}

/**
 * Convert a planner source into the stored jsonb shape. `winner_of` keys become
 * real fixture UUIDs once known; before that they are written as an empty string
 * and rewritten in pass 2.
 */
function toStoredSource(
  source: PlannedSource,
  idByKey: Map<string, string>
): FixtureSource {
  if (source.type === 'team') return { type: 'team', team_id: source.team_id }
  if (source.type === 'qualifier') return { type: 'qualifier', seed: source.seed }
  return { type: 'winner_of', fixture_id: idByKey.get(source.ref) ?? '' }
}
```

- [ ] **Step 4: Write the route**

Create `backend/src/modules/events/event-fixtures.routes.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import { requireRole } from '../../shared/middleware/auth'
import { getDb } from '../../shared/db/client'
import { generateFixtures } from './bracket/generator'

export async function eventFixturesRoutes(app: FastifyInstance) {
  /**
   * POST /events/:id/fixtures
   *
   * Builds the whole tournament: groups, knockout rounds, slots, pitches and
   * referees. One transaction — all of it or none. Re-runnable while nothing has
   * kicked off, so an organizer can re-seed after a team withdraws.
   */
  app.post(
    '/events/:id/fixtures',
    { preHandler: requireRole('organizer', 'admin') },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const event = await getDb()
        .selectFrom('events')
        .select(['id', 'organizer_id'])
        .where('id', '=', id)
        .executeTakeFirst()

      if (!event) return reply.code(404).send({ error: 'Event not found' })
      if (event.organizer_id !== request.userId && request.userRole !== 'admin') {
        return reply.code(403).send({ error: 'Forbidden — not your event' })
      }

      const result = await generateFixtures(id)
      if (!result.ok) return reply.code(result.code).send({ error: result.error })

      return reply.code(201).send({
        event_id: id,
        fixtures: result.fixtures,
        matches: result.matches,
        fell_back: result.fell_back,
        fallback_reason: result.fallback_reason,
      })
    }
  )
}
```

- [ ] **Step 5: Register the route**

In `backend/src/app.ts`, add the import after `eventRegistrationRoutes`:

```ts
import { eventFixturesRoutes } from './modules/events/event-fixtures.routes'
```

And register it after `eventRegistrationRoutes`:

```ts
  await app.register(eventFixturesRoutes, { prefix: V1_PREFIX })
```

- [ ] **Step 6: Run the tests**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
DATABASE_URL="postgresql://allsports:password@localhost:5433/allsports_test" \
  REDIS_URL="redis://localhost:6380" npm --workspace backend run test -- event-fixtures
```

Expected: PASS — 11 tests.

- [ ] **Step 7: Verify types and the whole suite twice**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports/backend && npx tsc --noEmit
cd /Users/advaitchoudhary/Documents/compete/allsports
for i in 1 2; do
  DATABASE_URL="postgresql://allsports:password@localhost:5433/allsports_test" \
    REDIS_URL="redis://localhost:6380" npm --workspace backend run test 2>&1 | grep -E "Test Files|Tests "
done
```

Expected: 0 type errors; **85 tests, 8 files**, both times.

- [ ] **Step 8: Commit**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
git add backend/src/modules/events/bracket/generator.ts backend/src/modules/events/event-fixtures.routes.ts backend/src/app.ts backend/src/tests/event-fixtures.test.ts
git commit -m "feat(bracket): generate a full tournament with tier enforcement"
```

---

### Task 5: Standings and the resolver — make the bracket advance

**Files:**
- Create: `backend/src/modules/events/bracket/standings.ts`
- Create: `backend/src/modules/events/bracket/resolver.ts`
- Modify: `backend/src/modules/scores/scores.routes.ts` (call both from `finalizeMatch`)
- Create: `backend/src/tests/bracket-resolver.test.ts`

**Interfaces:**
- Consumes: `event_fixtures` and standings columns (Task 1), generated fixtures (Task 4).
- Produces:
  - `export async function applyStandings(trx, matchId): Promise<void>` — updates `event_teams` for a completed **group** match.
  - `export async function rankStandings(eventId, group): Promise<Array<{ team_id: string; points: number; gd: number; gf: number; seed: number | null }>>` — ordered by points → GD → GF → head-to-head (two-way) → seed.
  - `export async function resolveFixtures(eventId): Promise<{ advanced: number }>` — fills any fixture whose sources are now satisfied and creates its match.
  - `finalizeMatch()` calls `applyStandings` then `resolveFixtures`.

- [ ] **Step 1: Write the failing test**

Create `backend/src/tests/bracket-resolver.test.ts`. It reuses the helper shape from `event-fixtures.test.ts`; repeated here in full because tasks may be read out of order.

```ts
/**
 * Integration tests — standings and bracket progression.
 *
 * Plays a whole 8-team tournament through the API surface and asserts the
 * bracket advances itself: group results feed the table, the table ranks the
 * qualifiers, and each knockout winner lands in the right downstream slot.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.mock('../shared/queue/ratings.stream', () => ({
  enqueueRatingJob: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../modules/auth/auth.service', () => ({
  initFirebase: vi.fn(),
  verifyFirebaseToken: vi.fn().mockResolvedValue({
    uid: 'test-res-uid',
    phone_number: '+919999999006',
    email: undefined,
  }),
  issueJwt: vi.fn().mockReturnValue('test-jwt-token'),
}))

import { getDb } from '../shared/db/client'
import { generateFixtures } from '../modules/events/bracket/generator'
import { resolveFixtures } from '../modules/events/bracket/resolver'
import { applyStandings, rankStandings } from '../modules/events/bracket/standings'

const ORGANIZER_ID = '550e8400-e29b-41d4-a716-4466554406f1'
const REF_ID = '550e8400-e29b-41d4-a716-4466554406f2'
const ALL_TEST_USERS = [ORGANIZER_ID, REF_ID]

let footballSportId: string
let eventId: string
let teamIds: string[] = []

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
  const teams = await db
    .selectFrom('teams')
    .select('id')
    .where('organizer_id', 'in', ALL_TEST_USERS)
    .execute()
  const tIds = teams.map((t) => t.id)

  if (eventIds.length > 0) {
    await db.deleteFrom('event_fixtures').where('event_id', 'in', eventIds).execute()
    await db.deleteFrom('matches').where('event_id', 'in', eventIds).execute()
    await db.deleteFrom('event_referees').where('event_id', 'in', eventIds).execute()
    await db.deleteFrom('event_teams').where('event_id', 'in', eventIds).execute()
    await db.deleteFrom('events').where('id', 'in', eventIds).execute()
  }
  if (tIds.length > 0) {
    await db.deleteFrom('matches').where('home_team_id', 'in', tIds).execute()
    await db.deleteFrom('matches').where('away_team_id', 'in', tIds).execute()
    await db.deleteFrom('event_teams').where('team_id', 'in', tIds).execute()
    await db.deleteFrom('teams').where('id', 'in', tIds).execute()
  }
  await db.deleteFrom('event_referees').where('user_id', 'in', ALL_TEST_USERS).execute()
  await db.deleteFrom('organizer_scores').where('user_id', 'in', ALL_TEST_USERS).execute()
  await db.deleteFrom('users').where('id', 'in', ALL_TEST_USERS).execute()
}

/** Complete a match with the given goals, then run standings + resolver. */
async function completeMatch(matchId: string, homeGoals: number, awayGoals: number) {
  const db = getDb()
  const match = await db
    .selectFrom('matches')
    .select(['home_team_id', 'away_team_id'])
    .where('id', '=', matchId)
    .executeTakeFirstOrThrow()

  const winner =
    homeGoals > awayGoals
      ? match.home_team_id
      : awayGoals > homeGoals
        ? match.away_team_id
        : null

  await db
    .updateTable('matches')
    .set({
      home_score: { goals: homeGoals },
      away_score: { goals: awayGoals },
      winner_team_id: winner,
      status: 'completed',
      completed_at: new Date(),
    })
    .where('id', '=', matchId)
    .execute()

  await db.transaction().execute(async (trx) => {
    await applyStandings(trx, matchId)
  })
  await resolveFixtures(eventId)
}

describe('Standings and bracket progression', () => {
  beforeAll(async () => {
    await cleanupTestData()
    await seedUser(ORGANIZER_ID, 'Turf Owner', 'organizer')
    await seedUser(REF_ID, 'Ref', 'referee', 'amateur')

    const db = getDb()
    const sport = await db
      .selectFrom('sports')
      .select('id')
      .where('slug', '=', 'football')
      .executeTakeFirstOrThrow()
    footballSportId = sport.id

    const event = await db
      .insertInto('events')
      .values({
        name: `Resolver Cup ${Date.now()}`,
        sport_id: footballSportId,
        organizer_id: ORGANIZER_ID,
        format: 'group_knockout',
        match_format: '5-a-side',
        match_duration_minutes: 12,
        city: 'Mumbai',
        status: 'registration',
        starts_at: new Date('2026-08-02T09:00:00.000Z'),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    eventId = event.id

    teamIds = []
    for (let i = 0; i < 8; i++) {
      const t = await db
        .insertInto('teams')
        .values({
          name: `RS Team ${i + 1} ${Date.now()}`,
          sport_id: footballSportId,
          organizer_id: ORGANIZER_ID,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      teamIds.push(t.id)
      await db
        .insertInto('event_teams')
        .values({ event_id: eventId, team_id: t.id, seed: i + 1 })
        .execute()
    }

    await db
      .insertInto('event_referees')
      .values({ event_id: eventId, user_id: REF_ID, pitch_label: 'Pitch 1' })
      .execute()

    const gen = await generateFixtures(eventId)
    expect(gen.ok).toBe(true)
  })

  afterAll(async () => {
    await cleanupTestData()
  })

  it('a group win records 3 points and the goals', async () => {
    const db = getDb()
    const groupMatch = await db
      .selectFrom('matches')
      .select(['id', 'home_team_id', 'away_team_id'])
      .where('event_id', '=', eventId)
      .where('round', 'like', 'group_%')
      .orderBy('scheduled_at', 'asc')
      .executeTakeFirstOrThrow()

    await completeMatch(groupMatch.id, 3, 1)

    const home = await db
      .selectFrom('event_teams')
      .select(['points', 'played', 'won', 'lost', 'goals_for', 'goals_against'])
      .where('event_id', '=', eventId)
      .where('team_id', '=', groupMatch.home_team_id)
      .executeTakeFirstOrThrow()
    expect(home).toMatchObject({
      points: 3,
      played: 1,
      won: 1,
      lost: 0,
      goals_for: 3,
      goals_against: 1,
    })

    const away = await db
      .selectFrom('event_teams')
      .select(['points', 'played', 'lost', 'goals_for', 'goals_against'])
      .where('event_id', '=', eventId)
      .where('team_id', '=', groupMatch.away_team_id)
      .executeTakeFirstOrThrow()
    expect(away).toMatchObject({ points: 0, played: 1, lost: 1, goals_for: 1, goals_against: 3 })
  })

  it('a draw records one point each', async () => {
    const db = getDb()
    const next = await db
      .selectFrom('matches')
      .select(['id', 'home_team_id', 'away_team_id'])
      .where('event_id', '=', eventId)
      .where('round', 'like', 'group_%')
      .where('status', '=', 'scheduled')
      .orderBy('scheduled_at', 'asc')
      .executeTakeFirstOrThrow()

    await completeMatch(next.id, 2, 2)

    for (const teamId of [next.home_team_id, next.away_team_id]) {
      const row = await db
        .selectFrom('event_teams')
        .select(['points', 'drawn'])
        .where('event_id', '=', eventId)
        .where('team_id', '=', teamId)
        .executeTakeFirstOrThrow()
      expect(row.points).toBeGreaterThanOrEqual(1)
      expect(row.drawn).toBe(1)
    }
  })

  it('knockout fixtures stay unresolved until the group stage finishes', async () => {
    const unresolved = await getDb()
      .selectFrom('event_fixtures')
      .select('id')
      .where('event_id', '=', eventId)
      .where('match_id', 'is', null)
      .execute()
    expect(unresolved.length).toBeGreaterThan(0)
  })

  it('completing every group match fills the whole first knockout round', async () => {
    const db = getDb()
    let guard = 0
    for (;;) {
      const pending = await db
        .selectFrom('matches')
        .select('id')
        .where('event_id', '=', eventId)
        .where('round', 'like', 'group_%')
        .where('status', '=', 'scheduled')
        .executeTakeFirst()
      if (!pending) break
      if (++guard > 50) throw new Error('group stage did not drain')
      // Deterministic, distinct scorelines so the table has no ties.
      await completeMatch(pending.id, (guard % 4) + 1, 0)
    }

    const semis = await db
      .selectFrom('event_fixtures')
      .select(['id', 'home_team_id', 'away_team_id', 'match_id'])
      .where('event_id', '=', eventId)
      .where('round', '=', 'semi')
      .execute()

    expect(semis).toHaveLength(2)
    for (const s of semis) {
      expect(s.home_team_id).not.toBeNull()
      expect(s.away_team_id).not.toBeNull()
      expect(s.match_id).not.toBeNull()
    }
  })

  it('ranks the group table by points then goal difference', async () => {
    const table = await rankStandings(eventId, 'a')
    expect(table.length).toBeGreaterThan(0)
    for (let i = 1; i < table.length; i++) {
      const prev = table[i - 1]
      const cur = table[i]
      const ordered =
        prev.points > cur.points ||
        (prev.points === cur.points && prev.gd > cur.gd) ||
        (prev.points === cur.points && prev.gd === cur.gd && prev.gf >= cur.gf)
      expect(ordered).toBe(true)
    }
  })

  it('a semi-final winner lands in the final', async () => {
    const db = getDb()
    const semiMatches = await db
      .selectFrom('event_fixtures as ef')
      .innerJoin('matches as m', 'm.id', 'ef.match_id')
      .select(['m.id as match_id', 'm.home_team_id'])
      .where('ef.event_id', '=', eventId)
      .where('ef.round', '=', 'semi')
      .execute()
    expect(semiMatches).toHaveLength(2)

    await completeMatch(semiMatches[0].match_id, 2, 0)

    const final = await db
      .selectFrom('event_fixtures')
      .select(['home_team_id', 'away_team_id', 'match_id'])
      .where('event_id', '=', eventId)
      .where('round', '=', 'final')
      .executeTakeFirstOrThrow()

    // One side filled, the other still waiting on the second semi.
    const filled = [final.home_team_id, final.away_team_id].filter(Boolean)
    expect(filled).toHaveLength(1)
    expect(filled[0]).toBe(semiMatches[0].home_team_id)
    // No match yet — a fixture needs both teams before it becomes a match.
    expect(final.match_id).toBeNull()

    await completeMatch(semiMatches[1].match_id, 0, 3)

    const finalAgain = await db
      .selectFrom('event_fixtures')
      .select(['home_team_id', 'away_team_id', 'match_id'])
      .where('event_id', '=', eventId)
      .where('round', '=', 'final')
      .executeTakeFirstOrThrow()
    expect(finalAgain.home_team_id).not.toBeNull()
    expect(finalAgain.away_team_id).not.toBeNull()
    expect(finalAgain.match_id).not.toBeNull()
  })

  it('re-resolving is idempotent — no double advance, no second match', async () => {
    const db = getDb()
    const before = await db
      .selectFrom('matches')
      .select('id')
      .where('event_id', '=', eventId)
      .execute()

    await resolveFixtures(eventId)
    await resolveFixtures(eventId)

    const after = await db
      .selectFrom('matches')
      .select('id')
      .where('event_id', '=', eventId)
      .execute()
    expect(after).toHaveLength(before.length)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
DATABASE_URL="postgresql://allsports:password@localhost:5433/allsports_test" \
  REDIS_URL="redis://localhost:6380" npm --workspace backend run test -- bracket-resolver
```

Expected: FAIL — `Failed to load url ../modules/events/bracket/standings`.

- [ ] **Step 3: Write standings**

Create `backend/src/modules/events/bracket/standings.ts`:

```ts
import { sql, type Kysely, type Transaction } from 'kysely'
import { getDb } from '../../../shared/db/client'
import type { Database } from '../../../shared/db/types'

const WIN_POINTS = 3
const DRAW_POINTS = 1

/** Goals out of a match score jsonb, which is shaped `{ goals: n }` for football. */
function goalsOf(score: unknown): number {
  if (!score || typeof score !== 'object') return 0
  const value = (score as Record<string, unknown>).goals
  return typeof value === 'number' ? value : Number(value ?? 0) || 0
}

/**
 * Fold a completed GROUP match into the two teams' standings rows.
 *
 * Knockout results are deliberately excluded — they don't belong in a group
 * table. Runs inside the caller's transaction so a match completing and its
 * table update commit together.
 */
export async function applyStandings(
  trx: Transaction<Database> | Kysely<Database>,
  matchId: string
): Promise<void> {
  const match = await trx
    .selectFrom('matches')
    .select([
      'id',
      'event_id',
      'round',
      'home_team_id',
      'away_team_id',
      'home_score',
      'away_score',
      'status',
    ])
    .where('id', '=', matchId)
    .executeTakeFirst()

  if (!match || !match.event_id) return
  if (match.status !== 'completed') return
  if (!match.round || !match.round.startsWith('group_')) return

  const homeGoals = goalsOf(match.home_score)
  const awayGoals = goalsOf(match.away_score)

  const rows = [
    {
      team_id: match.home_team_id,
      gf: homeGoals,
      ga: awayGoals,
      won: homeGoals > awayGoals ? 1 : 0,
      drawn: homeGoals === awayGoals ? 1 : 0,
      lost: homeGoals < awayGoals ? 1 : 0,
    },
    {
      team_id: match.away_team_id,
      gf: awayGoals,
      ga: homeGoals,
      won: awayGoals > homeGoals ? 1 : 0,
      drawn: homeGoals === awayGoals ? 1 : 0,
      lost: awayGoals < homeGoals ? 1 : 0,
    },
  ]

  for (const r of rows) {
    // sql`col + n` matches the pattern already used in scores.routes.ts, where
    // db.raw was deliberately replaced with it.
    const gained = r.won * WIN_POINTS + r.drawn * DRAW_POINTS
    await trx
      .updateTable('event_teams')
      .set({
        played: sql<number>`played + 1`,
        won: sql<number>`won + ${r.won}`,
        drawn: sql<number>`drawn + ${r.drawn}`,
        lost: sql<number>`lost + ${r.lost}`,
        goals_for: sql<number>`goals_for + ${r.gf}`,
        goals_against: sql<number>`goals_against + ${r.ga}`,
        points: sql<number>`points + ${gained}`,
      })
      .where('event_id', '=', match.event_id)
      .where('team_id', '=', r.team_id)
      .execute()
  }
}

export interface StandingRow {
  team_id: string
  points: number
  gd: number
  gf: number
  seed: number | null
}

/**
 * Ordered group table.
 *
 * points → goal difference → goals for → head-to-head → seed.
 * Head-to-head applies only to a TWO-way tie; three or more teams still level
 * fall back to seed order, which is deterministic and explainable to an
 * organizer standing on the pitch. No coin flips.
 */
export async function rankStandings(eventId: string, group: string): Promise<StandingRow[]> {
  const db = getDb()

  const rows = await db
    .selectFrom('event_teams')
    .select(['team_id', 'points', 'goals_for', 'goals_against', 'seed'])
    .where('event_id', '=', eventId)
    .where('group_no', '=', group)
    .execute()

  const table: StandingRow[] = rows.map((r) => ({
    team_id: r.team_id,
    points: Number(r.points),
    gd: Number(r.goals_for) - Number(r.goals_against),
    gf: Number(r.goals_for),
    seed: r.seed === null ? null : Number(r.seed),
  }))

  // Head-to-head data for breaking two-way ties.
  const played = await db
    .selectFrom('matches')
    .select(['home_team_id', 'away_team_id', 'home_score', 'away_score'])
    .where('event_id', '=', eventId)
    .where('status', '=', 'completed')
    .where('round', 'like', 'group_%')
    .execute()

  const headToHead = (a: string, b: string): number => {
    let aGoals = 0
    let bGoals = 0
    for (const m of played) {
      if (m.home_team_id === a && m.away_team_id === b) {
        aGoals += goalsOf(m.home_score)
        bGoals += goalsOf(m.away_score)
      } else if (m.home_team_id === b && m.away_team_id === a) {
        bGoals += goalsOf(m.home_score)
        aGoals += goalsOf(m.away_score)
      }
    }
    return bGoals - aGoals // negative => a ahead
  }

  const levelCount = (row: StandingRow) =>
    table.filter((t) => t.points === row.points && t.gd === row.gd && t.gf === row.gf).length

  return table.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points
    if (b.gd !== a.gd) return b.gd - a.gd
    if (b.gf !== a.gf) return b.gf - a.gf
    // Only a straight two-way tie is settled head-to-head.
    if (levelCount(a) === 2 && levelCount(b) === 2) {
      const h2h = headToHead(a.team_id, b.team_id)
      if (h2h !== 0) return h2h
    }
    return (a.seed ?? Number.MAX_SAFE_INTEGER) - (b.seed ?? Number.MAX_SAFE_INTEGER)
  })
}
```

- [ ] **Step 4: Write the resolver**

Create `backend/src/modules/events/bracket/resolver.ts`:

```ts
import { getDb } from '../../../shared/db/client'
import type { FixtureSource } from '../../../shared/db/types'
import type { MatchTier } from '../../../shared/tiers'
import { rankStandings } from './standings'

/**
 * Advance the bracket.
 *
 * Fills any fixture whose sources are now known and creates its `matches` row.
 * Two source kinds resolve here:
 *   - `winner_of` — as soon as the feeding fixture's match has a winner
 *   - `qualifier` — once EVERY group match is complete, the whole first knockout
 *     round is filled at once from the ranked qualifier list (group winners
 *     first, then best runners-up), which is how a real draw works
 *
 * Idempotent: a slot that already holds a team is never overwritten, and the
 * UNIQUE constraint on `event_fixtures.match_id` makes a second match
 * impossible for the same fixture.
 */
export async function resolveFixtures(eventId: string): Promise<{ advanced: number }> {
  const db = getDb()

  const event = await db
    .selectFrom('events')
    .select(['id', 'sport_id', 'tier', 'venue'])
    .where('id', '=', eventId)
    .executeTakeFirst()
  if (!event) return { advanced: 0 }

  const fixtures = await db
    .selectFrom('event_fixtures')
    .selectAll()
    .where('event_id', '=', eventId)
    .orderBy('scheduled_at', 'asc')
    .execute()

  const pending = fixtures.filter((f) => f.match_id === null)
  if (pending.length === 0) return { advanced: 0 }

  // ── winner_of resolution ──────────────────────────────────────────────────
  const winnerByFixture = new Map<string, string | null>()
  const withMatches = fixtures.filter((f) => f.match_id !== null)
  if (withMatches.length > 0) {
    const results = await db
      .selectFrom('matches')
      .select(['id', 'winner_team_id', 'status'])
      .where(
        'id',
        'in',
        withMatches.map((f) => f.match_id as string)
      )
      .execute()
    const byMatch = new Map(results.map((r) => [r.id, r]))
    for (const f of withMatches) {
      const m = byMatch.get(f.match_id as string)
      if (m && m.status === 'completed') winnerByFixture.set(f.id, m.winner_team_id)
    }
  }

  // ── qualifier resolution ──────────────────────────────────────────────────
  // Only once the entire group stage is done, so the table is final.
  let qualifierList: string[] = []
  const needsQualifiers = pending.some(
    (f) =>
      (f.home_source as FixtureSource).type === 'qualifier' ||
      (f.away_source as FixtureSource).type === 'qualifier'
  )

  if (needsQualifiers) {
    const groupsRemaining = await db
      .selectFrom('matches')
      .select('id')
      .where('event_id', '=', eventId)
      .where('round', 'like', 'group_%')
      .where('status', '!=', 'completed')
      .executeTakeFirst()

    if (!groupsRemaining) {
      const groupRows = await db
        .selectFrom('event_teams')
        .select('group_no')
        .where('event_id', '=', eventId)
        .where('group_no', 'is not', null)
        .execute()
      const groups = [...new Set(groupRows.map((g) => g.group_no as string))].sort()

      const tables = await Promise.all(groups.map((g) => rankStandings(eventId, g)))

      // Winners in table order first, then runners-up, then third places — each
      // band internally ordered by the same points/GD/GF comparison. Comparing
      // across groups is fair because group sizes are equal.
      const bands: Array<Array<{ team_id: string; points: number; gd: number; gf: number }>> = []
      const deepest = Math.max(...tables.map((t) => t.length), 0)
      for (let pos = 0; pos < deepest; pos++) {
        const band = tables
          .map((t) => t[pos])
          .filter((r): r is NonNullable<typeof r> => Boolean(r))
          .sort((a, b) => b.points - a.points || b.gd - a.gd || b.gf - a.gf)
        bands.push(band)
      }
      qualifierList = bands.flat().map((r) => r.team_id)
    }
  }

  // ── Fill and create ───────────────────────────────────────────────────────
  const resolveSide = (source: FixtureSource, current: string | null): string | null => {
    if (current) return current
    if (source.type === 'team') return source.team_id
    if (source.type === 'winner_of') return winnerByFixture.get(source.fixture_id) ?? null
    if (source.type === 'qualifier') return qualifierList[source.seed - 1] ?? null
    return null
  }

  let advanced = 0

  for (const f of pending) {
    const home = resolveSide(f.home_source as FixtureSource, f.home_team_id)
    const away = resolveSide(f.away_source as FixtureSource, f.away_team_id)

    if (home === f.home_team_id && away === f.away_team_id) continue

    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('event_fixtures')
        .set({ home_team_id: home, away_team_id: away, updated_at: new Date() })
        .where('id', '=', f.id)
        .execute()

      // A fixture only becomes a match once BOTH sides are known.
      if (!home || !away) return

      // Re-read under the transaction: another concurrent resolve may have won.
      const fresh = await trx
        .selectFrom('event_fixtures')
        .select('match_id')
        .where('id', '=', f.id)
        .executeTakeFirstOrThrow()
      if (fresh.match_id) return

      const match = await trx
        .insertInto('matches')
        .values({
          event_id: eventId,
          sport_id: event.sport_id,
          home_team_id: home,
          away_team_id: away,
          venue: event.venue,
          round: f.round,
          scheduled_at: f.scheduled_at,
          status: 'scheduled',
          tier: event.tier as MatchTier,
          referee_id: f.referee_id,
        })
        .returning('id')
        .executeTakeFirstOrThrow()

      await trx
        .updateTable('event_fixtures')
        .set({ match_id: match.id, updated_at: new Date() })
        .where('id', '=', f.id)
        .execute()

      advanced++
    })
  }

  return { advanced }
}
```

- [ ] **Step 5: Hook both into `finalizeMatch`**

In `backend/src/modules/scores/scores.routes.ts`, add the imports near the top:

```ts
import { applyStandings } from '../events/bracket/standings'
import { resolveFixtures } from '../events/bracket/resolver'
```

Then in `finalizeMatch()`, immediately **after** the `enqueueRatingJob({...})` call, add:

```ts
  // Tournament bookkeeping: fold the result into the group table, then advance
  // any bracket slot this result just decided. Both are no-ops for a standalone
  // match with no event_id.
  if (match.event_id) {
    await applyStandings(db, match.id)
    await resolveFixtures(match.event_id)
  }
```

If `finalizeMatch` does not already have `match.event_id` in scope, extend its match query to select `event_id`.

- [ ] **Step 6: Run the tests**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
DATABASE_URL="postgresql://allsports:password@localhost:5433/allsports_test" \
  REDIS_URL="redis://localhost:6380" npm --workspace backend run test -- bracket-resolver
```

Expected: PASS — 7 tests.

- [ ] **Step 7: Verify types and the whole suite twice**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports/backend && npx tsc --noEmit
cd /Users/advaitchoudhary/Documents/compete/allsports
for i in 1 2; do
  DATABASE_URL="postgresql://allsports:password@localhost:5433/allsports_test" \
    REDIS_URL="redis://localhost:6380" npm --workspace backend run test 2>&1 | grep -E "Test Files|Tests "
done
```

Expected: 0 type errors; **92 tests, 9 files**, both times.

- [ ] **Step 8: Commit**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
git add backend/src/modules/events/bracket/standings.ts backend/src/modules/events/bracket/resolver.ts backend/src/modules/scores/scores.routes.ts backend/src/tests/bracket-resolver.test.ts
git commit -m "feat(bracket): standings and self-advancing bracket resolver"
```

---

### Task 6: `GET /events/:id/fixtures` — the bracket and tables to read

**Files:**
- Modify: `backend/src/modules/events/event-fixtures.routes.ts`
- Modify: `backend/src/tests/event-fixtures.test.ts`

**Interfaces:**
- Consumes: `event_fixtures` (Task 1/4), `rankStandings` (Task 5).
- Produces: `GET /events/:id/fixtures` returning `{ event_id, tier, format, fixtures: [...], standings: [{ group, table: [...] }] }`. Each fixture carries resolved team names where known and a human placeholder where not (`"Winner of semi 1"`, `"Qualifier 3"`), which is exactly what Phase 5's public bracket page needs.

- [ ] **Step 1: Write the failing test**

Append inside `describe('Fixture generation', ...)` in `backend/src/tests/event-fixtures.test.ts`:

```ts
  it('GET returns the bracket with placeholders for unresolved sides', async () => {
    await makeEvent({ teamCount: 8 })
    await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/fixtures`,
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
    })

    const res = await app.inject({
      method: 'GET',
      url: `/v1/events/${eventId}/fixtures`,
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()

    expect(body.fixtures).toHaveLength(15)
    expect(body.tier).toBe('amateur')

    const group = body.fixtures.filter((f: any) => f.round.startsWith('group_'))
    expect(group).toHaveLength(12)
    for (const f of group) {
      expect(f.home_label).toBeTruthy()
      expect(f.away_label).toBeTruthy()
      expect(f.match_id).not.toBeNull()
      expect(f.pitch_label).toBeTruthy()
    }

    const semis = body.fixtures.filter((f: any) => f.round === 'semi')
    expect(semis).toHaveLength(2)
    for (const s of semis) {
      expect(s.match_id).toBeNull()
      expect(s.home_label).toMatch(/qualifier/i)
    }

    const final = body.fixtures.find((f: any) => f.round === 'final')
    expect(final.home_label).toMatch(/winner of/i)

    // Two groups, each with a four-row table.
    expect(body.standings).toHaveLength(2)
    for (const s of body.standings) {
      expect(s.table).toHaveLength(4)
    }
  })

  it('GET requires authentication', async () => {
    await makeEvent({ teamCount: 8 })
    const res = await app.inject({ method: 'GET', url: `/v1/events/${eventId}/fixtures` })
    expect(res.statusCode).toBe(401)
  })
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
DATABASE_URL="postgresql://allsports:password@localhost:5433/allsports_test" \
  REDIS_URL="redis://localhost:6380" npm --workspace backend run test -- event-fixtures
```

Expected: FAIL — the GET returns 404 because the route doesn't exist.

- [ ] **Step 3: Write the read endpoint**

In `backend/src/modules/events/event-fixtures.routes.ts`, add these imports:

```ts
import { requireAuth, requireRole } from '../../shared/middleware/auth'
import type { FixtureSource } from '../../shared/db/types'
import { rankStandings } from './bracket/standings'
```

(replacing the existing `requireRole`-only import), then append inside `eventFixturesRoutes`:

```ts
  /**
   * GET /events/:id/fixtures
   *
   * The bracket and the group tables. Unresolved sides come back as readable
   * placeholders ("Winner of semi 1", "Qualifier 3") rather than nulls, which is
   * what a bracket view needs to render — and exactly what Phase 5's public page
   * will consume.
   */
  app.get('/events/:id/fixtures', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const db = getDb()

    const event = await db
      .selectFrom('events')
      .select(['id', 'tier', 'format', 'match_format'])
      .where('id', '=', id)
      .executeTakeFirst()

    if (!event) return reply.code(404).send({ error: 'Event not found' })

    const rows = await db
      .selectFrom('event_fixtures as ef')
      .leftJoin('teams as ht', 'ht.id', 'ef.home_team_id')
      .leftJoin('teams as at', 'at.id', 'ef.away_team_id')
      .leftJoin('users as r', 'r.id', 'ef.referee_id')
      .leftJoin('matches as m', 'm.id', 'ef.match_id')
      .select([
        'ef.id',
        'ef.round',
        'ef.slot_no',
        'ef.pitch_label',
        'ef.scheduled_at',
        'ef.match_id',
        'ef.home_team_id',
        'ef.away_team_id',
        'ef.home_source',
        'ef.away_source',
        'ht.name as home_team_name',
        'at.name as away_team_name',
        'r.name as referee_name',
        'm.status as match_status',
        'm.home_score',
        'm.away_score',
      ])
      .where('ef.event_id', '=', id)
      .orderBy('ef.scheduled_at', 'asc')
      .orderBy('ef.slot_no', 'asc')
      .execute()

    // Round labels are needed to describe a winner_of placeholder in words.
    const roundBySlot = new Map(rows.map((f) => [f.id, `${f.round} ${f.slot_no}`]))

    const label = (
      source: FixtureSource,
      teamName: string | null
    ): string => {
      if (teamName) return teamName
      if (source.type === 'team') return 'TBC'
      if (source.type === 'qualifier') return `Qualifier ${source.seed}`
      return `Winner of ${roundBySlot.get(source.fixture_id) ?? 'earlier fixture'}`
    }

    const fixtures = rows.map((f) => ({
      id: f.id,
      round: f.round,
      slot_no: f.slot_no,
      pitch_label: f.pitch_label,
      scheduled_at: f.scheduled_at,
      referee_name: f.referee_name,
      match_id: f.match_id,
      match_status: f.match_status,
      home_team_id: f.home_team_id,
      away_team_id: f.away_team_id,
      home_label: label(f.home_source as FixtureSource, f.home_team_name),
      away_label: label(f.away_source as FixtureSource, f.away_team_name),
      home_score: f.home_score,
      away_score: f.away_score,
    }))

    const groupRows = await db
      .selectFrom('event_teams')
      .select('group_no')
      .where('event_id', '=', id)
      .where('group_no', 'is not', null)
      .execute()
    const groups = [...new Set(groupRows.map((g) => g.group_no as string))].sort()

    const standings = await Promise.all(
      groups.map(async (g) => ({ group: g, table: await rankStandings(id, g) }))
    )

    return {
      event_id: id,
      tier: event.tier,
      format: event.format,
      match_format: event.match_format,
      fixtures,
      standings,
    }
  })
```

- [ ] **Step 4: Run the tests**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
DATABASE_URL="postgresql://allsports:password@localhost:5433/allsports_test" \
  REDIS_URL="redis://localhost:6380" npm --workspace backend run test -- event-fixtures
```

Expected: PASS — 13 tests.

- [ ] **Step 5: Verify types and the whole suite twice**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports/backend && npx tsc --noEmit
cd /Users/advaitchoudhary/Documents/compete/allsports
for i in 1 2; do
  DATABASE_URL="postgresql://allsports:password@localhost:5433/allsports_test" \
    REDIS_URL="redis://localhost:6380" npm --workspace backend run test 2>&1 | grep -E "Test Files|Tests "
done
```

Expected: 0 type errors; **94 tests, 9 files**, both times.

- [ ] **Step 6: Verify live against the running app**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
docker compose restart backend
sleep 12
ORG=$(curl -s -X POST http://localhost:13000/v1/auth/dev-token -H 'Content-Type: application/json' \
  -d '{"key":"p05"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
EV=$(cat /tmp/p2ev.txt)   # the Phase 2 event, already has 2 teams and a referee
curl -s -X POST "http://localhost:13000/v1/events/$EV/fixtures" -H "Authorization: Bearer $ORG"
curl -s "http://localhost:13000/v1/events/$EV/fixtures" -H "Authorization: Bearer $ORG" | python3 -m json.tool | head -40
```

Expected: generation returns `fixtures: 1, matches: 1` (two teams = a single final), and the GET shows that fixture with both team names, a pitch, a time and a referee.

- [ ] **Step 7: Commit**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
git add backend/src/modules/events/event-fixtures.routes.ts backend/src/tests/event-fixtures.test.ts
git commit -m "feat(bracket): read the bracket and group tables with placeholders"
```

---

## Done criteria

1. Migrations `012`, `013`, `014` applied to the test **and** dev databases.
2. `npx tsc --noEmit` reports 0 errors.
3. **94 tests across 9 files**, passing twice in a row.
4. The planner produces a valid, connected bracket for **every** team count from 2 to 24, in both formats, with exactly `N−1` matches for a pure knockout.
5. A prime team count falls back to knockout with an explanation rather than failing.
6. Generation is refused, with nothing written, when any assigned referee cannot officiate the event's tier.
7. Completing every group match fills the whole first knockout round; each knockout winner lands in the correct downstream slot; re-resolving creates no duplicates.
8. `GET /events/:id/fixtures` renders unresolved sides as readable placeholders.

## Out of scope

Fast tournament scoring and rating match-weight (Phase 4), the public bracket page (Phase 5), guest claiming (Phase 6), push notifications (Phase 7). No mobile UI — backend only. Also deliberately excluded: seeding teams by their players' Elo (seeds come from `event_teams.seed` or registration order), avoiding same-group pairings in the first knockout round, and any bracket format beyond `knockout`/`group_knockout`.

## Known risks

| Risk | Severity | Mitigation |
|---|---|---|
| Scheduler cannot satisfy the rest rule with one pitch and many teams | Medium | Fails loudly with a message naming the fixture and suggesting more pitches, rather than emitting a bad schedule. Test covers the single-pitch case. |
| `winner_of` needs a two-pass insert (UUIDs unknown on pass 1) | Medium | Both passes are inside one transaction; the planner-local `ref` → UUID map is built during pass 1. A dangling `fixture_id: ''` would be visible immediately in the GET as "Winner of earlier fixture". |
| Qualifier ranking runs only when the whole group stage is complete | Low | Deliberate — a partial table would mis-seed the bracket. Test asserts knockout fixtures stay unresolved until then. |
| Resolver called twice concurrently could double-create a match | Medium | `UNIQUE` on `event_fixtures.match_id`, plus a re-read of `match_id` inside the transaction before inserting. Idempotency test covers repeat calls. |
| Tier freeze in `event-tier.ts` still keys off "any match exists" | Low | Correct today. Once `event_fixtures` exists it should check that table instead; noted for a follow-up rather than changed here. |
