/**
 * Integration tests — standings and bracket progression.
 *
 * Plays a whole 8-team tournament and asserts the bracket advances itself: group
 * results feed the table, the table ranks the qualifiers, and each knockout
 * winner lands in the right downstream slot.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.mock('../shared/queue/ratings.stream', () => ({
  enqueueRatingJob: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../modules/auth/auth.service', () => ({
  initFirebase: vi.fn(),
  verifyFirebaseToken: vi.fn().mockResolvedValue({
    uid: 'test-res-uid',
    phone_number: '+919999999006',
    email: undefined,
  }),
  issueJwt: vi.fn().mockReturnValue('test-jwt-token'),
}))

import { getDb } from '../shared/db/client'
import { generateFixtures } from '../modules/events/bracket/generator'
import { resolveFixtures } from '../modules/events/bracket/resolver'
import { recomputeStandings, rankStandings } from '../modules/events/bracket/standings'

const ORGANIZER_ID = '550e8400-e29b-41d4-a716-4466554406f1'
const REF_ID = '550e8400-e29b-41d4-a716-4466554406f2'
const ALL_TEST_USERS = [ORGANIZER_ID, REF_ID]

let footballSportId: string
let eventId: string

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
    await db.deleteFrom('matches').where('event_id', 'in', eventIds).execute()
    await db.deleteFrom('event_referees').where('event_id', 'in', eventIds).execute()
    await db.deleteFrom('event_teams').where('event_id', 'in', eventIds).execute()
    await db.deleteFrom('events').where('id', 'in', eventIds).execute()
  }
  if (tIds.length > 0) {
    await db.deleteFrom('matches').where('home_team_id', 'in', tIds).execute()
    await db.deleteFrom('matches').where('away_team_id', 'in', tIds).execute()
    await db.deleteFrom('event_teams').where('team_id', 'in', tIds).execute()
    await db.deleteFrom('teams').where('id', 'in', tIds).execute()
  }
  await db.deleteFrom('event_referees').where('user_id', 'in', ALL_TEST_USERS).execute()
  await db.deleteFrom('organizer_scores').where('user_id', 'in', ALL_TEST_USERS).execute()
  await db.deleteFrom('users').where('id', 'in', ALL_TEST_USERS).execute()
}

/** Complete a match with the given goals, then run standings + resolver. */
async function completeMatch(matchId: string, homeGoals: number, awayGoals: number) {
  const db = getDb()
  const match = await db
    .selectFrom('matches')
    .select(['home_team_id', 'away_team_id'])
    .where('id', '=', matchId)
    .executeTakeFirstOrThrow()

  const winner =
    homeGoals > awayGoals
      ? match.home_team_id
      : awayGoals > homeGoals
        ? match.away_team_id
        : null

  await db
    .updateTable('matches')
    .set({
      home_score: { goals: homeGoals },
      away_score: { goals: awayGoals },
      winner_team_id: winner,
      status: 'completed',
      completed_at: new Date(),
    })
    .where('id', '=', matchId)
    .execute()

  await recomputeStandings(eventId)
  await resolveFixtures(eventId)
}

describe('Standings and bracket progression', () => {
  beforeAll(async () => {
    await cleanupTestData()
    await seedUser(ORGANIZER_ID, 'Turf Owner', 'organizer')
    await seedUser(REF_ID, 'Ref', 'referee', 'amateur')

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
        name: `Resolver Cup ${Date.now()}`,
        sport_id: footballSportId,
        organizer_id: ORGANIZER_ID,
        format: 'group_knockout',
        players_per_side: 5,
        match_duration_minutes: 12,
        city: 'Mumbai',
        status: 'registration',
        starts_at: new Date('2026-08-02T09:00:00.000Z'),
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    eventId = event.id

    for (let i = 0; i < 8; i++) {
      const t = await db
        .insertInto('teams')
        .values({
          name: `RS Team ${i + 1} ${Date.now()}-${i}`,
          sport_id: footballSportId,
          organizer_id: ORGANIZER_ID,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      await db
        .insertInto('event_teams')
        .values({ event_id: eventId, team_id: t.id, seed: i + 1 })
        .execute()
    }

    await db
      .insertInto('event_referees')
      .values({ event_id: eventId, user_id: REF_ID, pitch_label: 'Pitch 1' })
      .execute()

    const gen = await generateFixtures(eventId)
    expect(gen.ok).toBe(true)
  })

  afterAll(async () => {
    await cleanupTestData()
  })

  it('a group win records 3 points and the goals', async () => {
    const db = getDb()
    const groupMatch = await db
      .selectFrom('matches')
      .select(['id', 'home_team_id', 'away_team_id'])
      .where('event_id', '=', eventId)
      .where('round', 'like', 'group_%')
      .orderBy('scheduled_at', 'asc')
      .executeTakeFirstOrThrow()

    await completeMatch(groupMatch.id, 3, 1)

    const home = await db
      .selectFrom('event_teams')
      .select(['points', 'played', 'won', 'lost', 'goals_for', 'goals_against'])
      .where('event_id', '=', eventId)
      .where('team_id', '=', groupMatch.home_team_id)
      .executeTakeFirstOrThrow()
    expect(Number(home.points)).toBe(3)
    expect(Number(home.played)).toBe(1)
    expect(Number(home.won)).toBe(1)
    expect(Number(home.lost)).toBe(0)
    expect(Number(home.goals_for)).toBe(3)
    expect(Number(home.goals_against)).toBe(1)

    const away = await db
      .selectFrom('event_teams')
      .select(['points', 'played', 'lost', 'goals_for', 'goals_against'])
      .where('event_id', '=', eventId)
      .where('team_id', '=', groupMatch.away_team_id)
      .executeTakeFirstOrThrow()
    expect(Number(away.points)).toBe(0)
    expect(Number(away.played)).toBe(1)
    expect(Number(away.lost)).toBe(1)
    expect(Number(away.goals_for)).toBe(1)
    expect(Number(away.goals_against)).toBe(3)
  })

  it('a draw records one point each', async () => {
    const db = getDb()
    const next = await db
      .selectFrom('matches')
      .select(['id', 'home_team_id', 'away_team_id'])
      .where('event_id', '=', eventId)
      .where('round', 'like', 'group_%')
      .where('status', '=', 'scheduled')
      .orderBy('scheduled_at', 'asc')
      .executeTakeFirstOrThrow()

    await completeMatch(next.id, 2, 2)

    for (const teamId of [next.home_team_id, next.away_team_id]) {
      const row = await db
        .selectFrom('event_teams')
        .select(['points', 'drawn'])
        .where('event_id', '=', eventId)
        .where('team_id', '=', teamId)
        .executeTakeFirstOrThrow()
      expect(Number(row.points)).toBeGreaterThanOrEqual(1)
      expect(Number(row.drawn)).toBe(1)
    }
  })

  it('knockout fixtures stay unresolved until the group stage finishes', async () => {
    const unresolved = await getDb()
      .selectFrom('event_fixtures')
      .select('id')
      .where('event_id', '=', eventId)
      .where('match_id', 'is', null)
      .execute()
    expect(unresolved.length).toBeGreaterThan(0)
  })

  it('completing every group match fills the whole first knockout round', async () => {
    const db = getDb()
    let guard = 0
    for (;;) {
      const pending = await db
        .selectFrom('matches')
        .select('id')
        .where('event_id', '=', eventId)
        .where('round', 'like', 'group_%')
        .where('status', '=', 'scheduled')
        .executeTakeFirst()
      if (!pending) break
      if (++guard > 50) throw new Error('group stage did not drain')
      // Deterministic, distinct scorelines so the table has few ties.
      await completeMatch(pending.id, (guard % 4) + 1, 0)
    }

    const semis = await db
      .selectFrom('event_fixtures')
      .select(['id', 'home_team_id', 'away_team_id', 'match_id'])
      .where('event_id', '=', eventId)
      .where('round', '=', 'semi')
      .execute()

    expect(semis).toHaveLength(2)
    for (const s of semis) {
      expect(s.home_team_id).not.toBeNull()
      expect(s.away_team_id).not.toBeNull()
      expect(s.match_id).not.toBeNull()
    }
  })

  it('ranks the group table by points then goal difference', async () => {
    const table = await rankStandings(eventId, 'a')
    expect(table.length).toBeGreaterThan(0)
    for (let i = 1; i < table.length; i++) {
      const prev = table[i - 1]
      const cur = table[i]
      const ordered =
        prev.points > cur.points ||
        (prev.points === cur.points && prev.gd > cur.gd) ||
        (prev.points === cur.points && prev.gd === cur.gd && prev.gf >= cur.gf)
      expect(ordered).toBe(true)
    }
  })

  it('a semi-final winner lands in the final', async () => {
    const db = getDb()
    const semiMatches = await db
      .selectFrom('event_fixtures as ef')
      .innerJoin('matches as m', 'm.id', 'ef.match_id')
      .select(['m.id as match_id', 'm.home_team_id'])
      .where('ef.event_id', '=', eventId)
      .where('ef.round', '=', 'semi')
      .orderBy('ef.slot_no', 'asc')
      .execute()
    expect(semiMatches).toHaveLength(2)

    await completeMatch(semiMatches[0].match_id, 2, 0)

    const final = await db
      .selectFrom('event_fixtures')
      .select(['home_team_id', 'away_team_id', 'match_id'])
      .where('event_id', '=', eventId)
      .where('round', '=', 'final')
      .executeTakeFirstOrThrow()

    // One side filled, the other still waiting on the second semi.
    const filled = [final.home_team_id, final.away_team_id].filter(Boolean)
    expect(filled).toHaveLength(1)
    expect(filled[0]).toBe(semiMatches[0].home_team_id)
    // No match yet — a fixture needs both teams before it becomes a match.
    expect(final.match_id).toBeNull()

    await completeMatch(semiMatches[1].match_id, 0, 3)

    const finalAgain = await db
      .selectFrom('event_fixtures')
      .select(['home_team_id', 'away_team_id', 'match_id'])
      .where('event_id', '=', eventId)
      .where('round', '=', 'final')
      .executeTakeFirstOrThrow()
    expect(finalAgain.home_team_id).not.toBeNull()
    expect(finalAgain.away_team_id).not.toBeNull()
    expect(finalAgain.match_id).not.toBeNull()
  })

  it('recomputing standings repeatedly is idempotent', async () => {
    // Why this matters: finalizeMatch is NOT transactional, so if it died between
    // marking a match completed and updating the table, an incrementing
    // implementation would be permanently wrong AND the 409 "already completed"
    // guard would block any retry. A full recompute converges instead.
    const db = getDb()
    const before = await db
      .selectFrom('event_teams')
      .select(['team_id', 'points', 'played', 'goals_for', 'goals_against'])
      .where('event_id', '=', eventId)
      .orderBy('team_id', 'asc')
      .execute()

    await recomputeStandings(eventId)
    await recomputeStandings(eventId)
    await recomputeStandings(eventId)

    const after = await db
      .selectFrom('event_teams')
      .select(['team_id', 'points', 'played', 'goals_for', 'goals_against'])
      .where('event_id', '=', eventId)
      .orderBy('team_id', 'asc')
      .execute()

    expect(after).toEqual(before)
  })

  it('re-resolving is idempotent — no double advance, no second match', async () => {
    const db = getDb()
    const before = await db
      .selectFrom('matches')
      .select('id')
      .where('event_id', '=', eventId)
      .execute()

    await resolveFixtures(eventId)
    await resolveFixtures(eventId)

    const after = await db
      .selectFrom('matches')
      .select('id')
      .where('event_id', '=', eventId)
      .execute()
    expect(after).toHaveLength(before.length)
  })
})
