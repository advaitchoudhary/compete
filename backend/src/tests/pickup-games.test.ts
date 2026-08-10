/**
 * Integration tests — pickup games.
 *
 * The roster is the whole feature. A tournament takes whole teams once and is
 * settled; a pickup game is a queue that reshapes itself every time someone drops
 * out, and the rules that matter are about parties: a group joins whole, waits
 * whole and leaves whole.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.mock('../shared/queue/ratings.stream', () => ({
  enqueueRatingJob: vi.fn().mockResolvedValue(undefined),
}))
// Push would try to reach Expo; the persisted rows are what we assert on.
vi.mock('../modules/notifications/notify.service', async () => {
  const actual = await vi.importActual<any>('../modules/notifications/notify.service')
  return { ...actual, notifyUsers: vi.fn().mockResolvedValue({ persisted: 0, pushed: 0, skippedGuests: 0 }) }
})

import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import { gamesRoutes } from '../modules/games/games.routes'
import { eventTierRoutes } from '../modules/events/event-tier.routes'
import { closeCasualGame } from '../modules/scores/scores.routes'
import { getDb } from '../shared/db/client'
import { notifyUsers } from '../modules/notifications/notify.service'

const TEST_JWT_SECRET = 'test-jwt-secret-minimum-32-chars-long'

const ORGANIZER = '550e8400-e29b-41d4-a716-4466554409a1'
const ALICE     = '550e8400-e29b-41d4-a716-4466554409a2'
const BOB       = '550e8400-e29b-41d4-a716-4466554409a3'
const CARL      = '550e8400-e29b-41d4-a716-4466554409a4'
const DEE       = '550e8400-e29b-41d4-a716-4466554409a5'
const REFEREE_ID = '550e8400-e29b-41d4-a716-4466554409a9'
const SEEDED = [ORGANIZER, ALICE, BOB, CARL, DEE, REFEREE_ID]

let app: any
let footballId: string

async function seedUser(id: string, name: string, role: string) {
  await getDb()
    .insertInto('users')
    .values({ id, name, role: role as any })
    .onConflict((oc) => oc.column('id').doUpdateSet({ name, role: role as any }))
    .execute()
}

const auth = (userId: string) => ({
  authorization: `Bearer ${app.jwt.sign({ sub: userId }, { expiresIn: '1h' })}`,
})

/** A 3-a-side game: capacity 6, small enough to overflow deliberately. */
async function createGame(playersPerSide = 3) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/games',
    headers: auth(ORGANIZER),
    payload: {
      name: `Pickup ${Date.now()}-${Math.random()}`,
      sport_slug: 'football',
      players_per_side: playersPerSide,
      match_duration_minutes: 60,
      city: 'Pune',
    },
  })
  expect(res.statusCode).toBe(201)
  return res.json().id as string
}

/** `mates` are typed-in names, which become guests. */
const join = (gameId: string, userId: string, mates: string[] = []) =>
  app.inject({
    method: 'POST',
    url: `/v1/games/${gameId}/join`,
    headers: auth(userId),
    payload: { players: mates.map((name) => ({ name })) },
  })

const rosterOf = (gameId: string) =>
  getDb()
    .selectFrom('event_players')
    .select(['user_id', 'added_by', 'status'])
    .where('event_id', '=', gameId)
    .execute()

async function cleanup() {
  const db = getDb()
  // Guests created by these tests, and every row that points at them.
  const guests = await db
    .selectFrom('users').select('id')
    .where('created_by', 'in', SEEDED).execute()
  const ids = guests.map((g) => g.id)

  const games = await db
    .selectFrom('events').select('id')
    .where('organizer_id', '=', ORGANIZER).execute()
  const gameIds = games.map((g) => g.id)

  if (gameIds.length > 0) {
    await db.deleteFrom('event_players').where('event_id', 'in', gameIds).execute()
    await db.deleteFrom('matches').where('event_id', 'in', gameIds).execute()
    await db.deleteFrom('event_referees').where('event_id', 'in', gameIds).execute()
    await db.deleteFrom('events').where('id', 'in', gameIds).execute()
  }
  // Ad-hoc sides drawn by these tests, and their membership rows.
  const adHoc = await db
    .selectFrom('teams').select('id')
    .where('organizer_id', '=', ORGANIZER).where('is_ad_hoc', '=', true).execute()
  if (adHoc.length > 0) {
    const teamIds = adHoc.map((t) => t.id)
    await db.deleteFrom('team_members').where('team_id', 'in', teamIds).execute()
    await db.deleteFrom('teams').where('id', 'in', teamIds).execute()
  }
  if (ids.length > 0) await db.deleteFrom('users').where('id', 'in', ids).execute()
  await db.deleteFrom('users').where('id', 'in', SEEDED).execute()
}

beforeAll(async () => {
  app = Fastify({ logger: false })
  await app.register(jwt, { secret: TEST_JWT_SECRET })
  await app.register(gamesRoutes, { prefix: '/v1' })
  await app.register(eventTierRoutes, { prefix: '/v1' })

  await cleanup()
  await seedUser(ORGANIZER, 'Pickup Organizer', 'organizer')
  for (const [id, name] of [[ALICE, 'Alice'], [BOB, 'Bob'], [CARL, 'Carl'], [DEE, 'Dee']] as const) {
    await seedUser(id, name, 'player')
  }

  const sport = await getDb()
    .selectFrom('sports').select('id').where('slug', '=', 'football').executeTakeFirstOrThrow()
  footballId = sport.id
  void footballId
})

afterAll(async () => {
  await cleanup()
  await app?.close()
})

describe('Pickup games — capacity and parties', () => {
  it('capacity is players per side doubled, and is never stored', async () => {
    const id = await createGame(7)
    const res = await app.inject({ method: 'GET', url: `/v1/games/${id}`, headers: auth(ALICE) })
    expect(res.json().game.capacity).toBe(14)
    expect(res.json().spots_left).toBe(14)
  })

  it('a party joins whole and counts as its full size', async () => {
    const id = await createGame(3) // capacity 6
    const res = await join(id, ALICE, ['Mate One', 'Mate Two'])
    expect(res.statusCode).toBe(201)
    expect(res.json().status).toBe('confirmed')
    expect(res.json().joined).toBe(3)
    expect(res.json().spots_left).toBe(3)
  })

  it('typed-in mates become guests attributed to whoever brought them', async () => {
    const id = await createGame(3)
    await join(id, ALICE, ['Guest Winger'])

    const guest = await getDb()
      .selectFrom('users')
      .select(['name', 'is_guest', 'created_by'])
      .where('name', '=', 'Guest Winger')
      .where('created_by', '=', ALICE)
      .executeTakeFirstOrThrow()

    // created_by is what lets Alice send them a claim link later, with no extra
    // permission wiring — the claim route already authorises on it.
    expect(guest.is_guest).toBe(true)
    expect(guest.created_by).toBe(ALICE)
  })

  it('a party that does not fit waits TOGETHER rather than being split', async () => {
    const id = await createGame(3) // capacity 6
    await join(id, ALICE, ['A1', 'A2', 'A3'])   // 4 confirmed, 2 free
    const res = await join(id, BOB, ['B1', 'B2']) // party of 3, only 2 free

    expect(res.statusCode).toBe(201)
    expect(res.json().status).toBe('waitlist')

    const roster = await rosterOf(id)
    const bobParty = roster.filter((r) => r.user_id === BOB || r.added_by === BOB)
    expect(bobParty).toHaveLength(3)
    // The point: not two in and one out.
    expect(new Set(bobParty.map((r) => r.status))).toEqual(new Set(['waitlist']))
  })

  it('refuses a second join by the same person', async () => {
    const id = await createGame(3)
    await join(id, ALICE)
    const again = await join(id, ALICE)
    expect(again.statusCode).toBe(409)
    expect(again.json().error).toMatch(/already joined/i)
  })

  it('refuses to bring someone who is already in the game', async () => {
    const id = await createGame(5)
    await join(id, BOB)
    const res = await app.inject({
      method: 'POST',
      url: `/v1/games/${id}/join`,
      headers: auth(ALICE),
      payload: { players: [{ user_id: BOB }] },
    })
    expect(res.statusCode).toBe(409)
  })
})

describe('Pickup games — withdrawal and the waitlist', () => {
  it('withdrawing takes the whole party and frees every slot', async () => {
    const id = await createGame(3) // capacity 6
    await join(id, ALICE, ['A1', 'A2'])  // 3 confirmed
    await join(id, BOB)                  // 4 confirmed

    const res = await app.inject({
      method: 'POST', url: `/v1/games/${id}/withdraw`, headers: auth(ALICE),
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().withdrew).toBe(3)

    const detail = await app.inject({ method: 'GET', url: `/v1/games/${id}`, headers: auth(BOB) })
    expect(detail.json().confirmed_count).toBe(1)
    expect(detail.json().spots_left).toBe(5)
  })

  it('a guest leaving does not drag the person who brought them', async () => {
    const id = await createGame(3)
    await join(id, ALICE, ['Solo Guest'])
    const roster = await rosterOf(id)
    const guestId = roster.find((r) => r.added_by === ALICE)!.user_id

    await app.inject({
      method: 'DELETE',
      url: `/v1/games/${id}/players/${guestId}`,
      headers: auth(ORGANIZER),
    })

    const after = await rosterOf(id)
    expect(after.find((r) => r.user_id === ALICE)!.status).toBe('confirmed')
    expect(after.find((r) => r.user_id === guestId)!.status).toBe('withdrawn')
  })

  it('promotion skips a party too large for the gap and takes the next that fits', async () => {
    const id = await createGame(3) // capacity 6
    await join(id, ALICE, ['A1', 'A2', 'A3', 'A4', 'A5']) // 6 confirmed — full
    await join(id, BOB, ['B1', 'B2'])                     // party of 3, waiting
    await join(id, CARL)                                  // party of 1, waiting behind

    // Free exactly two slots by removing two of Alice's guests individually.
    const roster = await rosterOf(id)
    const aliceGuests = roster.filter((r) => r.added_by === ALICE).map((r) => r.user_id)
    for (const g of aliceGuests.slice(0, 2)) {
      await app.inject({
        method: 'DELETE', url: `/v1/games/${id}/players/${g}`, headers: auth(ORGANIZER),
      })
    }

    const after = await rosterOf(id)
    // Bob's three cannot fit two slots, so they are passed over — leaving the game
    // short would be worse than taking the solo player behind them.
    expect(after.find((r) => r.user_id === BOB)!.status).toBe('waitlist')
    expect(after.find((r) => r.user_id === CARL)!.status).toBe('confirmed')
  })

  it('promotes a waiting party when a big enough gap opens, and tells them', async () => {
    vi.mocked(notifyUsers).mockClear()
    const id = await createGame(3) // capacity 6
    await join(id, ALICE, ['A1', 'A2'])  // 3 confirmed
    await join(id, BOB, ['B1', 'B2'])    // 6 confirmed — full
    await join(id, CARL, ['C1'])         // party of 2, waiting

    await app.inject({ method: 'POST', url: `/v1/games/${id}/withdraw`, headers: auth(ALICE) })

    const after = await rosterOf(id)
    const carlParty = after.filter((r) => r.user_id === CARL || r.added_by === CARL)
    expect(new Set(carlParty.map((r) => r.status))).toEqual(new Set(['confirmed']))

    const call = vi.mocked(notifyUsers).mock.calls.at(-1)?.[0]
    expect(call?.type).toBe('game_promoted')
    expect(call?.userIds).toContain(CARL)
  })

  it('a full game puts the next joiner on the waitlist with their position', async () => {
    const id = await createGame(3)
    await join(id, ALICE, ['A1', 'A2', 'A3', 'A4', 'A5']) // full
    const res = await join(id, BOB)
    expect(res.json().status).toBe('waitlist')
    expect(res.json().waitlist_position).toBe(1)
    expect(res.json().spots_left).toBe(0)
  })
})

describe('Pickup games — drawing the sides', () => {
  const REFEREE = '550e8400-e29b-41d4-a716-4466554409a9'

  async function fillAndRef(perSide = 3) {
    const id = await createGame(perSide)
    await seedUser(REFEREE, 'Pickup Ref', 'referee')
    await getDb().updateTable('users').set({ referee_tier: 'amateur' })
      .where('id', '=', REFEREE).execute()
    // One party fills the whole game.
    await join(id, ALICE, Array.from({ length: perSide * 2 - 1 }, (_, i) => `F${i}`))
    return id
  }

  it('refuses to draw without a referee', async () => {
    const id = await fillAndRef(3)
    const res = await app.inject({
      method: 'POST', url: `/v1/games/${id}/draw`, headers: auth(ORGANIZER),
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/referee/i)
  })

  it('refuses to draw a game that is not full', async () => {
    const id = await createGame(3)
    await seedUser(REFEREE, 'Pickup Ref', 'referee')
    await app.inject({
      method: 'POST', url: `/v1/games/${id}/referee`,
      headers: auth(ORGANIZER), payload: { user_id: REFEREE },
    })
    await join(id, ALICE)
    const res = await app.inject({
      method: 'POST', url: `/v1/games/${id}/draw`, headers: auth(ORGANIZER),
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/exactly 6 players/i)
  })

  it('the organizer cannot referee their own game', async () => {
    const id = await createGame(3)
    const res = await app.inject({
      method: 'POST', url: `/v1/games/${id}/referee`,
      headers: auth(ORGANIZER), payload: { user_id: ORGANIZER },
    })
    // Whoever referees scores the match; an organizer scoring their own game is
    // exactly what the grading system exists to prevent.
    expect(res.statusCode).toBe(409)
  })

  it('refuses a nominee who is not an approved referee', async () => {
    const id = await createGame(3)
    const res = await app.inject({
      method: 'POST', url: `/v1/games/${id}/referee`,
      headers: auth(ORGANIZER), payload: { user_id: BOB },
    })
    expect(res.statusCode).toBe(400)
  })

  it('draws two ad-hoc sides and a match carrying the duration', async () => {
    const id = await fillAndRef(3)
    await app.inject({
      method: 'POST', url: `/v1/games/${id}/referee`,
      headers: auth(ORGANIZER), payload: { user_id: REFEREE },
    })

    const res = await app.inject({
      method: 'POST', url: `/v1/games/${id}/draw`, headers: auth(ORGANIZER),
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.sides.colours.players).toHaveLength(3)
    expect(body.sides.whites.players).toHaveLength(3)

    const match = await getDb()
      .selectFrom('matches')
      .select(['referee_id', 'duration_minutes', 'tier', 'event_id'])
      .where('id', '=', body.match_id)
      .executeTakeFirstOrThrow()

    expect(match.referee_id).toBe(REFEREE)
    // The whole reason duration is asked for: a NULL reaches the engine as 90 min.
    expect(match.duration_minutes).toBe(60)
    expect(match.tier).toBe('amateur')

    const teams = await getDb()
      .selectFrom('teams').select(['is_ad_hoc'])
      .where('id', 'in', [body.sides.colours.team_id, body.sides.whites.team_id])
      .execute()
    expect(teams.every((t) => t.is_ad_hoc)).toBe(true)

    // Everyone knows which side they are on.
    const drawn = await getDb()
      .selectFrom('event_players').select(['team_id'])
      .where('event_id', '=', id).where('status', '=', 'confirmed').execute()
    expect(drawn.every((p) => p.team_id !== null)).toBe(true)
  })

  /**
   * The control room reads this to decide whether a redraw is still on offer. It
   * used to have no idea a match existed, so it kept offering one long after the
   * game had been played — a button whose only possible outcome was a 409.
   */
  it('the game detail carries the match once the sides are drawn', async () => {
    const id = await fillAndRef(3)
    await app.inject({
      method: 'POST', url: `/v1/games/${id}/referee`,
      headers: auth(ORGANIZER), payload: { user_id: REFEREE },
    })

    const before = await app.inject({
      method: 'GET', url: `/v1/games/${id}`, headers: auth(ORGANIZER),
    })
    expect(before.json().match).toBeNull()

    const draw = await app.inject({
      method: 'POST', url: `/v1/games/${id}/draw`, headers: auth(ORGANIZER),
    })
    const after = await app.inject({
      method: 'GET', url: `/v1/games/${id}`, headers: auth(ORGANIZER),
    })
    expect(after.json().match.id).toBe(draw.json().match_id)
    expect(after.json().match.status).toBe('scheduled')
  })

  it('a played pickup game is closed out, and a tournament is left alone', async () => {
    const id = await fillAndRef(3)
    await app.inject({
      method: 'POST', url: `/v1/games/${id}/referee`,
      headers: auth(ORGANIZER), payload: { user_id: REFEREE },
    })
    const draw = await app.inject({
      method: 'POST', url: `/v1/games/${id}/draw`, headers: auth(ORGANIZER),
    })
    const db = getDb()

    // Drawing sets it active. Nothing was ever moving it on from there, so the
    // organizer's hub listed a finished kickabout as still running.
    const statusOf = async (eventId: string) =>
      (await db.selectFrom('events').select('status')
        .where('id', '=', eventId).executeTakeFirstOrThrow()).status

    expect(await statusOf(id)).toBe('active')

    // While the match is unplayed the game stays open.
    await closeCasualGame(db, id)
    expect(await statusOf(id)).toBe('active')

    await db.updateTable('matches').set({ status: 'completed' })
      .where('id', '=', draw.json().match_id).execute()
    await closeCasualGame(db, id)
    expect(await statusOf(id)).toBe('completed')

    // A tournament ends when its bracket runs out, not when one match does.
    const tourney = await db
      .insertInto('events')
      .values({
        name: 'Not A Kickabout', sport_id: footballId, organizer_id: ORGANIZER,
        format: 'league', tier: 'amateur', city: 'Pune', status: 'active',
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    await closeCasualGame(db, tourney.id)
    expect(await statusOf(tourney.id)).toBe('active')
    await db.deleteFrom('events').where('id', '=', tourney.id).execute()
  })

  it('redrawing replaces the previous sides rather than stacking them', async () => {
    const id = await fillAndRef(3)
    await app.inject({
      method: 'POST', url: `/v1/games/${id}/referee`,
      headers: auth(ORGANIZER), payload: { user_id: REFEREE },
    })
    const first = await app.inject({
      method: 'POST', url: `/v1/games/${id}/draw`, headers: auth(ORGANIZER),
    })
    // A drawn game is 'active'; drawing again must still work while nothing has
    // kicked off, for the player who turns up late.
    const second = await app.inject({
      method: 'POST', url: `/v1/games/${id}/draw`, headers: auth(ORGANIZER),
    })
    expect(second.statusCode).toBe(201)
    expect(second.json().match_id).not.toBe(first.json().match_id)

    const matches = await getDb()
      .selectFrom('matches').select('id').where('event_id', '=', id).execute()
    expect(matches).toHaveLength(1)
  })
})

describe('Pickup games — integrity', () => {
  it('a pickup game cannot be graded above amateur', async () => {
    const id = await createGame(5)
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/events/${id}/tier`,
      headers: auth(ORGANIZER),
      payload: { tier: 'pro' },
    })
    // You pick the game, the teams and the opposition — a gradeable pickup game
    // would be the easiest rating to manufacture in the product.
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/always amateur/i)
  })

  it('is created at amateur with sign-ups already open', async () => {
    const id = await createGame(5)
    const row = await getDb()
      .selectFrom('events').select(['tier', 'status', 'format', 'players_per_side'])
      .where('id', '=', id).executeTakeFirstOrThrow()
    expect(row.tier).toBe('amateur')
    expect(row.status).toBe('registration')
    expect(row.format).toBe('casual')
    expect(row.players_per_side).toBe(5)
  })

  it('only the organizer who owns it can remove a player', async () => {
    const id = await createGame(5)
    await join(id, ALICE)
    const res = await app.inject({
      method: 'DELETE', url: `/v1/games/${id}/players/${ALICE}`, headers: auth(BOB),
    })
    expect(res.statusCode).toBe(403)
  })
})
