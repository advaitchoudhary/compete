import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireRole } from '../../shared/middleware/auth'
import { getDb } from '../../shared/db/client'

const SetRefereesBody = z.object({
  referees: z
    .array(
      z.object({
        user_id: z.string().uuid(),
        pitch_label: z.string().max(40).optional(),
      })
    )
    .min(1)
    .max(20),
})

export async function eventRefereesRoutes(app: FastifyInstance) {
  /**
   * POST /events/:id/referees
   *
   * The organizer nominates which already-approved referees are working this
   * tournament, and optionally pins each to a pitch. Replaces the whole roster
   * so the client can send the current selection without diffing.
   *
   * This grants the organizer NO scoring ability — it only records who is
   * eligible to be stamped onto generated matches as referee_id. Scoring stays
   * gated behind requireRole('referee','admin') plus assertMatchReferee.
   */
  app.post(
    '/events/:id/referees',
    { preHandler: requireRole('organizer', 'admin') },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const body = SetRefereesBody.safeParse(request.body)
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() })

      const ids = body.data.referees.map((r) => r.user_id)
      if (new Set(ids).size !== ids.length) {
        return reply.code(400).send({ error: 'The same referee appears twice (duplicate user_id)' })
      }

      const db = getDb()

      const event = await db
        .selectFrom('events')
        .select(['id', 'organizer_id'])
        .where('id', '=', id)
        .executeTakeFirst()

      if (!event) return reply.code(404).send({ error: 'Event not found' })
      if (event.organizer_id !== request.userId && request.userRole !== 'admin') {
        return reply.code(403).send({ error: 'Forbidden — not your event' })
      }

      // Every nominee must actually hold the referee role. An organizer cannot
      // smuggle a friend (or themselves) into a scoring position.
      const valid = await db
        .selectFrom('users')
        .select('id')
        .where('id', 'in', ids)
        .where('role', 'in', ['referee', 'admin'])
        .where('is_active', '=', true)
        .execute()

      const validIds = new Set(valid.map((u) => u.id))
      const invalid = ids.filter((uid) => !validIds.has(uid))
      if (invalid.length > 0) {
        return reply.code(400).send({
          error: `not an approved referee: ${invalid.join(', ')}`,
        })
      }

      await db.transaction().execute(async (trx) => {
        await trx.deleteFrom('event_referees').where('event_id', '=', id).execute()
        await trx
          .insertInto('event_referees')
          .values(
            body.data.referees.map((r) => ({
              event_id: id,
              user_id: r.user_id,
              pitch_label: r.pitch_label ?? null,
            }))
          )
          .execute()
      })

      return { event_id: id, count: body.data.referees.length }
    }
  )

  /**
   * GET /events/:id/referees
   * The event's referee roster, with names and tiers so the organizer can see
   * which tiers of match each of them is allowed to officiate.
   */
  app.get(
    '/events/:id/referees',
    { preHandler: requireRole('organizer', 'admin') },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const db = getDb()

      const event = await db
        .selectFrom('events')
        .select(['id', 'organizer_id'])
        .where('id', '=', id)
        .executeTakeFirst()

      if (!event) return reply.code(404).send({ error: 'Event not found' })
      if (event.organizer_id !== request.userId && request.userRole !== 'admin') {
        return reply.code(403).send({ error: 'Forbidden — not your event' })
      }

      const referees = await db
        .selectFrom('event_referees as er')
        .innerJoin('users as u', 'u.id', 'er.user_id')
        .select([
          'er.user_id',
          'er.pitch_label',
          'er.added_at',
          'u.name',
          'u.avatar_url',
          'u.referee_tier',
        ])
        .where('er.event_id', '=', id)
        .orderBy('er.pitch_label', 'asc')
        .execute()

      return { event_id: id, count: referees.length, referees }
    }
  )
}
