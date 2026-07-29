import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import jwt from '@fastify/jwt'
import rateLimit from '@fastify/rate-limit'

import { authRoutes } from './modules/auth/auth.routes'
import { usersRoutes } from './modules/users/users.routes'
import { sportsRoutes } from './modules/sports/sports.routes'
import { teamsRoutes } from './modules/teams/teams.routes'
import { eventsRoutes } from './modules/events/events.routes'
import { eventRefereesRoutes } from './modules/events/event-referees.routes'
import { matchesRoutes } from './modules/matches/matches.routes'
import { scoresRoutes } from './modules/scores/scores.routes'
import { achievementsRoutes } from './modules/achievements/achievements.routes'
import { refereeRoutes } from './modules/referee/referee.routes'
import { organizerRoutes } from './modules/organizer/organizer.routes'
import { adminRoutes } from './modules/admin/admin.routes'
import { initFirebase } from './modules/auth/auth.service'

const PORT = Number(process.env.PORT ?? 3000)
const HOST = process.env.HOST ?? '0.0.0.0'

async function build() {
  const app = Fastify({
    logger: {
      transport:
        process.env.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
  })

  // Plugins
  await app.register(cors, {
    origin: process.env.NODE_ENV === 'development' ? true : process.env.ALLOWED_ORIGINS?.split(','),
    credentials: true,
  })
  await app.register(helmet)
  await app.register(jwt, { secret: process.env.JWT_SECRET! })
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
    errorResponseBuilder: () => ({ error: 'Too many requests, slow down' }),
  })

  // Health check
  app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }))

  // Routes — all under /v1
  const V1_PREFIX = '/v1'
  await app.register(authRoutes, { prefix: V1_PREFIX })
  await app.register(usersRoutes, { prefix: V1_PREFIX })
  await app.register(sportsRoutes, { prefix: V1_PREFIX })
  await app.register(teamsRoutes, { prefix: V1_PREFIX })
  await app.register(eventsRoutes, { prefix: V1_PREFIX })
  await app.register(eventRefereesRoutes, { prefix: V1_PREFIX })
  await app.register(matchesRoutes, { prefix: V1_PREFIX })
  await app.register(scoresRoutes, { prefix: V1_PREFIX })
  await app.register(achievementsRoutes, { prefix: V1_PREFIX })
  await app.register(refereeRoutes, { prefix: V1_PREFIX })
  await app.register(organizerRoutes, { prefix: V1_PREFIX })
  await app.register(adminRoutes, { prefix: V1_PREFIX })

  // Global error handler
  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error)
    if (error.validation) {
      return reply.code(400).send({ error: 'Validation error', details: error.message })
    }
    reply.code(error.statusCode ?? 500).send({
      error: process.env.NODE_ENV === 'production' ? 'Internal server error' : error.message,
    })
  })

  return app
}

async function main() {
  initFirebase()

  const app = await build()
  await app.listen({ port: PORT, host: HOST })
  app.log.info(`AllSports API running on http://${HOST}:${PORT}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
