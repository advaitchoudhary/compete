/**
 * Integration tests — event tier authority (spec §3.1.1).
 *
 * These are the highest-value tests in the codebase: tier drives rating weight
 * (amateur 1.0 → legends 3.0), so a hole here lets an organizer inflate the
 * whole ladder. The rule: an event's tier may not exceed the LOWEST referee_tier
 * among its assigned referees.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.mock('../shared/queue/ratings.stream', () => ({
  enqueueRatingJob: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../modules/auth/auth.service', () => ({
  initFirebase: vi.fn(),
  verifyFirebaseToken: vi.fn().mockResolvedValue({
    uid: 'test-tier-uid',
    phone_number: '+919999999004',
    email: undefined,
  }),
  issueJwt: vi.fn().mockReturnValue('test-jwt-token'),
}))

import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import { eventTierRoutes } from '../modules/events/event-tier.routes'
import { eventRefereesRoutes } from '../modules/events/event-referees.routes'
import { getDb } from '../shared/db/client'

const TEST_JWT_SECRET = 'test-jwt-secret-minimum-32-chars-long'

const ORGANIZER_ID = '550e8400-e29b-41d4-a716-4466554404d1'
const REF_AMATEUR_ID = '550e8400-e29b-41d4-a716-4466554404d2'
const REF_PRO_ID = '550e8400-e29b-41d4-a716-4466554404d3'
const REF_LEGENDS_ID = '550e8400-e29b-41d4-a716-4466554404d4'

const ALL_TEST_USERS = [ORGANIZER_ID, REF_AMATEUR_ID, REF_PRO_ID, REF_LEGENDS_ID]

let eventId: string
let footballSportId: string
let teamAId: string
let teamBId: string

async function buildTestApp() {
  const app = Fastify({ logger: false })
  await app.register(jwt, { secret: TEST_JWT_SECRET })
  await app.register(eventTierRoutes, { prefix: '/v1' })
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

/**
 * Children before parents. Runs in beforeAll too: a failed assertion mid-test
 * skips inline cleanup, and a leftover row would then FK-block deleting its
 * owner and poison every later run.
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

  if (eventIds.length > 0) {
    await db.deleteFrom('matches').where('event_id', 'in', eventIds).execute()
    await db.deleteFrom('event_referees').where('event_id', 'in', eventIds).execute()
    await db.deleteFrom('event_teams').where('event_id', 'in', eventIds).execute()
    await db.deleteFrom('events').where('id', 'in', eventIds).execute()
  }
  if (teamIds.length > 0) {
    await db.deleteFrom('matches').where('home_team_id', 'in', teamIds).execute()
    await db.deleteFrom('matches').where('away_team_id', 'in', teamIds).execute()
    await db.deleteFrom('event_teams').where('team_id', 'in', teamIds).execute()
    await db.deleteFrom('team_members').where('team_id', 'in', teamIds).execute()
    await db.deleteFrom('teams').where('id', 'in', teamIds).execute()
  }
  await db.deleteFrom('event_referees').where('user_id', 'in', ALL_TEST_USERS).execute()
  await db.deleteFrom('organizer_scores').where('user_id', 'in', ALL_TEST_USERS).execute()
  await db.deleteFrom('users').where('id', 'in', ALL_TEST_USERS).execute()
}

async function setReferees(app: any, refs: Array<{ user_id: string; pitch_label?: string }>) {
  return app.inject({
    method: 'POST',
    url: `/v1/events/${eventId}/referees`,
    headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
    payload: { referees: refs },
  })
}

async function setTier(app: any, tier: string) {
  return app.inject({
    method: 'PATCH',
    url: `/v1/events/${eventId}/tier`,
    headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
    payload: { tier },
  })
}

describe('Event tier authority', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>

  beforeAll(async () => {
    app = await buildTestApp()
    await app.ready()
    await cleanupTestData()

    await seedUser(ORGANIZER_ID, 'Turf Owner', 'organizer')
    await seedUser(REF_AMATEUR_ID, 'Amateur Ref', 'referee', 'amateur')
    await seedUser(REF_PRO_ID, 'Pro Ref', 'referee', 'pro')
    await seedUser(REF_LEGENDS_ID, 'Legends Ref', 'referee', 'legends')

    const db = getDb()
    const sport = await db
      .selectFrom('sports')
      .select('id')
      .where('slug', '=', 'football')
      .executeTakeFirstOrThrow()
    footballSportId = sport.id

    // The test DB has no seeded teams, so create the two this suite needs for
    // the tier-freeze check. Owned by ORGANIZER_ID so cleanup finds them.
    const teamA = await db
      .insertInto('teams')
      .values({ name: 'Tier Test A', sport_id: footballSportId, organizer_id: ORGANIZER_ID })
      .returning('id')
      .executeTakeFirstOrThrow()
    teamAId = teamA.id

    const teamB = await db
      .insertInto('teams')
      .values({ name: 'Tier Test B', sport_id: footballSportId, organizer_id: ORGANIZER_ID })
      .returning('id')
      .executeTakeFirstOrThrow()
    teamBId = teamB.id

    const event = await db
      .insertInto('events')
      .values({
        name: 'Tier Authority Cup',
        sport_id: footballSportId,
        organizer_id: ORGANIZER_ID,
        format: 'knockout',
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

  it('a new event defaults to amateur', async () => {
    const row = await getDb()
      .selectFrom('events')
      .select('tier')
      .where('id', '=', eventId)
      .executeTakeFirstOrThrow()
    expect(row.tier).toBe('amateur')
  })

  it('with no referees assigned, only amateur is allowed', async () => {
    const res = await setTier(app, 'pro')
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('amateur')

    const ok = await setTier(app, 'amateur')
    expect(ok.statusCode).toBe(200)
  })

  it('rejects an invalid tier value', async () => {
    const res = await setTier(app, 'superstar')
    expect(res.statusCode).toBe(400)
  })

  it('cannot exceed the lowest assigned referee tier', async () => {
    // A pro and an amateur referee: the amateur is the floor, so pro is refused.
    const assign = await setReferees(app, [
      { user_id: REF_PRO_ID, pitch_label: 'Pitch 1' },
      { user_id: REF_AMATEUR_ID, pitch_label: 'Pitch 2' },
    ])
    expect(assign.statusCode).toBe(200)

    const res = await setTier(app, 'pro')
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('amateur')
  })

  it('allows the tier once every assigned referee qualifies', async () => {
    const assign = await setReferees(app, [
      { user_id: REF_PRO_ID, pitch_label: 'Pitch 1' },
      { user_id: REF_LEGENDS_ID, pitch_label: 'Pitch 2' },
    ])
    expect(assign.statusCode).toBe(200)

    // Floor is now 'pro' (legends outranks it), so pro is allowed.
    const res = await setTier(app, 'pro')
    expect(res.statusCode).toBe(200)
    expect(res.json().tier).toBe('pro')
  })

  it('still refuses a tier above the floor', async () => {
    // Floor is 'pro', so legends must be refused.
    const res = await setTier(app, 'legends')
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('pro')
  })

  it('refuses a referee swap that would undercut the current tier', async () => {
    // Event is 'pro'. Swapping in the amateur referee would drop the floor
    // below it — the exact loophole this check exists to close.
    const res = await setReferees(app, [{ user_id: REF_AMATEUR_ID, pitch_label: 'Pitch 1' }])
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('pro')

    // The roster must be unchanged.
    const rows = await getDb()
      .selectFrom('event_referees')
      .select('user_id')
      .where('event_id', '=', eventId)
      .execute()
    expect(rows).toHaveLength(2)
  })

  it('lowering the tier first then swapping referees is allowed', async () => {
    const down = await setTier(app, 'amateur')
    expect(down.statusCode).toBe(200)

    const res = await setReferees(app, [{ user_id: REF_AMATEUR_ID, pitch_label: 'Pitch 1' }])
    expect(res.statusCode).toBe(200)
  })

  it('freezes the tier once a match exists for the event', async () => {
    await getDb()
      .insertInto('matches')
      .values({
        event_id: eventId,
        sport_id: footballSportId,
        home_team_id: teamAId,
        away_team_id: teamBId,
        status: 'scheduled',
        tier: 'amateur',
        referee_id: REF_AMATEUR_ID,
      })
      .execute()

    const res = await setTier(app, 'semi_pro')
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('fixtures')
  })

  it('only an organizer or admin may change the tier', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/events/${eventId}/tier`,
      headers: { authorization: makeAuthHeader(REF_PRO_ID, app) },
      payload: { tier: 'amateur' },
    })
    // A referee isn't an organizer at all, so this is a role rejection.
    expect(res.statusCode).toBe(403)
  })
})
