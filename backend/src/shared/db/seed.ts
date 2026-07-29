/**
 * Dev seed — a referee + 12 football players + 2 teams + a scheduled match.
 *
 * Idempotent: re-running reuses existing rows (keyed by firebase_uid / team name
 * / an open match between the two teams). Every seeded user has a
 * `dev-uid-<key>` firebase_uid, so you can grab a token for any of them via:
 *
 *     POST /v1/auth/dev-token  { "key": "ref" }   // or p01 .. p12
 *
 * Run:  npm run db:seed   (inside the backend container or with DATABASE_URL set)
 */
import 'dotenv/config'
import { getDb } from './client'
import type { UserRole } from './types'

const CITY = 'Delhi'

// 6-a-side lineups (12 players). p01 & p07 are the team captains.
const TEAM_A = {
  name: 'Thunderbolts FC',
  players: [
    { key: 'p01', name: 'Arjun Mehta',    position: 'GK',  jersey: 1, captain: true },
    { key: 'p02', name: 'Rohan Verma',    position: 'DEF', jersey: 2 },
    { key: 'p03', name: 'Karan Nair',     position: 'DEF', jersey: 3 },
    { key: 'p04', name: 'Sahil Khan',     position: 'MID', jersey: 4 },
    { key: 'p05', name: 'Devansh Iyer',   position: 'FWD', jersey: 9 },
    { key: 'p06', name: 'Manish Gupta',   position: 'FWD', jersey: 11 },
  ],
}
const TEAM_B = {
  name: 'Galacticos FC',
  players: [
    { key: 'p07', name: 'Imran Sheikh',   position: 'GK',  jersey: 1, captain: true },
    { key: 'p08', name: 'Vivek Rana',     position: 'DEF', jersey: 5 },
    { key: 'p09', name: 'Aditya Joshi',   position: 'DEF', jersey: 6 },
    { key: 'p10', name: 'Nikhil Reddy',   position: 'MID', jersey: 8 },
    { key: 'p11', name: 'Yash Malhotra',  position: 'FWD', jersey: 10 },
    { key: 'p12', name: 'Tarun Pillai',   position: 'FWD', jersey: 7 },
  ],
}

type Db = ReturnType<typeof getDb>

async function ensureUser(
  db: Db,
  key: string,
  name: string,
  role: UserRole
): Promise<string> {
  const firebaseUid = `dev-uid-${key}`
  const existing = await db
    .selectFrom('users')
    .select('id')
    .where('firebase_uid', '=', firebaseUid)
    .executeTakeFirst()

  const refereeTier = role === 'referee' ? 'amateur' : null

  if (existing) {
    await db
      .updateTable('users')
      .set({ name, city: CITY, role, referee_tier: refereeTier })
      .where('id', '=', existing.id)
      .execute()
    return existing.id
  }

  const created = await db
    .insertInto('users')
    .values({ firebase_uid: firebaseUid, phone: `dev-${key}`, name, city: CITY, role, referee_tier: refereeTier })
    .returning('id')
    .executeTakeFirstOrThrow()
  return created.id
}

async function ensureTeam(
  db: Db,
  name: string,
  sportId: string,
  organizerId: string
): Promise<string> {
  const existing = await db
    .selectFrom('teams')
    .select('id')
    .where('name', '=', name)
    .where('sport_id', '=', sportId)
    .executeTakeFirst()
  if (existing) return existing.id

  const created = await db
    .insertInto('teams')
    .values({ name, sport_id: sportId, city: CITY, organizer_id: organizerId })
    .returning('id')
    .executeTakeFirstOrThrow()
  return created.id
}

async function seedRoster(
  db: Db,
  team: typeof TEAM_A
): Promise<{ teamId: string; captainId: string; playerIds: string[] }> {
  const playerIds: string[] = []
  for (const p of team.players) {
    playerIds.push(await ensureUser(db, p.key, p.name, 'player'))
  }
  const captainIdx = team.players.findIndex((p) => p.captain)
  const captainId = playerIds[captainIdx]

  // Team is organised by its captain
  const teamId = await ensureTeam(db, team.name, await footballId(db), captainId)

  for (let i = 0; i < team.players.length; i++) {
    const p = team.players[i]
    await db
      .insertInto('team_members')
      .values({
        team_id: teamId,
        user_id: playerIds[i],
        role: p.captain ? 'captain' : 'player',
        jersey_no: p.jersey,
      })
      .onConflict((oc) =>
        oc.columns(['team_id', 'user_id']).doUpdateSet({
          role: p.captain ? 'captain' : 'player',
          jersey_no: p.jersey,
          is_active: true,
        })
      )
      .execute()
  }

  return { teamId, captainId, playerIds }
}

let _footballId: string | undefined
async function footballId(db: Db): Promise<string> {
  if (_footballId) return _footballId
  const sport = await db
    .selectFrom('sports')
    .select('id')
    .where('slug', '=', 'football')
    .executeTakeFirstOrThrow()
  _footballId = sport.id
  return _footballId
}

async function main() {
  const db = getDb()
  const sportId = await footballId(db)

  const refereeId = await ensureUser(db, 'ref', 'Vikram Singh', 'referee')

  const a = await seedRoster(db, TEAM_A)
  const b = await seedRoster(db, TEAM_B)

  // Reuse an open (non-completed) match between the two teams, else create one.
  let match = await db
    .selectFrom('matches')
    .select(['id', 'status'])
    .where('home_team_id', '=', a.teamId)
    .where('away_team_id', '=', b.teamId)
    .where('status', 'in', ['scheduled', 'live'])
    .executeTakeFirst()

  if (!match) {
    match = await db
      .insertInto('matches')
      .values({
        sport_id: sportId,
        home_team_id: a.teamId,
        away_team_id: b.teamId,
        referee_id: refereeId,
        venue: 'Ambedkar Stadium, Delhi',
        round: 'Friendly',
        status: 'scheduled',
        scheduled_at: new Date(),
      })
      .returning(['id', 'status'])
      .executeTakeFirstOrThrow()
  }

  console.log('\n✅ Seed complete\n')
  console.log('Referee:      Vikram Singh   key="ref"   id=' + refereeId)
  console.log(`Team A:       ${TEAM_A.name}   id=${a.teamId}   (captain key=p01)`)
  console.log(`Team B:       ${TEAM_B.name}   id=${b.teamId}   (captain key=p07)`)
  console.log(`Match:        ${match.id}   status=${match.status}`)
  console.log('\nGrab a token for anyone:  POST /v1/auth/dev-token  {"key":"ref"|"p01".."p12"}')
  console.log('Start the match (as referee): PATCH /v1/matches/' + match.id + '/start\n')

  await db.destroy()
}

main().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
