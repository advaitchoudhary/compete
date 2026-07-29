import type { FastifyRequest, FastifyReply } from 'fastify'
import { getDb } from '../../shared/db/client'

/**
 * Ensures the caller is the referee assigned to this match (or an admin).
 * Use AFTER requireRole('referee','admin') so request.userRole is populated.
 *
 * Throws after sending the response so the route handler aborts.
 */
export async function assertMatchReferee(
  matchId: string,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const match = await getDb()
    .selectFrom('matches')
    .select('referee_id')
    .where('id', '=', matchId)
    .executeTakeFirst()

  if (!match) {
    reply.code(404).send({ error: 'Match not found' })
    throw new Error('not found')
  }

  // Admins can manage any match
  if (request.userRole === 'admin') return

  if (match.referee_id !== request.userId) {
    reply.code(403).send({ error: 'Only the match referee can manage this match' })
    throw new Error('forbidden')
  }
}
