/**
 * Integration tests — assigning referees to an event.
 * The organizer picks from already-approved referees; this is the pool the
 * fixture generator later draws from. The organizer never gains scoring rights.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.mock('../shared/queue/ratings.stream', () => ({
  enqueueRatingJob: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../modules/auth/auth.service', () => ({
  initFirebase: vi.fn(),
  verifyFirebaseToken: vi.fn().mockResolvedValue({
    uid: 'test-eventref-uid',
    phone_number: '+919999999002',
    email: undefined,
  }),
  issueJwt: vi.fn().mockReturnValue('test-jwt-token'),
}))

import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import { eventRefereesRoutes } from '../modules/events/event-referees.routes'
import { getDb } from '../shared/db/client'

const TEST_JWT_SECRET = 'test-jwt-secret-minimum-32-chars-long'

const ORGANIZER_ID = '550e8400-e29b-41d4-a716-4466554402b1'
const OTHER_ORGANIZER_ID = '550e8400-e29b-41d4-a716-4466554402b2'
const REFEREE_A_ID = '550e8400-e29b-41d4-a716-4466554402b3'
const REFEREE_B_ID = '550e8400-e29b-41d4-a716-4466554402b4'
const PLAYER_ID = '550e8400-e29b-41d4-a716-4466554402b5'

const ALL_TEST_USERS = [
  ORGANIZER_ID,
  OTHER_ORGANIZER_ID,
  REFEREE_A_ID,
  REFEREE_B_ID,
  PLAYER_ID,
]

let eventId: string

async function buildTestApp() {
  const app = Fastify({ logger: false })
  await app.register(jwt, { secret: TEST_JWT_SECRET })
  await app.register(eventRefereesRoutes, { prefix: '/v1' })
  return app
}

function makeAuthHeader(userId: string, app: any): string {
  return `Bearer ${app.jwt.sign({ sub: userId }, { expiresIn: '1h' })}`
}

async function seedUser(id: string, name: string, role: string, refereeTier?: string) {
  await getDb()
    .insertInto('users')
    .values({ id, name, role: role as any, referee_tier: (refereeTier ?? null) as any })
    .onConflict((oc) =>
      oc.column('id').doUpdateSet({
        role: role as any,
        referee_tier: (refereeTier ?? null) as any,
      })
    )
    .execute()
}

/** Children first, so a mid-test failure can't leave FK-blocking rows behind. */
async function cleanupTestData() {
  const db = getDb()
  const events = await db
    .selectFrom('events')
    .select('id')
    .where('organizer_id', 'in', ALL_TEST_USERS)
    .execute()
  const eventIds = events.map((e) => e.id)
  if (eventIds.length > 0) {
    await db.deleteFrom('event_referees').where('event_id', 'in', eventIds).execute()
    await db.deleteFrom('events').where('id', 'in', eventIds).execute()
  }
  await db.deleteFrom('event_referees').where('user_id', 'in', ALL_TEST_USERS).execute()
  await db.deleteFrom('organizer_scores').where('user_id', 'in', ALL_TEST_USERS).execute()
  await db.deleteFrom('users').where('id', 'in', ALL_TEST_USERS).execute()
}

describe('Event referees', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>

  beforeAll(async () => {
    app = await buildTestApp()
    await app.ready()

    await cleanupTestData()

    await seedUser(ORGANIZER_ID, 'Turf Owner', 'organizer')
    await seedUser(OTHER_ORGANIZER_ID, 'Rival Owner', 'organizer')
    await seedUser(REFEREE_A_ID, 'Referee A', 'referee', 'amateur')
    await seedUser(REFEREE_B_ID, 'Referee B', 'referee', 'semi_pro')
    await seedUser(PLAYER_ID, 'Just A Player', 'player')

    const db = getDb()
    const sport = await db
      .selectFrom('sports')
      .select('id')
      .where('slug', '=', 'football')
      .executeTakeFirstOrThrow()

    const event = await db
      .insertInto('events')
      .values({
        name: 'Referee Assignment Cup',
        sport_id: sport.id,
        organizer_id: ORGANIZER_ID,
        format: 'group_knockout',
        city: 'Mumbai',
        status: 'registration',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    eventId = event.id
  })

  afterAll(async () => {
    await cleanupTestData()
    await app.close()
  })

  it('requires the organizer role', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/referees`,
      headers: { authorization: makeAuthHeader(PLAYER_ID, app) },
      payload: { referees: [{ user_id: REFEREE_A_ID }] },
    })
    expect(res.statusCode).toBe(403)
  })

  it('refuses an organizer who does not own the event', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/referees`,
      headers: { authorization: makeAuthHeader(OTHER_ORGANIZER_ID, app) },
      payload: { referees: [{ user_id: REFEREE_A_ID }] },
    })
    expect(res.statusCode).toBe(403)
  })

  it('returns 404 for an unknown event', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/events/550e8400-e29b-41d4-a716-4466554402ff/referees',
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
      payload: { referees: [{ user_id: REFEREE_A_ID }] },
    })
    expect(res.statusCode).toBe(404)
  })

  it('refuses a user who is not an approved referee', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/referees`,
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
      payload: { referees: [{ user_id: PLAYER_ID }] },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('not an approved referee')
  })

  it('assigns referees with pitch labels', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/referees`,
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
      payload: {
        referees: [
          { user_id: REFEREE_A_ID, pitch_label: 'Pitch 1' },
          { user_id: REFEREE_B_ID, pitch_label: 'Pitch 2' },
        ],
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().count).toBe(2)
  })

  it('GET returns the assigned referees with their names and tiers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/events/${eventId}/referees`,
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.count).toBe(2)
    const labels = body.referees.map((r: any) => r.pitch_label).sort()
    expect(labels).toEqual(['Pitch 1', 'Pitch 2'])
    const tiers = body.referees.map((r: any) => r.referee_tier).sort()
    expect(tiers).toEqual(['amateur', 'semi_pro'])
  })

  it('replaces the roster rather than appending', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/referees`,
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
      payload: { referees: [{ user_id: REFEREE_A_ID, pitch_label: 'Pitch 1' }] },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().count).toBe(1)

    const rows = await getDb()
      .selectFrom('event_referees')
      .select('user_id')
      .where('event_id', '=', eventId)
      .execute()
    expect(rows).toHaveLength(1)
    expect(rows[0].user_id).toBe(REFEREE_A_ID)
  })

  it('rejects a duplicate referee in one request', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/referees`,
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
      payload: {
        referees: [
          { user_id: REFEREE_A_ID, pitch_label: 'Pitch 1' },
          { user_id: REFEREE_A_ID, pitch_label: 'Pitch 2' },
        ],
      },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('duplicate')
  })
})
