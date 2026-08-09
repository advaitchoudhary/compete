import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getDb } from '../../shared/db/client'
import { capacityOf } from './roster'

/**
 * The public page for a pickup game — the link the organizer drops in a WhatsApp
 * group.
 *
 * Unauthenticated, like the tournament page it mirrors, because the person opening
 * it has usually never heard of AllSports. Same conventions as
 * events/public-event.routes.ts: no preHandler, a rate limit standing in for auth,
 * the id validated before any database work, a cancelled game answering 404 rather
 * than 403 so nothing leaks, and a response written out field by field.
 *
 * That last one is the important one. Building the response as an allowlist means a
 * column added to `events` or `users` later cannot quietly become world-readable —
 * and this page shows a list of real people's names, so the bar is higher than for
 * a bracket.
 */

/** A cancelled game is treated as never having existed. */
const HIDDEN_STATUSES = new Set(['cancelled'])

/** Generous for a group chat all opening it at once, bounded for a scraper. */
const PUBLIC_RATE_LIMIT = { max: 240, timeWindow: '1 minute' }

export async function publicGameRoutes(app: FastifyInstance) {
  app.get(
    '/public/games/:id',
    { config: { rateLimit: PUBLIC_RATE_LIMIT } },
    async (request, reply) => {
      const parsed = z.string().uuid().safeParse((request.params as { id: string }).id)
      if (!parsed.success) return reply.code(400).send({ error: 'Invalid game id' })
      const id = parsed.data

      const db = getDb()
      const game = await db
        .selectFrom('events as e')
        .innerJoin('sports as s', 's.id', 'e.sport_id')
        .select([
          'e.id', 'e.name', 'e.status', 'e.players_per_side', 'e.match_format',
          'e.match_duration_minutes', 'e.city', 'e.venue', 'e.starts_at',
          's.slug as sport_slug',
        ])
        .where('e.id', '=', id)
        .where('e.format', '=', 'casual')
        .executeTakeFirst()

      if (!game || HIDDEN_STATUSES.has(game.status)) {
        return reply.code(404).send({ error: 'Game not found' })
      }

      const rows = await db
        .selectFrom('event_players as ep')
        .innerJoin('users as u', 'u.id', 'ep.user_id')
        .select(['ep.status', 'ep.position', 'ep.joined_at', 'ep.team_id', 'u.name'])
        .where('ep.event_id', '=', id)
        .where('ep.status', '!=', 'withdrawn')
        .orderBy('ep.joined_at', 'asc')
        .execute()

      const capacity = capacityOf(game.players_per_side)
      const confirmed = rows.filter((r) => r.status === 'confirmed')
      const waiting = rows.filter((r) => r.status === 'waitlist')

      // Sides only once they exist. Before the draw there is nothing to show, and
      // guessing would be worse than saying nothing.
      const teamIds = [...new Set(confirmed.map((r) => r.team_id).filter(Boolean))] as string[]
      const sides =
        teamIds.length === 2
          ? await (async () => {
              const teams = await db
                .selectFrom('teams')
                .select(['id', 'name'])
                .where('id', 'in', teamIds)
                .execute()
              return teams.map((t) => ({
                name: t.name,
                players: confirmed.filter((r) => r.team_id === t.id).map((r) => r.name),
              }))
            })()
          : null

      return {
        id: game.id,
        name: game.name,
        status: game.status,
        sport_slug: game.sport_slug,
        players_per_side: game.players_per_side,
        match_format: game.match_format,
        duration_minutes: game.match_duration_minutes,
        city: game.city,
        venue: game.venue,
        starts_at: game.starts_at,
        capacity,
        confirmed_count: confirmed.length,
        spots_left: Math.max(capacity - confirmed.length, 0),
        waitlist_count: waiting.length,
        // Names only. Nothing here needs a user id, so none is sent — unlike the
        // tournament page, which exposes scorer ids because the claim link needs them.
        playing: confirmed.map((r) => ({ name: r.name, position: r.position })),
        waiting: waiting.map((r) => ({ name: r.name })),
        sides,
      }
    }
  )
}
