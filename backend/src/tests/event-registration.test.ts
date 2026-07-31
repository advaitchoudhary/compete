/**
 * Integration tests — a captain registers their whole squad into a tournament.
 * Guest players are the primary path: at a turf tournament most of a roster has
 * no account, so the captain simply types names.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.mock('../shared/queue/ratings.stream', () => ({
  enqueueRatingJob: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../modules/auth/auth.service', () => ({
  initFirebase: vi.fn(),
  verifyFirebaseToken: vi.fn().mockResolvedValue({
    uid: 'test-reg-uid',
    phone_number: '+919999999003',
    email: undefined,
  }),
  issueJwt: vi.fn().mockReturnValue('test-jwt-token'),
}))

import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import { eventRegistrationRoutes } from '../modules/events/event-registration.routes'
import { getDb } from '../shared/db/client'

const TEST_JWT_SECRET = 'test-jwt-secret-minimum-32-chars-long'

const ORGANIZER_ID = '550e8400-e29b-41d4-a716-4466554403c1'
const CAPTAIN_A_ID = '550e8400-e29b-41d4-a716-4466554403c2'
const CAPTAIN_B_ID = '550e8400-e29b-41d4-a716-4466554403c3'
const KNOWN_PLAYER_ID = '550e8400-e29b-41d4-a716-4466554403c4'

const ALL_TEST_USERS = [ORGANIZER_ID, CAPTAIN_A_ID, CAPTAIN_B_ID, KNOWN_PLAYER_ID]

let openEventId: string
let closedEventId: string
let footballSportId: string

async function buildTestApp() {
  const app = Fastify({ logger: false })
  await app.register(jwt, { secret: TEST_JWT_SECRET })
  await app.register(eventRegistrationRoutes, { prefix: '/v1' })
  return app
}

function makeAuthHeader(userId: string, app: any): string {
  return `Bearer ${app.jwt.sign({ sub: userId }, { expiresIn: '1h' })}`
}

async function seedUser(id: string, name: string, role: string) {
  await getDb()
    .insertInto('users')
    .values({ id, name, role: role as any })
    .onConflict((oc) => oc.column('id').doUpdateSet({ role: role as any }))
    .execute()
}

/**
 * Children before parents. Also removes guest users created by these tests and
 * any teams they produced, which would otherwise block deleting the captains.
 */
async function cleanupTestData() {
  const db = getDb()

  const events = await db
    .selectFrom('events')
    .select('id')
    .where('organizer_id', 'in', ALL_TEST_USERS)
    .execute()
  const eventIds = events.map((e) => e.id)

  const teams = await db
    .selectFrom('teams')
    .select('id')
    .where('organizer_id', 'in', ALL_TEST_USERS)
    .execute()
  const teamIds = teams.map((t) => t.id)

  const guests = await db
    .selectFrom('users')
    .select('id')
    .where('created_by', 'in', ALL_TEST_USERS)
    .execute()
  const guestIds = guests.map((g) => g.id)

  if (eventIds.length > 0) {
    await db.deleteFrom('event_teams').where('event_id', 'in', eventIds).execute()
    await db.deleteFrom('event_referees').where('event_id', 'in', eventIds).execute()
  }
  if (teamIds.length > 0) {
    await db.deleteFrom('event_teams').where('team_id', 'in', teamIds).execute()
    await db.deleteFrom('team_members').where('team_id', 'in', teamIds).execute()
  }
  if (guestIds.length > 0) {
    await db.deleteFrom('team_members').where('user_id', 'in', guestIds).execute()
  }
  await db.deleteFrom('team_members').where('user_id', 'in', ALL_TEST_USERS).execute()
  if (teamIds.length > 0) {
    await db.deleteFrom('teams').where('id', 'in', teamIds).execute()
  }
  if (eventIds.length > 0) {
    await db.deleteFrom('events').where('id', 'in', eventIds).execute()
  }
  if (guestIds.length > 0) {
    await db.deleteFrom('users').where('id', 'in', guestIds).execute()
  }
  await db.deleteFrom('organizer_scores').where('user_id', 'in', ALL_TEST_USERS).execute()
  await db.deleteFrom('users').where('id', 'in', ALL_TEST_USERS).execute()
}

describe('Team self-registration', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>

  beforeAll(async () => {
    app = await buildTestApp()
    await app.ready()

    await cleanupTestData()

    await seedUser(ORGANIZER_ID, 'Turf Owner', 'organizer')
    await seedUser(CAPTAIN_A_ID, 'Captain A', 'player')
    await seedUser(CAPTAIN_B_ID, 'Captain B', 'player')
    await seedUser(KNOWN_PLAYER_ID, 'Known Player', 'player')

    const db = getDb()
    const sport = await db
      .selectFrom('sports')
      .select('id')
      .where('slug', '=', 'football')
      .executeTakeFirstOrThrow()
    footballSportId = sport.id

    const open = await db
      .insertInto('events')
      .values({
        name: 'Open Registration Cup',
        sport_id: footballSportId,
        organizer_id: ORGANIZER_ID,
        format: 'group_knockout',
        match_format: '5-a-side',
        city: 'Mumbai',
        status: 'registration',
        max_teams: 2,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    openEventId = open.id

    const closed = await db
      .insertInto('events')
      .values({
        name: 'Not Yet Open Cup',
        sport_id: footballSportId,
        organizer_id: ORGANIZER_ID,
        format: 'knockout',
        match_format: '5-a-side',
        city: 'Mumbai',
        status: 'upcoming',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    closedEventId = closed.id
  })

  afterAll(async () => {
    await cleanupTestData()
    await app.close()
  })

  it('requires authentication', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${openEventId}/register`,
      payload: { team_name: 'Anon FC', players: [{ name: 'Someone' }] },
    })
    expect(res.statusCode).toBe(401)
  })

  it('returns 404 for an unknown event', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/events/550e8400-e29b-41d4-a716-4466554403ff/register',
      headers: { authorization: makeAuthHeader(CAPTAIN_A_ID, app) },
      // A valid body, so we reach the event lookup rather than stopping at 400.
      payload: {
        team_name: 'Ghost FC',
        players: [{ name: 'G1' }, { name: 'G2' }, { name: 'G3' }, { name: 'G4' }],
      },
    })
    expect(res.statusCode).toBe(404)
  })

  it('refuses registration when the organizer has not opened it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${closedEventId}/register`,
      headers: { authorization: makeAuthHeader(CAPTAIN_A_ID, app) },
      payload: {
        team_name: 'Too Early FC',
        players: [{ name: 'P1' }, { name: 'P2' }, { name: 'P3' }, { name: 'P4' }],
      },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('not accepting registrations')
  })

  it('rejects a player entry carrying both user_id and name', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${openEventId}/register`,
      headers: { authorization: makeAuthHeader(CAPTAIN_A_ID, app) },
      payload: {
        team_name: 'Confused FC',
        players: [{ user_id: KNOWN_PLAYER_ID, name: 'Also A Name' }],
      },
    })
    expect(res.statusCode).toBe(400)
  })

  it('enforces the minimum squad size for the a-side format', async () => {
    // 5-a-side needs 5. Captain counts as one, so 3 more is only 4.
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${openEventId}/register`,
      headers: { authorization: makeAuthHeader(CAPTAIN_A_ID, app) },
      payload: {
        team_name: 'Short Squad FC',
        players: [{ name: 'P1' }, { name: 'P2' }, { name: 'P3' }],
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('at least 5')
  })

  it('registers a squad that is mostly guests', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${openEventId}/register`,
      headers: { authorization: makeAuthHeader(CAPTAIN_A_ID, app) },
      payload: {
        team_name: 'Powai Strikers',
        city: 'Mumbai',
        players: [
          { user_id: KNOWN_PLAYER_ID },
          { name: 'Rohit Sharma' },
          { name: 'Imran Khan' },
          { name: 'Sunil Chhetri' },
        ],
      },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.team_name).toBe('Powai Strikers')
    // captain + 4 = 5
    expect(body.roster).toHaveLength(5)
    expect(body.roster.filter((r: any) => r.is_guest)).toHaveLength(3)
    expect(body.roster.find((r: any) => r.user_id === CAPTAIN_A_ID).role).toBe('captain')

    // The guests are real users rows, attributed to the captain who typed them.
    const guests = await getDb()
      .selectFrom('users')
      .select(['name', 'is_guest', 'created_by', 'phone'])
      .where('created_by', '=', CAPTAIN_A_ID)
      .execute()
    expect(guests).toHaveLength(3)
    for (const g of guests) {
      expect(g.is_guest).toBe(true)
      expect(g.phone).toBeNull()
    }
  })

  it('rejects a duplicate team name in the same event, case-insensitively', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${openEventId}/register`,
      headers: { authorization: makeAuthHeader(CAPTAIN_B_ID, app) },
      payload: {
        team_name: '  powai strikers ',
        players: [{ name: 'Q1' }, { name: 'Q2' }, { name: 'Q3' }, { name: 'Q4' }],
      },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('already registered')
  })

  it('blocks a player from joining a second team in the same event', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${openEventId}/register`,
      headers: { authorization: makeAuthHeader(CAPTAIN_B_ID, app) },
      payload: {
        team_name: 'Poachers FC',
        players: [{ user_id: KNOWN_PLAYER_ID }, { name: 'R1' }, { name: 'R2' }, { name: 'R3' }],
      },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('already registered in this event')
  })

  it('blocks the same captain from registering twice in one event', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${openEventId}/register`,
      headers: { authorization: makeAuthHeader(CAPTAIN_A_ID, app) },
      payload: {
        team_name: 'Second Team FC',
        players: [{ name: 'S1' }, { name: 'S2' }, { name: 'S3' }, { name: 'S4' }],
      },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('already registered in this event')
  })

  it('refuses an unknown user_id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${openEventId}/register`,
      headers: { authorization: makeAuthHeader(CAPTAIN_B_ID, app) },
      payload: {
        team_name: 'Phantom FC',
        players: [
          { user_id: '550e8400-e29b-41d4-a716-4466554403fe' },
          { name: 'T1' },
          { name: 'T2' },
          { name: 'T3' },
        ],
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('unknown user_id')
  })

  it('enforces max_teams capacity', async () => {
    // max_teams is 2 and Powai Strikers took the first slot. Fill the second.
    const second = await app.inject({
      method: 'POST',
      url: `/v1/events/${openEventId}/register`,
      headers: { authorization: makeAuthHeader(CAPTAIN_B_ID, app) },
      payload: {
        team_name: 'Galacticos B',
        players: [{ name: 'U1' }, { name: 'U2' }, { name: 'U3' }, { name: 'U4' }],
      },
    })
    expect(second.statusCode).toBe(201)

    // A third team must be turned away.
    const third = await app.inject({
      method: 'POST',
      url: `/v1/events/${openEventId}/register`,
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
      payload: {
        team_name: 'One Too Many FC',
        players: [{ name: 'V1' }, { name: 'V2' }, { name: 'V3' }, { name: 'V4' }],
      },
    })
    expect(third.statusCode).toBe(409)
    expect(third.json().error).toContain('full')
  })

  it('GET /v1/events/:id/teams returns every squad with its roster', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/events/${openEventId}/teams`,
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.count).toBe(2)

    const strikers = body.teams.find((t: any) => t.name === 'Powai Strikers')
    expect(strikers).toBeDefined()
    expect(strikers.players).toHaveLength(5)
    expect(strikers.players.filter((p: any) => p.is_guest)).toHaveLength(3)
    expect(strikers.players.find((p: any) => p.role === 'captain').user_id).toBe(CAPTAIN_A_ID)
  })

  it('GET /v1/events/:id/teams requires authentication', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/events/${openEventId}/teams`,
    })
    expect(res.statusCode).toBe(401)
  })

  it('GET /v1/events/:id/teams 404s for an unknown event', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/events/550e8400-e29b-41d4-a716-4466554403fd/teams',
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
    })
    expect(res.statusCode).toBe(404)
  })
})
