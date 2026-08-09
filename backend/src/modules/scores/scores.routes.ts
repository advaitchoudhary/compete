import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { sql } from 'kysely'
import { requireAuth, requireRole } from '../../shared/middleware/auth'
import { getDb } from '../../shared/db/client'
import { getRedisPub, PubSubChannels } from '../../shared/redis/client'
import { enqueueRatingJob } from '../../shared/queue/ratings.stream'
import { emitFeedEvent } from '../feed/feed.service'
import { checkAchievements } from '../achievements/achievements.service'
import { assertMatchReferee } from '../matches/match.access'
import { recomputeStandings } from '../events/bracket/standings'
import { resolveFixtures } from '../events/bracket/resolver'
import { notifyUsers, eventPlayerIds } from '../notifications/notify.service'

const SubmitStatsBody = z.object({
  user_id: z.string().uuid(),
  team_id: z.string().uuid(),
  stats: z.record(z.union([z.number(), z.string(), z.boolean()])),
  position: z.string().max(20).optional(),
  // Client-generated UUID for offline idempotency
  client_event_id: z.string().uuid().optional(),
})

// Referee may deviate at most ±this from the algorithm's suggested star rating
const RATING_BOUND = 4
const RATING_ENGINE_URL = process.env.RATING_ENGINE_URL ?? 'http://rating-engine:8000'

const ApproveRatingsBody = z.object({
  ratings: z
    .array(z.object({ user_id: z.string().uuid(), rating: z.number().min(0).max(10) }))
    .min(1),
})

const BatchSyncBody = z.object({
  entries: z.array(
    z.object({
      user_id: z.string().uuid(),
      team_id: z.string().uuid(),
      stats: z.record(z.union([z.number(), z.string(), z.boolean()])),
      position: z.string().max(20).optional(),
      client_event_id: z.string().uuid(),
      client_timestamp: z.string().datetime(),
    })
  ).max(100),  // cap batch size
})

export async function scoresRoutes(app: FastifyInstance) {
  /**
   * POST /matches/:id/stats
   * Submit stats for one player in a match (online mode)
   */
  app.post('/matches/:id/stats', { preHandler: requireRole('referee', 'admin') }, async (request, reply) => {
    const { id: matchId } = request.params as { id: string }
    const body = SubmitStatsBody.safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() })

    await assertMatchReferee(matchId, request, reply)

    const db = getDb()
    const match = await db
      .selectFrom('matches')
      .select(['status', 'sport_id'])
      .where('id', '=', matchId)
      .executeTakeFirst()

    if (!match) return reply.code(404).send({ error: 'Match not found' })
    if (match.status === 'completed') {
      return reply.code(409).send({ error: 'Match already completed' })
    }

    const row = await db
      .insertInto('match_player_stats')
      .values({
        match_id: matchId,
        user_id: body.data.user_id,
        team_id: body.data.team_id,
        sport_id: match.sport_id,
        stats: JSON.stringify(body.data.stats) as unknown as Record<string, unknown>,
        position: body.data.position ?? null,
        entered_by: request.userId,
        client_event_id: body.data.client_event_id ?? null,
      })
      .onConflict((oc) =>
        // On re-submit (same player same match), update stats
        oc.columns(['match_id', 'user_id']).doUpdateSet({
          stats: JSON.stringify(body.data.stats) as unknown as Record<string, unknown>,
          position: body.data.position ?? null,
          entered_by: request.userId,
        })
      )
      .returningAll()
      .executeTakeFirstOrThrow()

    // Broadcast live update to WebSocket clients
    const pub = getRedisPub()
    await pub.publish(
      PubSubChannels.matchUpdate(matchId),
      JSON.stringify({ type: 'stats_update', player_id: body.data.user_id, stats: body.data.stats })
    )

    return reply.code(201).send(row)
  })

  /**
   * POST /matches/:id/stats/batch
   * Offline sync — submit multiple stat entries at once, idempotent by client_event_id
   */
  app.post('/matches/:id/stats/batch', { preHandler: requireRole('referee', 'admin') }, async (request, reply) => {
    const { id: matchId } = request.params as { id: string }
    const body = BatchSyncBody.safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() })

    await assertMatchReferee(matchId, request, reply)

    const db = getDb()
    const match = await db
      .selectFrom('matches')
      .select(['status', 'sport_id'])
      .where('id', '=', matchId)
      .executeTakeFirst()

    if (!match) return reply.code(404).send({ error: 'Match not found' })

    // Sort by client_timestamp to process in order
    const sorted = [...body.data.entries].sort(
      (a, b) => new Date(a.client_timestamp).getTime() - new Date(b.client_timestamp).getTime()
    )

    // Fall back to the position the captain declared at registration.
    //
    // The scorecard only sends a position for the keeper — deliberately, to keep
    // tournament-day scoring to a few taps — so without this every outfielder
    // reaches the rating engine positionless and forfeits both the defender
    // baseline and the clean-sheet share. An explicit position from the referee
    // always wins: they can see who actually played at the back.
    const declared = await db
      .selectFrom('team_members')
      .select(['user_id', 'team_id', 'position'])
      .where('team_id', 'in', [...new Set(sorted.map((e) => e.team_id))])
      .where('position', 'is not', null)
      .execute()

    const declaredByPlayer = new Map(
      declared.map((d) => [`${d.team_id}:${d.user_id}`, d.position as string])
    )

    // Upsert all entries — deduplicated by client_event_id
    const results = await db
      .insertInto('match_player_stats')
      .values(
        sorted.map((entry) => ({
          match_id: matchId,
          user_id: entry.user_id,
          team_id: entry.team_id,
          sport_id: match.sport_id,
          stats: JSON.stringify(entry.stats) as unknown as Record<string, unknown>,
          position:
            entry.position ?? declaredByPlayer.get(`${entry.team_id}:${entry.user_id}`) ?? null,
          entered_by: request.userId,
          client_event_id: entry.client_event_id,
        }))
      )
      .onConflict((oc) =>
        oc.column('client_event_id').doNothing()  // idempotent by client_event_id
      )
      .returning(['id', 'user_id', 'client_event_id'])
      .execute()

    return {
      synced: results.length,
      skipped: sorted.length - results.length,
      ids: results.map((r) => r.id),
    }
  })

  /**
   * POST /matches/:id/rating-suggestions
   * Referee asks the algorithm to suggest a 0–10 star for each player.
   * Persists suggestions; returns them with stats for review.
   */
  app.post(
    '/matches/:id/rating-suggestions',
    { preHandler: requireRole('referee', 'admin') },
    async (request, reply) => {
      const { id: matchId } = request.params as { id: string }
      await assertMatchReferee(matchId, request, reply)

      let engineOk = false
      try {
        const res = await fetch(`${RATING_ENGINE_URL}/matches/${matchId}/suggest`, {
          method: 'POST',
        })
        engineOk = res.ok
      } catch {
        engineOk = false
      }
      if (!engineOk) {
        return reply.code(502).send({ error: 'Rating engine unavailable' })
      }

      const players = await getDb()
        .selectFrom('match_player_stats as mps')
        .innerJoin('users as u', 'u.id', 'mps.user_id')
        .select([
          'mps.user_id', 'u.name', 'mps.team_id', 'mps.stats',
          'mps.suggested_rating', 'mps.match_rating', 'mps.rating_overridden',
        ])
        .where('mps.match_id', '=', matchId)
        .execute()

      return { match_id: matchId, bound: RATING_BOUND, players }
    }
  )

  /**
   * POST /matches/:id/ratings
   * Referee saves the final star ratings (the eye test). Each value must be
   * within ±RATING_BOUND of the algorithm's suggestion. Only before confirm.
   */
  app.post(
    '/matches/:id/ratings',
    { preHandler: requireRole('referee', 'admin') },
    async (request, reply) => {
      const { id: matchId } = request.params as { id: string }
      const body = ApproveRatingsBody.safeParse(request.body)
      if (!body.success) return reply.code(400).send({ error: body.error.flatten() })

      await assertMatchReferee(matchId, request, reply)
      const db = getDb()

      const match = await db
        .selectFrom('matches').select('status').where('id', '=', matchId).executeTakeFirst()
      if (!match) return reply.code(404).send({ error: 'Match not found' })
      if (match.status === 'completed') {
        return reply.code(409).send({ error: 'Match already completed — ratings locked' })
      }

      const existing = await db
        .selectFrom('match_player_stats')
        .select(['user_id', 'suggested_rating'])
        .where('match_id', '=', matchId)
        .execute()
      const suggested = new Map(existing.map((e) => [e.user_id, e.suggested_rating]))

      // Validate all against the ±bound before applying any
      const errors: string[] = []
      for (const r of body.data.ratings) {
        const s = suggested.get(r.user_id)
        if (s === undefined) {
          errors.push(`${r.user_id}: not in this match`)
        } else if (s === null) {
          errors.push(`${r.user_id}: no suggestion yet — run rating-suggestions first`)
        } else if (Math.abs(r.rating - Number(s)) > RATING_BOUND) {
          errors.push(
            `${r.user_id}: ${r.rating} is more than ±${RATING_BOUND} from suggestion ${s}`
          )
        }
      }
      if (errors.length) {
        return reply.code(400).send({ error: 'Out-of-bounds ratings', details: errors })
      }

      for (const r of body.data.ratings) {
        const s = Number(suggested.get(r.user_id))
        await db
          .updateTable('match_player_stats')
          .set({ match_rating: r.rating, rating_overridden: r.rating !== s })
          .where('match_id', '=', matchId)
          .where('user_id', '=', r.user_id)
          .execute()
      }

      return { saved: body.data.ratings.length }
    }
  )

  /**
   * POST /matches/:id/confirm
   * Captain confirms the scorecard for their team.
   * When BOTH captains confirm → match is completed → rating job enqueued.
   */
  app.post('/matches/:id/confirm', { preHandler: requireAuth }, async (request, reply) => {
    const { id: matchId } = request.params as { id: string }
    const db = getDb()

    const match = await db
      .selectFrom('matches')
      .selectAll()
      .where('id', '=', matchId)
      .executeTakeFirst()

    if (!match) return reply.code(404).send({ error: 'Match not found' })
    if (match.status === 'completed') {
      return reply.code(409).send({ error: 'Already confirmed' })
    }

    // Determine which team's captain is confirming
    const isCaptain = await db
      .selectFrom('team_members')
      .select(['team_id', 'role'])
      .where('user_id', '=', request.userId)
      .where('team_id', 'in', [match.home_team_id, match.away_team_id])
      .where('role', 'in', ['captain', 'vice_captain'])
      .executeTakeFirst()

    const isHomeOrg = await db
      .selectFrom('teams')
      .select('id')
      .where('id', '=', match.home_team_id)
      .where('organizer_id', '=', request.userId)
      .executeTakeFirst()

    const isAwayOrg = await db
      .selectFrom('teams')
      .select('id')
      .where('id', '=', match.away_team_id)
      .where('organizer_id', '=', request.userId)
      .executeTakeFirst()

    if (!isCaptain && !isHomeOrg && !isAwayOrg) {
      return reply.code(403).send({ error: 'Only team captains can confirm' })
    }

    const isHomeTeam =
      isCaptain?.team_id === match.home_team_id || !!isHomeOrg
    const isAwayTeam =
      isCaptain?.team_id === match.away_team_id || !!isAwayOrg

    // Update confirmation flag
    const updateFields: Record<string, boolean> = {}
    if (isHomeTeam) updateFields.home_confirmed = true
    if (isAwayTeam) updateFields.away_confirmed = true

    const updated = await db
      .updateTable('matches')
      .set(updateFields as any)
      .where('id', '=', matchId)
      .returningAll()
      .executeTakeFirstOrThrow()

    // Both confirmed → finalize the match and trigger rating computation
    if (updated.home_confirmed && updated.away_confirmed) {
      await finalizeMatch(db, match)
    }

    return {
      confirmed: true,
      both_confirmed: updated.home_confirmed && updated.away_confirmed,
      rating_computation_queued: updated.home_confirmed && updated.away_confirmed,
    }
  })

  /**
   * POST /matches/:id/complete
   * The match referee finalizes the game → match completes, winner is decided
   * from the score, and rating computation is triggered. (Officiator-driven.)
   */
  app.post('/matches/:id/complete', { preHandler: requireRole('referee', 'admin') }, async (request, reply) => {
    const { id: matchId } = request.params as { id: string }
    await assertMatchReferee(matchId, request, reply)

    const db = getDb()
    const match = await db.selectFrom('matches').selectAll().where('id', '=', matchId).executeTakeFirst()
    if (!match) return reply.code(404).send({ error: 'Match not found' })
    if (match.status === 'completed') return reply.code(409).send({ error: 'Match already completed' })

    const winnerTeamId = await finalizeMatch(db, match)
    return { completed: true, winner_team_id: winnerTeamId, rating_computation_queued: true }
  })
}

/**
 * Finalize a match: decide the winner, complete it, confirm stats, update team
 * records, enqueue rating computation, emit feed + achievements, notify realtime.
 * Shared by referee /complete and dual-captain /confirm.
 */
/**
 * Fire `rating_ready` exactly once, when the last match of a tournament is done.
 *
 * The condition is "no fixture is left without a completed match" — checked against
 * event_fixtures rather than matches, because a knockout fixture whose teams are
 * still unknown has no match row at all and would otherwise look finished.
 */
async function notifyIfTournamentFinished(
  db: ReturnType<typeof getDb>,
  eventId: string
): Promise<void> {
  const outstanding = await db
    .selectFrom('event_fixtures as ef')
    .leftJoin('matches as m', 'm.id', 'ef.match_id')
    .select('ef.id')
    .where('ef.event_id', '=', eventId)
    .where((eb) =>
      eb.or([eb('ef.match_id', 'is', null), eb('m.status', '!=', 'completed')])
    )
    .executeTakeFirst()

  if (outstanding) return

  const event = await db
    .selectFrom('events')
    .select(['id', 'name'])
    .where('id', '=', eventId)
    .executeTakeFirst()
  if (!event) return

  await notifyUsers({
    userIds: await eventPlayerIds(eventId),
    type: 'rating_ready',
    title: 'Your rating is in',
    body: `${event.name} is done. See how your rating moved and who topped the scoring.`,
    data: { event_id: eventId },
  })
}

async function finalizeMatch(db: ReturnType<typeof getDb>, match: any): Promise<string | null> {
  const sport = await db
    .selectFrom('sports').select('slug').where('id', '=', match.sport_id).executeTakeFirstOrThrow()
  const winnerTeamId = decideWinner(
    sport.slug, match.home_score, match.away_score, match.home_team_id, match.away_team_id
  )

  await db.updateTable('matches')
    .set({ status: 'completed', completed_at: new Date(), winner_team_id: winnerTeamId })
    .where('id', '=', match.id).execute()

  await db.updateTable('match_player_stats')
    .set({ confirmed_by_captain: true }).where('match_id', '=', match.id).execute()

  await enqueueRatingJob({
    match_id: match.id, sport_id: match.sport_id, triggered_at: new Date().toISOString(),
  })

  // Tournament bookkeeping: rebuild the group table, then advance any bracket
  // slot this result just decided. Both are no-ops for a standalone match with no
  // event_id. The standings rebuild is a full recompute rather than an increment,
  // so it is idempotent and self-heals if a previous completion was interrupted —
  // finalizeMatch is not transactional, so that matters.
  if (match.event_id) {
    await recomputeStandings(match.event_id)
    await resolveFixtures(match.event_id)
    await notifyIfTournamentFinished(db, match.event_id)
  }

  await updateTeamStats(db, { ...match, winner_team_id: winnerTeamId })

  const playerStats = await db
    .selectFrom('match_player_stats').select(['user_id', 'team_id', 'stats'])
    .where('match_id', '=', match.id).execute()

  for (const ps of playerStats) {
    await emitFeedEvent({
      actor_id: ps.user_id, action_type: 'match_completed', entity_type: 'match', entity_id: match.id,
      payload: { match_id: match.id, home_team_name: '', away_team_name: '', winner_team_id: winnerTeamId, stats: ps.stats },
    })
    checkAchievements(ps.user_id, match.sport_id, match.id).catch(console.error)
  }

  const pub = getRedisPub()
  await pub.publish(PubSubChannels.matchUpdate(match.id), JSON.stringify({ type: 'match_completed', match_id: match.id }))

  return winnerTeamId
}

async function updateTeamStats(
  db: ReturnType<typeof getDb>,
  match: {
    id: string
    home_team_id: string
    away_team_id: string
    winner_team_id: string | null
  }
) {
  const { home_team_id, away_team_id, winner_team_id } = match

  if (winner_team_id === home_team_id) {
    await db.updateTable('teams').set({ wins: sql<number>`wins + 1` })
      .where('id', '=', home_team_id).execute()
    await db.updateTable('teams').set({ losses: sql<number>`losses + 1` })
      .where('id', '=', away_team_id).execute()
  } else if (winner_team_id === away_team_id) {
    await db.updateTable('teams').set({ wins: sql<number>`wins + 1` })
      .where('id', '=', away_team_id).execute()
    await db.updateTable('teams').set({ losses: sql<number>`losses + 1` })
      .where('id', '=', home_team_id).execute()
  } else {
    // Draw (or no winner determinable)
    await db.updateTable('teams').set({ draws: sql<number>`draws + 1` })
      .where('id', 'in', [home_team_id, away_team_id]).execute()
  }
}

// Map each sport to the score-JSON key that decides the winner.
const WINNER_SCORE_KEY: Record<string, string> = {
  football: 'goals',
  basketball: 'points',
  cricket: 'runs',
  badminton: 'sets_won',
}

/**
 * Decide the winning team from the final scores. Returns null for a draw or
 * when the score can't be compared (missing scores / unknown sport).
 */
function decideWinner(
  sportSlug: string,
  homeScore: Record<string, unknown> | null,
  awayScore: Record<string, unknown> | null,
  homeTeamId: string,
  awayTeamId: string
): string | null {
  const key = WINNER_SCORE_KEY[sportSlug]
  if (!key || !homeScore || !awayScore) return null
  const h = Number(homeScore[key] ?? 0)
  const a = Number(awayScore[key] ?? 0)
  if (Number.isNaN(h) || Number.isNaN(a)) return null
  if (h > a) return homeTeamId
  if (a > h) return awayTeamId
  return null // draw
}
