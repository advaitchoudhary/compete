import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { verifyFirebaseToken, issueJwt } from './auth.service'
import { getDb } from '../../shared/db/client'
import { USER_ROLES } from '../../shared/db/types'
import { MATCH_TIERS } from '../../shared/tiers'

const VerifyBody = z.object({
  firebase_id_token: z.string().min(1),
  name: z.string().min(1).max(80).optional(),  // required on first sign-in
  city: z.string().max(50).optional(),
})

const DevTokenBody = z.object({
  key: z.string().min(1).max(40).optional(),
  name: z.string().min(1).max(80).optional(),
  // Built from the shared constants so a new role or tier can never be accepted
  // by the database and rejected here.
  role: z.enum(USER_ROLES).optional(),
  city: z.string().max(50).optional(),
  // Dev convenience: mint a referee at a given tier (defaults to 'amateur')
  referee_tier: z.enum(MATCH_TIERS).optional(),
})

export async function authRoutes(app: FastifyInstance) {
  /**
   * POST /auth/dev-token  (development only)
   *
   * Bypass Firebase for local testing. Each distinct `key` maps to a distinct
   * persistent test user, so you can mint many users (admins, referees,
   * players) for end-to-end flows. Re-using a key returns the same user; if a
   * `role` is supplied it is applied each call (handy to bootstrap an admin).
   * Returns 404 in production.
   *
   * Body (all optional): { key, name, role, city }
   *   key   — stable identity, e.g. "admin", "ref1", "p1" (default "local")
   *   role  — "player" | "referee" | "admin" (default "player" on create)
   */
  app.post('/auth/dev-token', async (request, reply) => {
    if (process.env.NODE_ENV !== 'development') {
      return reply.code(404).send({ error: 'Not found' })
    }

    const body = DevTokenBody.safeParse(request.body ?? {})
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() })

    const key = body.data.key ?? 'local'
    const firebaseUid = `dev-uid-${key}`
    const db = getDb()

    let user = await db
      .selectFrom('users')
      .selectAll()
      .where('firebase_uid', '=', firebaseUid)
      .executeTakeFirst()

    const role = body.data.role
    // A referee always needs a tier; default to 'amateur'.
    const refereeTier =
      role === 'referee' ? (body.data.referee_tier ?? 'amateur') : body.data.referee_tier ?? null

    if (!user) {
      user = await db
        .insertInto('users')
        .values({
          phone: `dev-${key}`,
          name: body.data.name ?? `Dev ${key}`,
          city: body.data.city ?? 'Pune',
          firebase_uid: firebaseUid,
          role: role ?? 'player',
          referee_tier: refereeTier,
        })
        .returningAll()
        .executeTakeFirstOrThrow()
    } else {
      // Allow promoting/demoting + (re)setting referee tier on an existing dev user
      const updates: Record<string, unknown> = {}
      if (role && role !== user.role) updates.role = role
      if (body.data.referee_tier) updates.referee_tier = body.data.referee_tier
      else if (role === 'referee' && !user.referee_tier) updates.referee_tier = 'amateur'
      if (Object.keys(updates).length > 0) {
        user = await db
          .updateTable('users')
          .set(updates as never)
          .where('id', '=', user.id)
          .returningAll()
          .executeTakeFirstOrThrow()
      }
    }

    const token = issueJwt(app, user.id)

    return reply.send({
      access_token: token,
      is_new_user: false,
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        avatar_url: user.avatar_url,
        city: user.city,
        role: user.role,
      },
    })
  })

  /**
   * POST /auth/verify
   *
   * Client calls Firebase Phone Auth, gets an ID token, sends it here.
   * We verify with Firebase Admin, then issue our own short-lived JWT.
   * Creates user record on first sign-in.
   */
  app.post('/auth/verify', async (request, reply) => {
    const body = VerifyBody.safeParse(request.body)
    if (!body.success) {
      return reply.code(400).send({ error: 'Invalid request', details: body.error.flatten() })
    }

    const { firebase_id_token, name, city } = body.data
    const db = getDb()

    // 1. Verify the Firebase ID token
    const firebaseUser = await verifyFirebaseToken(firebase_id_token)
    if (!firebaseUser) {
      return reply.code(401).send({ error: 'Invalid Firebase token' })
    }

    // 2. Find the account this sign-in belongs to.
    //
    // By firebase_uid first, then by phone number. The phone fallback matters
    // because a person can already exist here before they ever complete a Firebase
    // sign-in: seeded accounts, a guest who was claimed, someone an admin created.
    // Firebase only puts `phone_number` in the token after the OTP succeeded, so a
    // verified phone IS the identity and is safe to match on — without this,
    // signing in would fork a second, empty profile and strand the person's
    // history on the first one.
    let user = await db
      .selectFrom('users')
      .selectAll()
      .where('firebase_uid', '=', firebaseUser.uid)
      .executeTakeFirst()

    if (!user && firebaseUser.phone_number) {
      user = await db
        .selectFrom('users')
        .selectAll()
        .where('phone', '=', firebaseUser.phone_number)
        .where('is_active', '=', true)
        .executeTakeFirst()

      // Adopt the Firebase uid only if the row has none. Seeded dev accounts hold
      // a `dev-uid-*` sentinel that POST /auth/dev-token looks them up by;
      // overwriting it would silently break every quick-login button.
      if (user && !user.firebase_uid) {
        user = await db
          .updateTable('users')
          .set({ firebase_uid: firebaseUser.uid })
          .where('id', '=', user.id)
          .returningAll()
          .executeTakeFirstOrThrow()
      }
    }

    const isNewUser = !user

    if (!user) {
      if (!name) {
        // The client cannot know this is a first sign-in until it asks — there is
        // deliberately no "does this number exist" endpoint, since that would let
        // anyone enumerate who is registered. So the answer comes back here, with
        // a stable code rather than a message: the sign-in screen branches on it
        // to collect a name, and prose is free to change without breaking it.
        return reply.code(400).send({
          error: 'name is required for new users',
          code: 'NAME_REQUIRED',
        })
      }
      user = await db
        .insertInto('users')
        .values({
          // Empty string would collide on the second signup — the unique index on
          // phone only ignores NULL.
          phone: firebaseUser.phone_number ?? null,
          name,
          city: city ?? null,
          firebase_uid: firebaseUser.uid,
        })
        .returningAll()
        .executeTakeFirstOrThrow()
    }

    // 3. Issue our JWT
    const token = issueJwt(app, user.id)

    return reply.code(isNewUser ? 201 : 200).send({
      access_token: token,
      is_new_user: isNewUser,
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        avatar_url: user.avatar_url,
        city: user.city,
        // Without this a real phone sign-in returned no role, so the organizer
        // control room, the referee duty list and the admin queue all stayed
        // hidden from the people they belong to. dev-token already sent it.
        role: user.role,
      },
    })
  })
}
