import type { FastifyInstance } from 'fastify'
import { getUserAchievements } from './achievements.service'

export async function achievementsRoutes(app: FastifyInstance) {
  app.get('/users/:id/achievements', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { sport } = request.query as { sport?: string }
    return getUserAchievements(id, sport)
  })
}
