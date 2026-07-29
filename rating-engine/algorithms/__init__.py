# Sport-specific stat preprocessing before feeding into base algorithm

from typing import Any


def preprocess_cricket_stats(stats: dict[str, Any]) -> dict[str, Any]:
    """
    Cricket has batting + bowling in same match for all-rounders.
    We synthesize unified metrics from both.
    """
    processed = dict(stats)

    # Batting: strike rate bonus
    runs = float(stats.get("runs", 0))
    balls = float(stats.get("balls_faced", 0))
    if balls > 0:
        strike_rate = (runs / balls) * 100
        # SR above 150 is excellent, below 80 is poor
        processed["strike_rate_bonus"] = max(0, (strike_rate - 80) / 100)

    # Bowling: economy bonus (lower economy = better)
    runs_conceded = float(stats.get("runs_conceded", 0))
    overs = float(stats.get("overs_bowled", 0))
    if overs > 0:
        economy = runs_conceded / overs
        # Economy below 6 is good; scale bonus accordingly
        processed["economy_bonus"] = max(0, (10 - economy) / 10)

    return processed


def preprocess_basketball_stats(stats: dict[str, Any]) -> dict[str, Any]:
    """
    Compute shooting percentages from made/attempted pairs.
    """
    processed = dict(stats)

    fg_made = float(stats.get("fg_made", 0))
    fg_att = float(stats.get("fg_attempted", 1))
    processed["fg_percentage"] = (fg_made / fg_att * 100) if fg_att > 0 else 0

    three_made = float(stats.get("three_made", 0))
    three_att = float(stats.get("three_attempted", 1))
    processed["three_percentage"] = (three_made / three_att * 100) if three_att > 0 else 0

    ft_made = float(stats.get("ft_made", 0))
    ft_att = float(stats.get("ft_attempted", 1))
    processed["ft_percentage"] = (ft_made / ft_att * 100) if ft_att > 0 else 0

    return processed


SPORT_PREPROCESSORS = {
    "cricket": preprocess_cricket_stats,
    "basketball": preprocess_basketball_stats,
}


def preprocess_stats(sport_slug: str, stats: dict[str, Any]) -> dict[str, Any]:
    preprocessor = SPORT_PREPROCESSORS.get(sport_slug)
    if preprocessor:
        return preprocessor(stats)
    return stats
