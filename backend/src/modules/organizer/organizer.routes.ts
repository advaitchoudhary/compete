import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAuth } from '../../shared/middleware/auth'
import { getDb } from '../../shared/db/client'

const ApplyBody = z.object({
  full_name: z.string().min(2).max(80),
  city: z.string().min(2).max(50),
  // The turf/venue they run tournaments at — the thing that makes them credible.
  venue_name: z.string().min(2).max(120),
  phone: z.string().min(6).max(20).optional(),
  bio: z.string().max(500).optional(),
})

export async function organizerRoutes(app: FastifyInstance) {
  /**
   * POST /organizer/apply
   * A player applies to run tournaments. Creates a pending application that an
   * admin must approve. Reuses referee_applications with request_type
   * 'organizer' so admins triage referees and organizers in one queue.
   */
  app.post('/organizer/apply', { preHandler: requireAuth }, async (request, reply) => {
    const body = ApplyBody.safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() })

    const db = getDb()

    const me = await db
      .selectFrom('users')
      .select('role')
      .where('id', '=', request.userId)
      .executeTakeFirst()

    if (!me) return reply.code(401).send({ error: 'Unauthorized' })
    if (me.role === 'organizer') {
      return reply.code(409).send({ error: 'You are already an organizer' })
    }
    // A referee scores matches and an organizer must never score one. With a
    // single role per user, holding both would break that separation.
    if (me.role === 'referee') {
      return reply.code(409).send({
        error: 'A referee cannot also be an organizer — organizers must never score matches',
      })
    }
    if (me.role === 'admin') {
      return reply.code(409).send({ error: 'Admins can already create events' })
    }

    const pending = await db
      .selectFrom('referee_applications')
      .select('id')
      .where('user_id', '=', request.userId)
      .where('status', '=', 'pending')
      .executeTakeFirst()

    if (pending) {
      return reply.code(409).send({ error: 'You already have a pending application' })
    }

    // venue_name is folded into bio because referee_applications has no venue
    // column; it is a review aid for the admin, not queried data.
    const bio = body.data.bio
      ? `Venue: ${body.data.venue_name}. ${body.data.bio}`
      : `Venue: ${body.data.venue_name}.`

    const application = await db
      .insertInto('referee_applications')
      .values({
        user_id: request.userId,
        full_name: body.data.full_name,
        city: body.data.city,
        phone: body.data.phone ?? null,
        request_type: 'organizer',
        bio,
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    return reply.code(201).send(application)
  })

  /**
   * GET /organizer/me
   * The caller's role plus their latest application, for driving the UI state.
   */
  app.get('/organizer/me', { preHandler: requireAuth }, async (request, reply) => {
    const db = getDb()

    const me = await db
      .selectFrom('users')
      .select(['id', 'name', 'role'])
      .where('id', '=', request.userId)
      .executeTakeFirst()

    if (!me) return reply.code(401).send({ error: 'Unauthorized' })

    const application = await db
      .selectFrom('referee_applications')
      .selectAll()
      .where('user_id', '=', request.userId)
      .where('request_type', '=', 'organizer')
      .orderBy('created_at', 'desc')
      .executeTakeFirst()

    return {
      user_id: me.id,
      name: me.name,
      role: me.role,
      is_organizer: me.role === 'organizer' || me.role === 'admin',
      application: application ?? null,
    }
  })
}
