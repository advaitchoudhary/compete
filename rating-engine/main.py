"""
FastAPI app for the rating engine.
Exposes HTTP endpoints for:
  - Manual rating trigger (admin)
  - Rating simulation / preview (useful for testing)
  - Health check
"""

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import json
import threading
from config import settings
from consumer import run_consumer, get_db, decide_winner, team_clean_sheet
from algorithms.base import compute_performance_score, compute_new_rating, compute_star_rating
from algorithms import preprocess_stats

app = FastAPI(title="AllSports Rating Engine", version="0.1.0")


class RatingPreviewRequest(BaseModel):
    sport_slug: str
    player_stats: dict
    opponent_avg_rating: float = 50.0
    current_rating: float = 50.0
    matches_played: int = 10
    sport_schema: dict  # pass the full stat_schema from the sports table


class RatingPreviewResponse(BaseModel):
    performance_score: float
    new_rating: float
    delta: float
    match_rating: float  # 0-10 scale as shown in app


@app.get("/health")
def health():
    return {"status": "ok", "service": "rating-engine"}


@app.post("/preview", response_model=RatingPreviewResponse)
def preview_rating(req: RatingPreviewRequest):
    """
    Simulate what a player's new rating would be given their stats.
    Used by the frontend to show a live preview while entering stats.
    """
    processed = preprocess_stats(req.sport_slug, req.player_stats)
    perf = compute_performance_score(processed, req.sport_schema, req.opponent_avg_rating)
    new_r = compute_new_rating(req.current_rating, perf, req.matches_played)

    return RatingPreviewResponse(
        performance_score=round(perf, 2),
        new_rating=round(new_r, 2),
        delta=round(new_r - req.current_rating, 2),
        match_rating=round(perf / 10, 1),
    )


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
            clean = team_clean_sheet(
                slug, meta["home_score"], meta["away_score"],
                r["team_id"], meta["home_team_id"], meta["away_team_id"],
            )
            star = compute_star_rating(
                preprocess_stats(slug, stats), schema, r["position"], won, clean
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
