"""
Redis Streams consumer — reads the rating stream and processes match completion
events. Runs either as its own process (`python consumer.py`) or, in dev, in a
background thread inside the FastAPI server.

Delivery is at-least-once: a consumer group hands each message to one worker,
XACK confirms completion, and XAUTOCLAIM reclaims messages stranded by a crashed
worker. The idempotency guard in process_match makes any redelivery a no-op.
"""

import json
import logging
import os
import socket
import time
import uuid
from datetime import datetime, timezone
import psycopg2
import psycopg2.extras
import redis as redis_lib
from config import settings
from algorithms.base import (
    compute_star_rating,
    elo_delta,
    match_weight,
    blend_overall,
    compute_form_rating,
)
from algorithms import preprocess_stats

logger = logging.getLogger(__name__)

# Score-JSON key that decides the result, per sport (mirrors backend)
SCORE_KEY = {"football": "goals", "basketball": "points", "cricket": "runs", "badminton": "sets_won"}


def _scores(slug: str, home_score, away_score):
    key = SCORE_KEY.get(slug)
    if not key or not home_score or not away_score:
        return None, None
    h = home_score if isinstance(home_score, dict) else json.loads(home_score)
    a = away_score if isinstance(away_score, dict) else json.loads(away_score)
    try:
        return float(h.get(key, 0)), float(a.get(key, 0))
    except (TypeError, ValueError):
        return None, None


def _score_margin(slug: str, home_score, away_score) -> float:
    hv, av = _scores(slug, home_score, away_score)
    return abs(hv - av) if hv is not None and av is not None else 0.0


def decide_winner(slug, home_score, away_score, home_team_id, away_team_id):
    """Winning team id from the final score, or None for a draw / unknown."""
    hv, av = _scores(slug, home_score, away_score)
    if hv is None or av is None:
        return None
    if hv > av:
        return home_team_id
    if av > hv:
        return away_team_id
    return None


def team_clean_sheet(slug, home_score, away_score, team_id, home_team_id, away_team_id) -> bool:
    """True if the given team conceded 0 goals (clean sheet)."""
    hv, av = _scores(slug, home_score, away_score)
    if hv is None or av is None:
        return False
    conceded = av if team_id == home_team_id else hv
    return conceded == 0


def get_db():
    return psycopg2.connect(settings.database_url, cursor_factory=psycopg2.extras.RealDictCursor)


def get_redis():
    return redis_lib.from_url(settings.redis_url, decode_responses=True)


def process_match(match_id: str, sport_id: str, db_conn, redis_client) -> None:
    """
    Elo+ rating computation for a completed match:
      1. Update each player's per-tier Elo (win/loss vs opponent avg, margin,
         + individual star nudge) on the match's tier ladder.
      2. Recompute the blended overall "Elo number" → sport_profiles.
      3. Write the overall rating_history timeline + the 0–10 star per player.
    """
    cur = db_conn.cursor()

    # Idempotency: rating_history is written once per (user, match). If any row
    # exists for this match it was already processed → redelivery is a no-op.
    cur.execute("SELECT 1 FROM rating_history WHERE match_id = %s LIMIT 1", (match_id,))
    if cur.fetchone():
        logger.info(f"Match {match_id} already processed — skipping (idempotent)")
        return

    cur.execute("SELECT slug, stat_schema FROM sports WHERE id = %s", (sport_id,))
    sport = cur.fetchone()
    if not sport:
        logger.error(f"Sport {sport_id} not found")
        return
    sport_slug = sport["slug"]
    stat_schema = sport["stat_schema"]

    cur.execute("""
        SELECT home_team_id, away_team_id, winner_team_id, home_score, away_score, tier,
               duration_minutes
        FROM matches WHERE id = %s
    """, (match_id,))
    match = cur.fetchone()
    if not match:
        return
    tier = match["tier"] or "amateur"
    # Short tournament games carry less information — scale K accordingly.
    weight = match_weight(match.get("duration_minutes"))
    margin = _score_margin(sport_slug, match["home_score"], match["away_score"])

    cur.execute("""
        SELECT user_id, team_id, stats, match_rating, position
        FROM match_player_stats
        WHERE match_id = %s AND confirmed_by_captain = true
    """, (match_id,))
    rows = cur.fetchall()
    if not rows:
        logger.warning(f"No confirmed stats found for match {match_id}")
        return

    # Pre-match per-tier ratings for everyone (Elo uses pre-match values)
    def load_tier_rating(uid):
        cur.execute("""
            SELECT rating, matches_played, wins FROM tier_ratings
            WHERE user_id = %s AND sport_id = %s AND tier = %s
        """, (uid, sport_id, tier))
        r = cur.fetchone()
        return (float(r["rating"]), int(r["matches_played"]), int(r["wins"])) if r else (50.0, 0, 0)

    pre = {row["user_id"]: load_tier_rating(row["user_id"]) for row in rows}

    team_players: dict[str, list[str]] = {}
    for row in rows:
        team_players.setdefault(row["team_id"], []).append(row["user_id"])
    team_avg = {t: sum(pre[u][0] for u in us) / len(us) for t, us in team_players.items()}
    team_ids = list(team_avg.keys())

    for row in rows:
        uid = row["user_id"]
        team_id = row["team_id"]
        raw_stats = row["stats"] if isinstance(row["stats"], dict) else json.loads(row["stats"])
        processed = preprocess_stats(sport_slug, raw_stats)

        rating, matches_played, _ = pre[uid]
        opponent_team = next((t for t in team_ids if t != team_id), team_id)
        opponent_avg = team_avg.get(opponent_team, 50.0)

        won = match["winner_team_id"] == team_id
        actual = 1.0 if won else (0.5 if match["winner_team_id"] is None else 0.0)

        # Star: use the referee-approved value if present, else compute it
        # (win + clean-sheet bonuses are baked into the star, not the Elo).
        clean = team_clean_sheet(
            sport_slug, match["home_score"], match["away_score"],
            team_id, match["home_team_id"], match["away_team_id"],
        )
        star = float(row["match_rating"]) if row["match_rating"] is not None \
            else compute_star_rating(processed, stat_schema, row["position"], won, clean)

        delta = elo_delta(rating, opponent_avg, actual, matches_played, margin, star, weight)
        new_tier_rating = round(max(1.0, min(99.0, rating + delta)), 2)

        # Upsert this tier ladder
        cur.execute("""
            INSERT INTO tier_ratings (user_id, sport_id, tier, rating, matches_played, wins)
            VALUES (%s, %s, %s, %s, 1, %s)
            ON CONFLICT (user_id, sport_id, tier) DO UPDATE SET
                rating = %s,
                matches_played = tier_ratings.matches_played + 1,
                wins = tier_ratings.wins + %s,
                updated_at = NOW()
        """, (uid, sport_id, tier, new_tier_rating, 1 if won else 0,
              new_tier_rating, 1 if won else 0))

        # Blend the overall "Elo number" across all of this player's tiers
        cur.execute("""
            SELECT tier, rating, matches_played FROM tier_ratings
            WHERE user_id = %s AND sport_id = %s
        """, (uid, sport_id))
        tier_rows = [(r["tier"], float(r["rating"]), int(r["matches_played"])) for r in cur.fetchall()]
        overall = blend_overall(tier_rows)

        # Overall before (for the history timeline) + career aggregates
        cur.execute("""
            SELECT current_rating, career_stats FROM sport_profiles
            WHERE user_id = %s AND sport_id = %s
        """, (uid, sport_id))
        sp = cur.fetchone()
        overall_before = float(sp["current_rating"]) if sp else 50.0
        old_career = sp["career_stats"] if sp and isinstance(sp["career_stats"], dict) else {}
        new_career = dict(old_career)
        for stat, value in raw_stats.items():
            if isinstance(value, (int, float)):
                new_career[stat] = float(new_career.get(stat, 0)) + float(value)

        # Form = recent star scores (stored on a 0–100 scale as star × 10)
        cur.execute("""
            SELECT performance_score FROM rating_history
            WHERE user_id = %s AND sport_id = %s ORDER BY created_at DESC LIMIT 4
        """, (uid, sport_id))
        recent = [float(r["performance_score"]) for r in cur.fetchall()]
        recent.append(star * 10)
        form = compute_form_rating(recent)

        cur.execute("""
            INSERT INTO sport_profiles (user_id, sport_id, current_rating, form_rating,
                                        matches_played, wins, career_stats)
            VALUES (%s, %s, %s, %s, 1, %s, %s)
            ON CONFLICT (user_id, sport_id) DO UPDATE SET
                current_rating = %s, form_rating = %s,
                matches_played = sport_profiles.matches_played + 1,
                wins = sport_profiles.wins + %s,
                career_stats = %s, updated_at = NOW()
        """, (uid, sport_id, overall, form, 1 if won else 0, json.dumps(new_career),
              overall, form, 1 if won else 0, json.dumps(new_career)))

        cur.execute("""
            INSERT INTO rating_history (user_id, sport_id, match_id,
                                        rating_before, rating_after, performance_score)
            VALUES (%s, %s, %s, %s, %s, %s)
        """, (uid, sport_id, match_id, overall_before, overall, round(star * 10, 2)))

        # Persist the final star on the stat row (0–10)
        cur.execute("""
            UPDATE match_player_stats SET match_rating = %s WHERE match_id = %s AND user_id = %s
        """, (round(star, 1), match_id, uid))

        redis_client.publish(f"rating:{uid}", json.dumps({
            "user_id": uid, "sport_id": sport_id, "tier": tier,
            "tier_rating": new_tier_rating, "overall": overall,
            "old_overall": overall_before, "delta": round(overall - overall_before, 2),
            "star": round(star, 1),
        }))
        redis_client.delete(f"sp:{uid}:{sport_id}")

        logger.info(
            f"{uid}: {tier} {rating:.1f}→{new_tier_rating:.1f} | "
            f"overall {overall_before:.1f}→{overall:.1f} | star={star:.1f}"
        )

    db_conn.commit()
    logger.info(f"Rating computation complete for match {match_id}, {len(rows)} players")


def _ensure_group(redis_client) -> None:
    """Create the consumer group (and the stream itself) if it doesn't exist."""
    try:
        redis_client.xgroup_create(
            name=settings.rating_stream_key,
            groupname=settings.rating_consumer_group,
            id="0",          # read from the start of the stream
            mkstream=True,   # create the stream if no producer has written yet
        )
        logger.info(f"Created consumer group '{settings.rating_consumer_group}'")
    except redis_lib.ResponseError as e:
        if "BUSYGROUP" in str(e):
            pass  # group already exists — normal on restart
        else:
            raise


class PermanentFailure(Exception):
    """A payload no retry can fix (malformed ids) — dead-letter it immediately."""


def _pending_delivery_counts(redis_client) -> dict[str, int]:
    """
    entry_id → times-delivered for every entry in the group's pending list.
    Used to spot poison messages: XAUTOCLAIM happily re-delivers a failing entry
    forever, so we need the counter Redis already keeps to cap the retries.
    """
    try:
        pending = redis_client.xpending_range(
            name=settings.rating_stream_key,
            groupname=settings.rating_consumer_group,
            min="-",
            max="+",
            count=500,
        )
    except redis_lib.RedisError as e:
        logger.error(f"Could not read pending list: {e}")
        return {}
    return {p["message_id"]: int(p["times_delivered"]) for p in pending}


def _dead_letter(redis_client, entry_id: str, fields: dict, reason: str) -> None:
    """
    Move a hopeless entry to the dead-letter stream and ACK the original so it
    stops being reclaimed. The DLQ keeps the payload plus why it failed, so a
    bad match can be inspected (and replayed) instead of silently vanishing.
    """
    payload = {k: "" if v is None else str(v) for k, v in fields.items()}
    payload["_original_id"] = entry_id
    payload["_failed_at"] = datetime.now(timezone.utc).isoformat()
    payload["_reason"] = reason[:500]

    redis_client.xadd(settings.rating_dead_letter_key, payload, maxlen=1000, approximate=True)
    redis_client.xack(settings.rating_stream_key, settings.rating_consumer_group, entry_id)
    logger.error(
        f"Dead-lettered {entry_id} → {settings.rating_dead_letter_key}: {reason}"
    )


def _handle_entry(entry_id: str, fields: dict, redis_client) -> None:
    """Process one stream entry and XACK it. Raises on failure (no ACK → retried)."""
    match_id = fields.get("match_id") or ""
    sport_id = fields.get("sport_id") or ""

    # Validate before touching Postgres: an empty/garbage uuid raises deep inside
    # psycopg2 on every single retry, which is exactly the loop we're capping.
    for label, value in (("match_id", match_id), ("sport_id", sport_id)):
        try:
            uuid.UUID(value)
        except (ValueError, AttributeError, TypeError):
            raise PermanentFailure(f"malformed {label}: {value!r}")

    logger.info(f"Processing match {match_id} (entry {entry_id})")

    db_conn = get_db()
    try:
        process_match(match_id, sport_id, db_conn, redis_client)
    finally:
        db_conn.close()

    redis_client.xack(
        settings.rating_stream_key, settings.rating_consumer_group, entry_id
    )


def _reclaim_stranded(redis_client, consumer_name: str) -> None:
    """
    Reclaim entries delivered to a now-dead consumer that were never ACKed
    (idle longer than rating_claim_idle_ms), and process them here.
    """
    cursor = "0-0"
    while True:
        cursor, claimed, _deleted = redis_client.xautoclaim(
            name=settings.rating_stream_key,
            groupname=settings.rating_consumer_group,
            consumername=consumer_name,
            min_idle_time=settings.rating_claim_idle_ms,
            start_id=cursor,
            count=10,
        )
        # Counts are read after the claim, so times_delivered includes this attempt.
        counts = _pending_delivery_counts(redis_client) if claimed else {}
        for entry_id, fields in claimed:
            delivered = counts.get(entry_id, 1)
            if delivered > settings.rating_max_deliveries:
                _dead_letter(
                    redis_client, entry_id, fields,
                    f"gave up after {delivered} delivery attempts",
                )
                continue
            try:
                logger.warning(f"Reclaimed stranded entry {entry_id} (attempt {delivered})")
                _handle_entry(entry_id, fields, redis_client)
            except PermanentFailure as e:
                _dead_letter(redis_client, entry_id, fields, str(e))
            except Exception as e:
                logger.error(f"Failed to process reclaimed {entry_id}: {e}", exc_info=True)
        # XAUTOCLAIM returns the "0-0" cursor once it has scanned the whole PEL.
        # (A short scan that claims nothing also comes back as "0-0".)
        if cursor in ("0-0", "0") or not claimed:
            break


def run_consumer():
    """Main Redis Streams consumer loop."""
    redis_client = get_redis()
    consumer_name = f"{socket.gethostname()}-{os.getpid()}"

    _ensure_group(redis_client)
    logger.info(
        f"Rating consumer '{consumer_name}' started. "
        f"Reading stream '{settings.rating_stream_key}'..."
    )

    while True:
        try:
            # Recover anything a crashed worker left un-ACKed, then read new work.
            _reclaim_stranded(redis_client, consumer_name)

            resp = redis_client.xreadgroup(
                groupname=settings.rating_consumer_group,
                consumername=consumer_name,
                streams={settings.rating_stream_key: ">"},  # ">" = new, never-delivered
                count=10,
                block=5_000,  # ms; wake periodically so reclaim can run
            )
            if not resp:
                continue

            for _stream, entries in resp:
                for entry_id, fields in entries:
                    try:
                        _handle_entry(entry_id, fields, redis_client)
                    except PermanentFailure as e:
                        _dead_letter(redis_client, entry_id, fields, str(e))
                    except Exception as e:
                        logger.error(f"Failed to process {entry_id}: {e}", exc_info=True)
                        # No XACK → entry stays pending and is reclaimed/retried later,
                        # up to rating_max_deliveries before it is dead-lettered.

        except KeyboardInterrupt:
            logger.info("Consumer shutting down")
            break
        except Exception as e:
            logger.error(f"Consumer error: {e}", exc_info=True)
            time.sleep(5)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    run_consumer()
