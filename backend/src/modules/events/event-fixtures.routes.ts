import type { FastifyInstance } from 'fastify'
import { requireRole } from '../../shared/middleware/auth'
import { getDb } from '../../shared/db/client'
import { generateFixtures } from './bracket/generator'

export async function eventFixturesRoutes(app: FastifyInstance) {
  /**
   * POST /events/:id/fixtures
   *
   * Builds the whole tournament: groups, knockout rounds, slots, pitches and
   * referees. One transaction — all of it or none. Re-runnable while nothing has
   * kicked off, so an organizer can re-seed after a team withdraws.
   */
  app.post(
    '/events/:id/fixtures',
    { preHandler: requireRole('organizer', 'admin') },
    async (request, reply) => {
      const { id } = request.params as { id: string }

      const event = await getDb()
        .selectFrom('events')
        .select(['id', 'organizer_id'])
        .where('id', '=', id)
        .executeTakeFirst()

      if (!event) return reply.code(404).send({ error: 'Event not found' })
      if (event.organizer_id !== request.userId && request.userRole !== 'admin') {
        return reply.code(403).send({ error: 'Forbidden — not your event' })
      }

      const result = await generateFixtures(id)
      if (!result.ok) return reply.code(result.code).send({ error: result.error })

      return reply.code(201).send({
        event_id: id,
        fixtures: result.fixtures,
        matches: result.matches,
        fell_back: result.fell_back,
        fallback_reason: result.fallback_reason,
      })
    }
  )
}
