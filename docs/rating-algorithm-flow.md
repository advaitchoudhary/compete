# Rating Algorithm — Full Flow Reference

> The single place to settle any doubt about **how a player's rating is
> computed**, end to end. Covers the data flow (who calls what, in what order)
> and the exact math (every formula and constant), with a worked example from
> real data.
>
> Source of truth in code:
> - [`rating-engine/algorithms/base.py`](../rating-engine/algorithms/base.py) — the math
> - [`rating-engine/consumer.py`](../rating-engine/consumer.py) — the live pipeline
> - [`rating-engine/main.py`](../rating-engine/main.py) — `/suggest` + `/preview` HTTP
> - [`rating-engine/algorithms/__init__.py`](../rating-engine/algorithms/__init__.py) — per-sport stat preprocessing
> - [`backend/src/modules/scores/scores.routes.ts`](../backend/src/modules/scores/scores.routes.ts) — stat entry, suggestions, override, finalize
> - [`backend/src/modules/users/users.routes.ts`](../backend/src/modules/users/users.routes.ts) — how the app reads ratings back

---

## 0. The mental model in one paragraph

Every player has a **separate Elo per (sport, tier)** — e.g. an amateur-football
ladder and a semi-pro-football ladder are independent numbers. A match only
moves the **one ladder** it was played at. The **headline "Elo number"** you see
in the app is a **confidence-weighted blend** of all of a player's ladders for
that sport. Each match also produces a **0–10 star rating** ("man of the match"),
which the referee can override; that star both feeds the Elo update (as a nudge)
and is shown on the scorecard. All ratings live on a **0–100 scale, clamped to
[1, 99], starting at 50**.

```
 raw stats ──► star (0–10) ──► Elo delta on ONE tier ladder ──► blend all ladders ──► headline Elo
                  ▲                                                                        │
            referee may override                                                    shown in app
```

---

## 1. The three numbers (don't confuse them)

| Number | Scale | Where it lives | Meaning |
|---|---|---|---|
| **Star / match rating** | 0–10 (1 dp) | `match_player_stats.match_rating` | Per-match individual performance ("man of the match"). Referee-overridable. |
| **Performance score** | 0–100 | `rating_history.performance_score` | Just `star × 10`. Stored for the form trail. |
| **Elo rating** | 0–100, clamped [1,99] | `tier_ratings.rating` (per tier) and `sport_profiles.current_rating` (blended headline) | Long-running skill estimate. 50 = average. |

`ratingTone()` in the mobile theme keys the colors/labels off the Elo:
`≥85 ELITE · ≥70 EXCELLENT · ≥58 STRONG · ≥45 STEADY · ≥32 RISING · else ROOKIE`.

---

## 2. End-to-end flow (who does what, in order)

### Step 1 — Stat entry (backend, live match)
The referee enters per-player stats through the app.
`POST /matches/:id/stats` (or `/stats/batch` for offline sync) upserts rows into
`match_player_stats` (`user_id`, `team_id`, `stats` JSON, `position`).
Score is updated via `PATCH /matches/:id/score`.

### Step 2 — (Optional) Rating suggestions
`POST /matches/:id/rating-suggestions` → backend calls the engine
`POST /matches/:id/suggest`. The engine computes a **star** for each player
(`compute_star_rating`) using current stats + score, and persists it to
`match_player_stats.suggested_rating`. Returns the suggestions + the `bound` (±4).

### Step 3 — (Optional) Referee override ("the eye test")
`POST /matches/:id/ratings` with `{ratings:[{user_id, rating}]}`.
Each value must be within **±4** (`RATING_BOUND`) of the suggestion, else `400`.
Sets `match_player_stats.match_rating` and `rating_overridden = true`.
Locked once the match is completed.

### Step 4 — Finalize the match
Either the referee `POST /matches/:id/complete`, or **both** captains
`POST /matches/:id/confirm`. Both paths run `finalizeMatch()`:
- decides `winner_team_id` from the score (`decideWinner`),
- sets match `status = 'completed'`,
- flips every stat row to `confirmed_by_captain = true`,
- **enqueues a rating job to SQS** (`enqueueRatingJob({match_id, sport_id, …})`),
- updates team W/L/D, emits feed events + achievements, publishes a realtime
  `match_completed` event.

> The backend never computes Elo itself — it only enqueues. All rating math
> happens asynchronously in the engine.

### Step 5 — The engine consumes the job
`consumer.py:run_consumer()` long-polls SQS. For each message it calls
`process_match(match_id, sport_id)` (detailed in §4). On success the SQS message
is deleted; on exception it's left to reappear after the 120s visibility timeout
(automatic retry). The consumer runs as a **background thread** started by the
FastAPI app (`main.py @app.on_event("startup")`).

### Step 6 — The app reads it back
`GET /users/:id/stats/:sport` returns `current_rating` (headline),
`form_rating`, `matches_played`, `wins`, the per-tier `tier_ratings`, and the
last 10 `rating_history` rows (each with its match's `tier`). The mobile
ProfileHero / FormCard / Form Tracker render these.

---

## 3. The math (every formula)

All of this is in [`base.py`](../rating-engine/algorithms/base.py). The **live**
model is the "Elo+ v1" set of functions (`compute_star_rating`, `elo_delta`,
`blend_overall`, `compute_form_rating`). See §6 for the legacy preview model.

### 3.1 Stat preprocessing
Before scoring, sport-specific derived metrics are added
([`algorithms/__init__.py`](../rating-engine/algorithms/__init__.py)):
- **Cricket** — `strike_rate_bonus` from runs/balls, `economy_bonus` from runs_conceded/overs.
- **Basketball** — `fg_percentage`, `three_percentage`, `ft_percentage` from made/attempted pairs.
- **Football / badminton** — passthrough (no preprocessing).

### 3.2 Star rating — `compute_star_rating(stats, schema, position, won, clean_sheet) → 0–10`
The "man of the match" number. Built from a **position baseline** ("you did your
job") plus weighted performance, plus bonuses.

**Position baseline:** GK `5.0`; CB/LB/RB/CDM `4.0`; everyone else `3.0`.

**Goalkeeper branch** (position `GK`, or no position but GK-only stats present):
```
star = 5.0 + min(saves × 0.3, 3.0) − min(goals_conceded × 0.5, 3.0)
       + 2.5 if clean sheet (GK_CLEAN_SHEET_BONUS)
```

**Outfield branch:**
```
raw = Σ over metrics  weightᵢ × min(statᵢ / benchᵢ, 1.2)      # capped at 1.2× a "great game"
    + Σ over efficiency  weightᵢ × (statᵢ / 100)
pen = Σ over penalties  |weightᵢ| × statᵢ

star = baseline + 1.5 × raw − 0.3 × pen                       # CONTRIB_SCALE = 1.5
       + clean-sheet bonus: backline (CB/LB/RB) +2.0, midfield (CDM/CM/CAM) +1.0
```

**Then for everyone:** `+1.5 if won` (`WIN_BONUS`), and finally
`clamp(star, 0, 10)` rounded to 1 dp.

- `benchᵢ` comes from `STAR_BENCH` (per-match "great game" benchmarks, e.g.
  football `goals=2, assists=2, tackles=5, saves=5`), falling back to the
  schema threshold then `1.0`.
- `metrics` = `primary_metrics` ∪ (`batting/bowling/fielding_metrics` for cricket).

### 3.3 Expected result — `expected_score(rating, opponent_avg) → 0–1`
Classic logistic Elo on the 0–100 scale:
```
E = 1 / (1 + 10^((opponent_avg − rating) / 20))             # ELO_SCALE = 20
```
- Even matchup (gap 0) → `E = 0.5`.
- +20 rating edge → `E ≈ 0.91` (10× win odds). +40 → `E ≈ 0.99` (100×).
- `opponent_avg` = mean **pre-match** rating of the opposing team's players on the
  match's tier ladder (default 50 if unknown).

### 3.4 K-factor — `k_factor(matches_played)`
How fast a rating can move (max swing/game). Cold-start fast, stabilize later:
```
< 5 games → 32 | < 15 → 24 | < 40 → 16 | 40+ → 10
```

### 3.5 Margin-of-victory multiplier — `mov_multiplier(margin)`
```
MOV = 1 + 0.1 × min(max(|margin| − 1, 0), 5)     # 1.0 (margin ≤1) … 1.5 (margin ≥6)
```
`margin` = absolute difference of the deciding score key
(`goals`/`points`/`runs`/`sets_won`).

### 3.6 The Elo delta — `elo_delta(rating, opp, actual, matches, margin, star)`
**This is the core update.**
```
effective = (actual − E)  +  0.6 × (star/10 − 0.5)          # NUDGE = 0.6
delta     = k_factor(matches) × mov_multiplier(margin) × effective
```
- `actual` = **1** win / **0.5** draw / **0** loss.
- `(actual − E)` = the **surprise**: how much better the result was than expected.
- `0.6 × (star/10 − 0.5)` = the **performance nudge**: above-average play (star>5)
  adds, below-average subtracts, exactly 5 is neutral. (See `NUDGE` in glossary.)

New ladder rating: `clamp(rating + delta, 1, 99)` rounded to 2 dp.

### 3.7 Blended headline — `blend_overall(tier_rows) → Elo`
Weighted average across a player's tier ladders:
```
wₜ      = TIER_WEIGHT[tier] × matches/(matches + 5)          # prestige × confidence
Elo     = Σ(ratingₜ × wₜ) / Σ wₜ                             # default 50 if no ladders
```
- **Tier weight:** amateur `1.0`, semi_pro `1.5`, pro `2.0`, legends `3.0`
  (higher tiers count more).
- **Confidence `m/(m+5)`:** a low-volume ladder is discounted — ~5 games to reach
  half-trust. Stops a 1-game fluke from hijacking the headline.

### 3.8 Form rating — `compute_form_rating(recent_scores) → 0–100`
Exponentially-weighted average of the **last 5** performance scores
(`star × 10`), recent matches weighted higher:
```
weights = e^(0.3 × i) for i in 0..n-1   (latest highest)     # default 50 if none
form    = Σ(scoreᵢ × wᵢ) / Σ wᵢ
```

---

## 4. `process_match` — the consumer pipeline in detail

For a completed match (`consumer.py:process_match`):

1. **Idempotency.** If any `rating_history` row exists for this `match_id`, return
   immediately (SQS redelivery is a no-op).
2. **Load** the sport `slug` + `stat_schema`, the match (`teams`, `scores`,
   `tier`), and compute `margin`.
3. **Load confirmed rows** from `match_player_stats WHERE confirmed_by_captain = true`.
   (If none, log and bail.)
4. **Pre-match ratings.** For each player, read their `tier_ratings` row for this
   `(sport, tier)` → `(rating, matches_played, wins)`, default `(50, 0, 0)`.
5. **Team averages.** Group players by team, average their pre-match ratings →
   each side's `opponent_avg`.
6. **Per player:**
   - preprocess stats; determine `won` and `actual` (1/0.5/0); determine `clean` sheet.
   - **star** = `match_rating` if the referee set one, else `compute_star_rating(...)`.
   - `delta = elo_delta(rating, opponent_avg, actual, matches_played, margin, star)`.
   - `new_tier_rating = clamp(rating + delta, 1, 99)`.
   - **upsert `tier_ratings`** (rating set; `matches_played += 1`; `wins += won`).
   - **blend** across *all* this player's tier ladders → `overall`.
   - read `sport_profiles.current_rating` as `overall_before`; accumulate
     `career_stats` (sum of raw stats).
   - **form** = `compute_form_rating(last 4 performance_scores + star×10)`.
   - **upsert `sport_profiles`** (`current_rating = overall`, `form_rating = form`,
     `matches_played += 1`, `wins += won`, `career_stats`).
   - **insert `rating_history`** (`rating_before = overall_before`,
     `rating_after = overall`, `performance_score = star×10`). The `delta` column
     is generated: `rating_after − rating_before` (the **overall** move, which is
     what the app's ▲/▼ shows — *not* the tier delta).
   - **update `match_player_stats.match_rating = star`** (the final 0–10).
   - **Redis**: publish `rating:{uid}` (live update) and bust `sp:{uid}:{sport_id}` cache.
7. **Commit** the transaction.

> Key subtlety: the **tier delta** (from `elo_delta`) and the **overall delta**
> (stored in `rating_history.delta`) are different numbers. A big tier jump can
> produce a small headline move because the blend is volume-weighted.

---

## 5. Worked example — Devansh Iyer (real data)

Thunderbolts FC, won all three 3–2 (margin 1 → MOV 1.0). Rookie ⇒ K = 32 on each
ladder. New players/opponents start at 50.

### Match 1 — amateur, star 7.4
```
E         = 1/(1+10^((50−50)/20)) = 0.500
effective = (1 − 0.500) + 0.6×(7.4/10 − 0.5) = 0.5 + 0.144 = 0.644
delta     = 32 × 1.0 × 0.644 = 20.61
amateur:  50 → 70.61      headline (only ladder) = 70.61   ▲20.61
```

### Match 2 — semi_pro, star 8.0 (new ladder)
```
effective = (1 − 0.5) + 0.6×(8.0/10 − 0.5) = 0.5 + 0.18 = 0.68
delta     = 32 × 1.0 × 0.68 = 21.76
semi_pro: 50 → 71.76

blend: amateur 70.61×(1.0×1/6) + semi_pro 71.76×(1.5×1/6)
     = 11.77 + 17.94 = 29.71 ;  weights 0.1667+0.25 = 0.4167
headline = 29.71 / 0.4167 = 71.30        ▲0.69   (huge tier gain, tiny headline move!)
```

### Match 3 — amateur, star 6.8 (opponents slumped to avg ≈ 28)
```
E         = 1/(1+10^((28−70.61)/20)) ≈ 0.993      ← win is "expected", worth almost nothing
effective = (1 − 0.993) + 0.6×(6.8/10 − 0.5) = 0.007 + 0.108 = 0.115
delta     = 32 × 1.0 × 0.115 = 3.69               ← ~94% of this came from the star nudge
amateur:  70.61 → 74.30

blend: amateur 74.30×(1.0×2/7) + semi_pro 71.76×(1.5×1/6)
     = 21.23 + 17.94 = 39.17 ;  weights 0.2857+0.25 = 0.5357
headline = 39.17 / 0.5357 = 73.11        ▲1.81
```

**Final:** headline **73.11**, ladders **amateur 74.30 (2g) / semi_pro 71.76 (1g)**,
form **72.82**. Lesson: rookie + good star + even opponent = big jump (M1); a new
ladder pads a tier but the volume-weighted blend hides it (M2); once you're highly
rated and beating weak teams, only your star moves the needle (M3).

---

## 6. Two models live in the codebase

| | Live (match completion) | Legacy (preview/suggest helpers) |
|---|---|---|
| Functions | `compute_star_rating`, `elo_delta`, `blend_overall`, `compute_form_rating` | `compute_performance_score`, `compute_new_rating` |
| Used by | `consumer.process_match` (the real pipeline) | `main.py /preview`; `compute_performance_score` is **not** in the live path |
| Rating model | Per-tier Elo + star nudge + blend | Single rating, `delta = K × (perf/100 − rating/100)` |

`/suggest` uses `compute_star_rating` (the live star), so referee suggestions match
what the consumer will use. `/preview`'s `compute_new_rating` is the old
single-number Elo — handy for "what-if" but **not** how real ratings update.

---

## 7. Constants & defaults (quick table)

| Constant | Value | Role |
|---|---|---|
| `ELO_SCALE` | 20 | Logistic steepness (0–100 scale; chess uses 400) |
| `NUDGE` | 0.6 | Weight of individual star vs team result in the delta |
| `CONTRIB_SCALE` | 1.5 | Weighted performance added onto the star baseline |
| `WIN_BONUS` | 1.5 | Flat star bump for the winning team |
| `GK_CLEAN_SHEET_BONUS` | 2.5 | Keeper clean sheet |
| `CLEAN_SHEET_BONUS` | 2.0 | Backline clean sheet |
| `MIDFIELD_CLEAN_SHEET_BONUS` | 1.0 | Midfield clean sheet |
| `POSITION_BASELINE` | GK 5 / DEF 4 / else 3 | Star starting point |
| K-factor | 32 / 24 / 16 / 10 | <5 / <15 / <40 / 40+ games |
| MOV | 1.0 → 1.5 | Margin 1 → 6+ |
| `TIER_WEIGHT` | 1.0 / 1.5 / 2.0 / 3.0 | amateur / semi_pro / pro / legends |
| Confidence | `m/(m+5)` | Low-volume ladder discount |
| Rating clamp | [1, 99] | Soft floor/ceiling |
| Start rating | 50 | New player / tier / missing record |
| `RATING_BOUND` | ±4 | Referee override limit (in `scores.routes.ts`) |
| Form window | last 5, `e^0.3i` | Recency-weighted |

---

## 8. Glossary / FAQ

- **Is the Elo always out of 100?** Designed as 0–100, **clamped to [1, 99]**,
  centered at 50. It's a *rating*, not a percentage — 73 doesn't mean "73%".
- **What is `actual − expected`?** `actual` is the real result (1/0.5/0);
  `expected` (`E`) is the pre-match win probability from the rating gap.
  Their difference is the "surprise" that drives classic Elo.
- **What is the NUDGE?** The dial for how much individual play (the 0–10 star)
  bends the Elo result, on top of pure win/loss. At 0.6 it can swing the
  effective score by up to ±0.3. A player can win and still lose rating if their
  star is low enough on an already-expected win.
- **Why did a big tier jump barely move the headline?** The headline is a
  volume-weighted blend; a freshly-gained ladder enters with low confidence and,
  if it lands near the existing headline, contributes little (see M2 above).
- **Tier delta vs headline delta?** `elo_delta` moves *one ladder*;
  `rating_history.delta` records the *blended headline* move. They differ.
- **Idempotent?** Yes — `process_match` no-ops if `rating_history` already has a
  row for the match, so SQS redelivery is safe.

---

## 9. Tuning knobs (if you want to change behavior)

- **More/less swingy ratings overall** → K-factor tiers.
- **Reward blowouts more** → `mov_multiplier` slope / cap.
- **Individual play matters more vs team result** → `NUDGE`.
- **Top-end separation / spread** → the `[1, 99]` clamp + `ELO_SCALE` together.
- **Elite play counts more** → `TIER_WEIGHT`.
- **Trust low-volume ladders more/less** → the `+5` in `m/(m+5)`.
- **Star shape** → `POSITION_BASELINE`, `CONTRIB_SCALE`, `STAR_BENCH`, bonuses.
- **Referee freedom** → `RATING_BOUND` in `scores.routes.ts`.

Any change to `base.py` should be paired with a run of
`rating-engine/tests/test_algorithms.py`.
```
