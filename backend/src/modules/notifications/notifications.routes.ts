import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAuth } from '../../shared/middleware/auth'
import { getDb } from '../../shared/db/client'

const RegisterTokenBody = z.object({
  token: z.string().min(10).max(255),
  platform: z.enum(['ios', 'android', 'web']).optional(),
  device_id: z.string().max(120).optional(),
})

export async function notificationsRoutes(app: FastifyInstance) {
  /**
   * POST /push/register
   *
   * Called on every sign-in. Upserts on the token rather than (user, device):
   * Expo reissues tokens, and the same handset can be handed to another player —
   * in which case the token must move to the new owner, not sit under the old one.
   */
  app.post('/push/register', { preHandler: requireAuth }, async (request, reply) => {
    const body = RegisterTokenBody.safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() })

    await getDb()
      .insertInto('push_tokens')
      .values({
        user_id: request.userId,
        token: body.data.token,
        platform: body.data.platform ?? null,
        device_id: body.data.device_id ?? null,
      })
      .onConflict((oc) =>
        oc.column('token').doUpdateSet({
          user_id: request.userId,
          platform: body.data.platform ?? null,
          device_id: body.data.device_id ?? null,
          updated_at: new Date(),
        })
      )
      .execute()

    return { registered: true }
  })

  /**
   * DELETE /push/register — on sign-out, so the next user of this device does not
   * receive the previous one's notifications.
   */
  app.delete('/push/register', { preHandler: requireAuth }, async (request, reply) => {
    const body = z.object({ token: z.string().min(10) }).safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() })

    await getDb()
      .deleteFrom('push_tokens')
      .where('token', '=', body.data.token)
      .where('user_id', '=', request.userId)
      .execute()

    return { removed: true }
  })

  /**
   * GET /notifications — in-app history, so a missed push is not a lost message.
   */
  app.get('/notifications', { preHandler: requireAuth }, async (request) => {
    const query = request.query as { limit?: string; unread?: string }
    const limit = Math.min(Number(query.limit ?? 30), 100)

    let q = getDb()
      .selectFrom('notifications')
      .select(['id', 'type', 'title', 'body', 'data', 'read_at', 'created_at'])
      .where('user_id', '=', request.userId)
      .orderBy('created_at', 'desc')
      .limit(limit)

    if (query.unread === 'true') q = q.where('read_at', 'is', null)

    const notifications = await q.execute()
    const { unread } = await getDb()
      .selectFrom('notifications')
      .select((eb) => eb.fn.countAll<string>().as('unread'))
      .where('user_id', '=', request.userId)
      .where('read_at', 'is', null)
      .executeTakeFirstOrThrow()

    return { unread: Number(unread), count: notifications.length, notifications }
  })

  /**
   * POST /notifications/read — marks everything read, or a specific set.
   */
  app.post('/notifications/read', { preHandler: requireAuth }, async (request, reply) => {
    const body = z
      .object({ ids: z.array(z.string().uuid()).max(200).optional() })
      .safeParse(request.body ?? {})
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() })

    let q = getDb()
      .updateTable('notifications')
      .set({ read_at: new Date() })
      .where('user_id', '=', request.userId)
      .where('read_at', 'is', null)

    if (body.data.ids && body.data.ids.length > 0) {
      q = q.where('id', 'in', body.data.ids)
    }

    await q.execute()
    return { read: true }
  })
}
