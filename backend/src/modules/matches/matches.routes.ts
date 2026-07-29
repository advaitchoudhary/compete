import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAuth, requireRole } from '../../shared/middleware/auth'
import { getDb } from '../../shared/db/client'
import { getRedisPub, PubSubChannels } from '../../shared/redis/client'
import { assertMatchReferee } from './match.access'
import { MATCH_TIERS, canOfficiate } from '../../shared/tiers'

const CreateMatchBody = z.object({
  event_id: z.string().uuid().optional(),
  sport_slug: z.string(),
  home_team_id: z.string().uuid(),
  away_team_id: z.string().uuid(),
  venue: z.string().max(100).optional(),
  round: z.string().max(20).optional(),
  scheduled_at: z.string().datetime().optional(),
  tier: z.enum(MATCH_TIERS).optional(),  // defaults to 'amateur'
})

export async function matchesRoutes(app: FastifyInstance) {
  // POST /matches — create a match (referees only; creator becomes the match referee)
  app.post('/matches', { preHandler: requireRole('referee', 'admin') }, async (request, reply) => {
    const body = CreateMatchBody.safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() })

    if (body.data.home_team_id === body.data.away_team_id) {
      return reply.code(400).send({ error: 'Teams must be different' })
    }

    const db = getDb()

    const sport = await db
      .selectFrom('sports')
      .select('id')
      .where('slug', '=', body.data.sport_slug)
      .executeTakeFirst()

    if (!sport) return reply.code(404).send({ error: 'Sport not found' })

    // A referee may only create matches at or below their own tier (admins bypass).
    const tier = body.data.tier ?? 'amateur'
    if (request.userRole !== 'admin') {
      const me = await db
        .selectFrom('users')
        .select('referee_tier')
        .where('id', '=', request.userId)
        .executeTakeFirst()
      if (!canOfficiate(me?.referee_tier ?? null, tier)) {
        return reply.code(403).send({
          error: `Your referee tier (${me?.referee_tier ?? 'none'}) cannot officiate a '${tier}' match`,
        })
      }
    }

    const match = await db
      .insertInto('matches')
      .values({
        event_id: body.data.event_id ?? null,
        sport_id: sport.id,
        home_team_id: body.data.home_team_id,
        away_team_id: body.data.away_team_id,
        venue: body.data.venue ?? null,
        round: body.data.round ?? null,
        scheduled_at: body.data.scheduled_at ? new Date(body.data.scheduled_at) : null,
        status: 'scheduled',
        tier,
        referee_id: request.userId,
      })
      .returningAll()
      .executeTakeFirstOrThrow()

    return reply.code(201).send(match)
  })

  // GET /matches — list matches with optional filters
  app.get('/matches', { preHandler: requireAuth }, async (request, reply) => {
    const query = request.query as {
      status?: string       // 'scheduled' | 'live' | 'completed' | 'cancelled'
      sport_slug?: string   // 'cricket' | 'football' | 'badminton' | 'basketball'
      limit?: string
      offset?: string
    }
    const limit  = Math.min(Number(query.limit  ?? 20), 100)
    const offset = Number(query.offset ?? 0)
    const db = getDb()

    let q = db
      .selectFrom('matches as m')
      .innerJoin('teams as ht', 'ht.id', 'm.home_team_id')
      .innerJoin('teams as at', 'at.id', 'm.away_team_id')
      .innerJoin('sports as s',  's.id',  'm.sport_id')
      .select([
        'm.id', 'm.status', 'm.venue', 'm.round', 'm.event_id',
        'm.home_score', 'm.away_score', 'm.home_team_id', 'm.away_team_id',
        'm.scheduled_at', 'm.started_at', 'm.completed_at', 'm.created_at',
        'ht.name as home_team_name',
        'at.name as away_team_name',
        's.slug as sport_slug',
      ])
      .orderBy('m.created_at', 'desc')
      .limit(limit)
      .offset(offset)

    if (query.status)     q = q.where('m.status', '=', query.status)
    if (query.sport_slug) q = q.where('s.slug',   '=', query.sport_slug)

    return reply.send(await q.execute())
  })

  // GET /matches/:id — match detail with player stats
  app.get('/matches/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const db = getDb()

    const match = await db
      .selectFrom('matches as m')
      .innerJoin('teams as ht', 'ht.id', 'm.home_team_id')
      .innerJoin('teams as at', 'at.id', 'm.away_team_id')
      .innerJoin('sports as s', 's.id', 'm.sport_id')
      .selectAll('m')
      .select([
        'ht.name as home_team_name', 'ht.avatar_url as home_team_avatar',
        'at.name as away_team_name', 'at.avatar_url as away_team_avatar',
        's.name as sport_name', 's.slug as sport_slug', 's.stat_schema',
      ])
      .where('m.id', '=', id)
      .executeTakeFirst()

    if (!match) return reply.code(404).send({ error: 'Match not found' })

    const playerStats = await db
      .selectFrom('match_player_stats as mps')
      .innerJoin('users as u', 'u.id', 'mps.user_id')
      .select([
        'mps.user_id', 'u.name', 'u.avatar_url', 'mps.team_id',
        'mps.stats', 'mps.match_rating', 'mps.confirmed_by_captain',
      ])
      .where('mps.match_id', '=', id)
      .execute()

    return { ...match, player_stats: playerStats }
  })

  // PATCH /matches/:id/start — mark match as live
  app.patch('/matches/:id/start', { preHandler: requireRole('referee', 'admin') }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const db = getDb()

    await assertMatchReferee(id, request, reply)

    const match = await db
      .updateTable('matches')
      .set({ status: 'live', started_at: new Date() })
      .where('id', '=', id)
      .where('status', '=', 'scheduled')
      .returningAll()
      .executeTakeFirst()

    if (!match) return reply.code(409).send({ error: 'Match cannot be started' })

    // Notify real-time service
    const pub = getRedisPub()
    await pub.publish(PubSubChannels.matchUpdate(id), JSON.stringify({
      type: 'match_started',
      match_id: id,
      started_at: match.started_at,
    }))

    return match
  })

  // PATCH /matches/:id/score — update team score (live)
  app.patch('/matches/:id/score', { preHandler: requireRole('referee', 'admin') }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { home_score, away_score } = request.body as {
      home_score?: Record<string, unknown>
      away_score?: Record<string, unknown>
    }
    const db = getDb()

    await assertMatchReferee(id, request, reply)

    const updated: Record<string, unknown> = {}
    if (home_score) updated.home_score = JSON.stringify(home_score)
    if (away_score) updated.away_score = JSON.stringify(away_score)

    await db.updateTable('matches').set(updated as any).where('id', '=', id).execute()

    const pub = getRedisPub()
    await pub.publish(PubSubChannels.matchUpdate(id), JSON.stringify({
      type: 'score_update',
      match_id: id,
      home_score,
      away_score,
    }))

    return reply.code(204).send()
  })
}
