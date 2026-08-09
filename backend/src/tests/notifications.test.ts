/**
 * Integration tests — push tokens and notifications.
 *
 * The properties that matter: a notification is PERSISTED even when no device can
 * receive it, guests are never targeted (they have no app), and a delivery problem
 * can never fail the tournament action that triggered it.
 *
 * The Expo HTTP call is stubbed — these tests must not hit the network.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'

vi.mock('../shared/queue/ratings.stream', () => ({
  enqueueRatingJob: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../modules/auth/auth.service', () => ({
  initFirebase: vi.fn(),
  verifyFirebaseToken: vi.fn().mockResolvedValue({
    uid: 'test-notify-uid',
    phone_number: '+919999999009',
    email: undefined,
  }),
  issueJwt: vi.fn().mockReturnValue('test-jwt-token'),
}))

import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import { notificationsRoutes } from '../modules/notifications/notifications.routes'
import { notifyUsers } from '../modules/notifications/notify.service'
import { getDb } from '../shared/db/client'

const TEST_JWT_SECRET = 'test-jwt-secret-minimum-32-chars-long'

const PLAYER_ID = '550e8400-e29b-41d4-a716-4466554409c1'
const OTHER_ID = '550e8400-e29b-41d4-a716-4466554409c2'
const GUEST_ID = '550e8400-e29b-41d4-a716-4466554409c3'
const ALL_TEST_USERS = [PLAYER_ID, OTHER_ID, GUEST_ID]

async function buildTestApp() {
  const app = Fastify({ logger: false })
  await app.register(jwt, { secret: TEST_JWT_SECRET })
  await app.register(notificationsRoutes, { prefix: '/v1' })
  return app
}

const authHeader = (userId: string, app: any) =>
  `Bearer ${app.jwt.sign({ sub: userId }, { expiresIn: '1h' })}`

async function seedUser(id: string, name: string, isGuest = false) {
  await getDb()
    .insertInto('users')
    .values({ id, name, role: 'player', is_guest: isGuest })
    .onConflict((oc) => oc.column('id').doUpdateSet({ is_guest: isGuest }))
    .execute()
}

async function cleanupTestData() {
  const db = getDb()
  await db.deleteFrom('notifications').where('user_id', 'in', ALL_TEST_USERS).execute()
  await db.deleteFrom('push_tokens').where('user_id', 'in', ALL_TEST_USERS).execute()
  await db.deleteFrom('users').where('id', 'in', ALL_TEST_USERS).execute()
}

describe('Push tokens and notifications', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>
  /** Stands in for global fetch so these tests never touch the network. */
  const fetchMock = vi.fn()

  beforeAll(async () => {
    app = await buildTestApp()
    await app.ready()
    await cleanupTestData()
    await seedUser(PLAYER_ID, 'Registered Player')
    await seedUser(OTHER_ID, 'Another Player')
    await seedUser(GUEST_ID, 'Guest Striker', true)
  })

  beforeEach(() => {
    // Never touch the network. Default: Expo accepts everything.
    fetchMock.mockReset()
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ status: 'ok' }] }),
    })
    vi.stubGlobal('fetch', fetchMock)
  })

  afterAll(async () => {
    vi.unstubAllGlobals()
    await cleanupTestData()
    await app.close()
  })

  it('registering a push token requires authentication', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/push/register',
      payload: { token: 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('registers a token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/push/register',
      headers: { authorization: authHeader(PLAYER_ID, app) },
      payload: {
        token: 'ExponentPushToken[player-device-1]',
        platform: 'ios',
        device_id: 'iphone-1',
      },
    })
    expect(res.statusCode).toBe(200)

    const rows = await getDb()
      .selectFrom('push_tokens')
      .select(['user_id', 'platform'])
      .where('token', '=', 'ExponentPushToken[player-device-1]')
      .execute()
    expect(rows).toHaveLength(1)
    expect(rows[0].user_id).toBe(PLAYER_ID)
    expect(rows[0].platform).toBe('ios')
  })

  it('re-registering the same token on a new account moves it, not duplicates it', async () => {
    // A handed-over handset must not keep notifying the previous owner.
    await app.inject({
      method: 'POST',
      url: '/v1/push/register',
      headers: { authorization: authHeader(OTHER_ID, app) },
      payload: { token: 'ExponentPushToken[player-device-1]', platform: 'ios' },
    })

    const rows = await getDb()
      .selectFrom('push_tokens')
      .select('user_id')
      .where('token', '=', 'ExponentPushToken[player-device-1]')
      .execute()
    expect(rows).toHaveLength(1)
    expect(rows[0].user_id).toBe(OTHER_ID)
  })

  it('persists a notification even when the user has no device at all', async () => {
    const result = await notifyUsers({
      userIds: [PLAYER_ID],
      type: 'fixtures_published',
      title: 'Fixtures are up',
      body: '15 matches scheduled.',
      data: { event_id: 'abc' },
    })
    expect(result.persisted).toBe(1)
    expect(result.pushed).toBe(0) // token was moved to OTHER_ID above

    const res = await app.inject({
      method: 'GET',
      url: '/v1/notifications',
      headers: { authorization: authHeader(PLAYER_ID, app) },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.notifications[0].title).toBe('Fixtures are up')
    expect(body.notifications[0].data.event_id).toBe('abc')
    expect(body.unread).toBeGreaterThanOrEqual(1)
  })

  it('NEVER targets guests — they have no app', async () => {
    const result = await notifyUsers({
      userIds: [GUEST_ID],
      type: 'rating_ready',
      title: 'Your rating is in',
      body: 'Tournament finished.',
    })
    expect(result.persisted).toBe(0)
    expect(result.skippedGuests).toBe(1)

    const rows = await getDb()
      .selectFrom('notifications')
      .select('id')
      .where('user_id', '=', GUEST_ID)
      .execute()
    expect(rows).toHaveLength(0)
  })

  it('pushes to a registered device', async () => {
    const result = await notifyUsers({
      userIds: [OTHER_ID],
      type: 'rating_ready',
      title: 'Your rating is in',
      body: 'See how it moved.',
    })
    expect(result.persisted).toBe(1)
    expect(result.pushed).toBe(1)
    expect(fetchMock).toHaveBeenCalledWith(
      'https://exp.host/--/api/v2/push/send',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('prunes a token Expo reports as DeviceNotRegistered', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }],
      }),
    })

    await notifyUsers({
      userIds: [OTHER_ID],
      type: 'rating_ready',
      title: 'Stale device',
      body: 'Should prune.',
    })

    const rows = await getDb()
      .selectFrom('push_tokens')
      .select('id')
      .where('token', '=', 'ExponentPushToken[player-device-1]')
      .execute()
    expect(rows).toHaveLength(0)
  })

  it('a push failure never throws — the triggering action must not fail', async () => {
    fetchMock.mockRejectedValue(new Error('network down'))
    await expect(
      notifyUsers({
        userIds: [PLAYER_ID],
        type: 'fixtures_published',
        title: 'Still recorded',
        body: 'Even though Expo is unreachable.',
      })
    ).resolves.toMatchObject({ persisted: 1, pushed: 0 })
  })

  it('marks notifications read', async () => {
    const before = await app.inject({
      method: 'GET',
      url: '/v1/notifications',
      headers: { authorization: authHeader(PLAYER_ID, app) },
    })
    expect(before.json().unread).toBeGreaterThan(0)

    await app.inject({
      method: 'POST',
      url: '/v1/notifications/read',
      headers: { authorization: authHeader(PLAYER_ID, app) },
      payload: {},
    })

    const after = await app.inject({
      method: 'GET',
      url: '/v1/notifications',
      headers: { authorization: authHeader(PLAYER_ID, app) },
    })
    expect(after.json().unread).toBe(0)
  })

  it('only ever returns your own notifications', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/notifications',
      headers: { authorization: authHeader(OTHER_ID, app) },
    })
    const titles = res.json().notifications.map((n: any) => n.title)
    expect(titles).not.toContain('Fixtures are up') // that one belongs to PLAYER_ID
  })

  it('signing out removes the device token', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/push/register',
      headers: { authorization: authHeader(PLAYER_ID, app) },
      payload: { token: 'ExponentPushToken[signout-test]', platform: 'android' },
    })

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/push/register',
      headers: { authorization: authHeader(PLAYER_ID, app) },
      payload: { token: 'ExponentPushToken[signout-test]' },
    })
    expect(res.statusCode).toBe(200)

    const rows = await getDb()
      .selectFrom('push_tokens')
      .select('id')
      .where('token', '=', 'ExponentPushToken[signout-test]')
      .execute()
    expect(rows).toHaveLength(0)
  })
})
