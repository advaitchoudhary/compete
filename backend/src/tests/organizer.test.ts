/**
 * Integration tests — organizer identity:
 * apply → admin approves → role becomes 'organizer' → can create events.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

// Mock the rating-job producer so tests don't touch Redis
vi.mock('../shared/queue/ratings.stream', () => ({
  enqueueRatingJob: vi.fn().mockResolvedValue(undefined),
}))

// Mock Firebase admin
vi.mock('../modules/auth/auth.service', () => ({
  initFirebase: vi.fn(),
  verifyFirebaseToken: vi.fn().mockResolvedValue({
    uid: 'test-organizer-uid',
    phone_number: '+919999999001',
    email: undefined,
  }),
  issueJwt: vi.fn().mockReturnValue('test-jwt-token'),
}))

import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import { organizerRoutes } from '../modules/organizer/organizer.routes'
import { adminRoutes } from '../modules/admin/admin.routes'
import { eventsRoutes } from '../modules/events/events.routes'
import { getDb } from '../shared/db/client'

const TEST_JWT_SECRET = 'test-jwt-secret-minimum-32-chars-long'

const PLAYER_ID = '550e8400-e29b-41d4-a716-4466554401a1'
const ADMIN_ID = '550e8400-e29b-41d4-a716-4466554401a2'
const REFEREE_ID = '550e8400-e29b-41d4-a716-4466554401a3'
const OUTSIDER_ID = '550e8400-e29b-41d4-a716-4466554401a4'

const ALL_TEST_USERS = [PLAYER_ID, ADMIN_ID, REFEREE_ID, OUTSIDER_ID]

/**
 * Remove everything these tests could have created, children first.
 *
 * Run in both beforeAll and afterAll: if an assertion fails mid-test the
 * inline cleanup never runs, and a leftover events row would then block
 * deleting its owner via events_organizer_id_fkey — poisoning every later run.
 */
async function cleanupTestData() {
  const db = getDb()
  await db.deleteFrom('events').where('organizer_id', 'in', ALL_TEST_USERS).execute()
  await db.deleteFrom('referee_applications').where('user_id', 'in', ALL_TEST_USERS).execute()
  await db.deleteFrom('organizer_scores').where('user_id', 'in', ALL_TEST_USERS).execute()
  await db.deleteFrom('users').where('id', 'in', ALL_TEST_USERS).execute()
}

async function buildTestApp() {
  const app = Fastify({ logger: false })
  await app.register(jwt, { secret: TEST_JWT_SECRET })
  await app.register(organizerRoutes, { prefix: '/v1' })
  await app.register(adminRoutes, { prefix: '/v1' })
  await app.register(eventsRoutes, { prefix: '/v1' })
  return app
}

function makeAuthHeader(userId: string, app: any): string {
  return `Bearer ${app.jwt.sign({ sub: userId }, { expiresIn: '1h' })}`
}

async function seedUser(id: string, name: string, role: string, refereeTier?: string) {
  await getDb()
    .insertInto('users')
    .values({
      id,
      name,
      role: role as any,
      referee_tier: (refereeTier ?? null) as any,
    })
    .onConflict((oc) =>
      oc.column('id').doUpdateSet({
        role: role as any,
        referee_tier: (refereeTier ?? null) as any,
      })
    )
    .execute()
}

describe('Organizer identity', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>

  beforeAll(async () => {
    app = await buildTestApp()
    await app.ready()

    await cleanupTestData()
    await seedUser(PLAYER_ID, 'Test Player', 'player')
    await seedUser(ADMIN_ID, 'Test Admin', 'admin')
    await seedUser(REFEREE_ID, 'Test Referee', 'referee', 'amateur')
  })

  afterAll(async () => {
    await cleanupTestData()
    await app.close()
  })

  it('POST /v1/organizer/apply requires authentication', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/organizer/apply',
      payload: { full_name: 'Ravi Turf', city: 'Mumbai', venue_name: 'Powai Turf' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('POST /v1/organizer/apply validates the body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/organizer/apply',
      headers: { authorization: makeAuthHeader(PLAYER_ID, app) },
      payload: { full_name: 'R', city: 'M' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('a player can apply to become an organizer', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/organizer/apply',
      headers: { authorization: makeAuthHeader(PLAYER_ID, app) },
      payload: {
        full_name: 'Ravi Kumar',
        city: 'Mumbai',
        venue_name: 'Powai Turf Arena',
        bio: 'I run weekend 5-a-side tournaments.',
      },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.request_type).toBe('organizer')
    expect(body.status).toBe('pending')
    expect(body.requested_tier).toBeNull()
  })

  it('rejects a second pending application', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/organizer/apply',
      headers: { authorization: makeAuthHeader(PLAYER_ID, app) },
      payload: { full_name: 'Ravi Kumar', city: 'Mumbai', venue_name: 'Powai Turf Arena' },
    })
    expect(res.statusCode).toBe(409)
  })

  it('refuses an application from an existing referee', async () => {
    // A referee scores matches; an organizer must never score. One role each,
    // so a referee cannot also become an organizer.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/organizer/apply',
      headers: { authorization: makeAuthHeader(REFEREE_ID, app) },
      payload: { full_name: 'Test Referee', city: 'Delhi', venue_name: 'Any Turf' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('referee')
  })

  it('GET /v1/organizer/me reports role and latest application', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/organizer/me',
      headers: { authorization: makeAuthHeader(PLAYER_ID, app) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.role).toBe('player')
    expect(body.is_organizer).toBe(false)
    expect(body.application.request_type).toBe('organizer')
  })

  it('admin approval promotes the applicant to organizer, not referee', async () => {
    const db = getDb()
    const application = await db
      .selectFrom('referee_applications')
      .select('id')
      .where('user_id', '=', PLAYER_ID)
      .where('request_type', '=', 'organizer')
      .where('status', '=', 'pending')
      .executeTakeFirstOrThrow()

    const res = await app.inject({
      method: 'POST',
      url: `/v1/admin/referee-applications/${application.id}/approve`,
      headers: { authorization: makeAuthHeader(ADMIN_ID, app) },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().approved).toBe(true)

    const promoted = await db
      .selectFrom('users')
      .select(['role', 'referee_tier'])
      .where('id', '=', PLAYER_ID)
      .executeTakeFirstOrThrow()

    expect(promoted.role).toBe('organizer')
    // An organizer never officiates, so they must not be granted a referee tier.
    expect(promoted.referee_tier).toBeNull()
  })

  it('GET /v1/admin/referee-applications can filter by request_type', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/referee-applications?status=approved&request_type=organizer',
      headers: { authorization: makeAuthHeader(ADMIN_ID, app) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.applications.length).toBeGreaterThanOrEqual(1)
    for (const a of body.applications) {
      expect(a.request_type).toBe('organizer')
    }
  })

  it('rejects an invalid request_type filter', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/referee-applications?request_type=bogus',
      headers: { authorization: makeAuthHeader(ADMIN_ID, app) },
    })
    expect(res.statusCode).toBe(400)
  })

  it('a plain player cannot create an event', async () => {
    // PLAYER_ID was promoted to organizer earlier in this file, so use a
    // throwaway player seeded just for this check. cleanupTestData() removes it.
    await seedUser(OUTSIDER_ID, 'Outsider', 'player')

    const res = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { authorization: makeAuthHeader(OUTSIDER_ID, app) },
      payload: {
        name: 'Unauthorised Cup',
        sport_slug: 'football',
        format: 'knockout',
        city: 'Mumbai',
      },
    })
    expect(res.statusCode).toBe(403)
  })

  it('an approved organizer can create an event', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { authorization: makeAuthHeader(PLAYER_ID, app) },
      payload: {
        name: 'Sunday Turf Cup',
        sport_slug: 'football',
        format: 'group_knockout',
        city: 'Mumbai',
        venue: 'Powai Turf Arena',
        max_teams: 8,
        entry_fee: 200000,
      },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.organizer_id).toBe(PLAYER_ID)
    expect(body.format).toBe('group_knockout')
  })
})
