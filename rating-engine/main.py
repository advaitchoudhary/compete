"""
FastAPI app for the rating engine.
Exposes HTTP endpoints for:
  - Referee star-rating suggestions for a match
  - Health check

The Elo ratings themselves are never computed over HTTP — they are produced by the
Redis Streams consumer when a match completes (see consumer.py), so the ladder has
exactly one writer.
"""

from fastapi import FastAPI, HTTPException
import json
import threading
from config import settings
from consumer import run_consumer, get_db, decide_winner, team_conceded
from algorithms.base import compute_star_rating
from algorithms import preprocess_stats

app = FastAPI(title="AllSports Rating Engine", version="0.1.0")


@app.get("/health")
def health():
    return {"status": "ok", "service": "rating-engine"}


@app.post("/matches/{match_id}/suggest")
def suggest_match(match_id: str):
    """
    Compute the algorithm's suggested 0–10 star rating for every player in a
    match and persist it to match_player_stats.suggested_rating. The backend
    calls this so the referee can review/override the suggestions.
    """
    db = get_db()
    try:
        cur = db.cursor()
        cur.execute(
            """SELECT m.sport_id, s.slug, s.stat_schema,
                      m.home_team_id, m.away_team_id, m.home_score, m.away_score
               FROM matches m JOIN sports s ON s.id = m.sport_id
               WHERE m.id = %s""",
            (match_id,),
        )
        meta = cur.fetchone()
        if not meta:
            raise HTTPException(status_code=404, detail="Match not found")

        slug = meta["slug"]
        schema = meta["stat_schema"]
        # Winner (from the current score) so the suggested star includes the win bonus
        winner = decide_winner(
            slug, meta["home_score"], meta["away_score"],
            meta["home_team_id"], meta["away_team_id"],
        )

        cur.execute(
            "SELECT user_id, stats, position, team_id FROM match_player_stats WHERE match_id = %s",
            (match_id,),
        )
        rows = cur.fetchall()

        suggestions = []
        for r in rows:
            stats = r["stats"] if isinstance(r["stats"], dict) else json.loads(r["stats"])
            won = winner is not None and r["team_id"] == winner
            conceded = team_conceded(
                slug, meta["home_score"], meta["away_score"],
                r["team_id"], meta["home_team_id"], meta["away_team_id"],
            )
            clean = conceded == 0 if conceded is not None else False
            star = compute_star_rating(
                preprocess_stats(slug, stats), schema, r["position"], won, clean, conceded
            )
            cur.execute(
                "UPDATE match_player_stats SET suggested_rating = %s WHERE match_id = %s AND user_id = %s",
                (star, match_id, r["user_id"]),
            )
            suggestions.append({"user_id": r["user_id"], "suggested_rating": star})

        db.commit()
        return {"match_id": match_id, "suggestions": suggestions}
    finally:
        db.close()


# In dev, run the Streams consumer in a background thread alongside the API.
# In prod the consumer is its own process (see docs/deployment-fly.md), and the
# API process sets RUN_CONSUMER_IN_API=false so it doesn't double up.
@app.on_event("startup")
def start_consumer():
    if not settings.run_consumer_in_api:
        return
    t = threading.Thread(target=run_consumer, daemon=True, name="rating-consumer")
    t.start()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
