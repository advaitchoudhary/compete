import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAuth, requireRole } from '../../shared/middleware/auth'
import { getDb } from '../../shared/db/client'
import { createGuest } from '../users/guest.service'
import { notifyUsers } from '../notifications/notify.service'
import {
  capacityOf, countConfirmed, loadGame, partyMembers,
  promoteFromWaitlist, rosterFor, waitlistParties,
} from './roster'

/**
 * Pickup games — the weekly kickabout, as opposed to the occasional tournament.
 *
 * A game is an `events` row with format 'casual'. People join as individuals rather
 * than as registered teams, overflow waits in a queue that refills itself, and the
 * sides are drawn only when the game is full.
 *
 * Deliberately fixed at amateur grade. You choose your own game, your own teammates
 * and your own opposition, which makes this the easiest surface in the product on
 * which to inflate a rating — see the guard on PATCH /events/:id/tier.
 */

const SquadPosition = z.enum(['DEF', 'MID', 'FWD'])

const CreateGameBody = z.object({
  name: z.string().min(3).max(100),
  sport_slug: z.string(),
  // 5v5 through 11v11 — stored as the number because match_format cannot say 9v9.
  players_per_side: z.number().int().min(3).max(11),
  // Feeds the rating weight; a NULL duration is read as a full 90 minutes.
  match_duration_minutes: z.number().int().min(1).max(180),
  city: z.string().min(2).max(50),
  venue: z.string().max(100).optional(),
  starts_at: z.string().datetime().optional(),
})

const JoinBody = z.object({
  /** The caller's own position. They are always part of their party. */
  position: SquadPosition.nullish(),
  /** Mates they are bringing. Existing accounts by id, everyone else by name. */
  players: z
    .array(
      z
        .object({
          user_id: z.string().uuid().optional(),
          name: z.string().min(2).max(80).optional(),
          position: SquadPosition.nullish(),
        })
        .refine((p) => Boolean(p.user_id) !== Boolean(p.name), {
          message: 'each player needs exactly one of user_id or name',
        })
    )
    .max(21)
    .default([]),
})

export async function gamesRoutes(app: FastifyInstance) {
  /**
   * POST /games — create a pickup game.
   */
  app.post('/games', { preHandler: requireRole('organizer', 'admin') }, async (request, reply) => {
    const body = CreateGameBody.safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() })

    const db = getDb()
    const sport = await db
      .selectFrom('sports')
      .select('id')
      .where('slug', '=', body.data.sport_slug)
      .executeTakeFirst()
    if (!sport) return reply.code(404).send({ error: 'Sport not found' })

    const game = await db
      .insertInto('events')
      .values({
        name: body.data.name,
        sport_id: sport.id,
        organizer_id: request.userId,
        format: 'casual',
        // Not the organizer's to choose. See the module note.
        tier: 'amateur',
        players_per_side: body.data.players_per_side,
        match_duration_minutes: body.data.match_duration_minutes,
        city: body.data.city,
        venue: body.data.venue ?? null,
        starts_at: body.data.starts_at ? new Date(body.data.starts_at) : null,
        // Open immediately — a pickup game with closed sign-ups is just a plan.
        status: 'registration',
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    return reply.code(201).send({ ...game, capacity: capacityOf(game.players_per_side) })
  })

  /**
   * GET /games — the caller's own pickup games, with how full each one is.
   */
  app.get('/games', { preHandler: requireRole('organizer', 'admin') }, async (request, reply) => {
    const rows = await getDb()
      .selectFrom('events as e')
      .innerJoin('sports as s', 's.id', 'e.sport_id')
      .select([
        'e.id', 'e.name', 'e.status', 'e.city', 'e.venue', 'e.starts_at',
        'e.players_per_side', 'e.match_duration_minutes', 'e.created_at',
        's.slug as sport_slug',
        (eb) =>
          eb
            .selectFrom('event_players as ep')
            .select((e2) => e2.fn.countAll<string>().as('c'))
            .whereRef('ep.event_id', '=', 'e.id')
            .where('ep.status', '=', 'confirmed')
            .as('confirmed_count'),
        (eb) =>
          eb
            .selectFrom('event_players as ep')
            .select((e2) => e2.fn.countAll<string>().as('c'))
            .whereRef('ep.event_id', '=', 'e.id')
            .where('ep.status', '=', 'waitlist')
            .as('waitlist_count'),
      ])
      .where('e.organizer_id', '=', request.userId)
      .where('e.format', '=', 'casual')
      .orderBy('e.created_at', 'desc')
      .limit(50)
      .execute()

    return {
      items: rows.map((g) => ({
        ...g,
        confirmed_count: Number(g.confirmed_count ?? 0),
        waitlist_count: Number(g.waitlist_count ?? 0),
        capacity: capacityOf(g.players_per_side),
      })),
    }
  })

  /**
   * GET /games/:id — the full roster, in order, with the waitlist queue.
   */
  app.get('/games/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const game = await loadGame(id)
    if (!game) return reply.code(404).send({ error: 'Game not found' })

    const db = getDb()
    const players = await db
      .selectFrom('event_players as ep')
      .innerJoin('users as u', 'u.id', 'ep.user_id')
      .select([
        'ep.user_id', 'ep.added_by', 'ep.status', 'ep.position', 'ep.joined_at',
        'ep.team_id', 'u.name', 'u.is_guest', 'u.claimed_at',
      ])
      .where('ep.event_id', '=', id)
      .where('ep.status', '!=', 'withdrawn')
      .orderBy('ep.joined_at', 'asc')
      .execute()

    const roster = await rosterFor(db, id)
    const capacity = capacityOf(game.players_per_side)
    const confirmed = countConfirmed(roster)

    return {
      game: { ...game, capacity },
      confirmed_count: confirmed,
      spots_left: Math.max(capacity - confirmed, 0),
      // Position in the queue, so the UI can say "you are third in line".
      waitlist_order: waitlistParties(roster).flatMap((p) => p.members),
      players,
      you: {
        joined: players.some((p) => p.user_id === request.userId),
        status: players.find((p) => p.user_id === request.userId)?.status ?? null,
      },
    }
  })

  /**
   * POST /games/:id/join — put yourself down, and anyone you are bringing.
   *
   * The party is placed whole: if it does not fit in the remaining slots the entire
   * group waits together. Splitting four mates across the cut leaves half a group
   * turning up and the other half not.
   */
  app.post('/games/:id/join', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = JoinBody.safeParse(request.body ?? {})
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() })

    const game = await loadGame(id)
    if (!game) return reply.code(404).send({ error: 'Game not found' })
    if (game.status !== 'registration') {
      return reply.code(409).send({ error: `This game is not taking sign-ups (${game.status})` })
    }

    const db = getDb()
    const roster = await rosterFor(db, id)

    if (roster.some((r) => r.user_id === request.userId)) {
      return reply.code(409).send({ error: 'You have already joined this game' })
    }

    const existingIds = body.data.players.filter((p) => p.user_id).map((p) => p.user_id as string)
    const named = body.data.players.filter((p) => p.name)

    // Someone already on the list cannot be brought again by a second person.
    const clash = roster.find((r) => existingIds.includes(r.user_id))
    if (clash) {
      return reply.code(409).send({ error: 'One of those players has already joined this game' })
    }
    if (new Set(existingIds).size !== existingIds.length) {
      return reply.code(400).send({ error: 'The same player appears twice' })
    }

    if (existingIds.length > 0) {
      const found = await db
        .selectFrom('users')
        .select('id')
        .where('id', 'in', existingIds)
        .where('is_active', '=', true)
        .execute()
      if (found.length !== new Set(existingIds).size) {
        return reply.code(400).send({ error: 'One of those players does not exist' })
      }
    }

    const partySize = 1 + existingIds.length + named.length
    const capacity = capacityOf(game.players_per_side)
    const free = capacity - countConfirmed(roster)
    // Whole party in, or whole party waits.
    const status = partySize <= free ? 'confirmed' : 'waitlist'

    const placed = await db.transaction().execute(async (trx) => {
      const rows: Array<{ user_id: string; position: 'DEF' | 'MID' | 'FWD' | null }> = [
        { user_id: request.userId, position: body.data.position ?? null },
      ]

      for (const p of body.data.players) {
        if (p.user_id) {
          rows.push({ user_id: p.user_id, position: p.position ?? null })
          continue
        }
        const guest = await createGuest(trx, {
          name: p.name as string,
          city: game.city,
          createdBy: request.userId,
        })
        rows.push({ user_id: guest.id, position: p.position ?? null })
      }

      await trx
        .insertInto('event_players')
        .values(
          rows.map((r) => ({
            event_id: id,
            user_id: r.user_id,
            // The caller is the party; everyone else was brought by them.
            added_by: r.user_id === request.userId ? null : request.userId,
            status,
            position: r.position,
          }))
        )
        .execute()

      return rows.map((r) => r.user_id)
    })

    const after = await rosterFor(db, id)
    return reply.code(201).send({
      game_id: id,
      status,
      joined: placed.length,
      spots_left: Math.max(capacity - countConfirmed(after), 0),
      waitlist_position:
        status === 'waitlist'
          ? waitlistParties(after).flatMap((p) => p.members).indexOf(request.userId) + 1
          : null,
    })
  })

  /**
   * POST /games/:id/withdraw — drop out, taking anyone you brought with you.
   */
  app.post('/games/:id/withdraw', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const game = await loadGame(id)
    if (!game) return reply.code(404).send({ error: 'Game not found' })
    if (game.status !== 'registration') {
      return reply.code(409).send({
        error: 'The sides have already been drawn — speak to the organizer',
      })
    }

    const db = getDb()
    const leaving = await partyMembers(db, id, request.userId)
    if (leaving.length === 0) {
      return reply.code(404).send({ error: 'You are not in this game' })
    }

    await db
      .updateTable('event_players')
      .set({ status: 'withdrawn' })
      .where('event_id', '=', id)
      .where('user_id', 'in', leaving)
      .execute()

    const promoted = await promoteFromWaitlist(db, id)
    await notifyPromoted(promoted, game.name, id)

    return { game_id: id, withdrew: leaving.length, promoted: promoted.length }
  })

  /**
   * DELETE /games/:id/players/:userId — the organizer removes someone.
   *
   * Same party rule: removing the person who brought a group removes the group.
   */
  app.delete(
    '/games/:id/players/:userId',
    { preHandler: requireRole('organizer', 'admin') },
    async (request, reply) => {
      const { id, userId } = request.params as { id: string; userId: string }
      const game = await loadGame(id)
      if (!game) return reply.code(404).send({ error: 'Game not found' })
      if (game.organizer_id !== request.userId && request.userRole !== 'admin') {
        return reply.code(403).send({ error: 'Forbidden — not your game' })
      }

      const db = getDb()
      const leaving = await partyMembers(db, id, userId)
      if (leaving.length === 0) {
        return reply.code(404).send({ error: 'That player is not in this game' })
      }

      await db
        .updateTable('event_players')
        .set({ status: 'withdrawn' })
        .where('event_id', '=', id)
        .where('user_id', 'in', leaving)
        .execute()

      const promoted = await promoteFromWaitlist(db, id)
      await notifyPromoted(promoted, game.name, id)

      return { game_id: id, removed: leaving.length, promoted: promoted.length }
    }
  )
}

/** Being moved off the waitlist is the one thing a player must not miss. */
async function notifyPromoted(userIds: string[], gameName: string, gameId: string) {
  if (userIds.length === 0) return
  await notifyUsers({
    userIds,
    type: 'game_promoted',
    title: "You're in",
    body: `A spot opened up in ${gameName}. You're off the waitlist and playing.`,
    data: { game_id: gameId },
  })
}
