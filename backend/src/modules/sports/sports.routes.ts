import type { FastifyInstance } from 'fastify'
import { getDb } from '../../shared/db/client'
import { getRedis, CacheKeys } from '../../shared/redis/client'

export async function sportsRoutes(app: FastifyInstance) {
  // GET /sports — list all active sports
  app.get('/sports', async (_request, reply) => {
    const db = getDb()
    const sports = await db
      .selectFrom('sports')
      .select(['id', 'name', 'slug', 'icon_url', 'stat_schema'])
      .where('active', '=', true)
      .orderBy('name')
      .execute()

    return sports
  })

  // GET /sports/:slug — single sport detail
  app.get('/sports/:slug', async (request, reply) => {
    const { slug } = request.params as { slug: string }
    const db = getDb()

    const sport = await db
      .selectFrom('sports')
      .selectAll()
      .where('slug', '=', slug)
      .where('active', '=', true)
      .executeTakeFirst()

    if (!sport) return reply.code(404).send({ error: 'Sport not found' })
    return sport
  })

  // GET /leaderboards?sport=&city=&period= — city leaderboard
  app.get('/leaderboards', async (request, reply) => {
    const query = request.query as {
      sport: string
      city?: string
      period?: 'week' | 'month' | 'all_time'
      limit?: string
    }

    if (!query.sport) return reply.code(400).send({ error: 'sport param required' })

    const limit = Math.min(Number(query.limit ?? 50), 100)
    const period = query.period ?? 'all_time'
    const city = query.city ?? 'all'

    const cacheKey = CacheKeys.leaderboard(query.sport, city, period)
    const redis = getRedis()
    const cached = await redis.get(cacheKey)
    if (cached) return JSON.parse(cached)

    const db = getDb()

    let q = db
      .selectFrom('sport_profiles as sp')
      .innerJoin('users as u', 'u.id', 'sp.user_id')
      .innerJoin('sports as s', 's.id', 'sp.sport_id')
      .select([
        'sp.user_id',
        'u.name',
        'u.username',
        'u.avatar_url',
        'u.city',
        'sp.current_rating',
        'sp.form_rating',
        'sp.matches_played',
        'sp.wins',
        'sp.position',
      ])
      .where('s.slug', '=', query.sport)
      .where('sp.matches_played', '>=', 3)  // min 3 matches to appear on leaderboard
      .where('u.is_guest', '=', false)      // hide unclaimed guests from public rankings
      .orderBy('sp.current_rating', 'desc')
      .limit(limit)

    if (query.city) {
      q = q.where('u.city', '=', query.city)
    }

    const results = await q.execute()
    const ranked = results.map((r, i) => ({ rank: i + 1, ...r }))

    // Cache for 5 minutes
    await redis.set(cacheKey, JSON.stringify(ranked), 'EX', 300)

    return ranked
  })
}
