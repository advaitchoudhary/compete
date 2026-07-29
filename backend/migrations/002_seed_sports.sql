-- Seed: Sport definitions with full stat schemas
-- Migration: 002_seed_sports

INSERT INTO sports (id, name, slug, stat_schema) VALUES
(
  uuid_generate_v4(),
  'Cricket',
  'cricket',
  '{
    "score_format": "runs_wickets",
    "match_stats": ["runs","balls_faced","fours","sixes","out","dismissal_type","overs_bowled","wickets","runs_conceded","maidens","extras","catches","run_outs"],
    "batting_metrics": {"runs": 1.0, "fours": 0.2, "sixes": 0.5},
    "bowling_metrics": {"wickets": 3.0, "maidens": 0.5, "economy_bonus": 1.0},
    "fielding_metrics": {"catches": 1.0, "run_outs": 1.5},
    "positions": ["Top Order", "Middle Order", "All Rounder", "Wicket Keeper", "Bowler"],
    "max_stat_thresholds": {"runs": 300, "wickets": 10, "overs_bowled": 50},
    "formats": ["T10", "T20", "T30", "ODI", "Test"]
  }'
),
(
  uuid_generate_v4(),
  'Football',
  'football',
  '{
    "score_format": "goals",
    "match_stats": ["goals","assists","shots","shots_on_target","passes","pass_accuracy","tackles","interceptions","saves","goals_conceded","yellow_cards","red_cards","clean_sheet"],
    "primary_metrics": {"goals": 3.0, "assists": 1.5, "shots_on_target": 0.3, "tackles": 0.2, "interceptions": 0.2, "saves": 0.5, "clean_sheet": 2.0},
    "penalty_metrics": {"yellow_cards": -0.5, "red_cards": -2.0, "goals_conceded": -0.3},
    "positions": ["GK", "CB", "LB", "RB", "CDM", "CM", "CAM", "LW", "RW", "ST"],
    "max_stat_thresholds": {"goals": 15, "assists": 10, "saves": 20},
    "formats": ["5-a-side", "7-a-side", "11-a-side"]
  }'
),
(
  uuid_generate_v4(),
  'Badminton',
  'badminton',
  '{
    "score_format": "sets",
    "match_stats": ["points_won","points_lost","aces","smashes","net_shots","errors","sets_won","sets_lost"],
    "primary_metrics": {"points_won": 0.5, "aces": 1.0, "smashes": 0.3, "sets_won": 5.0},
    "penalty_metrics": {"errors": -0.2, "points_lost": -0.1},
    "positions": ["Singles", "Doubles"],
    "event_types": ["MS", "WS", "MD", "WD", "XD"],
    "max_stat_thresholds": {"points_won": 100, "aces": 30},
    "formats": ["Singles", "Doubles", "Mixed Doubles"]
  }'
),
(
  uuid_generate_v4(),
  'Basketball',
  'basketball',
  '{
    "score_format": "points",
    "match_stats": ["points","rebounds","assists","steals","blocks","turnovers","fouls","fg_made","fg_attempted","three_made","three_attempted","ft_made","ft_attempted","plus_minus"],
    "primary_metrics": {"points": 1.0, "rebounds": 0.8, "assists": 1.0, "steals": 1.5, "blocks": 1.5},
    "penalty_metrics": {"turnovers": -0.5, "fouls": -0.3},
    "efficiency_metrics": {"fg_percentage": 0.5, "three_percentage": 0.5, "ft_percentage": 0.3},
    "positions": ["PG", "SG", "SF", "PF", "C"],
    "max_stat_thresholds": {"points": 60, "rebounds": 25, "assists": 20},
    "formats": ["5-on-5", "3x3", "21"]
  }'
);
