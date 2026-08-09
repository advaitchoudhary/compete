# Tournament OS — how it works and how to run it

The product in one line: **a turf owner runs a Sunday tournament from their phone,
and every player walks away with a rating they can't fake.**

This document is the operating manual. Part 1 is the product model — the four roles
and why the rules are what they are. Part 2 is the click-by-click flow. Part 3 is
what is genuinely not built yet.

Written 2026-08-04, against branch `feat/organizer-foundation`.

---

## Part 1 — The product model

### The four roles

| Role | Who they are in real life | What they can do |
|---|---|---|
| **Player** | Someone who turns up to play | Register a squad, see their rating, claim a guest identity |
| **Referee** | A vetted official, graded amateur → legends | Score **only** matches they were assigned to |
| **Organizer** | The turf/venue owner | Create tournaments, assign referees, build brackets, open and close the day |
| **Admin** | You | Approve referee and organizer applications, set referee grades |

Roles are granted by an admin approving an application. Nobody self-promotes.

### The one idea everything else protects

A rating is only worth something if it cannot be bought. The entire design exists to
make one specific fraud impossible: **an organizer inventing a high-grade tournament
to inflate their friends' ratings.**

Four locks, and they compound:

1. **An organizer cannot score.** Assigning a referee grants the organizer no scoring
   ability whatsoever. Scoring requires the referee role *and* being the referee on
   that specific match.
2. **A tournament's grade is capped by its weakest referee.** Every match in a Pro
   tournament must be officiated at Pro level, so the lowest-graded official on the
   roster sets the ceiling for the whole event. An organizer with only amateur
   referees can only run an amateur tournament, full stop.
3. **Swapping referees after the fact is refused.** Set the grade to Pro with Pro
   referees, then try to swap them for amateurs, and the swap is rejected — the
   backend simulates the resulting roster before saving it.
4. **The grade freezes when the bracket is built.** Once fixtures exist the grade
   cannot change, so a finished amateur event can never be re-declared Legends to
   retroactively reweight everyone's rating.

Grade is not cosmetic. It is a multiplier on how far a result moves a rating:

| Grade | Weight |
|---|---|
| Amateur | 1.0× |
| Semi-Pro | 1.5× |
| Pro | 2.0× |
| Legends | 3.0× |

### Why referees define the schedule

There is no "how many pitches do you have?" field, and that is deliberate. **Pitch
capacity is derived from the referee roster** — you assign each referee to a pitch,
and the number of distinct pitches is how many matches can run in parallel.

The reason: a pitch with no referee cannot host a graded match, so a pitch you
*have* but cannot *staff* is not capacity. Deriving it from the roster makes it
impossible to schedule a day you can't actually officiate.

The practical consequence, which surprises people: **a referee with no pitch label
contributes nothing.** They're on the roster, they cap the grade, but they add no
capacity. The assignment screen warns about this.

### Guests: the thing that makes it usable at a real turf

Most players at a Sunday tournament have no account and won't make one. So a captain
registering a squad just **types their mates' names**. Each becomes a *guest* — a
real identity with real stats and a real rating, but no login.

Later, the guest gets a WhatsApp link, taps it, and the identity becomes their
account with all history intact. **Claiming the link IS signing in** — no password
step. This is the growth loop: one captain's typing produces N future users, each
already holding a rating they want to look at.

---

## Part 2 — Running a tournament

### Getting in

Log out, then use the dev quick-login buttons — no passwords:

| Button | Who | Role |
|---|---|---|
| ⚽ Player | Devansh | player |
| 🏟️ Organizer | Rohan | organizer |
| 🦓 Referee | Vikram | referee (semi-pro) |
| 🛡️ Admin | Ranjit | admin |

As Organizer: **Matches tab → 🏟️ Manage** → your control room.

### Step 0 · Create the tournament

**Matches → + Create.** Name, sport, format, players-per-side, match length, city,
max teams.

Two fields matter more than they look:

- **Players per side** sets the squad minimum at registration. 5-a-side rejects a
  4-player squad, 11-a-side needs 11. Cap is the minimum plus 7 for a bench.
- **Match length** is the slot length for the whole schedule and also weights the
  rating — a 12-minute game moves a rating less than a 90-minute one.

Only **Knockout** and **Groups + Knockout** are offered, because those are the only
two the bracket generator can build.

There is deliberately no grade field here. A brand-new event has no referees, so
nothing above Amateur could be authorised yet.

### Step 1 · Referees & pitches

Tap **Assign referees**. Search the pool of approved officials, tap to select, and
each gets the next free pitch automatically (usually what you want). Tap a pitch pill
to change it.

The header projects consequences live: **selected · pitches · max grade**. Pick a
weak referee and watch the ceiling drop.

It warns you about three real mistakes: nobody has a pitch, two referees share a
pitch (only one gets those matches), or the selection can no longer support the grade
you already set.

### Step 2 · Competition grade

Pill row. Options above what your roster supports are shown **locked with a 🔒** —
visible, so you can see what better referees would unlock, rather than hidden.

After the bracket is built this locks entirely and says so.

### Step 3 · Team sign-ups

**Open sign-ups** flips the event to accepting registrations, then **Copy public link
for WhatsApp**. That link is a real public page — no login, no app install — where
players see the bracket, the schedule and who's next up.

Captains register their own squads. **You never type in a team list.** Teams appear
in the control room as they arrive, with seeds.

You can close sign-ups again if you opened them too early.

### Step 4 · Build the bracket

If anything's missing, the amber box lists exactly what, and the button is disabled.
When it's clear, **Generate fixtures** builds the whole day in one transaction:
groups, knockout rounds, kick-off times, pitch assignments and referee-per-match.

**It handles any number of teams.** 5 teams, 9 teams, 13 — no power-of-two
requirement. Odd counts get a play-in round and byes for top seeds. If teams can't
split into equal groups (5 teams into 2 groups), it falls back to a straight knockout
and tells you why.

While nothing has kicked off you can **Rebuild bracket** — for when a team withdraws
an hour before. After the first whistle that option disappears.

### Step 5 · Match day

**Start tournament**, then step back. Referees score from their own phones: three
stats per player (goals, assists, saves), one goalkeeper tap per team, then approve
the algorithm's suggested star ratings or override them.

A referee can only score **their own** matches. Trying another pitch's match is
rejected outright.

As results land, winners propagate into later fixtures automatically —
"Winner of Semi-final 1" becomes a real team name. Group tables re-rank live, with
qualifying positions marked.

**Finish tournament** when done. It warns if matches are unplayed. Finishing is
final — a completed tournament cannot be reopened, because its ratings are published.

---

## Part 3 — What is NOT built

Being straight about this, because the gaps matter for planning.

### Blocks deployment

- **`backend/Dockerfile` is broken for this repo layout.** It runs `npm ci` against a
  per-package lockfile, but this is an npm workspaces monorepo with a single root
  lockfile. Local dev works because compose mounts the source. **Nothing can deploy
  until this is fixed** — it's the top priority before any real user sees this.

### Missing product surfaces

- **No admin UI for grading referees.** An admin can approve applications, but a
  referee's grade is set by direct DB access. Since the grade ceiling is the whole
  anti-fraud mechanism, this is the most important missing screen.
- **No cancel-tournament button.** The API supports it; the UI doesn't.
- **No organizer view of a squad's players.** You see team names and seeds, not who's
  in them.
- **`match_next` notification isn't implemented.** "Your match is in 10 minutes"
  needs a scheduler, and there isn't one. Fixtures-published and rating-ready
  notifications do work.

### Known behavioural limitations

- **Rest gaps aren't guaranteed across knockout rounds.** The scheduler avoids
  putting a *known* team in back-to-back slots, but a knockout fixture's teams aren't
  known when scheduling — so a semi-final winner can be scheduled straight into the
  final with no break. On the 5-team run: semi at 15:00, final at 15:12, 12-minute
  matches. For 5-a-side this is survivable; for 11-a-side it isn't. Fixing it means
  reserving rest windows for unresolved fixtures.
- **Group standings tie-breaks handle two-way ties only.** Three-way ties on points
  and goal difference fall through to seed order rather than a mini-table.
- **Guest claim links don't expire.**

### Testing state

- 130 backend tests, 41 rating-engine tests, 0 type errors.
- `npm test` in `backend/` now works with no env setup (the fallback ports were
  wrong — pointing at 5432/6379 rather than compose's 5433/6380).
- **An intermittent failure remains, roughly 1 run in 10.** Postgres logs
  `FATAL: connection to client lost` with transient FK violations. `fileParallelism:
  false` reduced it. Not reproducible on demand, cause unidentified. It has never
  failed twice in a row, so a re-run is currently the workaround — not a fix.
- All 30+ commits are on `feat/organizer-foundation`, never merged to `main`.

### The pattern worth remembering

Across all seven phases, **automated tests caught regressions well, but every genuine
design gap was found by looking at real data or rendered output**: the unset team
seeds, both scheduler bugs, the empty-squad state, the repeating group headers, the
`/complete` 400, and today the `play_in 1` label and the wrong test DB port. The
tests were green through all of them.
