import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAuth, requireRole } from '../../shared/middleware/auth'
import { getDb } from '../../shared/db/client'

const UpdateProfileBody = z.object({
  name: z.string().min(1).max(80).optional(),
  username: z.string().min(3).max(30).regex(/^[a-z0-9_]+$/).optional(),
  city: z.string().max(50).optional(),
  bio: z.string().max(200).optional(),
})

const CreateGuestBody = z.object({
  name: z.string().min(1).max(80),
  city: z.string().max(50).optional(),
})

export async function usersRoutes(app: FastifyInstance) {
  // GET /users/me — the authenticated user's own record, including role.
  // Registered before /users/:id so 'me' isn't swallowed as an :id param.
  app.get('/users/me', { preHandler: requireAuth }, async (request, reply) => {
    const user = await getDb()
      .selectFrom('users')
      .select([
        'id', 'name', 'username', 'phone', 'avatar_url',
        'city', 'bio', 'role', 'created_at',
      ])
      .where('id', '=', request.userId)
      .executeTakeFirst()

    if (!user) return reply.code(404).send({ error: 'User not found' })
    return user
  })

  // GET /users/search?q=&sport=&include_guests=&limit= — find players to add to a match.
  // Matches on name/username. When ?sport= is given, includes that sport's rating
  // & position. Guests are excluded unless include_guests=true.
  app.get('/users/search', { preHandler: requireAuth }, async (request, reply) => {
    const query = request.query as {
      q?: string
      sport?: string
      include_guests?: string
      limit?: string
    }
    const q = query.q?.trim() ?? ''
    if (q.length < 2) {
      return reply.code(400).send({ error: 'q must be at least 2 characters' })
    }
    const limit = Math.min(Number(query.limit ?? 20), 50)
    const term = `%${q}%`
    const includeGuests = query.include_guests === 'true'
    const db = getDb()

    if (query.sport) {
      const sport = await db
        .selectFrom('sports')
        .select('id')
        .where('slug', '=', query.sport)
        .executeTakeFirst()
      if (!sport) return reply.code(404).send({ error: 'Sport not found' })

      let qb = db
        .selectFrom('users as u')
        .leftJoin('sport_profiles as sp', (join) =>
          join.onRef('sp.user_id', '=', 'u.id').on('sp.sport_id', '=', sport.id)
        )
        .select([
          'u.id', 'u.name', 'u.username', 'u.avatar_url', 'u.city', 'u.is_guest',
          'sp.current_rating', 'sp.position', 'sp.matches_played',
        ])
        .where('u.is_active', '=', true)
        .where((eb) => eb.or([eb('u.name', 'ilike', term), eb('u.username', 'ilike', term)]))
        .orderBy('u.name')
        .limit(limit)
      if (!includeGuests) qb = qb.where('u.is_guest', '=', false)
      return qb.execute()
    }

    let qb = db
      .selectFrom('users as u')
      .select(['u.id', 'u.name', 'u.username', 'u.avatar_url', 'u.city', 'u.is_guest'])
      .where('u.is_active', '=', true)
      .where((eb) => eb.or([eb('u.name', 'ilike', term), eb('u.username', 'ilike', term)]))
      .orderBy('u.name')
      .limit(limit)
    if (!includeGuests) qb = qb.where('u.is_guest', '=', false)
    return qb.execute()
  })

  // POST /users/guest — referee creates a guest (credential-less) player.
  // The row gets a real id and accumulates ratings/stats like any user, but
  // is hidden from public leaderboards until claimed (is_guest stays true).
  app.post('/users/guest', { preHandler: requireRole('referee', 'admin') }, async (request, reply) => {
    const body = CreateGuestBody.safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() })

    const guest = await getDb()
      .insertInto('users')
      .values({
        name: body.data.name,
        city: body.data.city ?? null,
        phone: null,
        firebase_uid: null,
        is_guest: true,
        created_by: request.userId,
      })
      .returning(['id', 'name', 'city', 'is_guest', 'created_at'])
      .executeTakeFirstOrThrow()

    return reply.code(201).send(guest)
  })

  // GET /users/:id — public profile
  app.get('/users/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const db = getDb()

    const user = await db
      .selectFrom('users')
      .select(['id', 'name', 'username', 'avatar_url', 'city', 'bio', 'created_at'])
      .where('id', '=', id)
      .where('is_active', '=', true)
      .executeTakeFirst()

    if (!user) return reply.code(404).send({ error: 'User not found' })

    // Fetch sport profiles with ratings
    const sportProfiles = await db
      .selectFrom('sport_profiles as sp')
      .innerJoin('sports as s', 's.id', 'sp.sport_id')
      .select([
        'sp.sport_id',
        's.name as sport_name',
        's.slug as sport_slug',
        'sp.position',
        'sp.current_rating',
        'sp.form_rating',
        'sp.matches_played',
        'sp.wins',
        'sp.career_stats',
      ])
      .where('sp.user_id', '=', id)
      .execute()

    // Follower counts
    const [followerCount, followingCount] = await Promise.all([
      db.selectFrom('follows').select(db.fn.count('follower_id').as('count'))
        .where('following_id', '=', id).executeTakeFirst(),
      db.selectFrom('follows').select(db.fn.count('following_id').as('count'))
        .where('follower_id', '=', id).executeTakeFirst(),
    ])

    return {
      ...user,
      sport_profiles: sportProfiles,
      followers: Number(followerCount?.count ?? 0),
      following: Number(followingCount?.count ?? 0),
    }
  })

  // PUT /users/me — update own profile (authenticated)
  app.put('/users/me', { preHandler: requireAuth }, async (request, reply) => {
    const body = UpdateProfileBody.safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() })

    const db = getDb()

    // Check username uniqueness if being changed
    if (body.data.username) {
      const existing = await db
        .selectFrom('users')
        .select('id')
        .where('username', '=', body.data.username)
        .where('id', '!=', request.userId)
        .executeTakeFirst()

      if (existing) return reply.code(409).send({ error: 'Username already taken' })
    }

    const updated = await db
      .updateTable('users')
      .set(body.data)
      .where('id', '=', request.userId)
      .returningAll()
      .executeTakeFirstOrThrow()

    return {
      id: updated.id,
      name: updated.name,
      username: updated.username,
      city: updated.city,
      bio: updated.bio,
      avatar_url: updated.avatar_url,
    }
  })

  // GET /users/:id/stats/:sportSlug — career stats for one sport
  app.get('/users/:id/stats/:sportSlug', async (request, reply) => {
    const { id, sportSlug } = request.params as { id: string; sportSlug: string }
    const db = getDb()

    const profile = await db
      .selectFrom('sport_profiles as sp')
      .innerJoin('sports as s', 's.id', 'sp.sport_id')
      .selectAll('sp')
      .select(['s.name as sport_name', 's.slug', 's.stat_schema'])
      .where('sp.user_id', '=', id)
      .where('s.slug', '=', sportSlug)
      .executeTakeFirst()

    if (!profile) return reply.code(404).send({ error: 'Profile not found' })

    // Last 10 rating history entries (with the tier of each match)
    const ratingHistory = await db
      .selectFrom('rating_history as rh')
      .innerJoin('matches as m', 'm.id', 'rh.match_id')
      .select([
        'rh.rating_after', 'rh.rating_before', 'rh.delta', 'rh.performance_score',
        'rh.created_at', 'rh.match_id', 'm.tier',
      ])
      .where('rh.user_id', '=', id)
      .where('rh.sport_id', '=', profile.sport_id)
      .orderBy('rh.created_at', 'desc')
      .limit(10)
      .execute()

    // Per-tier Elo ladders (the headline overall is the blended current_rating)
    const tierRatings = await db
      .selectFrom('tier_ratings')
      .select(['tier', 'rating', 'matches_played', 'wins'])
      .where('user_id', '=', id)
      .where('sport_id', '=', profile.sport_id)
      .execute()

    return { ...profile, rating_history: ratingHistory, tier_ratings: tierRatings }
  })

  // POST /users/:id/follow
  app.post('/users/:id/follow', { preHandler: requireAuth }, async (request, reply) => {
    const { id: targetId } = request.params as { id: string }
    if (targetId === request.userId) {
      return reply.code(400).send({ error: 'Cannot follow yourself' })
    }

    const db = getDb()
    await db
      .insertInto('follows')
      .values({ follower_id: request.userId, following_id: targetId })
      .onConflict((oc) => oc.doNothing())
      .execute()

    return reply.code(204).send()
  })

  // DELETE /users/:id/follow — unfollow
  app.delete('/users/:id/follow', { preHandler: requireAuth }, async (request, reply) => {
    const { id: targetId } = request.params as { id: string }
    const db = getDb()
    await db
      .deleteFrom('follows')
      .where('follower_id', '=', request.userId)
      .where('following_id', '=', targetId)
      .execute()

    return reply.code(204).send()
  })

  // GET /users/:id/feed — activity feed (paginated)
  app.get('/users/:id/feed', async (request, reply) => {
    const { id } = request.params as { id: string }
    const query = request.query as { cursor?: string; limit?: string }
    const limit = Math.min(Number(query.limit ?? 20), 50)
    const db = getDb()

    // Get people this user follows
    const following = await db
      .selectFrom('follows')
      .select('following_id')
      .where('follower_id', '=', id)
      .execute()

    const actorIds = [id, ...following.map((f) => f.following_id)]

    let q = db
      .selectFrom('feed_events')
      .selectAll()
      .where('actor_id', 'in', actorIds)
      .orderBy('created_at', 'desc')
      .limit(limit + 1)

    if (query.cursor) {
      q = q.where('created_at', '<', new Date(query.cursor))
    }

    const items = await q.execute()
    const hasMore = items.length > limit
    const results = hasMore ? items.slice(0, limit) : items

    return {
      items: results,
      next_cursor: hasMore ? results[results.length - 1].created_at.toISOString() : null,
    }
  })
}
