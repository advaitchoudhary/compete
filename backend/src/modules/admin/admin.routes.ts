import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireRole } from '../../shared/middleware/auth'
import { getDb } from '../../shared/db/client'
import { MATCH_TIERS, TIER_RANK } from '../../shared/tiers'

const RejectBody = z.object({
  notes: z.string().max(500).optional(),
})

const SetTierBody = z.object({ tier: z.enum(MATCH_TIERS) })

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

  /**
   * GET /admin/referees?q=
   *
   * Every approved official and the grade they hold. Approval grants a tier once
   * and nothing could change it afterwards, so a referee who earned a promotion —
   * or who should be demoted — could only be edited directly in Postgres. That is
   * a poor place for the control the whole rating ladder rests on.
   */
  app.get('/admin/referees', { preHandler: requireRole('admin') }, async (request, reply) => {
    const query = request.query as { q?: string }
    const db = getDb()

    let qb = db
      .selectFrom('users as u')
      .select([
        'u.id', 'u.name', 'u.username', 'u.city', 'u.avatar_url', 'u.referee_tier', 'u.is_active',
        // What they have actually done, so a grade is a judgement rather than a guess.
        (eb) =>
          eb
            .selectFrom('matches as m')
            .select((e2) => e2.fn.countAll<string>().as('c'))
            .whereRef('m.referee_id', '=', 'u.id')
            .where('m.status', '=', 'completed')
            .as('matches_officiated'),
        (eb) =>
          eb
            .selectFrom('event_referees as er')
            .innerJoin('events as e', 'e.id', 'er.event_id')
            .select((e2) => e2.fn.countAll<string>().as('c'))
            .whereRef('er.user_id', '=', 'u.id')
            .where('e.status', 'in', ['registration', 'active', 'upcoming'])
            .as('upcoming_events'),
      ])
      .where('u.role', '=', 'referee')
      .orderBy('u.name', 'asc')
      .limit(200)

    if (query.q?.trim()) {
      const term = `%${query.q.trim()}%`
      qb = qb.where((eb) => eb.or([eb('u.name', 'ilike', term), eb('u.username', 'ilike', term)]))
    }

    const rows = await qb.execute()
    return {
      tiers: MATCH_TIERS,
      count: rows.length,
      referees: rows.map((r) => ({
        ...r,
        matches_officiated: Number(r.matches_officiated ?? 0),
        upcoming_events: Number(r.upcoming_events ?? 0),
      })),
    }
  })

  /**
   * PATCH /admin/referees/:id/tier
   *
   * A referee's grade caps every tournament they are assigned to, so lowering it
   * can leave an event graded above what its roster now supports. That is not
   * blocked — an admin demoting someone usually means it — but the affected
   * events are named in the response so it is a decision rather than a surprise.
   */
  app.patch(
    '/admin/referees/:id/tier',
    { preHandler: requireRole('admin') },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const body = SetTierBody.safeParse(request.body)
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() })

      const db = getDb()
      const referee = await db
        .selectFrom('users')
        .select(['id', 'name', 'role', 'referee_tier'])
        .where('id', '=', id)
        .executeTakeFirst()

      if (!referee) return reply.code(404).send({ error: 'Referee not found' })
      if (referee.role !== 'referee') {
        return reply.code(409).send({ error: `${referee.name} is not a referee` })
      }

      // Events this person is on that are graded above the tier they are about to
      // hold. Read BEFORE the write so the comparison is against the new value.
      const affected = await db
        .selectFrom('event_referees as er')
        .innerJoin('events as e', 'e.id', 'er.event_id')
        .select(['e.id', 'e.name', 'e.tier', 'e.status'])
        .where('er.user_id', '=', id)
        .where('e.status', 'in', ['upcoming', 'registration', 'active'])
        .execute()

      const nowUnsupported = affected.filter(
        (e) => TIER_RANK[e.tier] > TIER_RANK[body.data.tier]
      )

      const updated = await db
        .updateTable('users')
        .set({ referee_tier: body.data.tier })
        .where('id', '=', id)
        .returning(['id', 'name', 'referee_tier'])
        .executeTakeFirstOrThrow()

      return {
        referee: updated,
        previous_tier: referee.referee_tier,
        // Named so the admin sees what they just affected.
        events_now_above_this_referee: nowUnsupported.map((e) => ({
          id: e.id,
          name: e.name,
          tier: e.tier,
          status: e.status,
        })),
      }
    }
  )
}
