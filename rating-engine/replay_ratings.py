"""
One-off: recompute every star rating and replay the whole Elo history.

Needed after fixing the keeper misclassification, which made compute_star_rating
ignore goals and assists for every outfield player. Every rating in the database
was produced by that broken function.

Why a FULL replay and not just the affected event: Elo is path-dependent. A
player's rating change in a match is a function of their rating going in, so
correcting one tournament while leaving its inputs wrong would still give the
wrong answer. The only consistent result comes from replaying every completed
match in chronological order from a clean baseline.

What is preserved: referee overrides. Where `rating_overridden` is true the
human's number is kept and only the algorithm's suggestion beside it is
refreshed. Everything else is recomputed.

Run:  docker compose exec rating-engine python replay_ratings.py [--apply]
Without --apply it reports what it would do and changes nothing.
"""
import json
import sys

from algorithms import preprocess_stats
from algorithms.base import compute_star_rating
from consumer import get_db, get_redis, decide_winner, team_conceded, process_match

APPLY = "--apply" in sys.argv


def main() -> None:
    db = get_db()
    redis_client = get_redis()
    cur = db.cursor()

    cur.execute("SELECT COUNT(*) AS c FROM matches WHERE status = 'completed'")
    total = cur.fetchone()["c"]
    cur.execute("SELECT COUNT(*) AS c FROM match_player_stats WHERE rating_overridden = true")
    overridden = cur.fetchone()["c"]
    print(f"completed matches: {total} | referee overrides preserved: {overridden}")

    if not APPLY:
        print("dry run — pass --apply to write")
        return

    # ── Reset ────────────────────────────────────────────────────────────────
    # rating_history is also the idempotency key process_match checks, so it has
    # to go before anything can be replayed.
    cur.execute("DELETE FROM rating_history")
    cur.execute("DELETE FROM tier_ratings")
    cur.execute(
        """UPDATE match_player_stats
           SET suggested_rating = NULL, match_rating = NULL
           WHERE rating_overridden = false"""
    )
    cur.execute(
        """UPDATE sport_profiles
           SET current_rating = 50.00, form_rating = NULL,
               matches_played = 0, wins = 0, career_stats = '{}'::jsonb"""
    )
    db.commit()
    print("reset: history, tier ladders and profiles back to baseline")

    # ── Replay ───────────────────────────────────────────────────────────────
    cur.execute(
        """SELECT id, sport_id FROM matches
           WHERE status = 'completed'
           ORDER BY completed_at NULLS LAST, created_at"""
    )
    matches = cur.fetchall()

    rated = 0
    for n, m in enumerate(matches, 1):
        match_id, sport_id = m["id"], m["sport_id"]

        cur.execute(
            """SELECT s.slug, s.stat_schema, m.home_team_id, m.away_team_id,
                      m.home_score, m.away_score
               FROM matches m JOIN sports s ON s.id = m.sport_id
               WHERE m.id = %s""",
            (match_id,),
        )
        meta = cur.fetchone()
        winner = decide_winner(
            meta["slug"], meta["home_score"], meta["away_score"],
            meta["home_team_id"], meta["away_team_id"],
        )

        cur.execute(
            """SELECT user_id, stats, position, team_id, rating_overridden
               FROM match_player_stats WHERE match_id = %s""",
            (match_id,),
        )
        for row in cur.fetchall():
            stats = row["stats"] if isinstance(row["stats"], dict) else json.loads(row["stats"])
            won = winner is not None and row["team_id"] == winner
            conceded = team_conceded(
                meta["slug"], meta["home_score"], meta["away_score"],
                row["team_id"], meta["home_team_id"], meta["away_team_id"],
            )
            clean = conceded == 0 if conceded is not None else False
            star = compute_star_rating(
                preprocess_stats(meta["slug"], stats),
                meta["stat_schema"], row["position"], won, clean, conceded,
            )
            if row["rating_overridden"]:
                # Keep the referee's number; refresh only the suggestion it sat against.
                cur.execute(
                    """UPDATE match_player_stats SET suggested_rating = %s
                       WHERE match_id = %s AND user_id = %s""",
                    (star, match_id, row["user_id"]),
                )
            else:
                cur.execute(
                    """UPDATE match_player_stats SET suggested_rating = %s, match_rating = %s
                       WHERE match_id = %s AND user_id = %s""",
                    (star, star, match_id, row["user_id"]),
                )
        db.commit()

        before = _history_count(cur)
        process_match(match_id, sport_id, db, redis_client)
        if _history_count(cur) > before:
            rated += 1

        if n % 10 == 0 or n == len(matches):
            print(f"  replayed {n}/{len(matches)}")

    print(f"done — {rated} matches produced ratings "
          f"({len(matches) - rated} had no confirmed stat lines)")
    db.close()


def _history_count(cur) -> int:
    cur.execute("SELECT COUNT(*) AS c FROM rating_history")
    return cur.fetchone()["c"]


if __name__ == "__main__":
    main()
