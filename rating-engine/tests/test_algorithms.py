"""
Unit tests for the rating algorithm.
Run: pytest tests/ -v
"""

import pytest
from algorithms.base import (
    compute_performance_score,
    compute_new_rating,
    compute_form_rating,
)
from algorithms import preprocess_stats

FOOTBALL_SCHEMA = {
    "primary_metrics": {"goals": 3.0, "assists": 1.5, "tackles": 0.2, "saves": 0.5, "clean_sheet": 2.0},
    "penalty_metrics": {"yellow_cards": -0.5, "red_cards": -2.0},
    "efficiency_metrics": {},
    "max_stat_thresholds": {"goals": 15, "assists": 10, "tackles": 20, "saves": 20},
}

CRICKET_SCHEMA = {
    "batting_metrics": {"runs": 1.0, "fours": 0.2, "sixes": 0.5},
    "bowling_metrics": {"wickets": 3.0, "maidens": 0.5},
    "primary_metrics": {"runs": 1.0, "wickets": 3.0, "fours": 0.2, "sixes": 0.5, "maidens": 0.5},
    "penalty_metrics": {},
    "efficiency_metrics": {},
    "max_stat_thresholds": {"runs": 300, "wickets": 10, "fours": 20, "sixes": 10, "maidens": 6},
}

BASKETBALL_SCHEMA = {
    "primary_metrics": {"points": 1.0, "rebounds": 0.8, "assists": 1.0, "steals": 1.5, "blocks": 1.5},
    "penalty_metrics": {"turnovers": -0.5, "fouls": -0.3},
    "efficiency_metrics": {"fg_percentage": 0.5, "three_percentage": 0.5, "ft_percentage": 0.3},
    "max_stat_thresholds": {"points": 60, "rebounds": 25, "assists": 20, "steals": 10, "blocks": 10},
}


class TestPerformanceScore:

    def test_zero_stats_gives_low_score(self):
        stats = {"goals": 0, "assists": 0, "tackles": 0}
        score = compute_performance_score(stats, FOOTBALL_SCHEMA, 50.0)
        assert score < 20, "Zero stats should produce a low performance score"

    def test_excellent_stats_give_high_score(self):
        stats = {"goals": 3, "assists": 2, "tackles": 8, "clean_sheet": 0}
        score = compute_performance_score(stats, FOOTBALL_SCHEMA, 50.0)
        assert score > 50, f"Excellent stats should produce score > 50, got {score}"

    def test_red_card_penalizes_score(self):
        good_stats = {"goals": 1, "assists": 1, "red_cards": 0}
        bad_stats  = {"goals": 1, "assists": 1, "red_cards": 1}
        good_score = compute_performance_score(good_stats, FOOTBALL_SCHEMA, 50.0)
        bad_score  = compute_performance_score(bad_stats, FOOTBALL_SCHEMA, 50.0)
        assert good_score > bad_score, "Red card should reduce performance score"

    def test_strong_opposition_boosts_score(self):
        stats = {"goals": 1, "assists": 0}
        low_opp_score  = compute_performance_score(stats, FOOTBALL_SCHEMA, 20.0)
        high_opp_score = compute_performance_score(stats, FOOTBALL_SCHEMA, 80.0)
        assert high_opp_score > low_opp_score, "Same performance vs stronger opponent should score higher"

    def test_score_always_in_valid_range(self):
        extreme_stats = {"goals": 999, "assists": 999, "tackles": 999}
        score = compute_performance_score(extreme_stats, FOOTBALL_SCHEMA, 100.0)
        assert 0 <= score <= 100, f"Score must be 0-100, got {score}"

        zero_stats = {}
        score = compute_performance_score(zero_stats, FOOTBALL_SCHEMA, 0.0)
        assert 0 <= score <= 100

    def test_cricket_century_scores_well(self):
        stats = preprocess_stats("cricket", {"runs": 100, "balls_faced": 85, "fours": 8, "sixes": 3})
        score = compute_performance_score(stats, CRICKET_SCHEMA, 50.0)
        assert score > 45, f"A cricket century should produce a high score, got {score}"

    def test_basketball_triple_double(self):
        raw_stats = {
            "points": 25, "rebounds": 10, "assists": 10,
            "steals": 2, "blocks": 1, "turnovers": 3, "fouls": 2,
            "fg_made": 9, "fg_attempted": 18,
            "three_made": 3, "three_attempted": 7,
            "ft_made": 4, "ft_attempted": 4,
        }
        stats = preprocess_stats("basketball", raw_stats)
        score = compute_performance_score(stats, BASKETBALL_SCHEMA, 50.0)
        assert score > 55, f"Triple double should produce a strong score, got {score}"


class TestNewRating:

    def test_great_performance_increases_rating(self):
        new_r = compute_new_rating(50.0, 80.0, 10)
        assert new_r > 50.0, "High performance should increase rating"

    def test_poor_performance_decreases_rating(self):
        new_r = compute_new_rating(70.0, 20.0, 10)
        assert new_r < 70.0, "Poor performance should decrease rating"

    def test_rating_stays_in_1_to_99(self):
        # Push rating to extremes
        r = compute_new_rating(99.0, 100.0, 200)
        assert r <= 99.0
        r = compute_new_rating(1.0, 0.0, 200)
        assert r >= 1.0

    def test_new_player_changes_faster(self):
        # New player (5 matches) vs veteran (200 matches), same performance
        new_delta   = abs(compute_new_rating(50.0, 90.0, 5)   - 50.0)
        vet_delta   = abs(compute_new_rating(50.0, 90.0, 200) - 50.0)
        assert new_delta > vet_delta, "New players should have higher K-factor (change more per match)"

    def test_average_performance_gives_minimal_change(self):
        # Performance score = current rating → small change
        new_r = compute_new_rating(50.0, 50.0, 30)
        assert abs(new_r - 50.0) < 3, f"Average performance should change rating minimally, got {new_r}"


class TestFormRating:

    def test_empty_returns_default(self):
        assert compute_form_rating([]) == 50.0

    def test_recent_scores_weighted_more(self):
        # Scores improving over time — form should reflect recent high scores
        scores = [30.0, 40.0, 50.0, 60.0, 80.0]  # recent = high
        form = compute_form_rating(scores)
        simple_avg = sum(scores) / len(scores)
        assert form > simple_avg, "Recent good form should produce higher form rating than simple average"

    def test_uses_last_5_only(self):
        many_low  = [10.0] * 20 + [90.0, 90.0, 90.0, 90.0, 90.0]
        form = compute_form_rating(many_low)
        assert form > 80.0, "Should use last 5 scores (all high), ignoring older low scores"


class TestPreprocessors:

    def test_cricket_computes_strike_rate_bonus(self):
        stats = preprocess_stats("cricket", {"runs": 60, "balls_faced": 30})  # SR = 200
        assert "strike_rate_bonus" in stats
        assert stats["strike_rate_bonus"] > 0

    def test_basketball_computes_fg_percentage(self):
        stats = preprocess_stats("basketball", {"fg_made": 8, "fg_attempted": 16})
        assert "fg_percentage" in stats
        assert abs(stats["fg_percentage"] - 50.0) < 0.1

    def test_unknown_sport_returns_unchanged(self):
        original = {"some_stat": 5}
        result = preprocess_stats("volleyball", original)
        assert result == original
