import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireRole } from '../../shared/middleware/auth'
import { getDb } from '../../shared/db/client'

const RejectBody = z.object({
  notes: z.string().max(500).optional(),
})

export async function adminRoutes(app: FastifyInstance) {
  /**
   * GET /admin/referee-applications?status=pending
   * Admin review queue. Defaults to pending applications.
   */
  app.get(
    '/admin/referee-applications',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      const query = request.query as {
        status?: string
        request_type?: string
        limit?: string
        offset?: string
      }
      const status = query.status ?? 'pending'
      const limit = Math.min(Number(query.limit ?? 50), 100)
      const offset = Number(query.offset ?? 0)

      if (!['pending', 'approved', 'rejected'].includes(status)) {
        return reply.code(400).send({ error: 'Invalid status filter' })
      }
      if (
        query.request_type &&
        !['initial', 'upgrade', 'organizer'].includes(query.request_type)
      ) {
        return reply.code(400).send({ error: 'Invalid request_type filter' })
      }

      let q = getDb()
        .selectFrom('referee_applications as ra')
        .innerJoin('users as u', 'u.id', 'ra.user_id')
        .select([
          'ra.id', 'ra.user_id', 'ra.full_name', 'ra.city', 'ra.phone',
          'ra.experience_years', 'ra.sports', 'ra.certification', 'ra.bio',
          'ra.request_type', 'ra.requested_tier',
          'ra.status', 'ra.reviewed_by', 'ra.reviewed_at', 'ra.review_notes',
          'ra.created_at',
          'u.name as user_name', 'u.username', 'u.avatar_url', 'u.referee_tier',
        ])
        .where('ra.status', '=', status as 'pending' | 'approved' | 'rejected')
        .orderBy('ra.created_at', 'desc')
        .limit(limit)
        .offset(offset)

      if (query.request_type) {
        q = q.where(
          'ra.request_type',
          '=',
          query.request_type as 'initial' | 'upgrade' | 'organizer'
        )
      }

      const applications = await q.execute()

      return {
        status,
        request_type: query.request_type ?? null,
        count: applications.length,
        applications,
      }
    }
  )

  /**
   * POST /admin/referee-applications/:id/approve
   * Approves an application and promotes the applicant to 'referee'.
   */
  app.post(
    '/admin/referee-applications/:id/approve',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const db = getDb()

      const result = await db.transaction().execute(async (trx) => {
        const application = await trx
          .selectFrom('referee_applications')
          .selectAll()
          .where('id', '=', id)
          .forUpdate()
          .executeTakeFirst()

        if (!application) return { error: 'not_found' as const }
        if (application.status !== 'pending') {
          return { error: 'already_reviewed' as const, status: application.status }
        }

        const updated = await trx
          .updateTable('referee_applications')
          .set({
            status: 'approved',
            reviewed_by: request.userId,
            reviewed_at: new Date(),
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow()

        if (application.request_type === 'organizer') {
          // Organizers schedule; they never officiate. Deliberately leave
          // referee_tier NULL so no scoring capability is implied.
          await trx
            .updateTable('users')
            .set({ role: 'organizer' })
            .where('id', '=', application.user_id)
            .execute()
        } else {
          // Promote to referee and set their tier. Initial requests grant
          // 'amateur'; upgrade requests grant the requested tier.
          const grantedTier = application.requested_tier ?? 'amateur'
          await trx
            .updateTable('users')
            .set({ role: 'referee', referee_tier: grantedTier })
            .where('id', '=', application.user_id)
            .execute()
        }

        return { application: updated }
      })

      if ('error' in result) {
        if (result.error === 'not_found') {
          return reply.code(404).send({ error: 'Application not found' })
        }
        return reply.code(409).send({
          error: `Application already ${result.status}`,
        })
      }

      return { approved: true, application: result.application }
    }
  )

  /**
   * POST /admin/referee-applications/:id/reject
   */
  app.post(
    '/admin/referee-applications/:id/reject',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const body = RejectBody.safeParse(request.body ?? {})
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() })

      const db = getDb()

      const application = await db
        .selectFrom('referee_applications')
        .select(['id', 'status'])
        .where('id', '=', id)
        .executeTakeFirst()

      if (!application) return reply.code(404).send({ error: 'Application not found' })
      if (application.status !== 'pending') {
        return reply.code(409).send({ error: `Application already ${application.status}` })
      }

      const updated = await db
        .updateTable('referee_applications')
        .set({
          status: 'rejected',
          reviewed_by: request.userId,
          reviewed_at: new Date(),
          review_notes: body.data.notes ?? null,
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow()

      return { rejected: true, application: updated }
    }
  )
}
