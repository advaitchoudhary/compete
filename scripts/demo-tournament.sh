#!/usr/bin/env bash
#
# demo-tournament.sh — build one complete tournament from nothing, so the whole
# system can be exercised by hand.
#
# Runs the real product flow through the real API: an organizer is approved, an
# event is created and graded, referees are assigned, teams register with guest
# players, fixtures are generated, matches are played, ratings settle, and a guest
# claim link is minted. It finishes by printing the URLs to open.
#
# Everything it creates is prefixed DEMO so `--clean` can remove it again.
#
# Usage:
#   ./scripts/demo-tournament.sh           build a fresh demo tournament
#   ./scripts/demo-tournament.sh --clean   remove everything it created
#
set -uo pipefail

API=${API:-http://localhost:13000/v1}
WEB=${WEB:-http://localhost:8081}
# 6 teams -> 2 groups of 3 -> semis -> final, so both group and knockout stages
# are exercised. Try TEAM_COUNT=5 to see the prime-count knockout fallback, or
# TEAM_COUNT=9 for three groups of three.
TEAM_COUNT=${TEAM_COUNT:-6}

say()  { printf "\n\033[1;32m▸ %s\033[0m\n" "$1"; }
info() { printf "  %s\n" "$1"; }
fail() { printf "\n\033[1;31m✗ %s\033[0m\n" "$1"; exit 1; }

sql()  { docker exec allsports_postgres psql -U allsports -d allsports_dev -tAc "$1" | tr -d ' '; }
sqlv() { docker exec allsports_postgres psql -U allsports -d allsports_dev -c "$1"; }

# Mint a dev session. $1 = seed key, rest = extra JSON fields.
token() {
  curl -s --max-time 8 -X POST "$API/auth/dev-token" \
    -H 'Content-Type: application/json' -d "$1" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])' 2>/dev/null
}

jq_field() { python3 -c "import sys,json;print(json.load(sys.stdin)$1)" 2>/dev/null; }

# ── clean ────────────────────────────────────────────────────────────────────
if [[ "${1:-}" == "--clean" ]]; then
  say "Removing DEMO data"
  sqlv "
  DO \$\$
  DECLARE ev UUID; t UUID;
  BEGIN
    FOR ev IN SELECT id FROM events WHERE name LIKE 'DEMO %' LOOP
      DELETE FROM match_player_stats WHERE match_id IN (SELECT id FROM matches WHERE event_id = ev);
      DELETE FROM event_fixtures WHERE event_id = ev;
      DELETE FROM matches WHERE event_id = ev;
      DELETE FROM event_referees WHERE event_id = ev;
      DELETE FROM event_teams WHERE event_id = ev;
      DELETE FROM events WHERE id = ev;
    END LOOP;
    FOR t IN SELECT id FROM teams WHERE name LIKE 'DEMO %' LOOP
      DELETE FROM match_player_stats WHERE team_id = t;
      DELETE FROM matches WHERE home_team_id = t OR away_team_id = t;
      DELETE FROM event_teams WHERE team_id = t;
      DELETE FROM team_members WHERE team_id = t;
      DELETE FROM teams WHERE id = t;
    END LOOP;
    DELETE FROM notifications WHERE title LIKE '%DEMO%' OR body LIKE '%DEMO%';
    DELETE FROM users WHERE name LIKE 'DEMO %';
  END \$\$;"
  say "Clean."
  exit 0
fi

# ── preflight ────────────────────────────────────────────────────────────────
say "Checking services"
curl -s --max-time 5 --retry 20 --retry-delay 2 --retry-all-errors "${API%/v1}/health" >/dev/null \
  || fail "Backend not reachable at ${API%/v1}. Try: docker compose up -d"
info "backend    ok"
curl -s --max-time 5 http://localhost:18000/health >/dev/null && info "rating-engine ok" \
  || info "rating-engine DOWN (ratings will not compute)"

# ── 1. organizer ─────────────────────────────────────────────────────────────
say "1. Organizer"
ADMIN=$(token '{"key":"ranjit","role":"admin","name":"DEMO Admin"}')
ORG=$(token '{"key":"demo-org","name":"DEMO Turf Owner"}')
[[ -n "$ORG" ]] || fail "could not mint a session — is the backend healthy?"
ORGID=$(sql "SELECT id FROM users WHERE firebase_uid='dev-uid-demo-org';")

ROLE=$(sql "SELECT role FROM users WHERE id='$ORGID';")
if [[ "$ROLE" != "organizer" ]]; then
  curl -s -m 10 -X POST "$API/organizer/apply" -H "Authorization: Bearer $ORG" \
    -H 'Content-Type: application/json' \
    -d '{"full_name":"DEMO Turf Owner","city":"Mumbai","venue_name":"DEMO Powai Turf"}' >/dev/null
  APPID=$(curl -s -m 10 "$API/admin/referee-applications?status=pending&request_type=organizer" \
    -H "Authorization: Bearer $ADMIN" | jq_field '["applications"][0]["id"]')
  curl -s -m 10 -X POST "$API/admin/referee-applications/$APPID/approve" \
    -H "Authorization: Bearer $ADMIN" >/dev/null
  info "applied and approved"
else
  info "already an organizer"
fi
info "role = $(sql "SELECT role FROM users WHERE id='$ORGID';")"

# ── 2. event ─────────────────────────────────────────────────────────────────
say "2. Event"
EV=$(curl -s -m 10 -X POST "$API/events" -H "Authorization: Bearer $ORG" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"DEMO Sunday Cup\",\"sport_slug\":\"football\",\"format\":\"group_knockout\",\"match_format\":\"5-a-side\",\"match_duration_minutes\":12,\"city\":\"Mumbai\",\"venue\":\"DEMO Powai Turf\",\"max_teams\":$TEAM_COUNT,\"entry_fee\":200000,\"starts_at\":\"$(date -u -v+1d +%Y-%m-%dT09:00:00.000Z 2>/dev/null || date -u -d '+1 day' +%Y-%m-%dT09:00:00.000Z)\"}" \
  | jq_field '["id"]')
[[ -n "$EV" ]] || fail "event creation failed (is the organizer approved?)"
info "event $EV"
info "tier at creation = $(sql "SELECT tier FROM events WHERE id='$EV';")  (always amateur — tier is not settable at creation)"

# ── 3. referees, then tier ───────────────────────────────────────────────────
say "3. Referees, then tier"
REF=$(token '{"key":"demo-ref","role":"referee","referee_tier":"semi_pro","name":"DEMO Referee"}')
REFID=$(sql "SELECT id FROM users WHERE firebase_uid='dev-uid-demo-ref';")
curl -s -m 10 -X POST "$API/events/$EV/referees" -H "Authorization: Bearer $ORG" \
  -H 'Content-Type: application/json' \
  -d "{\"referees\":[{\"user_id\":\"$REFID\",\"pitch_label\":\"Pitch 1\"}]}" >/dev/null
info "assigned DEMO Referee (semi_pro) to Pitch 1"

info "trying tier=pro   → $(curl -s -m 10 -X PATCH "$API/events/$EV/tier" -H "Authorization: Bearer $ORG" -H 'Content-Type: application/json' -d '{"tier":"pro"}' | head -c 100)"
info "trying tier=semi_pro → $(curl -s -m 10 -X PATCH "$API/events/$EV/tier" -H "Authorization: Bearer $ORG" -H 'Content-Type: application/json' -d '{"tier":"semi_pro"}' | head -c 80)"

# ── 4. registration ──────────────────────────────────────────────────────────
say "4. Team registration (captains + guest players)"
curl -s -m 10 -X PATCH "$API/events/$EV/status" -H "Authorization: Bearer $ORG" \
  -H 'Content-Type: application/json' -d '{"status":"registration"}' >/dev/null
info "registration opened"

for i in $(seq 1 "$TEAM_COUNT"); do
  CAP=$(token "{\"key\":\"demo-cap$i\",\"name\":\"DEMO Captain $i\"}")
  RES=$(curl -s -m 15 -X POST "$API/events/$EV/register" -H "Authorization: Bearer $CAP" \
    -H 'Content-Type: application/json' \
    -d "{\"team_name\":\"DEMO Team $i\",\"city\":\"Mumbai\",\"players\":[{\"name\":\"DEMO Guest ${i}A\"},{\"name\":\"DEMO Guest ${i}B\"},{\"name\":\"DEMO Guest ${i}C\"},{\"name\":\"DEMO Guest ${i}D\"}]}")
  info "team $i → $(echo "$RES" | jq_field '["team_name"]' 2>/dev/null || echo "$RES" | head -c 70)"
done
info "registered: $(sql "SELECT COUNT(*) FROM event_teams WHERE event_id='$EV';") teams, $(sql "SELECT COUNT(*) FROM users WHERE name LIKE 'DEMO Guest%';") guests created"

# ── 5. fixtures ──────────────────────────────────────────────────────────────
say "5. Generate fixtures"
GEN=$(curl -s -m 30 -X POST "$API/events/$EV/fixtures" -H "Authorization: Bearer $ORG")
info "$GEN"
sqlv "SELECT ef.round, ef.slot_no, to_char(ef.scheduled_at,'HH24:MI') AS at, ef.pitch_label,
             COALESCE(ht.name,'(pending)') AS home, COALESCE(at2.name,'(pending)') AS away
      FROM event_fixtures ef
      LEFT JOIN teams ht ON ht.id=ef.home_team_id
      LEFT JOIN teams at2 ON at2.id=ef.away_team_id
      WHERE ef.event_id='$EV' ORDER BY ef.scheduled_at;"

# ── 6. play it ───────────────────────────────────────────────────────────────
say "6. Play every match (referee scores, bracket advances itself)"
curl -s -m 10 -X PATCH "$API/events/$EV/status" -H "Authorization: Bearer $ORG" \
  -H 'Content-Type: application/json' -d '{"status":"active"}' >/dev/null
# Driven entirely through the API — GET /events/:id/fixtures and
# GET /events/:id/teams give everything needed. An earlier version shelled out to
# `docker exec psql` for every query and Docker Desktop buckled under the churn,
# failing partway through. Using the product's own endpoints is both more robust
# and a better test.
python3 - "$API" "$EV" "$REF" <<'PY'
import json, sys, urllib.request, urllib.error, uuid, datetime

API, EV, REF = sys.argv[1], sys.argv[2], sys.argv[3]

import time

def call(method, path, body=None, auth=True, _retries=3):
    """
    One API call, backing off on 429.

    The API rate-limits at 100 requests/minute and a full tournament is a few
    hundred calls, so a demo that ignores the limit silently produces garbage —
    which is exactly what an earlier version of this script did.
    """
    for attempt in range(_retries):
        req = urllib.request.Request(f"{API}{path}", method=method)
        # Only declare a JSON body when there IS one. Sending
        # Content-Type: application/json with an empty body makes Fastify try to
        # parse it and return 400 — which is what made every /complete call fail
        # in an earlier version of this script.
        data = json.dumps(body).encode() if body is not None else None
        if data is not None:
            req.add_header("Content-Type", "application/json")
        if auth:
            req.add_header("Authorization", f"Bearer {REF}")
        try:
            with urllib.request.urlopen(req, data, timeout=30) as r:
                raw = r.read().decode()
                return r.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as e:
            raw = e.read().decode()
            try:
                parsed = json.loads(raw)
            except Exception:
                parsed = raw
            rate_limited = e.code == 429 or (
                isinstance(parsed, dict) and "Too many requests" in str(parsed.get("error", ""))
            )
            if rate_limited and attempt < _retries - 1:
                print("  (rate limited — waiting for the window to clear)")
                time.sleep(20)
                continue
            return e.code, parsed
    return 0, None

# Rosters, keyed by team.
_, teams = call("GET", f"/events/{EV}/teams")
roster = {t["team_id"]: t["players"] for t in teams["teams"]}

played = 0
# Play in waves: fetch the fixture list once, play everything currently playable,
# then re-fetch to pick up knockout matches the resolver has since created. That
# keeps the request count well under the rate limit, unlike re-polling per match.
for _wave in range(6):
    code, fx = call("GET", f"/events/{EV}/fixtures")
    if code != 200 or not isinstance(fx, dict) or "fixtures" not in fx:
        print(f"  could not read fixtures ({code}): {fx}")
        break
    playable = [f for f in fx["fixtures"] if f["match_id"] and f["match_status"] == "scheduled"]
    if not playable:
        break

    for nxt in playable:
        played += 1
        mid, home, away = nxt["match_id"], nxt["home_team_id"], nxt["away_team_id"]

        # The same sequence TournamentScorecard uses. Completion is LAST because it is
        # what locks the ratings.
        now = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
        entries, hg, ag = [], 0, 0
        for side, tid in (("home", home), ("away", away)):
            for i, p in enumerate(roster.get(tid, [])):
                goals = 1 if (side == "home" and i % 2 == 0) else 0
                keeper = i == len(roster.get(tid, [])) - 1
                stats = {"goals": goals, "assists": 1 if i % 3 == 0 else 0,
                         "saves": 3 if keeper else 0}
                if side == "home":
                    hg += goals
                else:
                    ag += goals
                e = {"user_id": p["user_id"], "team_id": tid, "stats": stats,
                     "client_event_id": str(uuid.uuid4()), "client_timestamp": now}
                if keeper:
                    e["position"] = "GK"
                entries.append(e)
        if hg == ag:
            hg += 1  # knockout ties must be decisive

        call("POST", f"/matches/{mid}/stats/batch", {"entries": entries})
        call("PATCH", f"/matches/{mid}/score",
             {"home_score": {"goals": hg}, "away_score": {"goals": ag}})

        # Pull the algorithm's stars and approve them unchanged — the normal case.
        code, sug = call("POST", f"/matches/{mid}/rating-suggestions", {})
        if code == 200 and sug.get("players"):
            call("POST", f"/matches/{mid}/ratings", {"ratings": [
                {"user_id": p["user_id"], "rating": float(p["suggested_rating"] or 0)}
                for p in sug["players"]
            ]})

        code, _ = call("POST", f"/matches/{mid}/complete", {})
        print(f"  {nxt['round']:9s} {hg}–{ag}  → {code}")

print(f"  played {played} matches")
PY
sqlv "SELECT t.name, et.played, et.won, et.drawn, et.lost, et.goals_for AS gf, et.points
      FROM event_teams et JOIN teams t ON t.id=et.team_id
      WHERE et.event_id='$EV' ORDER BY et.group_no, et.points DESC;"

# ── 7. guest claim link ──────────────────────────────────────────────────────
say "7. Guest claim link"
GUEST=$(sql "SELECT u.id FROM users u WHERE u.name LIKE 'DEMO Guest%' AND u.is_guest=true AND u.claimed_at IS NULL LIMIT 1;")
CLAIM=$(curl -s -m 10 -X POST "$API/guests/$GUEST/claim-link" -H "Authorization: Bearer $REF")
CLAIM_URL=$(echo "$CLAIM" | jq_field '["claim_url"]')
info "for $(echo "$CLAIM" | jq_field '["guest_name"]')"

# ── 8. notifications ─────────────────────────────────────────────────────────
say "8. Notifications generated"
sqlv "SELECT type, title, COUNT(*) AS recipients FROM notifications GROUP BY 1,2 ORDER BY 1;"

# ── done ─────────────────────────────────────────────────────────────────────
cat <<BANNER

$(printf '\033[1;32m════════════════════════════════════════════════════════════\033[0m')
  OPEN THESE
$(printf '\033[1;32m════════════════════════════════════════════════════════════\033[0m')

  Public tournament page   (no login needed — this is the spectator view)
    $WEB/e/$EV

  Guest claim link         (what a guest gets over WhatsApp)
    $CLAIM_URL

  The app                  (dev quick-login: Player / Referee / Admin)
    $WEB

  Raw public API           (see exactly what a stranger can read)
    $API/public/events/$EV

  Referee scorecard preview (dev only)
    $WEB/dev-preview?match=<any scheduled match id>&as=demo-ref

  Tear it all down again:
    ./scripts/demo-tournament.sh --clean

BANNER
