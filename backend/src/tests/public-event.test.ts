/**
 * Integration tests — the public tournament page endpoint.
 *
 * This is the only unauthenticated, world-readable surface in the API, and it is
 * the acquisition loop: ~80 players and a few hundred sideline spectators hit one
 * URL. So the tests that matter most are the negative ones — it must expose names
 * and scores and nothing else.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.mock('../shared/queue/ratings.stream', () => ({
  enqueueRatingJob: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../modules/auth/auth.service', () => ({
  initFirebase: vi.fn(),
  verifyFirebaseToken: vi.fn().mockResolvedValue({
    uid: 'test-pub-uid',
    phone_number: '+919999999007',
    email: undefined,
  }),
  issueJwt: vi.fn().mockReturnValue('test-jwt-token'),
}))

import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import { publicEventRoutes } from '../modules/events/public-event.routes'
import { generateFixtures } from '../modules/events/bracket/generator'
import { recomputeStandings } from '../modules/events/bracket/standings'
import { resolveFixtures } from '../modules/events/bracket/resolver'
import { getDb } from '../shared/db/client'

const TEST_JWT_SECRET = 'test-jwt-secret-minimum-32-chars-long'

const ORGANIZER_ID = '550e8400-e29b-41d4-a716-4466554407a1'
const REF_ID = '550e8400-e29b-41d4-a716-4466554407a2'
const PLAYER_ID = '550e8400-e29b-41d4-a716-4466554407a3'
const GUEST_ID = '550e8400-e29b-41d4-a716-4466554407a4'
const ALL_TEST_USERS = [ORGANIZER_ID, REF_ID, PLAYER_ID, GUEST_ID]

let footballSportId: string
let eventId: string
let cancelledEventId: string
let teamIds: string[] = []

async function buildTestApp() {
  const app = Fastify({ logger: false })
  await app.register(jwt, { secret: TEST_JWT_SECRET })
  await app.register(publicEventRoutes, { prefix: '/v1' })
  return app
}

async function seedUser(
  id: string,
  name: string,
  role: string,
  extra: { refereeTier?: string; phone?: string; isGuest?: boolean } = {}
) {
  await getDb()
    .insertInto('users')
    .values({
      id,
      name,
      role: role as any,
      referee_tier: (extra.refereeTier ?? null) as any,
      phone: extra.phone ?? null,
      is_guest: extra.isGuest ?? false,
    })
    .onConflict((oc) =>
      oc.column('id').doUpdateSet({
        role: role as any,
        phone: extra.phone ?? null,
        is_guest: extra.isGuest ?? false,
      })
    )
    .execute()
}

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
  const tIds = teams.map((t) => t.id)

  if (eventIds.length > 0) {
    await db.deleteFrom('event_fixtures').where('event_id', 'in', eventIds).execute()
    await db.deleteFrom('match_player_stats').where('match_id', 'in',
      db.selectFrom('matches').select('id').where('event_id', 'in', eventIds)).execute()
    await db.deleteFrom('matches').where('event_id', 'in', eventIds).execute()
    await db.deleteFrom('event_referees').where('event_id', 'in', eventIds).execute()
    await db.deleteFrom('event_teams').where('event_id', 'in', eventIds).execute()
    await db.deleteFrom('events').where('id', 'in', eventIds).execute()
  }
  if (tIds.length > 0) {
    await db.deleteFrom('matches').where('home_team_id', 'in', tIds).execute()
    await db.deleteFrom('matches').where('away_team_id', 'in', tIds).execute()
    await db.deleteFrom('event_teams').where('team_id', 'in', tIds).execute()
    await db.deleteFrom('team_members').where('team_id', 'in', tIds).execute()
    await db.deleteFrom('teams').where('id', 'in', tIds).execute()
  }
  await db.deleteFrom('event_referees').where('user_id', 'in', ALL_TEST_USERS).execute()
  await db.deleteFrom('organizer_scores').where('user_id', 'in', ALL_TEST_USERS).execute()
  await db.deleteFrom('users').where('id', 'in', ALL_TEST_USERS).execute()
}

describe('Public tournament page', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>

  beforeAll(async () => {
    app = await buildTestApp()
    await app.ready()
    await cleanupTestData()

    // A phone number on a player is the thing that must never leak.
    await seedUser(ORGANIZER_ID, 'Turf Owner', 'organizer', { phone: '+919000000001' })
    await seedUser(REF_ID, 'Vikram Referee', 'referee', { refereeTier: 'amateur', phone: '+919000000002' })
    await seedUser(PLAYER_ID, 'Registered Player', 'player', { phone: '+919000000003' })
    await seedUser(GUEST_ID, 'Guest Striker', 'player', { isGuest: true })

    const db = getDb()
    const sport = await db
      .selectFrom('sports')
      .select('id')
      .where('slug', '=', 'football')
      .executeTakeFirstOrThrow()
    footballSportId = sport.id

    const event = await db
      .insertInto('events')
      .values({
        name: 'Public Sunday Cup',
        sport_id: footballSportId,
        organizer_id: ORGANIZER_ID,
        format: 'knockout',
        match_format: '5-a-side',
        match_duration_minutes: 12,
        city: 'Mumbai',
        venue: 'Powai Turf',
        status: 'active',
        starts_at: new Date('2026-08-09T09:00:00.000Z'),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    eventId = event.id

    teamIds = []
    for (let i = 0; i < 4; i++) {
      const t = await db
        .insertInto('teams')
        .values({
          name: `Public Team ${i + 1}`,
          sport_id: footballSportId,
          organizer_id: ORGANIZER_ID,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      teamIds.push(t.id)
      await db
        .insertInto('event_teams')
        .values({ event_id: eventId, team_id: t.id, seed: i + 1 })
        .execute()
    }

    // Both a registered player and a guest, so we can assert guests appear by
    // name (that is the point — a guest sees themselves and claims it later).
    await db
      .insertInto('team_members')
      .values([
        { team_id: teamIds[0], user_id: PLAYER_ID, role: 'captain' },
        { team_id: teamIds[0], user_id: GUEST_ID, role: 'player' },
      ])
      .execute()

    await db
      .insertInto('event_referees')
      .values({ event_id: eventId, user_id: REF_ID, pitch_label: 'Pitch 1' })
      .execute()

    const gen = await generateFixtures(eventId)
    expect(gen.ok).toBe(true)

    const cancelled = await db
      .insertInto('events')
      .values({
        name: 'Called Off Cup',
        sport_id: footballSportId,
        organizer_id: ORGANIZER_ID,
        format: 'knockout',
        city: 'Mumbai',
        status: 'cancelled',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    cancelledEventId = cancelled.id
  })

  afterAll(async () => {
    await cleanupTestData()
    await app.close()
  })

  it('needs no authentication at all', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/public/events/${eventId}` })
    expect(res.statusCode).toBe(200)
    expect(res.json().name).toBe('Public Sunday Cup')
  })

  it('returns the event, its bracket and its teams', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/public/events/${eventId}` })
    const body = res.json()

    expect(body.city).toBe('Mumbai')
    expect(body.venue).toBe('Powai Turf')
    expect(body.tier).toBe('amateur')
    expect(body.match_format).toBe('5-a-side')
    // 4 teams knockout = 2 semis + final
    expect(body.fixtures).toHaveLength(3)
    expect(body.teams).toHaveLength(4)
  })

  it('renders unresolved sides as readable placeholders', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/public/events/${eventId}` })
    const final = res.json().fixtures.find((f: any) => f.round === 'final')
    expect(final.home_label).toMatch(/winner of/i)
    expect(final.match_id).toBeNull()
  })

  it('EXPOSES NO PHONE NUMBERS ANYWHERE in the payload', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/public/events/${eventId}` })
    const raw = res.body
    expect(raw).not.toContain('+9190000000')
    expect(raw).not.toContain('phone')
  })

  it('exposes no firebase uid, no email and no organizer identity', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/public/events/${eventId}` })
    const raw = res.body.toLowerCase()
    expect(raw).not.toContain('firebase')
    expect(raw).not.toContain('email')
    expect(raw).not.toContain('organizer_id')
  })

  it('404s for an unknown event', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/public/events/550e8400-e29b-41d4-a716-4466554407ff',
    })
    expect(res.statusCode).toBe(404)
  })

  it('404s — not 403 — for a cancelled event, leaking nothing', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/public/events/${cancelledEventId}` })
    expect(res.statusCode).toBe(404)
    expect(res.body).not.toContain('Called Off Cup')
  })

  it('rejects a malformed id without a database error', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/public/events/not-a-uuid' })
    expect(res.statusCode).toBe(400)
  })

  it('lists top scorers, including guests by name', async () => {
    const db = getDb()
    const match = await db
      .selectFrom('matches')
      .select(['id', 'home_team_id'])
      .where('event_id', '=', eventId)
      .executeTakeFirstOrThrow()

    await db
      .insertInto('match_player_stats')
      .values([
        {
          match_id: match.id,
          user_id: GUEST_ID,
          team_id: teamIds[0],
          sport_id: footballSportId,
          stats: { goals: 3, assists: 1 },
          confirmed_by_captain: true,
        },
        {
          match_id: match.id,
          user_id: PLAYER_ID,
          team_id: teamIds[0],
          sport_id: footballSportId,
          stats: { goals: 1, assists: 2 },
          confirmed_by_captain: true,
        },
      ])
      .execute()

    const res = await app.inject({ method: 'GET', url: `/v1/public/events/${eventId}` })
    const scorers = res.json().top_scorers

    expect(scorers.length).toBeGreaterThanOrEqual(2)
    expect(scorers[0].name).toBe('Guest Striker')
    expect(scorers[0].goals).toBe(3)
    // A guest is flagged so the page can invite them to claim their profile.
    expect(scorers[0].is_guest).toBe(true)
    expect(scorers[1].name).toBe('Registered Player')
    // Ordered by goals descending.
    expect(scorers[0].goals).toBeGreaterThanOrEqual(scorers[1].goals)
  })

  it('shows live scores once a match is completed', async () => {
    const db = getDb()
    const match = await db
      .selectFrom('matches')
      .select(['id', 'home_team_id', 'away_team_id'])
      .where('event_id', '=', eventId)
      .orderBy('scheduled_at', 'asc')
      .executeTakeFirstOrThrow()

    await db
      .updateTable('matches')
      .set({
        home_score: { goals: 4 },
        away_score: { goals: 1 },
        winner_team_id: match.home_team_id,
        status: 'completed',
        completed_at: new Date(),
      })
      .where('id', '=', match.id)
      .execute()

    await recomputeStandings(eventId)
    await resolveFixtures(eventId)

    const res = await app.inject({ method: 'GET', url: `/v1/public/events/${eventId}` })
    const body = res.json()

    const played = body.fixtures.find((f: any) => f.match_status === 'completed')
    expect(played).toBeDefined()
    expect(played.home_goals).toBe(4)
    expect(played.away_goals).toBe(1)

    // The winner has advanced, so the final now names one side.
    const final = body.fixtures.find((f: any) => f.round === 'final')
    expect(final.home_label).not.toMatch(/winner of/i)
  })
})
