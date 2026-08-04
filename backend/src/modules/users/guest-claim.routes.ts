import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAuth } from '../../shared/middleware/auth'
import { getDb } from '../../shared/db/client'
import { issueJwt } from '../auth/auth.service'

/**
 * Guest claiming — turning a name someone typed into an owned profile.
 *
 * A guest played in a tournament and earned real ratings. Claiming uses the
 * promote-in-place model: the SAME `users` row gains credentials and flips
 * `is_guest`, so every match_player_stats / rating_history / tier_ratings /
 * sport_profiles row carries over with nothing repointed. `users.claimed_at` is
 * the one-time-use guard, which is why no token table is needed.
 *
 * Delivery is a link the captain shares from their own phone over WhatsApp — a
 * guest has no app, so push can't reach them, and server-sent SMS would mean
 * gateway cost and DLT registration in India before there is a paying customer.
 *
 * SECURITY: claim tokens are signed with the same secret as session tokens, so
 * they carry `typ: 'guest_claim'` and the auth middleware rejects that type.
 * Without the discriminator, handing someone a claim link would hand them a live
 * session for that player.
 */

/** Marks a JWT as a claim link rather than a session. Checked in both directions. */
export const CLAIM_TOKEN_TYPE = 'guest_claim'

/**
 * Long enough to survive being forwarded through WhatsApp and opened the next day,
 * short enough that a leaked link doesn't stay live forever.
 */
const CLAIM_TOKEN_TTL = '14d'

const ClaimBody = z.object({
  token: z.string().min(10),
  /** Optional: the claimer's real name, replacing whatever the captain typed. */
  name: z.string().min(2).max(80).optional(),
})

export async function guestClaimRoutes(app: FastifyInstance) {
  /**
   * POST /guests/:id/claim-link
   *
   * Mints a shareable claim link. Allowed for an admin, any referee or organizer,
   * or the captain of a team the guest actually plays for — the captain is usually
   * the person who typed the name in, and the person with their number.
   */
  app.post('/guests/:id/claim-link', { preHandler: requireAuth }, async (request, reply) => {
    const { id: guestId } = request.params as { id: string }
    if (!z.string().uuid().safeParse(guestId).success) {
      return reply.code(400).send({ error: 'Invalid guest id' })
    }

    const db = getDb()

    const guest = await db
      .selectFrom('users')
      .select(['id', 'name', 'is_guest', 'claimed_at', 'created_by'])
      .where('id', '=', guestId)
      .executeTakeFirst()

    if (!guest) return reply.code(404).send({ error: 'Player not found' })
    if (!guest.is_guest) {
      return reply.code(409).send({ error: 'That player is not a guest — nothing to claim' })
    }
    if (guest.claimed_at) {
      return reply.code(409).send({ error: 'That profile has already been claimed' })
    }

    // ── Who may hand out this link ──────────────────────────────────────────
    const me = await db
      .selectFrom('users')
      .select('role')
      .where('id', '=', request.userId)
      .executeTakeFirst()
    if (!me) return reply.code(401).send({ error: 'Unauthorized' })

    let allowed =
      me.role === 'admin' || me.role === 'referee' || me.role === 'organizer' ||
      guest.created_by === request.userId

    if (!allowed) {
      // Or a captain of a team the guest plays for.
      const shared = await db
        .selectFrom('team_members as mine')
        .innerJoin('team_members as theirs', 'theirs.team_id', 'mine.team_id')
        .select('mine.team_id')
        .where('mine.user_id', '=', request.userId)
        .where('mine.role', 'in', ['captain', 'vice_captain'])
        .where('theirs.user_id', '=', guestId)
        .executeTakeFirst()
      allowed = Boolean(shared)
    }

    if (!allowed) {
      return reply.code(403).send({
        error: 'Only this player’s captain, a referee, an organizer or an admin can share a claim link',
      })
    }

    const token = app.jwt.sign({ sub: guestId, typ: CLAIM_TOKEN_TYPE }, { expiresIn: CLAIM_TOKEN_TTL })
    const base = process.env.PUBLIC_WEB_URL ?? 'http://localhost:8081'

    return {
      guest_id: guestId,
      guest_name: guest.name,
      token,
      claim_url: `${base}/claim?token=${token}`,
      expires_in: CLAIM_TOKEN_TTL,
    }
  })

  /**
   * POST /auth/claim — no authentication; possession of the link IS the credential,
   * exactly like a magic link. Returns a real session so the claimer is signed in
   * immediately rather than being bounced to a login screen.
   */
  app.post('/auth/claim', async (request, reply) => {
    const body = ClaimBody.safeParse(request.body)
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() })

    let payload: { sub?: string; typ?: string }
    try {
      payload = app.jwt.verify(body.data.token) as { sub?: string; typ?: string }
    } catch {
      return reply.code(401).send({ error: 'This claim link is invalid or has expired' })
    }

    // A session token must not be usable as a claim token either.
    if (payload.typ !== CLAIM_TOKEN_TYPE || !payload.sub) {
      return reply.code(401).send({ error: 'This claim link is invalid or has expired' })
    }

    const db = getDb()
    const guest = await db
      .selectFrom('users')
      .select(['id', 'name', 'is_guest', 'claimed_at'])
      .where('id', '=', payload.sub)
      .executeTakeFirst()

    if (!guest) return reply.code(404).send({ error: 'Player not found' })
    // claimed_at is the single-use guard — the token itself stays valid until it
    // expires, but it can only ever do this once.
    if (guest.claimed_at || !guest.is_guest) {
      return reply.code(409).send({ error: 'This profile has already been claimed' })
    }

    const updated = await db
      .updateTable('users')
      .set({
        is_guest: false,
        claimed_at: new Date(),
        ...(body.data.name ? { name: body.data.name } : {}),
      })
      .where('id', '=', guest.id)
      // Re-check inside the write so two simultaneous claims can't both win.
      .where('claimed_at', 'is', null)
      .returning(['id', 'name', 'username', 'avatar_url', 'city', 'role', 'is_guest'])
      .executeTakeFirst()

    if (!updated) {
      return reply.code(409).send({ error: 'This profile has already been claimed' })
    }

    return {
      access_token: issueJwt(app, updated.id),
      claimed: true,
      user: updated,
    }
  })
}
