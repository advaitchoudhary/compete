"""
The "Elo+" rating model.

Two separate numbers come out of a match, and keeping them separate is the whole
point of this design:

  * The **Elo rating** (0–100) is system-owned and derives from the *result* —
    win/draw/loss against the opponent average, scaled by margin of victory, with
    a K-factor that shrinks as a player accumulates matches. Held per tier
    (amateur / semi_pro / pro / legends) in the tier_ratings ladder, then blended
    into one headline number by tier weight and volume. See `elo_delta` and
    `blend_overall`.

  * The **star rating** (0–10) is the human-facing "recognition" number computed
    from a player's own stats on top of a position baseline (a keeper is judged on
    saves and clean sheets, a striker on goals). A referee may adjust it within
    hard bounds. It feeds Elo only indirectly, as a nudge — so a referee can never
    move Elo directly, which is what keeps the ladder trustworthy. See
    `compute_star_rating`.

Every sport supplies a stat_schema from the database:
  - primary_metrics:      {stat: weight}    positive contributions
  - penalty_metrics:      {stat: weight}    negative (cards, turnovers)
  - efficiency_metrics:   {stat: weight}    ratio stats (FG%, pass accuracy)
  - max_stat_thresholds:  {stat: max}       normalisation ceilings
"""

from typing import Any
import math


# ════════════════════════════════════════════════════════════════════
# Elo+ model (v1) — per-tier Elo, blended overall, star rating, margin
# ════════════════════════════════════════════════════════════════════

# A 12-minute 5-a-side carries far less information than a 90-minute match, so it
# must not move Elo as much. Applied to K — NOT to the tier blend, which is a
# separate quantity and would double-count. See spec §3.5.
REFERENCE_MINUTES = 90.0   # a full match
MATCH_WEIGHT_FLOOR = 0.25  # a very short game still counts for something

ELO_SCALE = 20.0          # sensitivity on the 0–100 rating range
NUDGE = 0.6               # how much the star (individual) shifts the team result
CONTRIB_SCALE = 1.5       # weighted-stat performance added ON TOP of the position baseline
WIN_BONUS = 1.5           # flat rating bump for every player on the winning team
GK_CLEAN_SHEET_BONUS = 2.5        # keeper: a clean sheet is the most he can do
CLEAN_SHEET_BONUS = 2.0          # back line on a clean sheet
MIDFIELD_CLEAN_SHEET_BONUS = 1.0  # smaller share for midfielders (they help defend)

# Star rating starts from a position baseline ("you did your job"), then
# performance is added. GK 5, defenders 4, everyone else 3.
POSITION_BASELINE = {
    "GK": 5.0,
    "CB": 4.0, "LB": 4.0, "RB": 4.0, "CDM": 4.0,
}
DEFAULT_BASELINE = 3.0

# Clean-sheet reward tiers: back line gets the full bonus, midfield a share.
BACKLINE_POSITIONS = frozenset({"CB", "LB", "RB"})
MIDFIELD_POSITIONS = frozenset({"CDM", "CM", "CAM"})

# Overall-blend tier weights (higher tier counts more)
TIER_WEIGHT = {"amateur": 1.0, "semi_pro": 1.5, "pro": 2.0, "legends": 3.0}

# Per-MATCH "great game" benchmarks (NOT season maxes). Used to normalize the
# star rating. Tunable; per-position weighting is a known follow-up.
STAR_BENCH = {
    # football
    "goals": 2.0, "assists": 2.0, "shots_on_target": 3.0, "shots": 4.0,
    "tackles": 5.0, "interceptions": 4.0, "saves": 5.0, "passes": 40.0, "clean_sheet": 1.0,
    # basketball
    "points": 25.0, "rebounds": 10.0, "steals": 3.0, "blocks": 3.0,
    # cricket
    "runs": 50.0, "fours": 6.0, "sixes": 3.0, "wickets": 3.0, "maidens": 2.0, "catches": 2.0,
    # badminton
    "sets_won": 2.0, "points_won": 21.0, "smashes": 10.0, "aces": 5.0,
}


def expected_score(rating: float, opponent_avg: float) -> float:
    """Elo expected result (0–1) given your rating vs the opponent average."""
    return 1.0 / (1.0 + 10 ** ((opponent_avg - rating) / ELO_SCALE))


def k_factor(matches_played: int) -> float:
    """Cold-start: move fast early, stabilise as the player matures."""
    if matches_played < 5:
        return 32.0
    if matches_played < 15:
        return 24.0
    if matches_played < 40:
        return 16.0
    return 10.0


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


def mov_multiplier(margin: float) -> float:
    """Margin-of-victory multiplier, 1.0 (margin ≤1) … 1.5 (margin ≥6)."""
    return 1.0 + 0.1 * min(max(abs(margin) - 1, 0), 5)


# Keeper-only stats — used to infer a goalkeeper when no position is recorded.
GK_STATS = ("saves", "goals_conceded", "clean_sheet")


def compute_star_rating(
    player_stats: dict[str, Any],
    sport_schema: dict[str, Any],
    position: str | None = None,
    won: bool = False,
    clean_sheet: bool = False,
) -> float:
    """
    0–10 'man of the match' star — the flat, referee-approvable rating.
    Position baseline (GK 5, defenders 4, others 3) + weighted performance,
    + CLEAN_SHEET_BONUS for the keeper & back line, + flat WIN_BONUS for the
    winning team. This star is what later feeds Elo (via the nudge).

    clean_sheet is a team-level fact (the player's team conceded 0).
    """
    pos = (position or "").upper()

    # Goalkeeper — baseline 5, shaped by saves / clean sheet / goals conceded.
    if pos == "GK" or (pos == "" and any(k in player_stats for k in GK_STATS)):
        saves = float(player_stats.get("saves", 0) or 0)
        conceded = float(player_stats.get("goals_conceded", 0) or 0)
        gk_clean = clean_sheet or bool(player_stats.get("clean_sheet")) or (
            "goals_conceded" in player_stats and conceded == 0
        )
        star = POSITION_BASELINE["GK"] + min(saves * 0.3, 3.0) - min(conceded * 0.5, 3.0)
        if gk_clean:
            star += GK_CLEAN_SHEET_BONUS
    else:
        # Outfield (incl. defenders): position baseline + weighted performance.
        baseline = POSITION_BASELINE.get(pos, DEFAULT_BASELINE)

        metrics: dict[str, float] = dict(sport_schema.get("primary_metrics", {}))
        for grp in ("batting_metrics", "bowling_metrics", "fielding_metrics"):
            metrics.update(sport_schema.get(grp, {}))
        thresholds = sport_schema.get("max_stat_thresholds", {})

        raw = 0.0
        for stat, weight in metrics.items():
            val = float(player_stats.get(stat, 0) or 0)
            bench = STAR_BENCH.get(stat) or float(thresholds.get(stat, 0)) or 1.0
            raw += weight * min(val / bench, 1.2)

        for stat, weight in sport_schema.get("efficiency_metrics", {}).items():
            raw += weight * (float(player_stats.get(stat, 0) or 0) / 100.0)

        pen = 0.0
        for stat, weight in sport_schema.get("penalty_metrics", {}).items():
            pen += abs(weight) * float(player_stats.get(stat, 0) or 0)

        star = baseline + CONTRIB_SCALE * raw - 0.3 * pen

        # Clean-sheet reward: full for the back line, a share for midfield.
        if clean_sheet:
            if pos in BACKLINE_POSITIONS:
                star += CLEAN_SHEET_BONUS
            elif pos in MIDFIELD_POSITIONS:
                star += MIDFIELD_CLEAN_SHEET_BONUS

    if won:
        star += WIN_BONUS

    return round(max(0.0, min(10.0, star)), 1)


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


def blend_overall(tier_rows: list[tuple[str, float, int]]) -> float:
    """
    Headline 'Elo number' = blend of per-tier ratings, weighted by
    tier weight × volume-confidence (matches/(matches+5)). A regular
    semi-pro therefore out-blends a flukey pro.

    tier_rows: list of (tier, rating, matches_played).
    """
    num = 0.0
    den = 0.0
    for tier, rating, matches in tier_rows:
        w = TIER_WEIGHT.get(tier, 1.0) * (matches / (matches + 5.0))
        num += rating * w
        den += w
    return round(num / den, 2) if den > 0 else 50.0


def compute_form_rating(recent_performance_scores: list[float]) -> float:
    """
    Weighted average of last N performance scores.
    More recent matches carry higher weight (exponential decay).
    """
    if not recent_performance_scores:
        return 50.0

    scores = recent_performance_scores[-5:]  # last 5 only
    n = len(scores)
    weights = [math.exp(0.3 * i) for i in range(n)]   # exponential: latest has highest weight
    total_weight = sum(weights)

    weighted_sum = sum(s * w for s, w in zip(scores, weights))
    return round(weighted_sum / total_weight, 2)
