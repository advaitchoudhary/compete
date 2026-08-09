import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireRole } from '../../shared/middleware/auth'
import { getDb } from '../../shared/db/client'
import { MATCH_TIERS } from '../../shared/tiers'
import { assertTierSupported, eventHasFixtures, maxTierForEvent } from './event-tier'

const SetTierBody = z.object({ tier: z.enum(MATCH_TIERS) })

export async function eventTierRoutes(app: FastifyInstance) {
  /**
   * PATCH /events/:id/tier
   *
   * Sets the competition grade of a tournament. Capped by the lowest
   * referee_tier among assigned referees, and frozen once fixtures exist so a
   * finished amateur event cannot be re-declared 'legends' to retroactively
   * reweight ratings. See spec §3.1.1.
   */
  app.patch(
    '/events/:id/tier',
    { preHandler: requireRole('organizer', 'admin') },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const body = SetTierBody.safeParse(request.body)
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() })

      const db = getDb()
      const event = await db
        .selectFrom('events')
        .select(['id', 'organizer_id', 'tier', 'format'])
        .where('id', '=', id)
        .executeTakeFirst()

      if (!event) return reply.code(404).send({ error: 'Event not found' })

      // A pickup game is amateur and stays amateur. The organizer picks the game,
      // the teams and the opposition, so a gradeable pickup game would be the
      // easiest way in the product to manufacture a rating.
      if (event.format === 'casual') {
        return reply.code(409).send({
          error: 'Pickup games are always amateur grade — only tournaments can be graded',
        })
      }
      if (event.organizer_id !== request.userId && request.userRole !== 'admin') {
        return reply.code(403).send({ error: 'Forbidden — not your event' })
      }

      if (await eventHasFixtures(id)) {
        return reply.code(409).send({
          error: 'Tier is locked once fixtures have been generated',
        })
      }

      const supported = await assertTierSupported(id, body.data.tier)
      if (!supported.ok) return reply.code(409).send({ error: supported.reason })

      const updated = await db
        .updateTable('events')
        .set({ tier: body.data.tier })
        .where('id', '=', id)
        .returning(['id', 'tier'])
        .executeTakeFirstOrThrow()

      return {
        event_id: updated.id,
        tier: updated.tier,
        max_supported: await maxTierForEvent(id),
      }
    }
  )
}
