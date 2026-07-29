import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAuth } from '../../shared/middleware/auth'
import { getDb } from '../../shared/db/client'

const CreateTeamBody = z.object({
  name: z.string().min(2).max(60),
  sport_slug: z.string(),
  city: z.string().max(50).optional(),
  founded_at: z.string().optional(),
})

const AddMemberBody = z.object({
  user_id: z.string().uuid(),
  role: z.enum(['captain', 'vice_captain', 'player', 'coach']).default('player'),
  jersey_no: z.number().int().min(1).max(99).optional(),
})

export async function teamsRoutes(app: FastifyInstance) {
  // POST /teams — create team
  app.post('/teams', { preHandler: requireAuth }, async (request, reply) => {
    const body = CreateTeamBody.safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() })

    const db = getDb()

    const sport = await db
      .selectFrom('sports')
      .select('id')
      .where('slug', '=', body.data.sport_slug)
      .executeTakeFirst()

    if (!sport) return reply.code(404).send({ error: 'Sport not found' })

    const team = await db.transaction().execute(async (trx) => {
      const newTeam = await trx
        .insertInto('teams')
        .values({
          name: body.data.name,
          sport_id: sport.id,
          city: body.data.city ?? null,
          organizer_id: request.userId,
          founded_at: body.data.founded_at ? new Date(body.data.founded_at) : null,
        })
        .returningAll()
        .executeTakeFirstOrThrow()

      // Auto-add creator as captain
      await trx
        .insertInto('team_members')
        .values({
          team_id: newTeam.id,
          user_id: request.userId,
          role: 'captain',
        })
        .execute()

      return newTeam
    })

    return reply.code(201).send(team)
  })

  // GET /teams/:id — team detail with roster
  app.get('/teams/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const db = getDb()

    const team = await db
      .selectFrom('teams as t')
      .innerJoin('sports as s', 's.id', 't.sport_id')
      .selectAll('t')
      .select(['s.name as sport_name', 's.slug as sport_slug'])
      .where('t.id', '=', id)
      .executeTakeFirst()

    if (!team) return reply.code(404).send({ error: 'Team not found' })

    const members = await db
      .selectFrom('team_members as tm')
      .innerJoin('users as u', 'u.id', 'tm.user_id')
      .leftJoin('sport_profiles as sp', (join) =>
        join.onRef('sp.user_id', '=', 'tm.user_id').on('sp.sport_id', '=', team.sport_id)
      )
      .select([
        'u.id',
        'u.name',
        'u.username',
        'u.avatar_url',
        'tm.role',
        'tm.jersey_no',
        'sp.current_rating',
        'sp.position',
      ])
      .where('tm.team_id', '=', id)
      .where('tm.is_active', '=', true)
      .execute()

    return { ...team, members }
  })

  // GET /teams?sport=&city= — browse teams
  app.get('/teams', async (request, reply) => {
    const query = request.query as { sport?: string; city?: string; limit?: string }
    const limit = Math.min(Number(query.limit ?? 20), 50)
    const db = getDb()

    let q = db
      .selectFrom('teams as t')
      .innerJoin('sports as s', 's.id', 't.sport_id')
      .select(['t.id', 't.name', 't.city', 't.avatar_url', 't.wins', 't.losses', 't.avg_rating',
               's.name as sport_name', 's.slug as sport_slug'])
      .limit(limit)
      .orderBy('t.wins', 'desc')

    if (query.sport) q = q.where('s.slug', '=', query.sport)
    if (query.city) q = q.where('t.city', '=', query.city)

    return q.execute()
  })

  // POST /teams/:id/members — add player to team
  app.post('/teams/:id/members', { preHandler: requireAuth }, async (request, reply) => {
    const { id: teamId } = request.params as { id: string }
    const body = AddMemberBody.safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() })

    const db = getDb()

    // Only organizer or captain can add members
    const team = await db
      .selectFrom('teams')
      .select('organizer_id')
      .where('id', '=', teamId)
      .executeTakeFirst()

    if (!team) return reply.code(404).send({ error: 'Team not found' })
    if (team.organizer_id !== request.userId) {
      // Also allow captains
      const captainship = await db
        .selectFrom('team_members')
        .select('role')
        .where('team_id', '=', teamId)
        .where('user_id', '=', request.userId)
        .where('role', 'in', ['captain', 'vice_captain'])
        .executeTakeFirst()
      if (!captainship) return reply.code(403).send({ error: 'Only captains can add members' })
    }

    await db
      .insertInto('team_members')
      .values({
        team_id: teamId,
        user_id: body.data.user_id,
        role: body.data.role,
        jersey_no: body.data.jersey_no ?? null,
      })
      .onConflict((oc) =>
        oc.columns(['team_id', 'user_id']).doUpdateSet({
          role: body.data.role,
          jersey_no: body.data.jersey_no ?? null,
          is_active: true,
        })
      )
      .execute()

    return reply.code(204).send()
  })
}
