/**
 * Integration tests — guest claiming.
 *
 * A guest played in a tournament, accumulated real ratings, and now needs to own
 * them. The model is promote-in-place: the SAME users row gains credentials and
 * flips is_guest, so every match_player_stats / rating_history / tier_ratings /
 * sport_profiles row carries over with no repointing.
 *
 * The security tests here are the important ones. Claim tokens are signed with the
 * same secret as access tokens, so without a type discriminator a claim link would
 * BE a session for that user. That must not be possible.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.mock('../shared/queue/ratings.stream', () => ({
  enqueueRatingJob: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../modules/auth/auth.service', async () => {
  const actual = await vi.importActual<any>('../modules/auth/auth.service')
  return {
    ...actual,
    initFirebase: vi.fn(),
    verifyFirebaseToken: vi.fn().mockResolvedValue({
      uid: 'test-claim-uid',
      phone_number: '+919999999008',
      email: undefined,
    }),
  }
})

import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import { guestClaimRoutes } from '../modules/users/guest-claim.routes'
import { usersRoutes } from '../modules/users/users.routes'
import { getDb } from '../shared/db/client'

const TEST_JWT_SECRET = 'test-jwt-secret-minimum-32-chars-long'

const CAPTAIN_ID = '550e8400-e29b-41d4-a716-4466554408b1'
const OUTSIDER_ID = '550e8400-e29b-41d4-a716-4466554408b2'
const REF_ID = '550e8400-e29b-41d4-a716-4466554408b3'
const GUEST_ID = '550e8400-e29b-41d4-a716-4466554408b4'
const REAL_USER_ID = '550e8400-e29b-41d4-a716-4466554408b5'
const ALL_TEST_USERS = [CAPTAIN_ID, OUTSIDER_ID, REF_ID, GUEST_ID, REAL_USER_ID]

let footballSportId: string
let teamId: string

async function buildTestApp() {
  const app = Fastify({ logger: false })
  await app.register(jwt, { secret: TEST_JWT_SECRET })
  await app.register(guestClaimRoutes, { prefix: '/v1' })
  await app.register(usersRoutes, { prefix: '/v1' })
  return app
}

function accessHeader(userId: string, app: any): string {
  return `Bearer ${app.jwt.sign({ sub: userId }, { expiresIn: '1h' })}`
}

async function seedUser(
  id: string,
  name: string,
  role: string,
  extra: { isGuest?: boolean; createdBy?: string } = {}
) {
  await getDb()
    .insertInto('users')
    .values({
      id,
      name,
      role: role as any,
      is_guest: extra.isGuest ?? false,
      created_by: extra.createdBy ?? null,
    })
    .onConflict((oc) =>
      oc.column('id').doUpdateSet({
        role: role as any,
        is_guest: extra.isGuest ?? false,
        created_by: extra.createdBy ?? null,
        claimed_at: null,
        phone: null,
        firebase_uid: null,
      })
    )
    .execute()
}

async function cleanupTestData() {
  const db = getDb()
  const teams = await db
    .selectFrom('teams')
    .select('id')
    .where('organizer_id', 'in', ALL_TEST_USERS)
    .execute()
  const tIds = teams.map((t) => t.id)
  if (tIds.length > 0) {
    await db.deleteFrom('team_members').where('team_id', 'in', tIds).execute()
    await db.deleteFrom('teams').where('id', 'in', tIds).execute()
  }
  await db.deleteFrom('team_members').where('user_id', 'in', ALL_TEST_USERS).execute()
  await db.deleteFrom('sport_profiles').where('user_id', 'in', ALL_TEST_USERS).execute()
  await db.deleteFrom('tier_ratings').where('user_id', 'in', ALL_TEST_USERS).execute()
  await db.deleteFrom('organizer_scores').where('user_id', 'in', ALL_TEST_USERS).execute()
  await db.deleteFrom('users').where('id', 'in', ALL_TEST_USERS).execute()
}

describe('Guest claiming', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>

  beforeAll(async () => {
    app = await buildTestApp()
    await app.ready()
    await cleanupTestData()

    await seedUser(CAPTAIN_ID, 'Team Captain', 'player')
    await seedUser(OUTSIDER_ID, 'Random Outsider', 'player')
    await seedUser(REF_ID, 'Vikram Referee', 'referee')
    await seedUser(REAL_USER_ID, 'Already Registered', 'player')
    await seedUser(GUEST_ID, 'Guest Striker', 'player', { isGuest: true, createdBy: CAPTAIN_ID })

    const db = getDb()
    const sport = await db
      .selectFrom('sports')
      .select('id')
      .where('slug', '=', 'football')
      .executeTakeFirstOrThrow()
    footballSportId = sport.id

    const team = await db
      .insertInto('teams')
      .values({ name: 'Claim Test FC', sport_id: footballSportId, organizer_id: CAPTAIN_ID })
      .returning('id')
      .executeTakeFirstOrThrow()
    teamId = team.id

    await db
      .insertInto('team_members')
      .values([
        { team_id: teamId, user_id: CAPTAIN_ID, role: 'captain' },
        { team_id: teamId, user_id: GUEST_ID, role: 'player' },
      ])
      .execute()

    // The guest has earned a rating — the whole point of claiming.
    await db
      .insertInto('sport_profiles')
      .values({
        user_id: GUEST_ID,
        sport_id: footballSportId,
        current_rating: 68.5,
        matches_played: 3,
        wins: 2,
      })
      .execute()
    await db
      .insertInto('tier_ratings')
      .values({
        user_id: GUEST_ID,
        sport_id: footballSportId,
        tier: 'amateur',
        rating: 68.5,
        matches_played: 3,
        wins: 2,
      })
      .execute()
  })

  afterAll(async () => {
    await cleanupTestData()
    await app.close()
  })

  const mintLink = (asUser: string) =>
    app.inject({
      method: 'POST',
      url: `/v1/guests/${GUEST_ID}/claim-link`,
      headers: { authorization: accessHeader(asUser, app) },
    })

  it('minting a claim link requires authentication', async () => {
    const res = await app.inject({ method: 'POST', url: `/v1/guests/${GUEST_ID}/claim-link` })
    expect(res.statusCode).toBe(401)
  })

  it('refuses someone with no relationship to the guest', async () => {
    const res = await mintLink(OUTSIDER_ID)
    expect(res.statusCode).toBe(403)
  })

  it('the captain of the guest’s team can mint a link', async () => {
    const res = await mintLink(CAPTAIN_ID)
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.token).toBeTruthy()
    expect(body.claim_url).toContain(body.token)
    expect(body.guest_name).toBe('Guest Striker')
  })

  it('a referee can also mint a link', async () => {
    const res = await mintLink(REF_ID)
    expect(res.statusCode).toBe(200)
  })

  it('refuses to mint for a user who is not a guest', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/guests/${REAL_USER_ID}/claim-link`,
      headers: { authorization: accessHeader(REF_ID, app) },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/not a guest/i)
  })

  it('A CLAIM TOKEN CANNOT BE USED AS AN ACCESS TOKEN', async () => {
    // Claim tokens are signed with the same secret as sessions. Without a type
    // discriminator, handing someone a claim link would hand them a live session
    // for that player. This is the test that proves it cannot.
    const minted = await mintLink(CAPTAIN_ID)
    const claimToken = minted.json().token

    const res = await app.inject({
      method: 'GET',
      url: '/v1/users/me',
      headers: { authorization: `Bearer ${claimToken}` },
    })
    expect(res.statusCode).toBe(401)
  })

  it('rejects a garbage claim token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/claim',
      payload: { token: 'not-a-real-token' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('rejects an access token used as a claim token', async () => {
    // The inverse of the test above — the discriminator must work both ways.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/claim',
      payload: { token: app.jwt.sign({ sub: GUEST_ID }, { expiresIn: '1h' }) },
    })
    expect(res.statusCode).toBe(401)
  })

  it('claiming promotes in place and keeps every rating', async () => {
    const minted = await mintLink(CAPTAIN_ID)
    const token = minted.json().token

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/claim',
      payload: { token, name: 'Rohit Sharma' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()

    // Logged straight in — no second step.
    expect(body.access_token).toBeTruthy()
    expect(body.user.id).toBe(GUEST_ID) // SAME row, not a new user
    expect(body.user.is_guest).toBe(false)
    expect(body.user.name).toBe('Rohit Sharma')

    const db = getDb()
    const row = await db
      .selectFrom('users')
      .select(['is_guest', 'claimed_at', 'name'])
      .where('id', '=', GUEST_ID)
      .executeTakeFirstOrThrow()
    expect(row.is_guest).toBe(false)
    expect(row.claimed_at).not.toBeNull()

    // The ratings are untouched because nothing was repointed.
    const profile = await db
      .selectFrom('sport_profiles')
      .select(['current_rating', 'matches_played', 'wins'])
      .where('user_id', '=', GUEST_ID)
      .executeTakeFirstOrThrow()
    expect(Number(profile.current_rating)).toBeCloseTo(68.5, 1)
    expect(Number(profile.matches_played)).toBe(3)

    const tier = await db
      .selectFrom('tier_ratings')
      .select('rating')
      .where('user_id', '=', GUEST_ID)
      .executeTakeFirstOrThrow()
    expect(Number(tier.rating)).toBeCloseTo(68.5, 1)
  })

  it('the returned session actually works', async () => {
    // Reset and claim again so this test owns its own token.
    await seedUser(GUEST_ID, 'Guest Striker', 'player', { isGuest: true, createdBy: CAPTAIN_ID })
    const token = (await mintLink(CAPTAIN_ID)).json().token
    const claimed = await app.inject({ method: 'POST', url: '/v1/auth/claim', payload: { token } })
    const access = claimed.json().access_token

    const me = await app.inject({
      method: 'GET',
      url: '/v1/users/me',
      headers: { authorization: `Bearer ${access}` },
    })
    expect(me.statusCode).toBe(200)
    expect(me.json().id).toBe(GUEST_ID)
  })

  it('a claim link is single-use — the second attempt fails', async () => {
    // GUEST_ID was just claimed by the previous test; reuse of any link must fail.
    const stale = await mintLink(CAPTAIN_ID)
    // Minting for an already-claimed user is refused up front...
    expect(stale.statusCode).toBe(409)
  })

  it('claiming an already-claimed profile fails even with a valid older token', async () => {
    await seedUser(GUEST_ID, 'Guest Striker', 'player', { isGuest: true, createdBy: CAPTAIN_ID })
    const token = (await mintLink(CAPTAIN_ID)).json().token

    const first = await app.inject({ method: 'POST', url: '/v1/auth/claim', payload: { token } })
    expect(first.statusCode).toBe(200)

    const second = await app.inject({ method: 'POST', url: '/v1/auth/claim', payload: { token } })
    expect(second.statusCode).toBe(409)
    expect(second.json().error).toMatch(/already been claimed/i)
  })
})
