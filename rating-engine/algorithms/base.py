"""
Sport-agnostic Elo-based rating algorithm.

Every sport defines its stat_schema in the database with:
  - primary_metrics: {stat_name: weight} — positive contributions
  - penalty_metrics: {stat_name: weight} — negative contributions (yellow cards, turnovers)
  - max_stat_thresholds: {stat_name: max_value} — for normalization
  - efficiency_metrics: {stat_name: weight} — ratio-based stats (FG%, pass accuracy)

The algorithm:
1. Compute base performance score (0-100) from weighted stats
2. Adjust for opposition strength
3. Apply Elo-like delta to existing rating
"""

from typing import Any
import math


def compute_performance_score(
    player_stats: dict[str, Any],
    sport_schema: dict[str, Any],
    opponent_avg_rating: float,
) -> float:
    """
    Returns a performance score in [0, 100].
    """
    thresholds = sport_schema.get("max_stat_thresholds", {})
    primary = sport_schema.get("primary_metrics", {})
    penalty = sport_schema.get("penalty_metrics", {})
    efficiency = sport_schema.get("efficiency_metrics", {})

    # --- Primary stats (positive) ---
    positive_score = 0.0
    positive_weight_total = sum(primary.values()) if primary else 1.0

    for stat, weight in primary.items():
        value = float(player_stats.get(stat, 0))
        max_val = float(thresholds.get(stat, 100))
        # Normalize: cap at threshold, then scale to 0-1
        normalized = min(value / max_val, 1.0) if max_val > 0 else 0.0
        positive_score += normalized * weight

    # Scale to 0-80 (leaving 20 points headroom for elite performance)
    if positive_weight_total > 0:
        positive_score = (positive_score / positive_weight_total) * 80
    else:
        positive_score = 0.0

    # --- Penalty stats (negative) ---
    penalty_score = 0.0
    for stat, weight in penalty.items():
        value = float(player_stats.get(stat, 0))
        max_val = float(thresholds.get(stat, 10))
        normalized = min(value / max_val, 1.0) if max_val > 0 else 0.0
        penalty_score += normalized * abs(weight)

    # Cap penalties at 20 points deduction
    penalty_score = min(penalty_score * 5, 20)

    # --- Efficiency stats (FG%, pass accuracy — only meaningful above 5+ attempts) ---
    efficiency_bonus = 0.0
    for stat, weight in efficiency.items():
        value = float(player_stats.get(stat, 0))
        # Already a percentage (0–100), scale contribution
        efficiency_bonus += (value / 100.0) * weight

    # Normalize efficiency bonus to 0-10
    eff_weight_total = sum(efficiency.values()) if efficiency else 1
    efficiency_bonus = (efficiency_bonus / eff_weight_total) * 10 if eff_weight_total else 0

    raw_score = positive_score - penalty_score + efficiency_bonus
    raw_score = max(0.0, min(100.0, raw_score))

    # --- Opposition strength modifier ---
    # Performing well against a 70-rated opponent is worth more than vs 30-rated
    # Modifier range: 0.75x (vs weak) to 1.25x (vs strong)
    opp_modifier = 0.75 + (opponent_avg_rating / 100.0) * 0.50

    final_score = raw_score * opp_modifier
    return round(max(0.0, min(100.0, final_score)), 2)


def compute_new_rating(
    old_rating: float,
    performance_score: float,
    matches_played: int,
) -> float:
    """
    Elo-like update.

    K-factor decreases as player matures (more data = more stable rating).
    New players (< 20 matches) change faster — large K factor.
    Veterans (100+ matches) change slowly — small K factor.
    """
    if matches_played < 10:
        k = 40
    elif matches_played < 30:
        k = 30
    elif matches_played < 100:
        k = 20
    else:
        k = 10

    expected = old_rating / 100.0
    actual = performance_score / 100.0
    delta = k * (actual - expected)

    new_rating = old_rating + delta
    # Soft floor/ceiling: ratings asymptotically approach limits
    new_rating = max(1.0, min(99.0, new_rating))
    return round(new_rating, 2)


# ════════════════════════════════════════════════════════════════════
# Elo+ model (v1) — per-tier Elo, blended overall, star rating, margin
# ════════════════════════════════════════════════════════════════════

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
) -> float:
    """Tier-ladder Elo change. The star (which already carries the win bonus)
    nudges the team result into the Elo delta."""
    expected = expected_score(rating, opponent_avg)
    effective = (actual - expected) + NUDGE * (star / 10.0 - 0.5)
    return k_factor(matches_played) * mov_multiplier(margin) * effective


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
