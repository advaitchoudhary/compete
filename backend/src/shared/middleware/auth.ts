import type { FastifyRequest, FastifyReply } from 'fastify'
import { getDb } from '../db/client'
import type { UserRole } from '../db/types'

declare module 'fastify' {
  interface FastifyRequest {
    userId: string
    userRole: UserRole
  }
}

export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    await request.jwtVerify()
    // jwtVerify attaches the decoded payload to request.user
    // We cast it to our payload shape
    const payload = request.user as { sub: string }
    request.userId = payload.sub
  } catch {
    reply.code(401).send({ error: 'Unauthorized' })
  }
}

/**
 * requireRole(...roles)
 *
 * Verifies the JWT and checks the user's *current* role from the DB
 * (not the token), so an admin approval / role change takes effect
 * immediately without forcing the user to re-login.
 *
 * Use instead of requireAuth when an endpoint is role-gated, e.g.
 *   { preHandler: requireRole('referee') }
 *   { preHandler: requireRole('admin') }
 */
export function requireRole(...roles: UserRole[]) {
  return async function (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      await request.jwtVerify()
      request.userId = (request.user as { sub: string }).sub
    } catch {
      return reply.code(401).send({ error: 'Unauthorized' })
    }

    const user = await getDb()
      .selectFrom('users')
      .select('role')
      .where('id', '=', request.userId)
      .where('is_active', '=', true)
      .executeTakeFirst()

    if (!user) {
      return reply.code(401).send({ error: 'Unauthorized' })
    }

    request.userRole = user.role
    if (!roles.includes(user.role)) {
      return reply.code(403).send({
        error: `Forbidden — requires role: ${roles.join(' or ')}`,
      })
    }
  }
}
