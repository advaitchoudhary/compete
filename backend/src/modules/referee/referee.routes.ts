import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAuth, requireRole } from '../../shared/middleware/auth'
import { getDb } from '../../shared/db/client'
import { MATCH_TIERS, TIER_RANK } from '../../shared/tiers'

const ApplyBody = z.object({
  full_name: z.string().min(2).max(80),
  city: z.string().min(2).max(50),
  phone: z.string().min(6).max(20).optional(),
  experience_years: z.number().int().min(0).max(80).optional(),
  // Sport slugs the applicant can officiate
  sports: z.array(z.string()).min(1).max(10).optional(),
  certification: z.string().max(200).optional(),
  bio: z.string().max(500).optional(),
})

export async function refereeRoutes(app: FastifyInstance) {
  /**
   * POST /referee/apply
   * A player applies to become a referee. Creates a pending application
   * that an admin must approve. One pending application at a time.
   */
  app.post('/referee/apply', { preHandler: requireAuth }, async (request, reply) => {
    const body = ApplyBody.safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() })

    const db = getDb()

    const me = await db
      .selectFrom('users')
      .select('role')
      .where('id', '=', request.userId)
      .executeTakeFirst()

    if (!me) return reply.code(401).send({ error: 'Unauthorized' })
    if (me.role === 'referee' || me.role === 'admin') {
      return reply.code(409).send({ error: 'You are already a referee' })
    }

    // Reject if a pending application already exists
    const pending = await db
      .selectFrom('referee_applications')
      .select('id')
      .where('user_id', '=', request.userId)
      .where('status', '=', 'pending')
      .executeTakeFirst()

    if (pending) {
      return reply.code(409).send({ error: 'You already have a pending application' })
    }

    const application = await db
      .insertInto('referee_applications')
      .values({
        user_id: request.userId,
        full_name: body.data.full_name,
        city: body.data.city,
        phone: body.data.phone ?? null,
        experience_years: body.data.experience_years ?? null,
        sports: body.data.sports ?? null,
        certification: body.data.certification ?? null,
        bio: body.data.bio ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    return reply.code(201).send(application)
  })

  /**
   * POST /referee/upgrade
   * An approved referee requests promotion to a higher tier. Creates a pending
   * 'upgrade' application that an admin approves (which bumps referee_tier).
   */
  app.post('/referee/upgrade', { preHandler: requireRole('referee') }, async (request, reply) => {
    const body = z
      .object({ requested_tier: z.enum(MATCH_TIERS), note: z.string().max(500).optional() })
      .safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() })

    const db = getDb()
    const me = await db
      .selectFrom('users')
      .select(['name', 'city', 'referee_tier'])
      .where('id', '=', request.userId)
      .executeTakeFirstOrThrow()

    const current = me.referee_tier ?? 'amateur'
    if (TIER_RANK[body.data.requested_tier] <= TIER_RANK[current]) {
      return reply.code(400).send({
        error: `Requested tier must be higher than your current tier (${current})`,
      })
    }

    const pending = await db
      .selectFrom('referee_applications')
      .select('id')
      .where('user_id', '=', request.userId)
      .where('status', '=', 'pending')
      .executeTakeFirst()
    if (pending) return reply.code(409).send({ error: 'You already have a pending request' })

    const application = await db
      .insertInto('referee_applications')
      .values({
        user_id: request.userId,
        full_name: me.name,
        city: me.city ?? 'Unknown',
        request_type: 'upgrade',
        requested_tier: body.data.requested_tier,
        bio: body.data.note ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    return reply.code(201).send(application)
  })

  /**
   * GET /referee/me
   * Returns the caller's role and their latest referee application (if any).
   */
  app.get('/referee/me', { preHandler: requireAuth }, async (request, reply) => {
    const db = getDb()

    const me = await db
      .selectFrom('users')
      .select(['id', 'name', 'role', 'referee_tier'])
      .where('id', '=', request.userId)
      .executeTakeFirst()

    if (!me) return reply.code(401).send({ error: 'Unauthorized' })

    const application = await db
      .selectFrom('referee_applications')
      .selectAll()
      .where('user_id', '=', request.userId)
      .orderBy('created_at', 'desc')
      .executeTakeFirst()

    return {
      user_id: me.id,
      name: me.name,
      role: me.role,
      is_referee: me.role === 'referee' || me.role === 'admin',
      referee_tier: me.referee_tier,
      application: application ?? null,
    }
  })
}
