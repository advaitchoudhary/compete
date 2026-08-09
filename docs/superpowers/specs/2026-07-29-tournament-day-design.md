# Tournament Day — Design Spec

**Date:** 2026-07-29
**Status:** Approved, ready for implementation planning
**Scope:** Phase 1 of repositioning AllSports as a league/tournament operating system

---

## 1. Product decision

AllSports is a **league and tournament operating system**, sold first to **turf and venue owners** who run single-day football tournaments.

Three decisions frame everything below:

| Decision | Choice | Why |
|---|---|---|
| Core strategy | League/tournament OS | An organizer is a *bulk* cold-start: one deal brings ~80 players, 8 teams and 2–3 referees. Organizers already have referees, which dissolves the referee-supply problem without weakening rating integrity. |
| Sport focus | Football only, aggressively | Other sports stay in the schema but are hidden from the UI. Enables football-specific depth without genericising. Reversible. |
| Business stage | Pre-launch, zero real users | Goal is one real tournament with one real turf owner. Payments deferred; cash collected at the gate. |

### The target loop

1. **Saturday** — turf owner creates "Sunday Cup", 8 teams, 5-a-side, ₹2000/team. Shares a link.
2. **Registration** — captains register teams and type in player names. Most are unregistered → guest users.
3. **Sunday morning** — organizer taps *Generate fixtures*. Groups, semis and final are created with time slots, pitches and referees.
4. **Match day** — assigned referee taps goals/assists/saves. Ending a match auto-advances the winner.
5. **Sideline** — anyone opens a public link, no login: live bracket, live scores, top scorer.
6. **Evening** — every player rated. Guests get a claim link: "You scored 2 goals today, rating 68. Claim your profile."

Steps 5 and 6 are the acquisition loop and are in scope precisely because they convert the event's spectators and guests into users.

### Explicitly out of scope

Multi-week leagues, in-app payments, video/highlights, chat, non-football sports, scouting/Talent Hunt.

---

## 2. Current-state facts this design depends on

Verified against the running database and source on 2026-07-29:

- `users.role` is constrained to `player | referee | admin` — **no organizer role exists**.
- `POST /events` is gated by `requireAuth` only — **any logged-in player can create a tournament**, while creating a single match requires an approved referee tier. This inversion is fixed here.
- `matches.home_team_id` and `matches.away_team_id` are both **NOT NULL** — and this design deliberately keeps them that way (see §3.3).
- `matches.routes.ts` uses `innerJoin` on `teams` for both sides at lines 89, 90, 117 and 118, so a NULL team id would **silently drop rows** from the match list and detail endpoints.
- `mobile/src/types/tournament.ts` declares `MatchSummary.home_team_id` and `home_team_name` as non-nullable `string`.
- `matches` has `event_id`, `round`, `tier`, `referee_id` but **no `format` or `duration_minutes`**.
- `events` already allows `format IN (knockout, league, round_robin, group_knockout, casual)` and has `entry_fee`, `prize_pool`, `max_teams`, `rules`.
- `event_teams` already has `seed`, `group_no`, `points` — but nothing ever writes `points`.
- `referee_applications.request_type` is constrained to `initial | upgrade`.
- `users` already has `is_guest`, `created_by`, `claimed_at`, `referee_tier`.
- `sports.stat_schema` for football already contains `formats: [5-a-side, 7-a-side, 11-a-side]` and `match_stats` including `goals`, `assists`, `saves`, `clean_sheet`.
- `backend/src/modules/notifications/` is an **empty directory**. No FCM, no `expo-notifications`, no push token storage anywhere.
- `events` and `follows` tables have **0 rows**. Tournaments are untested code.
- Existing migrations run `001`–`008`; new work starts at `009`.

---

## 3. Architecture

Eight units, each independently useful and testable.

### 3.1 Organizer identity

Add `organizer` to the `users.role` check constraint and extend `referee_applications.request_type` to accept `organizer`. This reuses the admin review queue, the approve/reject endpoints and the admin screen already built for referees — one workflow serves both.

`POST /events` changes from `requireAuth` to `requireRole('organizer', 'admin')`, closing the open front door.

**Permission boundary — the core integrity rule:**

> An organizer may **create** events and **schedule** matches. An organizer may **never** score a match. Scoring remains restricted to the tier-approved referee assigned to that specific match, enforced by the existing `assertMatchReferee`.

New table `event_referees` holds the referees working an event. The organizer selects from already-approved referees; the fixture generator stamps each generated match with one of them. No new scoring rights are created anywhere.

```
event_referees (event_id, user_id, pitch_label, added_at)
  PK (event_id, user_id)
```

`pitch_label` lets the generator keep a referee on one pitch all day.

#### 3.1.1 Event tier authority — the anti-fraud mechanism

**This is the single most load-bearing rule in the design.** Tier drives rating weight (amateur 1.0 → legends 3.0 in the blended overall Elo), so whoever controls tier controls the ladder.

Today that authority sits entirely with referees: `matches.routes.ts:41-53` refuses to create a match above the creating referee's own `referee_tier` via `canOfficiate`. A referee cannot inflate beyond their verified standing.

**Phase 3 would break this.** The fixture generator creates matches on the *organizer's* command, and organizers have no tier. Left unaddressed, an organizer could declare a `legends` tournament and inflate 80 players' ratings at 3.0× weight. Nothing is inflated today only because events have no tier at all.

**Rule (decided 2026-07-29): an event's tier may not exceed the LOWEST `referee_tier` among its assigned referees.**

Every match in a pro tournament must be officiated at pro level, so the weakest assigned referee constrains the whole tournament. This deliberately reuses the referee authority chain rather than inventing a new one, and it produces the right real-world gate: **to run a pro tournament you must recruit pro referees.**

```
events.tier  TEXT NOT NULL DEFAULT 'amateur'
  CHECK (tier IN ('amateur','semi_pro','pro','legends'))
```

Defaulting to `amateur` means an unspecified tournament is always the lowest-weight one, never the highest — matching how `matches.tier` already behaves.

**Three enforcement points, defence in depth:**

1. **Setting the tier** (`PATCH /events/:id/tier`) — validated against the referees currently assigned.
2. **Assigning referees** (`POST /events/:id/referees`) — rejected if the new roster would drop the floor below the event's current tier. Otherwise an organizer could set `pro` with pro referees, then swap them for amateurs.
3. **Fixture generation** — every generated match is re-checked against its own assigned referee using the existing `canOfficiate`. This is the real guarantee: even if 1 and 2 were bypassed, no match can be created above its referee's standing.

**Tier is not settable at creation.** An event has no referees yet at that moment, so `POST /events` always starts at `amateur`; raising it requires assigning qualifying referees first. This avoids a guaranteed-fail code path and teaches the model through use.

**Tier freezes at fixture generation.** Once fixtures exist the tier is immutable, so an organizer cannot run an amateur tournament and re-declare it `legends` afterwards to retroactively reweight ratings already computed from it.

**Edge cases:**
- An event with **zero** assigned referees supports `amateur` only.
- Assigned **admins** are treated as unrestricted and excluded from the floor calculation (they already bypass tier gating everywhere else).
- A referee with a NULL `referee_tier` cannot officiate at all (`canOfficiate` returns false for null), so their presence holds the event at `amateur`.

**Rejected alternative:** giving organizers their own `organizer_tier` ladder. It adds a second admin approval queue, and on its own it would still permit an amateur referee to officiate a pro match — so it is strictly weaker than this rule, not an alternative to it. It can be layered on later if organizers need tier standing independent of the referees they can book.

### 3.2 Team self-registration with guests

Captains register their own teams via the event link. Guest players are the **primary** path here, not an edge case — expect 60%+ of a roster to be unregistered.

`POST /v1/events/:id/register` accepts a team name and a player list. Each player is either an existing `user_id` (found via the existing `/users/search`) or a bare name, which creates a guest via the existing guest-player flow. The endpoint creates the team, its `team_members`, and the `event_teams` row in one transaction.

Registration is allowed only while `events.status = 'registration'` and while `count(event_teams) < max_teams`.

### 3.3 Fixture generation and bracket progression

`POST /v1/events/:id/fixtures` — organizer-only, idempotent-guarded (refuses if fixtures already exist), runs in one transaction.

**Supported formats:** `knockout` and `group_knockout`. `league`/`round_robin` remain in the DB constraint but are rejected by this endpoint.

**Team counts (decided 2026-07-31): no count is ever turned away.** A real turf tournament gets whatever turns up — nine teams, or five. An earlier draft restricted this to 8/12/16, which was a convenience, not a requirement.

**`knockout` works for any N ≥ 2** via a play-in round, with byes to the top seeds:

```
P = largest power of two ≤ N
play-in matches = N − P
byes            = N − 2(N − P)
```

| N | Shape | Total matches |
|---|---|---|
| 5 | 1 play-in, 3 byes → semis → final | 4 |
| 6 | 2 play-ins, 2 byes → semis → final | 5 |
| 9 | 1 play-in, 7 byes → quarters → semis → final | 8 |

**`group_knockout` requires EQUAL group sizes.** Groups of unequal size have played a different number of matches, so their points are not comparable — and filling a bracket needs a "best runner-up" comparison across groups. Real tournaments patch this with points-per-game or by discarding results against the bottom team; both are arbitrary and neither is explainable to a team that goes out on it. Requiring equal groups makes the comparison genuinely fair, so this constraint is a fairness property rather than a simplification.

Group count targets groups of 4, falling back to 3: `G = ceil(N / 4)`, accepted only if `N % G == 0`.

| N | Groups | Qualify | Total matches |
|---|---|---|---|
| 6 | 2 × 3 | top 2 → semis | 6 + 3 = 9 |
| 8 | 2 × 4 | top 2 → semis | 12 + 3 = 15 |
| 9 | 3 × 3 | 3 winners + best runner-up → semis | 9 + 3 = 12 |
| 12 | 3 × 4 | 3 winners + best runner-up → semis | 18 + 3 = 21 |
| 16 | 4 × 4 | top 2 → quarters | 24 + 7 = 31 |

Qualifier count is the largest power of two that is ≤ `2 × G` and ≤ `N`, minimum 2.

**When N cannot form equal groups** (a prime count such as 5, 7, 11, 13) the endpoint does **not** fail — it generates a `knockout` instead and says so in the response, so the organizer understands why their bracket looks different.

**Seeding:** by `event_teams.seed` where set, otherwise random, snake-distributed across groups so seeds spread rather than cluster.

**No third-place match** (decided 2026-07-31): losing semi-finalists go home. One less match and a shorter day.

**Points:** 3 for a win, 1 for a draw, 0 for a loss. Group matches may be drawn. **Knockout matches must be decisive** — the referee records the penalty result as the final score; there is no shootout modelling.

**Scheduling inputs** (decided 2026-07-31), so the generator can assign `scheduled_at`:
- **Pitch count** = the number of distinct `pitch_label` values on `event_referees`. Derived rather than stored, so it can never disagree with the referees actually assigned.
- **Slot length** = new `events.match_duration_minutes` column, which Phase 4 also needs for rating match-weight.
- **Kickoff** = the existing `events.starts_at`.

Slots are assigned round-robin across pitches. **Rest gap rule: a team must have at least one full slot free between its own matches.** Generation fails loudly rather than emitting a schedule that violates it.

Each fixture is stamped with `referee_id` from `event_referees` for its pitch, plus `round`, `slot_no`, `pitch_label` and `scheduled_at`.

**Regeneration** (decided 2026-07-31): permitted while **every** match for the event is still `scheduled` — it deletes those matches and all fixtures, then rebuilds. Once any match has started or completed, generation is final. This resolves a contradiction in an earlier draft, which promised re-seeding "by deleting fixtures with a NULL `match_id`" while also creating `matches` rows for every group fixture immediately, leaving nothing deletable. Teams withdrawing an hour before kickoff is normal at these events, so a recovery path is required.

**Progression — the `event_fixtures` model.**

A knockout slot must exist before its teams are known. Rather than making `matches.home_team_id`/`away_team_id` nullable, the bracket lives in its own table and **`matches` is left completely untouched**:

```sql
event_fixtures (
  id            uuid PRIMARY KEY,
  event_id      uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  round         text NOT NULL,        -- 'group_a' | 'quarter' | 'semi' | 'final' | 'third_place'
  slot_no       integer NOT NULL,     -- ordering within the round (SF1, SF2)
  pitch_label   text,
  scheduled_at  timestamptz,
  referee_id    uuid REFERENCES users(id),

  home_source   jsonb NOT NULL,       -- how this side resolves
  away_source   jsonb NOT NULL,

  home_team_id  uuid REFERENCES teams(id),   -- nullable, but on a NEW table
  away_team_id  uuid REFERENCES teams(id),

  match_id      uuid UNIQUE REFERENCES matches(id),   -- set once both teams are known

  created_at, updated_at
)
```

`home_source` / `away_source` take one of three shapes:

| Shape | Meaning |
|---|---|
| `{"type":"team","team_id":"…"}` | Known at generation time (group stage) |
| `{"type":"winner_of","fixture_id":"…"}` | Winner of an earlier fixture |
| `{"type":"group_position","group":"A","pos":1}` | Group qualifier |

**Lifecycle.** The generator creates all 16 fixtures in one transaction. Group fixtures already know both teams, so they immediately create their `matches` rows and set `match_id`. Knockout fixtures sit with `match_id` NULL. When a match completes, `finalizeMatch()` calls a **resolver** that finds fixtures whose sources are now satisfied, fills their team ids, creates the real `matches` row, and links it.

Whenever the resolver (or the generator) creates a `matches` row it copies across: `event_id`, `round`, `referee_id`, `scheduled_at`, `venue`, plus `tier` from `events.tier` and `format` / `duration_minutes` from `events.match_format` and `events.match_duration_minutes`. The last two are what §3.5 needs to weight the rating correctly, so they must be stamped at creation, not backfilled.

**Every created match must pass `canOfficiate(assignedReferee.referee_tier, match.tier)` — the third and final enforcement point of §3.1.1.** If any generated match would exceed its assigned referee's standing, the whole generation transaction is refused with an error naming the referee and the tier. This is what makes tier inflation impossible even if the earlier checks were bypassed, so it is a hard requirement of the generator, not a nicety.

**Why a separate table rather than nullable columns.** A *fixture* is a slot in a competition structure; a *match* is a game between two known teams. They have genuinely different lifecycles — group fixtures resolve instantly, knockout fixtures resolve across six hours — and conflating them is what forces the nullable columns.

The concrete cost of the nullable approach, measured on 2026-07-29: **78 references to `home_team_id`/`away_team_id` across 13 files** (35 backend, 10 rating engine, 33 mobile), including **four `innerJoin`s on `teams`** at `matches.routes.ts:89,90,117,118`. An `innerJoin` against a NULL id does not error — it **silently drops the row**, so `GET /matches` and `GET /matches/:id` would quietly stop returning any placeholder fixture, with no exception and no log line. `mobile/src/types/tournament.ts` additionally declares `home_team_id` and `home_team_name` as non-nullable `string`, so the UI would render `undefined` in place of a team name.

With `event_fixtures`, all 78 references keep working unchanged, the four `innerJoin`s stay correct, the rating engine never sees a half-formed match, and mobile's `MatchSummary` type is untouched.

**Two properties this buys for free:** the public bracket page needs placeholders ("Winner of SF1") and can read them directly instead of reconstructing them; and the organizer can re-generate or re-seed the bracket before kickoff by deleting fixtures with a NULL `match_id` — impossible if the bracket lives inside `matches`.

**Drift risk and its containment.** Two tables can disagree about what is scheduled. Contained by the `UNIQUE` constraint on `match_id` and by making the resolver the **sole** creator of tournament `matches` rows. `POST /matches` remains for standalone non-event matches only.

**Rejected alternative:** a sentinel "TBD" team row with a fixed UUID. It preserves the NOT NULL constraints but pollutes `teams`, and that fake team eventually surfaces in leaderboards, player search and stats queries.

**Standings.** `event_teams` gains the columns a real league table needs:

```
played, won, drawn, lost, goals_for, goals_against  (all integer not null default 0)
```

`points` already exists. Updated inside `finalizeMatch()` for group-stage matches only. Tie-break order: **points → goal difference → goals for → head-to-head**.

Head-to-head applies **only to two-way ties**. A three-or-more-way tie surviving goals-for falls back to `event_teams.seed` ascending, which is deterministic and explainable to an organizer standing on the pitch. No coin flips, no random ordering.

### 3.4 Fast tournament scoring

A tournament day is 16 matches with ~90 seconds between whistles. The existing `RefereeScorecard` collects positions plus every schema metric — far too slow, and slow entry produces skipped or fabricated data, which is worse than less data.

New `TournamentScorecard` collects exactly four things: **goals, assists, saves, clean sheet**. Both rosters side by side, large tap targets, running score derived from goals. A *Review* action then reveals the algorithm's star suggestions for referee approval (see §3.4.1), and *End match* completes the match and advances the winner. Target: under 45 seconds of stat entry, plus the review glance.

Reuses the existing `POST /matches/:id/stats/batch`, `POST /matches/:id/rating-suggestions`, `POST /matches/:id/ratings` and `POST /matches/:id/complete` endpoints — all four already exist. Clean sheet is derived team-level, as the rating engine already does.

Position is optional here. When absent, the engine's existing GK stat-inference fallback applies.

#### 3.4.1 Referee rating override — per match, immediately after the whistle

**Decision (2026-07-29): the referee reviews and overrides star ratings for a match right after that match, before ending it. Deferred or batched review is explicitly rejected.** Reviewing while the game is still fresh in the referee's mind is the point — an hour later they will not remember who was quietly excellent.

The override already exists and works end to end; only the mobile UI was never built:

| Piece | Where |
|---|---|
| `POST /matches/:id/rating-suggestions` | `scores.routes.ts:160` — stores the algorithm's `suggested_rating` per player |
| `POST /matches/:id/ratings` | `scores.routes.ts:199` — accepts a referee value within **±4** of the suggestion |
| `RATING_BOUND = 4` | `scores.routes.ts:22` |
| `suggested_rating`, `rating_overridden` | `match_player_stats`, migration 007 |

**No backend change is required, and `finalizeMatch()` is not touched.** The existing endpoint order already produces exactly this flow, because `POST /matches/:id/ratings` is only rejected once the match is `completed` — so review naturally belongs before completion:

```
1. POST /matches/:id/stats/batch        goals · assists · saves · clean sheet
2. POST /matches/:id/rating-suggestions algorithm's 0–10 per player
3. POST /matches/:id/ratings            referee's adjustments, each within ±4
4. POST /matches/:id/complete           locks ratings, advances the bracket, enqueues Elo
```

This is the single most important reason match completion must stay the last step: it is what locks the ratings.

**The UI must make four calls feel like one screen.** `TournamentScorecard` is a single view, not a wizard:

- The referee taps in goals/assists/saves as the match runs.
- On the final whistle they hit *Review* — the screen calls `stats/batch` then `rating-suggestions` and re-renders in place, each player's row now showing the suggested 0–10 with a compact `−`/`+` control and the permitted range.
- Every value is pre-filled with the algorithm's suggestion, so **doing nothing is a valid, correct action.** The referee only touches the two or three players they disagree with.
- *End match* then fires `ratings` followed by `complete` as one user action.

So it is two taps plus any adjustments, not four steps.

**Known risk — the time budget.** This is the one real cost of reviewing per match: 16 matches at ~90 seconds between whistles now includes a glance at ~12 star ratings. Mitigations are pre-filled suggestions (no input required to proceed), large tap targets, and out-of-range values being impossible to enter rather than rejected after the fact. If it proves too slow with a real referee at a real tournament, the lever to pull is reducing what §3.4 collects — not moving the review later.

**Context on how much the override still carries:** it was introduced because keepers and defenders scored absurdly low. Position baselines, the GK baseline of 5 and the tiered clean-sheet bonuses have since fixed that at the source. So it now functions as a trust mechanism over a system-owned ladder rather than as a bug workaround — which is why pre-filled defaults that the referee usually accepts unchanged is the right interaction, and why the ±4 bound is enough to keep Elo honest.

### 3.5 Rating weight for short matches

A 12-minute 5-a-side decided by one goal must not move Elo like a 90-minute match. Without this, one tournament injects 16 low-information results at full weight and scrambles the ladder.

```
matches.format            text null   -- '5-a-side' | '7-a-side' | '11-a-side'
matches.duration_minutes  integer null
```

The rating engine multiplies **K** by a duration-derived weight:

```
match_weight = clamp(duration_minutes / 90, MATCH_WEIGHT_FLOOR, 1.0)
K_effective  = K × match_weight
```

with `MATCH_WEIGHT_FLOOR = 0.25`. A null `duration_minutes` defaults to 90 → weight 1.0, so **all existing matches and ratings are unaffected**.

**Design rationale.** The weight belongs in K, not in the tier blend. Tier weight is deliberately kept out of K to avoid double-counting (it applies only in the overall blend). Match weight is a different quantity — how much information a single result carries — so K is its correct home. Duration alone is the knob; format is recorded for display and stat interpretation but does not separately scale the weight, avoiding a second overlapping multiplier.

### 3.6 Public bracket page

The acquisition surface: ~80 players and a few hundred sideline spectators converging on one URL.

`GET /v1/public/events/:id` — **no authentication**. Returns event meta, group standings, the bracket tree, live scores and top scorers. Names only; no phone numbers, no user ids beyond what a claim link needs. Rate-limited separately from authenticated routes.

Rendered at Expo web route `/e/[id]`, reusing the React Native codebase via `react-native-web`. Live updates ride the existing Socket.IO/Redis bridge.

**Dependencies:** production hosting needs `expo export --platform web` on a static host — new infra work. If more than one realtime instance is ever run, the Socket.IO Redis adapter (step 3 of the infra plan, currently not started) becomes a hard prerequisite or cross-instance score broadcasts will silently drop.

### 3.7 Guest claiming

Closes the loop: a guest played, was rated, and now has a reason to install.

A signed, short-lived JWT carrying the guest `user_id` forms a claim URL. Claiming attaches credentials to the existing row in place and flips `is_guest` to false — the promote-in-place model already chosen — so all `match_player_stats`, `rating_history`, `tier_ratings` and `sport_profiles` rows carry over untouched. `users.claimed_at` is the one-time-use guard, so **no token table is needed**.

**Delivery:** the link is shared by the captain from their own phone via WhatsApp/SMS. Guests have no app, so push cannot reach them; server-sent SMS would mean gateway cost and DLT registration in India before there is a single paying customer.

### 3.8 Push notifications

Built from zero — the module directory is currently empty.

`expo-notifications` in the app registers a token on login to `POST /v1/push/register`, stored in `push_tokens (user_id, token, platform, device_id, created_at)` with a unique constraint on `token`. The backend sends via `expo-server-sdk`, which needs no FCM or APNs credentials initially.

Every send also persists a row to `notifications` for in-app history, finally giving that empty module a purpose.

Phase 1 triggers, all tournament-day:

| Trigger | Audience | Timing |
|---|---|---|
| `fixtures_published` | every registered player in the event | on generate |
| `match_next` | both rosters of the upcoming match | ~10 min before slot |
| `rating_ready` | every player in the event | after last match completes |

Guests are excluded from all push (no app, no token) — they receive the WhatsApp claim link instead.

---

## 4. Migrations

| # | Phase | File | Contents |
|---|---|---|---|
| 009 | 1 ✅ | `009_organizer_role.sql` | `users.role` += `organizer`; `referee_applications.request_type` += `organizer` |
| 010 | 1 ✅ | `010_event_referees.sql` | `event_referees` table |
| 011 | 2 | `011_event_tier_and_format.sql` | `events` += `tier` (NOT NULL DEFAULT `'amateur'`, see §3.1.1), `match_format` |
| 012 | 3 | `012_event_match_duration.sql` | `events` += `match_duration_minutes` (slot length; Phase 4 needs it too) |
| 013 | 3 | `013_event_standings.sql` | `event_teams` += `played, won, drawn, lost, goals_for, goals_against` |
| 014 | 3 | `014_event_fixtures.sql` | `event_fixtures` table (bracket structure + source resolution + `match_id` link) |
| 015 | 4 | `015_match_duration.sql` | `matches` += `format`, `duration_minutes` |
| 016 | 7 | `016_push_notifications.sql` | `push_tokens`, `notifications` tables |

**No migration alters `matches` team columns.** The only change to `matches` is migration 015, which adds two nullable columns — additive and safe. This is a deliberate revision: an earlier draft made `home_team_id`/`away_team_id` nullable and was rejected once the blast radius was measured (see §3.3).

**Numbering note:** an earlier draft assigned `011` to standings. `011` is now the Phase 2 events migration, and everything after it shifted by one. `match_format` and `duration_minutes` become real columns rather than living inside the `events.rules` JSON blob as originally sketched — validated, typed and queryable.

---

## 5. Endpoints

**Changed**

| Endpoint | Change |
|---|---|
| `POST /v1/events` | `requireAuth` → `requireRole('organizer','admin')` |

**New**

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /v1/organizer/apply` | player | Apply to become an organizer (reuses `referee_applications`) |
| `POST /v1/events/:id/referees` | organizer | Assign approved referees + pitch labels. **Rejected if the new roster no longer supports the event's tier** (§3.1.1) |
| `GET /v1/events/:id/referees` | organizer | List them |
| `PATCH /v1/events/:id/tier` | organizer | Set the event's tier. Capped by the lowest assigned `referee_tier`; frozen once fixtures exist (§3.1.1) |
| `POST /v1/events/:id/register` | captain | Register a team with a roster incl. guests |
| `POST /v1/events/:id/fixtures` | organizer | Generate the full day's fixtures |
| `GET /v1/events/:id/fixtures` | any auth | Bracket + standings |
| `GET /v1/public/events/:id` | **none** | Public bracket, standings, live scores, top scorers |
| `POST /v1/guests/:id/claim-link` | captain of the guest's team, organizer, referee or admin | Mint a signed claim URL |
| `POST /v1/auth/claim` | none (token) | Claim a guest profile in place |
| `POST /v1/push/register` | any auth | Store an Expo push token |
| `GET /v1/notifications` | any auth | In-app notification history |

The existing admin approve/reject endpoints extend to flip `role` to `organizer` when `request_type = 'organizer'`.

---

## 6. Error handling

- **Fixture generation** is a single transaction. Any failure rolls back entirely — no half-built brackets. Re-running when fixtures exist returns 409.
- **Insufficient referees**: generation refuses with a clear error naming how many referees are needed for the pitch count.
- **Team count**: generation refuses when team count is not supported by the chosen format (e.g. `group_knockout` needs a count divisible into equal groups).
- **The resolver is idempotent** — re-completing a match must not double-advance a winner or double-count standings. It refuses to fill an `event_fixtures` slot that already holds a team, and refuses to create a second `matches` row for a fixture that already has `match_id` set (enforced at the DB level by `UNIQUE(match_id)`).
- **Unresolved fixtures are not startable.** A fixture with a NULL `match_id` has no match to start; the referee simply cannot see it in their queue yet. This falls out of the model rather than needing a guard.
- **Draws in knockout**: Phase 1 requires the referee to record a decisive result (penalties entered as the final score). No shootout modelling.
- **Push failures** never block a request — send is fire-and-forget with failures logged; expired Expo tokens are pruned on receipt of a `DeviceNotRegistered` receipt.
- **Public endpoint** is rate-limited independently and returns 404 (not 403) for non-existent or unpublished events, leaking nothing.

---

## 7. Testing

- **Fixture generator** — unit tests per format and team count (8/12/16), asserting match count, no team playing twice in a slot, rest gaps honoured, every match has a referee.
- **Resolver** — completing a semi fills the correct final slot and creates its `matches` row; re-completing the same match does not double-advance or create a second match; a fixture with one slot filled stays unresolved.
- **Standings** — table maths and the full tie-break chain, including a two-way head-to-head tie and a three-way tie falling back to seed order.
- **Isolation guarantee** — with unresolved fixtures present in an event, `GET /matches`, `GET /matches/:id` and the rating consumer behave exactly as before. This is the test that proves the `event_fixtures` choice paid off.
- **Rating weight** — a null `duration_minutes` reproduces today's Elo deltas exactly (backwards-compatibility guard); a 12-minute match produces a delta at the floor weight.
- **Tier authority (§3.1.1)** — the highest-value tests in this design. An event with no referees accepts only `amateur`; raising the tier above the lowest assigned `referee_tier` is refused; swapping in a lower-tier referee after setting a high tier is refused; the generator refuses to create any match exceeding its assigned referee's standing; and the tier cannot be changed once fixtures exist.
- **Override ordering** — the per-match review must happen before completion: a referee value within ±4 is accepted while the match is live, the same call returns 409 once the match is `completed`, an out-of-range value is rejected, and the Elo consumer uses the referee's saved star rather than the algorithm's suggestion.
- **Guest claim** — claiming carries all rating history over; a second claim with the same token fails.
- **End-to-end** — seed an 8-team event, register teams with guests, generate, score all 16 matches, assert standings, bracket, ratings and the public payload.

---

## 8. Build order

1. Organizer role + `event_referees` + close the `POST /events` gate
2. Team self-registration with guests
3. `event_fixtures` + fixture generation + resolver + standings
4. Fast tournament scoring + rating match-weight
5. Public bracket page
6. Guest claim flow
7. Push notifications

Seven phases. Phases 1–4 are the minimum that lets a turf owner run a real tournament; 5 and 6 are the acquisition loop and should not be deferred past the first real event, since a tournament without them generates no users.

An earlier draft had eight phases, with an isolated high-risk migration phase for making team ids nullable. Adopting `event_fixtures` removed that phase entirely.

---

## 9. Known risks

| Risk | Severity | Mitigation |
|---|---|---|
| `event_fixtures` and `matches` drift out of sync | Medium | `UNIQUE(match_id)`; the resolver is the sole creator of tournament matches; `POST /matches` reserved for standalone matches |
| Resolver double-advances a winner on match re-completion | Medium | Resolver is idempotent — it refuses to fill a slot that is already populated, mirroring the rating consumer's idempotency guard |
| Rating engine has no volume mount; local Docker builds are blocked by corporate TLS interception | Medium | `docker cp` + restart for local iteration; fix Docker CA trust before deploying |
| Public web page needs new static hosting | Medium | `expo export --platform web`; decide host during Phase 6 |
| Socket.IO Redis adapter absent | Medium | Single realtime instance only until infra step 3 lands |
| Backend has pre-existing `tsc --noEmit` type debt | Low | Runs fine under `tsx`; clean up opportunistically |
| Organizer sales is relationship-heavy with a build-before-demo gap | Medium (business) | Phases 1–4 are the minimum demonstrable slice; target one design-partner turf owner |
