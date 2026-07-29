# Rating Engine

Python 3.12 · FastAPI · SQS Consumer
Location: `rating-engine/`
Port: `8000`

---

## Start

```bash
cd rating-engine
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp ../.env.example .env
uvicorn main:app --reload
```

---

## Directory Structure

```
rating-engine/
├── algorithms/
│   ├── __init__.py    # sport-specific preprocessors (cricket, basketball)
│   └── base.py        # core Elo-like algorithm (sport-agnostic)
├── tests/
│   └── test_algorithms.py    # 16 unit tests
├── config.py          # pydantic settings (env vars)
├── consumer.py        # SQS polling loop + match processing
├── main.py            # FastAPI app + /preview endpoint
├── requirements.txt
└── Dockerfile
```

---

## Why Python, Why Separate

**Python**: Better ecosystem for numerical computation. `math`, `statistics`, and eventually `numpy`/`sklearn` if the algorithm is upgraded to ML. Clean mathematical code without TypeScript ceremony.

**Separate process**: Rating computation is CPU-bound and bursty — when a tournament ends, 20 matches complete in minutes. This service can scale horizontally without affecting the REST API. If it crashes, matches still save and stats still record. Ratings catch up when it recovers.

---

## `config.py`

Pydantic settings. Reads environment variables and validates them at startup. If `DATABASE_URL` is missing, the service refuses to start with a clear error — not a silent failure at query time.

```python
settings.database_url          # PostgreSQL connection
settings.redis_url             # Redis URL
settings.sqs_rating_queue_url  # Full SQS queue URL
settings.sqs_endpoint          # LocalStack endpoint (dev only)
```

---

## `algorithms/base.py` — The Core Algorithm

Three functions.

### `compute_performance_score(player_stats, sport_schema, opponent_avg_rating)`

Takes player stats for one match and returns a **performance score: 0–100**.

**Step 1 — Primary stats (positive contributions)**

Each sport defines `primary_metrics` in its `stat_schema` as `{stat: weight}`:
```json
{"goals": 3.0, "assists": 1.5, "clean_sheet": 2.0, "saves": 0.5}
```

For each stat:
1. Get the player's value (e.g., goals = 2)
2. Get the maximum threshold from `max_stat_thresholds` (e.g., goals max = 15)
3. Normalize: `min(value / max, 1.0)` → 2/15 = 0.133
4. Multiply by weight: 0.133 × 3.0 = 0.4
5. Sum all contributions

Scale the total to 0–80. The 20-point headroom is reserved for elite efficiency stats.

**Step 2 — Penalty stats (negative contributions)**

Sports define `penalty_metrics` as `{stat: weight}`:
```json
{"yellow_cards": -0.5, "red_cards": -2.0}
```

Same normalization process. The deduction is capped at 20 points maximum — even a red card + 3 yellows can't reduce score below 0.

**Step 3 — Efficiency stats (percentage bonuses)**

For basketball: FG%, 3-point%, FT%. Already percentages (0–100). Contribute up to 10 bonus points.

**Step 4 — Opposition strength modifier**

```python
opp_modifier = 0.75 + (opponent_avg_rating / 100.0) * 0.50
```

- Opponent average rating = 20 → modifier = 0.85 (weak opponent, same stats worth less)
- Opponent average rating = 50 → modifier = 1.00 (average, no change)
- Opponent average rating = 80 → modifier = 1.15 (strong opponent, same stats worth more)

Range: 0.75× to 1.25×.

This prevents leaderboard gaming by playing weak teams repeatedly. A hat-trick against a 20-rated team is worth less than a hat-trick against a 70-rated team.

---

### `compute_new_rating(old_rating, performance_score, matches_played)`

Elo-like update formula.

**K-factor** (how much a single match can change rating):

| Matches played | K-factor |
|----------------|----------|
| < 10 | 40 |
| 10–29 | 30 |
| 30–99 | 20 |
| 100+ | 10 |

New players change fast — their rating converges to their true level quickly. Veterans are stable — a single bad match doesn't tank 100 career matches of data.

**Formula:**
```python
expected = old_rating / 100.0        # how well we "expected" them to do
actual   = performance_score / 100.0  # how well they actually did

delta      = K × (actual - expected)
new_rating = old_rating + delta
new_rating = max(1.0, min(99.0, new_rating))  # hard floor/ceiling
```

**Example:**
```
Player at rating 60, performance score 80, 15 matches played → K = 30
expected = 0.60
actual   = 0.80
delta    = 30 × (0.80 - 0.60) = 30 × 0.20 = 6.0
new_rating = 60 + 6.0 = 66.0
```

**Example 2 (bad match):**
```
Player at rating 70, performance score 30, 50 matches played → K = 20
expected = 0.70
actual   = 0.30
delta    = 20 × (0.30 - 0.70) = 20 × -0.40 = -8.0
new_rating = 70 - 8.0 = 62.0
```

---

### `compute_form_rating(recent_performance_scores)`

Takes the last 5 performance scores. Returns a weighted average where recent matches carry more weight — exponential decay.

```python
scores  = [45, 55, 60, 70, 85]  # oldest to newest
weights = [e^(0.3×0), e^(0.3×1), e^(0.3×2), e^(0.3×3), e^(0.3×4)]
        = [1.0, 1.35, 1.82, 2.46, 3.32]
```

The most recent match (85) gets weight 3.32. The oldest (45) gets weight 1.0. The final form rating is pulled toward recent performance — correctly showing that a player who was on 45 but just played 85 is "in form."

---

## `algorithms/__init__.py` — Sport Preprocessors

Some sports need data transformation before hitting the base algorithm.

### Cricket preprocessor

```python
# Strike rate bonus
strike_rate = (runs / balls_faced) * 100
strike_rate_bonus = max(0, (strike_rate - 80) / 100)
# SR of 160 → bonus = 0.8. SR of 70 → no bonus (below threshold)

# Economy bonus (lower economy = better)
economy = runs_conceded / overs_bowled
economy_bonus = max(0, (10 - economy) / 10)
# Economy 5 → bonus = 0.5. Economy 11 → no bonus
```

### Basketball preprocessor

```python
fg_percentage  = (fg_made / fg_attempted) * 100
three_percentage = (three_made / three_attempted) * 100
ft_percentage  = (ft_made / ft_attempted) * 100
```

These computed percentages are then read by the base algorithm via `efficiency_metrics`.

### Other sports

Pass through unchanged. The base algorithm handles them directly from raw stats.

**To add a new sport:** Create a function in `SPORT_PREPROCESSORS` dict. The base algorithm needs no changes.

---

## `consumer.py` — SQS Polling Loop

This is the main process. A `while True` loop that polls SQS every 20 seconds.

### Why long polling (`WaitTimeSeconds=20`)

Instead of checking every second (100k API calls/day, expensive), the consumer tells SQS to wait up to 20 seconds for a message to arrive. This is called long polling. Cost goes from ~100k API calls/day to a few hundred.

### `process_match(match_id, sport_id, db_conn, redis_client)`

The full rating computation pipeline for one match:

**1. Load sport schema**
```sql
SELECT slug, stat_schema FROM sports WHERE id = ?
```
Gets the weights, thresholds, positions for this sport.

**2. Load player stats**
```sql
SELECT mps.user_id, mps.stats, mps.team_id,
       sp.current_rating, sp.matches_played, sp.career_stats
FROM match_player_stats mps
LEFT JOIN sport_profiles sp ON sp.user_id = mps.user_id AND sp.sport_id = ?
WHERE mps.match_id = ? AND mps.confirmed_by_captain = true
```
Only processes stats confirmed by captains. Players with no existing sport profile get `current_rating = 50` (neutral starting point).

**3. Compute team averages**
Groups players by team. For each player, the opponent's average rating is the average of all confirmed players on the other team. This is the opposition strength input.

**4. Per player — compute and write**

For each confirmed player:

```
preprocessed_stats = preprocess_stats(sport_slug, raw_stats)
perf_score         = compute_performance_score(preprocessed_stats, schema, opponent_avg)
new_rating         = compute_new_rating(old_rating, perf_score, matches_played)
recent_4           = [last 4 perf scores from rating_history]
form               = compute_form_rating(recent_4 + [perf_score])
career_stats       = old_career_stats + this_match_stats  # running totals
```

Then writes:
- **Upsert `sport_profiles`** — creates the row if it's the player's first match in this sport, otherwise updates `current_rating`, `form_rating`, `matches_played`, `career_stats`
- **Insert `rating_history`** — one immutable record: `rating_before`, `rating_after`, `performance_score`. Never updated.
- **Update `match_player_stats.match_rating`** — converts 0–100 performance score to 0–10 scale (divide by 10). This is the per-match rating shown on the match detail screen, like Sofascore's 7.4/10

**5. Publish to Redis**
```python
redis.publish(f"rating:{user_id}", json.dumps({
  "old_rating": 63.0,
  "new_rating": 67.2,
  "delta": 4.2,
  "match_rating": 7.8
}))
```
The real-time service picks this up and pushes it to the player's phone as a live notification.

**6. Invalidate cache**
```python
redis.delete(f"sp:{user_id}:{sport_id}")
```
The next time the app fetches this player's profile, it hits the database for fresh data instead of serving stale cached rating.

### Error Handling

If `process_match` raises an exception:
- The SQS message is NOT deleted
- After `VisibilityTimeout=120` seconds, SQS makes it visible again
- The consumer retries automatically
- This continues up to the dead-letter queue threshold (configurable in AWS)

If the consumer loop itself crashes, it logs the error and sleeps 5 seconds before retrying. It never exits.

---

## `main.py` — FastAPI App

Two endpoints plus startup hook.

**`GET /health`**
Returns `{"status": "ok"}`. Used by ECS health check.

**`POST /preview`**
Given stats and schema, returns what the rating would be without writing anything. The mobile app can call this while the scorer fills in stats to show a real-time rating preview.

```
Request:  { sport_slug, player_stats, current_rating, sport_schema, ... }
Response: { performance_score, new_rating, delta, match_rating }
```

**`@app.on_event("startup")`**
Spawns the SQS consumer in a daemon background thread when the FastAPI server starts. Both the HTTP server and the queue consumer run in the same process — the HTTP server handles `/preview` requests while the consumer background thread polls SQS.

---

## Tests

```bash
cd rating-engine && pytest tests/ -v
```

16 tests across 4 classes:

**`TestPerformanceScore`**
- Zero stats → low score
- Excellent stats → high score
- Red card penalizes
- Stronger opponent boosts same performance
- Score always stays in 0–100
- Cricket century scores well
- Basketball triple-double scores well

**`TestNewRating`**
- Good performance increases rating
- Poor performance decreases rating
- Rating stays within 1–99
- New players change faster than veterans
- Average performance gives minimal change

**`TestFormRating`**
- Empty input returns 50.0
- Recent scores weighted more than old scores
- Uses last 5 matches only (ignores older history)

**`TestPreprocessors`**
- Cricket computes strike rate bonus
- Basketball computes FG percentage
- Unknown sports pass through unchanged

---

## Adding a New Sport

1. Insert a row into the `sports` table with `stat_schema` defining `primary_metrics`, `penalty_metrics`, `max_stat_thresholds`, and `positions`
2. Optionally add a preprocessor in `algorithms/__init__.py` if the sport needs derived stats
3. Done. No other changes needed.
