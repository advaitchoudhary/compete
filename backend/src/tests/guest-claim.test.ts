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
    verifyFirebaseToken: vi.fn(),
  }
})

import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import { guestClaimRoutes } from '../modules/users/guest-claim.routes'
import { usersRoutes } from '../modules/users/users.routes'
import { getDb } from '../shared/db/client'
import { verifyFirebaseToken } from '../modules/auth/auth.service'

/**
 * Claiming now needs a verified phone as well as the link, so every claim in
 * these tests carries one. Each caller gets a DISTINCT number: the route refuses
 * a number that already belongs to another account, so reusing one would fail
 * for the right reason in the wrong test.
 */
const ID_TOKEN = 'fake-firebase-id-token'
let phoneSeq = 0
function asPhoneUser(phone?: string) {
  phoneSeq += 1
  const number = phone ?? `+9198765${String(43000 + phoneSeq).padStart(5, '0')}`
  vi.mocked(verifyFirebaseToken).mockResolvedValue({
    uid: `test-claim-uid-${phoneSeq}`,
    phone_number: number,
    email: undefined,
  })
  return number
}

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
    asPhoneUser()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/claim',
      payload: { token: 'not-a-real-token', firebase_id_token: ID_TOKEN },
    })
    expect(res.statusCode).toBe(401)
  })

  it('rejects an access token used as a claim token', async () => {
    asPhoneUser()
    // The inverse of the test above — the discriminator must work both ways.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/claim',
      payload: { token: app.jwt.sign({ sub: GUEST_ID }, { expiresIn: '1h' }), firebase_id_token: ID_TOKEN },
    })
    expect(res.statusCode).toBe(401)
  })

  it('claiming promotes in place and keeps every rating', async () => {
    asPhoneUser()
    const minted = await mintLink(CAPTAIN_ID)
    const token = minted.json().token

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/claim',
      payload: { token, name: 'Rohit Sharma', firebase_id_token: ID_TOKEN },
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
    asPhoneUser()
    // Reset and claim again so this test owns its own token.
    await seedUser(GUEST_ID, 'Guest Striker', 'player', { isGuest: true, createdBy: CAPTAIN_ID })
    const token = (await mintLink(CAPTAIN_ID)).json().token
    const claimed = await app.inject({ method: 'POST', url: '/v1/auth/claim', payload: { token, firebase_id_token: ID_TOKEN } })
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
    asPhoneUser()
    // GUEST_ID was just claimed by the previous test; reuse of any link must fail.
    const stale = await mintLink(CAPTAIN_ID)
    // Minting for an already-claimed user is refused up front...
    expect(stale.statusCode).toBe(409)
  })

  it('claiming an already-claimed profile fails even with a valid older token', async () => {
    asPhoneUser()
    await seedUser(GUEST_ID, 'Guest Striker', 'player', { isGuest: true, createdBy: CAPTAIN_ID })
    const token = (await mintLink(CAPTAIN_ID)).json().token

    const first = await app.inject({ method: 'POST', url: '/v1/auth/claim', payload: { token, firebase_id_token: ID_TOKEN } })
    expect(first.statusCode).toBe(200)

    const second = await app.inject({ method: 'POST', url: '/v1/auth/claim', payload: { token, firebase_id_token: ID_TOKEN } })
    expect(second.statusCode).toBe(409)
    expect(second.json().error).toMatch(/already been claimed/i)
  })

  it('claiming leaves a credential the person can come back with', async () => {
    // The reason phone verification was made mandatory: promotion used to leave
    // phone and firebase_uid null, so the new owner had a rating and no way to
    // sign in once their session expired.
    await seedUser(GUEST_ID, 'Guest Winger', 'player', { isGuest: true, createdBy: CAPTAIN_ID })
    const phone = asPhoneUser()
    const token = (await mintLink(CAPTAIN_ID)).json().token

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/claim',
      payload: { token, firebase_id_token: ID_TOKEN },
    })
    expect(res.statusCode).toBe(200)

    const row = await getDb()
      .selectFrom('users')
      .select(['phone', 'firebase_uid', 'is_guest'])
      .where('id', '=', GUEST_ID)
      .executeTakeFirstOrThrow()

    expect(row.phone).toBe(phone)
    expect(row.firebase_uid).toBeTruthy()
    expect(row.is_guest).toBe(false)
  })

  it('the link alone is not enough — phone verification is required', async () => {
    await seedUser(GUEST_ID, 'Guest Winger', 'player', { isGuest: true, createdBy: CAPTAIN_ID })
    asPhoneUser()
    const token = (await mintLink(CAPTAIN_ID)).json().token

    const res = await app.inject({ method: 'POST', url: '/v1/auth/claim', payload: { token } })
    expect(res.statusCode).toBe(400)

    // And the profile is untouched — a failed claim must not consume the link.
    const row = await getDb()
      .selectFrom('users').select(['is_guest', 'claimed_at'])
      .where('id', '=', GUEST_ID).executeTakeFirstOrThrow()
    expect(row.is_guest).toBe(true)
    expect(row.claimed_at).toBeNull()
  })

  it('refuses a number that already belongs to someone else', async () => {
    await seedUser(GUEST_ID, 'Guest Winger', 'player', { isGuest: true, createdBy: CAPTAIN_ID })
    // Give the existing real user the number the claimer will present.
    const phone = '+919876500999'
    await getDb().updateTable('users').set({ phone }).where('id', '=', REAL_USER_ID).execute()
    asPhoneUser(phone)

    const token = (await mintLink(CAPTAIN_ID)).json().token
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/claim',
      payload: { token, firebase_id_token: ID_TOKEN },
    })

    expect(res.statusCode).toBe(409)
    expect(res.json().code).toBe('PHONE_IN_USE')

    // Merging two histories is a real feature; until it exists nothing is taken.
    const row = await getDb()
      .selectFrom('users').select(['is_guest'])
      .where('id', '=', GUEST_ID).executeTakeFirstOrThrow()
    expect(row.is_guest).toBe(true)
  })
})
