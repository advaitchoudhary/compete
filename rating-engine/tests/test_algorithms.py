"""
Unit tests for the Elo+ rating model.
Run: pytest tests/ -v

These cover the functions that are actually in the live pipeline:
  compute_star_rating  → the 0–10 referee-approvable number
  elo_delta            → the per-tier Elo change
  blend_overall        → the headline "Elo number" across tiers
  compute_form_rating  → recent-form weighting
  preprocess_stats     → per-sport derived stats

Most assertions are about *relationships* (more goals scores higher, a newcomer
moves faster than a veteran) rather than exact numbers, because the star
constants are explicitly tuneable. Where an absolute value is asserted, the
arithmetic is spelled out in a comment so a deliberate retune is easy to update
while an accidental sign flip still fails.
"""

import pytest

from algorithms.base import (
    compute_star_rating,
    elo_delta,
    blend_overall,
    compute_form_rating,
    WIN_BONUS,
    CLEAN_SHEET_BONUS,
    MIDFIELD_CLEAN_SHEET_BONUS,
)
from algorithms import preprocess_stats

# compute_star_rating rounds to 1 decimal place, so the difference between two
# star values can be off by a full rounding step in either direction. Comparing a
# *difference* against a constant therefore needs this tolerance, not a tighter
# one: e.g. a raw 5.25 rounds to 5.2 while 5.25 + 1.5 = 6.75 rounds to 6.8, a
# difference of 1.6 for a bonus of 1.5.
ROUNDING_TOLERANCE = 0.11

FOOTBALL_SCHEMA = {
    "primary_metrics": {"goals": 3.0, "assists": 1.5, "tackles": 0.2, "saves": 0.5, "clean_sheet": 2.0},
    "penalty_metrics": {"yellow_cards": -0.5, "red_cards": -2.0},
    "efficiency_metrics": {},
    "max_stat_thresholds": {"goals": 15, "assists": 10, "tackles": 20, "saves": 20},
}

CRICKET_SCHEMA = {
    "batting_metrics": {"runs": 1.0, "fours": 0.2, "sixes": 0.5},
    "bowling_metrics": {"wickets": 3.0, "maidens": 0.5},
    "primary_metrics": {},
    "penalty_metrics": {},
    "efficiency_metrics": {},
    "max_stat_thresholds": {"runs": 300, "wickets": 10, "fours": 20, "sixes": 10, "maidens": 6},
}


class TestStarRating:
    """The 0–10 star: position baseline + weighted contribution + bonuses."""

    def test_goalkeeper_clean_sheet_with_saves(self):
        # GK baseline 5.0 + (3 saves x 0.3) + clean-sheet 2.5, nothing conceded = 8.4
        star = compute_star_rating({"saves": 3, "goals_conceded": 0}, FOOTBALL_SCHEMA, position="GK")
        assert abs(star - 8.4) < 0.05, f"expected ~8.4, got {star}"

    def test_goalkeeper_conceding_scores_lower_than_clean_sheet(self):
        clean = compute_star_rating({"saves": 3, "goals_conceded": 0}, FOOTBALL_SCHEMA, position="GK")
        leaky = compute_star_rating({"saves": 3, "goals_conceded": 2}, FOOTBALL_SCHEMA, position="GK")
        assert clean > leaky

    def test_busy_goalkeeper_is_not_punished_for_doing_his_job(self):
        # Guards a real regression: a keeper on a winning team once scored 0.3
        # because defensive weights were tiny and goals_conceded penalised him.
        # A keeper who made saves must never land near the floor.
        star = compute_star_rating({"saves": 3, "goals_conceded": 1}, FOOTBALL_SCHEMA, position="GK")
        assert star > 4.0, f"a keeper with 3 saves should not be near the floor, got {star}"

    def test_goalkeeper_inferred_without_position(self):
        # No position recorded, but keeper-only stats present → GK path.
        star = compute_star_rating({"saves": 4, "goals_conceded": 0}, FOOTBALL_SCHEMA)
        assert star > 5.0

    def test_defender_baseline_beats_forward_baseline(self):
        # With no stats at all a CB (baseline 4) outranks a ST (baseline 3):
        # an unremarkable defensive shift is not a bad performance.
        cb = compute_star_rating({}, FOOTBALL_SCHEMA, position="CB")
        st = compute_star_rating({}, FOOTBALL_SCHEMA, position="ST")
        assert cb > st

    def test_scoring_striker_beats_quiet_striker(self):
        quiet = compute_star_rating({"goals": 0}, FOOTBALL_SCHEMA, position="ST")
        sharp = compute_star_rating({"goals": 2}, FOOTBALL_SCHEMA, position="ST")
        assert sharp > quiet

    def test_more_goals_scores_higher(self):
        one = compute_star_rating({"goals": 1}, FOOTBALL_SCHEMA, position="ST")
        two = compute_star_rating({"goals": 2}, FOOTBALL_SCHEMA, position="ST")
        assert two > one

    def test_win_bonus_is_flat_and_applied(self):
        lost = compute_star_rating({"goals": 1}, FOOTBALL_SCHEMA, position="ST", won=False)
        won = compute_star_rating({"goals": 1}, FOOTBALL_SCHEMA, position="ST", won=True)
        assert abs((won - lost) - WIN_BONUS) < ROUNDING_TOLERANCE

    def test_clean_sheet_rewards_backline_more_than_midfield(self):
        cb_plain = compute_star_rating({}, FOOTBALL_SCHEMA, position="CB")
        cb_clean = compute_star_rating({}, FOOTBALL_SCHEMA, position="CB", clean_sheet=True)
        cm_plain = compute_star_rating({}, FOOTBALL_SCHEMA, position="CM")
        cm_clean = compute_star_rating({}, FOOTBALL_SCHEMA, position="CM", clean_sheet=True)

        assert abs((cb_clean - cb_plain) - CLEAN_SHEET_BONUS) < ROUNDING_TOLERANCE
        assert abs((cm_clean - cm_plain) - MIDFIELD_CLEAN_SHEET_BONUS) < ROUNDING_TOLERANCE
        assert (cb_clean - cb_plain) > (cm_clean - cm_plain)

    def test_clean_sheet_gives_forwards_nothing(self):
        plain = compute_star_rating({"goals": 1}, FOOTBALL_SCHEMA, position="ST")
        clean = compute_star_rating({"goals": 1}, FOOTBALL_SCHEMA, position="ST", clean_sheet=True)
        assert abs(clean - plain) < 0.05, "a striker earns no credit for the defence's clean sheet"

    def test_red_card_reduces_the_star(self):
        clean = compute_star_rating({"goals": 1, "red_cards": 0}, FOOTBALL_SCHEMA, position="ST")
        sent_off = compute_star_rating({"goals": 1, "red_cards": 1}, FOOTBALL_SCHEMA, position="ST")
        assert sent_off < clean

    def test_star_is_clamped_to_0_10(self):
        absurd = compute_star_rating(
            {"goals": 50, "assists": 50, "tackles": 99}, FOOTBALL_SCHEMA, position="ST", won=True
        )
        assert 0.0 <= absurd <= 10.0

        disaster = compute_star_rating({"red_cards": 5}, FOOTBALL_SCHEMA, position="ST")
        assert 0.0 <= disaster <= 10.0

    def test_cricket_uses_batting_and_bowling_metrics(self):
        quiet = compute_star_rating({"runs": 2}, CRICKET_SCHEMA, position="BAT")
        century = compute_star_rating({"runs": 100, "fours": 8, "sixes": 3}, CRICKET_SCHEMA, position="BAT")
        assert century > quiet


class TestEloDelta:
    """Per-tier Elo change: result vs expectation, scaled by K, margin and star."""

    def test_win_against_equal_opponent_gains(self):
        assert elo_delta(50.0, 50.0, 1.0, 10, 1.0, 5.0) > 0

    def test_loss_against_equal_opponent_drops(self):
        assert elo_delta(50.0, 50.0, 0.0, 10, 1.0, 5.0) < 0

    def test_draw_against_equal_opponent_is_neutral(self):
        # actual == expected, and a mid star (5/10) means the nudge is zero.
        assert abs(elo_delta(50.0, 50.0, 0.5, 10, 1.0, 5.0)) < 0.01

    def test_beating_a_stronger_opponent_gains_more(self):
        vs_weaker = elo_delta(50.0, 30.0, 1.0, 10, 1.0, 5.0)
        vs_stronger = elo_delta(50.0, 70.0, 1.0, 10, 1.0, 5.0)
        assert vs_stronger > vs_weaker

    def test_star_nudges_the_delta(self):
        anonymous = elo_delta(50.0, 50.0, 1.0, 10, 1.0, 2.0)
        man_of_the_match = elo_delta(50.0, 50.0, 1.0, 10, 1.0, 9.0)
        assert man_of_the_match > anonymous

    def test_newcomer_moves_faster_than_veteran(self):
        newcomer = abs(elo_delta(50.0, 50.0, 1.0, 2, 1.0, 5.0))
        veteran = abs(elo_delta(50.0, 50.0, 1.0, 100, 1.0, 5.0))
        assert newcomer > veteran, "cold-start K must move new players faster"

    def test_bigger_margin_amplifies_the_delta(self):
        narrow = elo_delta(50.0, 50.0, 1.0, 10, 1.0, 5.0)
        thrashing = elo_delta(50.0, 50.0, 1.0, 10, 5.0, 5.0)
        assert thrashing > narrow

    def test_margin_multiplier_saturates(self):
        big = elo_delta(50.0, 50.0, 1.0, 10, 6.0, 5.0)
        absurd = elo_delta(50.0, 50.0, 1.0, 10, 20.0, 5.0)
        assert abs(big - absurd) < 0.01, "margin multiplier must cap, not run away"


class TestBlendOverall:
    """The headline Elo number: per-tier ratings weighted by tier and volume."""

    def test_no_history_returns_default(self):
        assert blend_overall([]) == 50.0

    def test_single_tier_returns_that_rating(self):
        assert abs(blend_overall([("amateur", 63.5, 12)]) - 63.5) < 0.01

    def test_regular_semi_pro_outweighs_one_off_pro(self):
        # The headline design claim: a substantiated semi-pro record carries more
        # of the blend than a single flattering pro appearance.
        blended = blend_overall([("semi_pro", 70.0, 20), ("pro", 95.0, 1)])
        assert abs(blended - 70.0) < abs(blended - 95.0)

    def test_volume_pulls_the_blend_toward_a_tier(self):
        light = blend_overall([("amateur", 90.0, 1), ("pro", 40.0, 30)])
        heavy = blend_overall([("amateur", 90.0, 30), ("pro", 40.0, 30)])
        assert heavy > light

    def test_higher_tier_carries_more_weight_at_equal_volume(self):
        # Equal volume, different ratings: the pro tier's weight should drag the
        # blend above the plain arithmetic midpoint of 60.
        blended = blend_overall([("amateur", 40.0, 10), ("pro", 80.0, 10)])
        assert blended > 60.0, "the higher tier should pull above the plain average"


class TestFormRating:

    def test_empty_returns_default(self):
        assert compute_form_rating([]) == 50.0

    def test_recent_scores_weighted_more(self):
        scores = [30.0, 40.0, 50.0, 60.0, 80.0]  # improving
        form = compute_form_rating(scores)
        simple_avg = sum(scores) / len(scores)
        assert form > simple_avg, "recent good form should beat the flat average"

    def test_uses_last_5_only(self):
        many_low = [10.0] * 20 + [90.0] * 5
        assert compute_form_rating(many_low) > 80.0


class TestPreprocessors:

    def test_cricket_computes_strike_rate_bonus(self):
        stats = preprocess_stats("cricket", {"runs": 60, "balls_faced": 30})  # SR 200
        assert "strike_rate_bonus" in stats
        assert stats["strike_rate_bonus"] > 0

    def test_basketball_computes_fg_percentage(self):
        stats = preprocess_stats("basketball", {"fg_made": 8, "fg_attempted": 16})
        assert "fg_percentage" in stats
        assert abs(stats["fg_percentage"] - 50.0) < 0.1

    def test_unknown_sport_returns_unchanged(self):
        original = {"some_stat": 5}
        assert preprocess_stats("volleyball", original) == original
