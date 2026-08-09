# Rating Match-Weight Implementation Plan (Phase 4a)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a 12-minute 5-a-side moving Elo as much as a 90-minute match, so a tournament day cannot scramble the ladder.

**Architecture:** Record each match's format and duration at creation, then multiply the Elo K-factor by a duration-derived weight in the Python engine. Deliberately small: the referee override needs no backend change (spec §3.4.1), so this phase is one migration, a stamping change in the bracket generator/resolver, and one multiplier in `algorithms/base.py`.

**Tech Stack:** Kysely/Postgres (backend), Python 3.12 (rating engine), Vitest, pytest.

## Global Constraints

- Continue on branch **`feat/organizer-foundation`**. Phases 1–4a merge to `main` together.
- Migrations: this plan adds **`015`**. Apply to the dev DB by hand — `allsports_dev` has no `pgmigrations` table.
- `npx tsc --noEmit` (from `backend/`) must report 0 errors before any commit.
- Backend is at **95 tests / 9 files**; rating engine at **32 tests**. Every task states the new total.
- **The rating engine has no volume mount and `docker compose build` is broken by corporate TLS interception.** To run changed Python in the container: `docker cp rating-engine/<file> allsports_rating_engine:/app/<file>` then `docker compose restart rating-engine`.
- Run pytest with the repo's installed binary: `/Users/advaitchoudhary/.local/share/virtualenvs/Desktop-grGLEN5t/bin/pytest tests/ -v` from `rating-engine/`. `pytest.ini` sets `pythonpath = .` so the bare binary works.

## The rule (spec §3.5)

```
match_weight = clamp(duration_minutes / 90, MATCH_WEIGHT_FLOOR, 1.0)
K_effective  = K × match_weight
```

`MATCH_WEIGHT_FLOOR = 0.25`. **A null `duration_minutes` defaults to 90 → weight 1.0, so every existing match and rating is unaffected** — this is a hard backwards-compatibility requirement, not an intention.

Weight belongs in **K**, not the tier blend. Tier weight is deliberately kept out of K to avoid double-counting; match weight is a different quantity (how much information one result carries), so K is its correct home. Duration is the only knob — format is recorded for display and stat interpretation but does not separately scale the weight, which would be a second overlapping multiplier.

---

### Task 1: Record format and duration on matches

**Files:**
- Create: `backend/migrations/015_match_duration.sql`
- Modify: `backend/src/shared/db/types.ts`
- Modify: `backend/src/modules/events/bracket/generator.ts`
- Modify: `backend/src/modules/events/bracket/resolver.ts`
- Modify: `backend/src/tests/event-fixtures.test.ts`

**Interfaces:**
- Consumes: `events.match_format` / `events.match_duration_minutes` (Phases 2–3).
- Produces: `matches.format: MatchFormat | null`, `matches.duration_minutes: number | null`, both stamped by the generator and resolver at match creation.

- [ ] **Step 1: Write migration 015**

Create `backend/migrations/015_match_duration.sql`:

```sql
-- AllSports — Match Format & Duration
-- Migration: 015_match_duration
-- Run order: 15
--
-- Copied from the parent event when a tournament match is created, so the rating
-- engine can weight a short game correctly: a 12-minute 5-a-side must not move
-- Elo like a 90-minute match. See spec §3.5.
--
-- Both nullable. A NULL duration is treated as 90 minutes (weight 1.0) by the
-- engine, so every match created before this migration keeps its current Elo
-- behaviour exactly.

ALTER TABLE matches ADD COLUMN IF NOT EXISTS format TEXT
  CHECK (format IN ('5-a-side', '7-a-side', '11-a-side'));

ALTER TABLE matches ADD COLUMN IF NOT EXISTS duration_minutes INTEGER
  CHECK (duration_minutes > 0 AND duration_minutes <= 180);
```

- [ ] **Step 2: Apply to both databases and verify**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
DATABASE_URL="postgresql://allsports:password@localhost:5433/allsports_test" npm --workspace backend run db:migrate
docker exec -i allsports_postgres psql -U allsports -d allsports_dev -q < backend/migrations/015_match_duration.sql
docker exec allsports_postgres psql -U allsports -d allsports_test -tAc \
  "SELECT column_name FROM information_schema.columns WHERE table_name='matches' AND column_name IN ('format','duration_minutes') ORDER BY column_name;"
```

Expected: `### MIGRATION 015_match_duration (UP) ###` then `Migrations complete!`, and both column names print.

- [ ] **Step 3: Add the Kysely types**

In `backend/src/shared/db/types.ts`, in `MatchTable`, add after the `tier` line:

```ts
  // Copied from the parent event at creation; drives the rating match-weight.
  format: MatchFormat | null
  duration_minutes: number | null
```

- [ ] **Step 4: Stamp them in the generator**

In `backend/src/modules/events/bracket/generator.ts`, add `'match_duration_minutes'` to the event select if not already present (it is), then in the **pass 3** `insertInto('matches')` values, add after `tier: eventTier,`:

```ts
          format: event.match_format,
          duration_minutes: event.match_duration_minutes,
```

- [ ] **Step 5: Stamp them in the resolver**

In `backend/src/modules/events/bracket/resolver.ts`, extend the event select:

```ts
  const event = await db
    .selectFrom('events')
    .select(['id', 'sport_id', 'tier', 'venue', 'match_format', 'match_duration_minutes'])
    .where('id', '=', eventId)
    .executeTakeFirst()
```

And in its `insertInto('matches')` values, add after `tier: event.tier as MatchTier,`:

```ts
          format: event.match_format,
          duration_minutes: event.match_duration_minutes,
```

- [ ] **Step 6: Assert the stamping in the existing test**

In `backend/src/tests/event-fixtures.test.ts`, inside the test `generates 15 fixtures for 8 teams and creates only the group matches`, change the matches assertion block to also check format and duration. Replace:

```ts
    const matches = await db
      .selectFrom('matches')
      .select(['tier', 'status'])
      .where('event_id', '=', eventId)
      .execute()
    expect(matches).toHaveLength(12)
    for (const m of matches) {
      expect(m.tier).toBe('amateur')
      expect(m.status).toBe('scheduled')
    }
```

with:

```ts
    const matches = await db
      .selectFrom('matches')
      .select(['tier', 'status', 'format', 'duration_minutes'])
      .where('event_id', '=', eventId)
      .execute()
    expect(matches).toHaveLength(12)
    for (const m of matches) {
      expect(m.tier).toBe('amateur')
      expect(m.status).toBe('scheduled')
      // Inherited from the event so the rating engine can weight a short game.
      expect(m.format).toBe('5-a-side')
      expect(m.duration_minutes).toBe(12)
    }
```

- [ ] **Step 7: Verify**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports/backend && npx tsc --noEmit
cd /Users/advaitchoudhary/Documents/compete/allsports
for i in 1 2; do
  DATABASE_URL="postgresql://allsports:password@localhost:5433/allsports_test" \
    REDIS_URL="redis://localhost:6380" npm --workspace backend run test 2>&1 | grep -E "Test Files|Tests "
done
```

Expected: 0 type errors; **95 tests, 9 files**, both times.

- [ ] **Step 8: Commit**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
git add backend/migrations/015_match_duration.sql backend/src/shared/db/types.ts backend/src/modules/events/bracket/generator.ts backend/src/modules/events/bracket/resolver.ts backend/src/tests/event-fixtures.test.ts
git commit -m "feat(rating): record match format and duration for weighting"
```

---

### Task 2: Weight K by match duration in the engine

**Files:**
- Modify: `rating-engine/algorithms/base.py`
- Modify: `rating-engine/consumer.py`
- Modify: `rating-engine/tests/test_algorithms.py`

**Interfaces:**
- Consumes: `matches.duration_minutes` from Task 1.
- Produces:
  - `MATCH_WEIGHT_FLOOR = 0.25` and `REFERENCE_MINUTES = 90.0` in `algorithms/base.py`
  - `def match_weight(duration_minutes: float | None) -> float`
  - `elo_delta(..., weight: float = 1.0)` — the default keeps every existing caller behaving identically.

- [ ] **Step 1: Write the failing tests**

In `rating-engine/tests/test_algorithms.py`, add `match_weight` to the imports from `algorithms.base`:

```python
from algorithms.base import (
    compute_star_rating,
    elo_delta,
    match_weight,
    blend_overall,
    compute_form_rating,
    WIN_BONUS,
    CLEAN_SHEET_BONUS,
    MIDFIELD_CLEAN_SHEET_BONUS,
)
```

And append this class at the end of the file:

```python
class TestMatchWeight:
    """
    A short game carries less information, so it must move Elo less.
    The backwards-compatibility guard is the important one here: every match
    recorded before duration existed must keep its exact previous behaviour.
    """

    def test_a_full_match_has_full_weight(self):
        assert match_weight(90) == 1.0

    def test_missing_duration_is_treated_as_a_full_match(self):
        # THE compatibility guard: existing rows have no duration.
        assert match_weight(None) == 1.0

    def test_a_long_match_does_not_exceed_full_weight(self):
        assert match_weight(120) == 1.0

    def test_a_short_match_is_floored_not_zeroed(self):
        # 12/90 = 0.13, below the floor, so it clamps to 0.25 rather than
        # making a tournament result count for almost nothing.
        assert match_weight(12) == 0.25
        assert match_weight(1) == 0.25

    def test_a_mid_length_match_scales_linearly(self):
        assert abs(match_weight(45) - 0.5) < 1e-9

    def test_weight_is_monotonic(self):
        weights = [match_weight(d) for d in (5, 20, 45, 60, 90)]
        assert weights == sorted(weights)

    def test_elo_delta_defaults_to_unweighted(self):
        # No weight argument must reproduce the pre-Phase-4a delta exactly.
        assert elo_delta(50.0, 50.0, 1.0, 10, 1.0, 5.0) == elo_delta(
            50.0, 50.0, 1.0, 10, 1.0, 5.0, 1.0
        )

    def test_a_short_match_moves_elo_less_than_a_full_one(self):
        full = elo_delta(50.0, 50.0, 1.0, 10, 1.0, 5.0, match_weight(90))
        short = elo_delta(50.0, 50.0, 1.0, 10, 1.0, 5.0, match_weight(12))
        assert abs(short) < abs(full)
        # Floor is 0.25, so the short game should be a quarter of the full one.
        assert abs(short - full * 0.25) < 1e-9

    def test_weighting_preserves_direction(self):
        # A win must still gain and a loss must still drop, however short.
        assert elo_delta(50.0, 50.0, 1.0, 10, 1.0, 5.0, match_weight(12)) > 0
        assert elo_delta(50.0, 50.0, 0.0, 10, 1.0, 5.0, match_weight(12)) < 0
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports/rating-engine
/Users/advaitchoudhary/.local/share/virtualenvs/Desktop-grGLEN5t/bin/pytest tests/ -q
```

Expected: FAIL at collection — `ImportError: cannot import name 'match_weight'`.

- [ ] **Step 3: Implement the weight**

In `rating-engine/algorithms/base.py`, add to the Elo+ constants block (next to `ELO_SCALE`):

```python
# ── Match weight ────────────────────────────────────────────────────────────
# A 12-minute 5-a-side carries far less information than a 90-minute match, so it
# must not move Elo as much. Applied to K — NOT to the tier blend, which is a
# separate quantity and would double-count. See spec §3.5.
REFERENCE_MINUTES = 90.0   # a full match
MATCH_WEIGHT_FLOOR = 0.25  # a very short game still counts for something
```

Add this function next to `k_factor`:

```python
def match_weight(duration_minutes: float | None) -> float:
    """
    How much a single result should count, from its duration.

    A missing duration means the match predates the column, so it is treated as a
    full 90 minutes — every rating computed before this existed stays identical.
    """
    if duration_minutes is None:
        return 1.0
    try:
        minutes = float(duration_minutes)
    except (TypeError, ValueError):
        return 1.0
    if minutes <= 0:
        return MATCH_WEIGHT_FLOOR
    return max(MATCH_WEIGHT_FLOOR, min(1.0, minutes / REFERENCE_MINUTES))
```

Then change `elo_delta` to accept and apply the weight:

```python
def elo_delta(
    rating: float,
    opponent_avg: float,
    actual: float,        # 1 win / 0.5 draw / 0 loss
    matches_played: int,
    margin: float,
    star: float,          # 0–10
    weight: float = 1.0,  # match weight (see match_weight); 1.0 = a full match
) -> float:
    """Tier-ladder Elo change. The star (which already carries the win bonus)
    nudges the team result into the Elo delta, and `weight` scales K down for a
    short game. Defaults to 1.0 so existing callers are unaffected."""
    expected = expected_score(rating, opponent_avg)
    effective = (actual - expected) + NUDGE * (star / 10.0 - 0.5)
    return k_factor(matches_played) * weight * mov_multiplier(margin) * effective
```

- [ ] **Step 4: Pass the weight from the consumer**

In `rating-engine/consumer.py`, add `match_weight` to the imports from `algorithms.base`:

```python
from algorithms.base import (
    compute_star_rating,
    elo_delta,
    match_weight,
    blend_overall,
    compute_form_rating,
)
```

Extend the match query to fetch the duration:

```python
    cur.execute("""
        SELECT home_team_id, away_team_id, winner_team_id, home_score, away_score, tier,
               duration_minutes
        FROM matches WHERE id = %s
    """, (match_id,))
```

Immediately after `tier = match["tier"] or "amateur"`, add:

```python
    # Short tournament games carry less information — scale K accordingly.
    weight = match_weight(match.get("duration_minutes"))
```

And pass it into the call:

```python
        delta = elo_delta(rating, opponent_avg, actual, matches_played, margin, star, weight)
```

- [ ] **Step 5: Run the tests**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports/rating-engine
/Users/advaitchoudhary/.local/share/virtualenvs/Desktop-grGLEN5t/bin/pytest tests/ -q
python3 -c "import ast; [ast.parse(open(f).read()) for f in ['consumer.py','main.py','algorithms/base.py']]; print('SYNTAX OK')"
```

Expected: **41 passed** (32 existing + 9 new); `SYNTAX OK`.

- [ ] **Step 6: Load the change into the running container and verify it boots**

The rating engine has no volume mount and the image can't be rebuilt (corporate TLS), so copy the files in:

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
docker cp rating-engine/algorithms/base.py allsports_rating_engine:/app/algorithms/base.py
docker cp rating-engine/consumer.py allsports_rating_engine:/app/consumer.py
docker compose restart rating-engine
sleep 8
curl -s -m 5 http://localhost:18000/health; echo
docker logs --tail 15 allsports_rating_engine 2>/dev/null | grep -iE "Traceback|ImportError|Error" | head -3
```

Expected: `{"status":"ok","service":"rating-engine"}` and no import errors.

- [ ] **Step 7: Commit**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
git add rating-engine/algorithms/base.py rating-engine/consumer.py rating-engine/tests/test_algorithms.py
git commit -m "feat(rating): weight Elo K by match duration"
```

---

### Task 3: Verify the weight end to end against real data

**Files:** none — verification only.

- [ ] **Step 1: Confirm generated tournament matches carry the duration**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports
docker exec allsports_postgres psql -U allsports -d allsports_dev -c \
  "SELECT round, format, duration_minutes, tier FROM matches WHERE event_id=(SELECT id FROM events WHERE name='Nine Team Cup') ORDER BY scheduled_at LIMIT 5;"
```

Expected: `format = 5-a-side`, `duration_minutes = 12` on matches generated after Task 1. Matches generated *before* it will show NULL — which is correct and, per the compatibility rule, weight 1.0.

- [ ] **Step 2: Prove the weight actually changes an Elo delta**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports/rating-engine
python3 - <<'PY'
from algorithms.base import elo_delta, match_weight
full  = elo_delta(50.0, 50.0, 1.0, 10, 2.0, 8.0, match_weight(90))
short = elo_delta(50.0, 50.0, 1.0, 10, 2.0, 8.0, match_weight(12))
none_ = elo_delta(50.0, 50.0, 1.0, 10, 2.0, 8.0, match_weight(None))
print(f"90-minute win : {full:+.2f}")
print(f"12-minute win : {short:+.2f}")
print(f"no duration   : {none_:+.2f}  (must equal the 90-minute value)")
assert abs(none_ - full) < 1e-9, "backwards compatibility broken"
assert abs(short) < abs(full)
print("OK — short games move Elo less; missing duration is unchanged")
PY
```

Expected: the 12-minute delta is a quarter of the 90-minute one, and the no-duration case matches the full-match value exactly.

- [ ] **Step 3: Full regression across both services**

```bash
cd /Users/advaitchoudhary/Documents/compete/allsports/backend && npx tsc --noEmit
cd /Users/advaitchoudhary/Documents/compete/allsports
DATABASE_URL="postgresql://allsports:password@localhost:5433/allsports_test" \
  REDIS_URL="redis://localhost:6380" npm --workspace backend run test 2>&1 | grep -E "Test Files|Tests "
cd rating-engine && /Users/advaitchoudhary/.local/share/virtualenvs/Desktop-grGLEN5t/bin/pytest tests/ -q | tail -2
```

Expected: 0 type errors; 95 backend tests; 41 rating-engine tests.

---

## Done criteria

1. Migration `015` applied to the test and dev databases.
2. Generated tournament matches carry `format` and `duration_minutes` from their event.
3. `match_weight(None) == match_weight(90) == 1.0` — existing ratings provably unaffected.
4. A 12-minute match produces exactly a quarter of the Elo delta of a 90-minute one.
5. 95 backend tests, 41 rating-engine tests, 0 type errors.
6. The rating engine boots with the change loaded and `/health` responds.

## Out of scope

The `TournamentScorecard` mobile screen (deferred to Phase 4b — it is the first mobile work in this effort and cannot be held to the same verification standard as the backend). Also out: the public bracket page (Phase 5), guest claiming (Phase 6), push notifications (Phase 7).

**No backend change is needed for the referee override** — `stats/batch → rating-suggestions → ratings(±4) → complete` already works, per spec §3.4.1. Phase 4b is UI sequencing only.

## Known risks

| Risk | Severity | Mitigation |
|---|---|---|
| Changing `elo_delta`'s signature breaks an existing caller | Low | `weight` defaults to 1.0, and a test asserts the no-argument call is identical to passing 1.0 |
| The floor of 0.25 may be too generous or too harsh for a 12-minute game | Low | It is a single named constant; retune once a real tournament's ratings can be inspected |
| Python changes need `docker cp` because the image can't be rebuilt | Medium | Documented in Task 2 Step 6. The underlying Docker CA-trust problem still blocks deployment and is tracked separately |
