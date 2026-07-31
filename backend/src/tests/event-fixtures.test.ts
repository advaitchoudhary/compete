/**
 * Integration tests — fixture generation.
 *
 * Covers the third tier-authority enforcement point (spec §3.1.1): every
 * generated match must pass canOfficiate against its own referee, or the whole
 * transaction is refused. That is the backstop making tier inflation impossible.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'

vi.mock('../shared/queue/ratings.stream', () => ({
  enqueueRatingJob: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../modules/auth/auth.service', () => ({
  initFirebase: vi.fn(),
  verifyFirebaseToken: vi.fn().mockResolvedValue({
    uid: 'test-fx-uid',
    phone_number: '+919999999005',
    email: undefined,
  }),
  issueJwt: vi.fn().mockReturnValue('test-jwt-token'),
}))

import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import { eventFixturesRoutes } from '../modules/events/event-fixtures.routes'
import { getDb } from '../shared/db/client'

const TEST_JWT_SECRET = 'test-jwt-secret-minimum-32-chars-long'

const ORGANIZER_ID = '550e8400-e29b-41d4-a716-4466554405e1'
const REF_AMATEUR_ID = '550e8400-e29b-41d4-a716-4466554405e2'
const REF_PRO_ID = '550e8400-e29b-41d4-a716-4466554405e3'
const OUTSIDER_ID = '550e8400-e29b-41d4-a716-4466554405e4'

const ALL_TEST_USERS = [ORGANIZER_ID, REF_AMATEUR_ID, REF_PRO_ID, OUTSIDER_ID]

let footballSportId: string
let eventId: string

async function buildTestApp() {
  const app = Fastify({ logger: false })
  await app.register(jwt, { secret: TEST_JWT_SECRET })
  await app.register(eventFixturesRoutes, { prefix: '/v1' })
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

/** Remove every event/team this suite could have created, children first. */
async function clearEventsAndTeams() {
  const db = getDb()
  const events = await db
    .selectFrom('events')
    .select('id')
    .where('organizer_id', 'in', ALL_TEST_USERS)
    .execute()
  const eventIds = events.map((e) => e.id)
  if (eventIds.length > 0) {
    await db.deleteFrom('event_fixtures').where('event_id', 'in', eventIds).execute()
    await db.deleteFrom('matches').where('event_id', 'in', eventIds).execute()
    await db.deleteFrom('event_referees').where('event_id', 'in', eventIds).execute()
    await db.deleteFrom('event_teams').where('event_id', 'in', eventIds).execute()
    await db.deleteFrom('events').where('id', 'in', eventIds).execute()
  }
  const teams = await db
    .selectFrom('teams')
    .select('id')
    .where('organizer_id', 'in', ALL_TEST_USERS)
    .execute()
  const tIds = teams.map((t) => t.id)
  if (tIds.length > 0) {
    await db.deleteFrom('matches').where('home_team_id', 'in', tIds).execute()
    await db.deleteFrom('matches').where('away_team_id', 'in', tIds).execute()
    await db.deleteFrom('event_teams').where('team_id', 'in', tIds).execute()
    await db.deleteFrom('team_members').where('team_id', 'in', tIds).execute()
    await db.deleteFrom('teams').where('id', 'in', tIds).execute()
  }
}

async function cleanupTestData() {
  await clearEventsAndTeams()
  const db = getDb()
  await db.deleteFrom('event_referees').where('user_id', 'in', ALL_TEST_USERS).execute()
  await db.deleteFrom('organizer_scores').where('user_id', 'in', ALL_TEST_USERS).execute()
  await db.deleteFrom('users').where('id', 'in', ALL_TEST_USERS).execute()
}

/** Fresh event with `teamCount` registered teams, a tier, and pitched referees. */
async function makeEvent(opts: {
  teamCount: number
  tier?: 'amateur' | 'semi_pro' | 'pro' | 'legends'
  referees?: Array<{ id: string; pitch: string }>
  format?: 'knockout' | 'group_knockout'
}) {
  const db = getDb()
  const event = await db
    .insertInto('events')
    .values({
      name: `Fixture Cup ${Date.now()}`,
      sport_id: footballSportId,
      organizer_id: ORGANIZER_ID,
      format: opts.format ?? 'group_knockout',
      match_format: '5-a-side',
      match_duration_minutes: 12,
      city: 'Mumbai',
      status: 'registration',
      starts_at: new Date('2026-08-02T09:00:00.000Z'),
      tier: (opts.tier ?? 'amateur') as any,
    })
    .returning('id')
    .executeTakeFirstOrThrow()

  for (let i = 0; i < opts.teamCount; i++) {
    const t = await db
      .insertInto('teams')
      .values({
        name: `FX Team ${i + 1} ${Date.now()}-${i}`,
        sport_id: footballSportId,
        organizer_id: ORGANIZER_ID,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await db
      .insertInto('event_teams')
      .values({ event_id: event.id, team_id: t.id, seed: i + 1 })
      .execute()
  }

  for (const r of opts.referees ?? [{ id: REF_AMATEUR_ID, pitch: 'Pitch 1' }]) {
    await db
      .insertInto('event_referees')
      .values({ event_id: event.id, user_id: r.id, pitch_label: r.pitch })
      .execute()
  }

  eventId = event.id
  return event.id
}

describe('Fixture generation', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>

  beforeAll(async () => {
    app = await buildTestApp()
    await app.ready()
    await cleanupTestData()

    await seedUser(ORGANIZER_ID, 'Turf Owner', 'organizer')
    await seedUser(REF_AMATEUR_ID, 'Amateur Ref', 'referee', 'amateur')
    await seedUser(REF_PRO_ID, 'Pro Ref', 'referee', 'pro')
    await seedUser(OUTSIDER_ID, 'Outsider', 'player')

    const sport = await getDb()
      .selectFrom('sports')
      .select('id')
      .where('slug', '=', 'football')
      .executeTakeFirstOrThrow()
    footballSportId = sport.id
  })

  // Each test builds its own event, so clear between them for exact counts.
  afterEach(async () => {
    await clearEventsAndTeams()
  })

  afterAll(async () => {
    await cleanupTestData()
    await app.close()
  })

  it('requires the organizer role', async () => {
    await makeEvent({ teamCount: 8 })
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/fixtures`,
      headers: { authorization: makeAuthHeader(OUTSIDER_ID, app) },
    })
    expect(res.statusCode).toBe(403)
  })

  it('404s for an unknown event', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/events/550e8400-e29b-41d4-a716-4466554405ff/fixtures',
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
    })
    expect(res.statusCode).toBe(404)
  })

  it('refuses when fewer than two teams are registered', async () => {
    await makeEvent({ teamCount: 1 })
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/fixtures`,
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/at least 2/i)
  })

  it('refuses when no referees are assigned', async () => {
    await makeEvent({ teamCount: 8, referees: [] })
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/fixtures`,
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/pitch|referee/i)
  })

  it('generates 15 fixtures for 8 teams and creates only the group matches', async () => {
    await makeEvent({ teamCount: 8 })
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/fixtures`,
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.fixtures).toBe(15)
    expect(body.matches).toBe(12) // group only; knockout waits for qualifiers

    const db = getDb()
    const fixtures = await db
      .selectFrom('event_fixtures')
      .select(['round', 'match_id', 'referee_id', 'pitch_label', 'scheduled_at'])
      .where('event_id', '=', eventId)
      .execute()

    expect(fixtures).toHaveLength(15)
    expect(fixtures.filter((f) => f.match_id !== null)).toHaveLength(12)
    for (const f of fixtures) {
      expect(f.referee_id).not.toBeNull()
      expect(f.pitch_label).not.toBeNull()
      expect(f.scheduled_at).not.toBeNull()
    }

    const matches = await db
      .selectFrom('matches')
      .select(['tier', 'status'])
      .where('event_id', '=', eventId)
      .execute()
    expect(matches).toHaveLength(12)
    for (const m of matches) {
      expect(m.tier).toBe('amateur')
      expect(m.status).toBe('scheduled')
    }
  })

  it('falls back to knockout for a prime team count and explains why', async () => {
    await makeEvent({ teamCount: 5 })
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/fixtures`,
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.fell_back).toBe(true)
    expect(body.fallback_reason).toMatch(/equal groups/i)
    expect(body.fixtures).toBe(4)
  })

  it('nine teams becomes three groups of three', async () => {
    await makeEvent({ teamCount: 9 })
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/fixtures`,
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().fixtures).toBe(12)

    const groups = await getDb()
      .selectFrom('event_teams')
      .select('group_no')
      .where('event_id', '=', eventId)
      .execute()
    const counts = new Map<string, number>()
    for (const g of groups) counts.set(g.group_no!, (counts.get(g.group_no!) ?? 0) + 1)
    expect([...counts.values()].sort()).toEqual([3, 3, 3])
  })

  it('REFUSES generation when a referee cannot officiate the event tier', async () => {
    // The third enforcement point of §3.1.1. The event is 'pro' but an amateur
    // referee is assigned, so no match may legally be created.
    await makeEvent({
      teamCount: 8,
      tier: 'pro',
      referees: [
        { id: REF_PRO_ID, pitch: 'Pitch 1' },
        { id: REF_AMATEUR_ID, pitch: 'Pitch 2' },
      ],
    })
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/fixtures`,
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/cannot officiate/i)

    // Nothing must have been written — the whole transaction is refused.
    const db = getDb()
    const fixtures = await db
      .selectFrom('event_fixtures')
      .select('id')
      .where('event_id', '=', eventId)
      .execute()
    const matches = await db
      .selectFrom('matches')
      .select('id')
      .where('event_id', '=', eventId)
      .execute()
    expect(fixtures).toHaveLength(0)
    expect(matches).toHaveLength(0)
  })

  it('allows generation when every referee clears the tier', async () => {
    await makeEvent({
      teamCount: 8,
      tier: 'pro',
      referees: [{ id: REF_PRO_ID, pitch: 'Pitch 1' }],
    })
    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/fixtures`,
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
    })
    expect(res.statusCode).toBe(201)
    const matches = await getDb()
      .selectFrom('matches')
      .select('tier')
      .where('event_id', '=', eventId)
      .execute()
    expect(matches.length).toBeGreaterThan(0)
    for (const m of matches) expect(m.tier).toBe('pro')
  })

  it('regenerates while nothing has kicked off', async () => {
    await makeEvent({ teamCount: 8 })
    const first = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/fixtures`,
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
    })
    expect(first.statusCode).toBe(201)

    const again = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/fixtures`,
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
    })
    expect(again.statusCode).toBe(201)

    // Exactly one set of fixtures — the old ones were removed, not duplicated.
    const fixtures = await getDb()
      .selectFrom('event_fixtures')
      .select('id')
      .where('event_id', '=', eventId)
      .execute()
    expect(fixtures).toHaveLength(15)
  })

  it('refuses to regenerate once a match has started', async () => {
    await makeEvent({ teamCount: 8 })
    await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/fixtures`,
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
    })

    const db = getDb()
    const match = await db
      .selectFrom('matches')
      .select('id')
      .where('event_id', '=', eventId)
      .executeTakeFirstOrThrow()
    await db
      .updateTable('matches')
      .set({ status: 'live', started_at: new Date() })
      .where('id', '=', match.id)
      .execute()

    const res = await app.inject({
      method: 'POST',
      url: `/v1/events/${eventId}/fixtures`,
      headers: { authorization: makeAuthHeader(ORGANIZER_ID, app) },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/already started|kicked off/i)
  })
})
