import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAuth } from '../../shared/middleware/auth'
import { getDb } from '../../shared/db/client'
import { issueJwt, verifyFirebaseToken } from '../auth/auth.service'
import { claimLinkAuthorizer } from './claim-link.access'

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
 * Claiming requires TWO proofs: the link says which profile, and a phone sign-in
 * says who is taking it. The link alone used to be enough, which left the new
 * owner with no phone and no firebase_uid — they owned a rating with nothing to
 * sign in with once the session expired, and the link was already spent.
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
  /**
   * A Firebase ID token from completing phone sign-in.
   *
   * Required, because the link alone is not an identity. Claiming used to hand
   * over the profile on possession of the URL, which meant the new owner ended up
   * with `phone` and `firebase_uid` both null — they owned a rating and had
   * nothing to sign in with once their session expired, and the link was spent.
   * Verifying a phone here is what makes the profile theirs permanently.
   */
  firebase_id_token: z.string().min(1),
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
    // Defined once in claim-link.access.ts, because the match screen has to ask the
    // same question to decide whether to draw the button.
    const me = await db
      .selectFrom('users')
      .select('role')
      .where('id', '=', request.userId)
      .executeTakeFirst()
    if (!me) return reply.code(401).send({ error: 'Unauthorized' })

    const mayShare = await claimLinkAuthorizer(db, { id: request.userId, role: me.role })

    if (!mayShare({ id: guest.id, created_by: guest.created_by })) {
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
   * POST /auth/claim — no session required, but two proofs are.
   *
   * The link proves WHICH profile is being claimed; the phone sign-in proves WHO
   * is claiming it and leaves them a credential they can come back with. Neither
   * alone is enough: a forwarded link cannot take a profile without also passing
   * an OTP, and a verified phone cannot take a profile without the link.
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

    const firebaseUser = await verifyFirebaseToken(body.data.firebase_id_token)
    if (!firebaseUser) {
      return reply.code(401).send({ error: 'Phone verification failed. Try signing in again.' })
    }
    if (!firebaseUser.phone_number) {
      return reply.code(400).send({ error: 'A verified phone number is required to claim a profile' })
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

    // That number may already be somebody. Merging two histories into one is a
    // real feature with real ways to go wrong, so refuse plainly rather than
    // silently picking a winner and losing the other side's ratings.
    const taken = await db
      .selectFrom('users')
      .select(['id', 'name'])
      .where('phone', '=', firebaseUser.phone_number)
      .where('id', '!=', guest.id)
      .executeTakeFirst()

    if (taken) {
      return reply.code(409).send({
        error:
          'That number already belongs to an AllSports account. ' +
          'Sign in with it instead, or claim this profile with a different number.',
        code: 'PHONE_IN_USE',
      })
    }

    const updated = await db
      .updateTable('users')
      .set({
        is_guest: false,
        claimed_at: new Date(),
        // The point of the whole change: a credential that outlives the session.
        phone: firebaseUser.phone_number,
        firebase_uid: firebaseUser.uid,
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

    // The rating is the entire reason this person tapped the link. Return it so
    // the success screen can show the number rather than promising it exists.
    const profiles = await db
      .selectFrom('sport_profiles as sp')
      .innerJoin('sports as s', 's.id', 'sp.sport_id')
      .select(['s.slug as sport_slug', 'sp.current_rating', 'sp.matches_played', 'sp.wins'])
      .where('sp.user_id', '=', updated.id)
      .orderBy('sp.matches_played', 'desc')
      .execute()

    return {
      access_token: issueJwt(app, updated.id),
      claimed: true,
      user: updated,
      profiles: profiles.map((p) => ({
        sport_slug: p.sport_slug,
        rating: Number(p.current_rating),
        matches_played: p.matches_played,
        wins: p.wins,
      })),
    }
  })
}
