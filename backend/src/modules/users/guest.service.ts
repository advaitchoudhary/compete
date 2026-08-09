import type { Kysely, Transaction } from 'kysely'
import type { Database } from '../../shared/db/types'

/**
 * Creating a guest — a real player with no way to sign in yet.
 *
 * Most people at a turf on a Sunday have no account and will not make one, so
 * somebody types their name and they become a `users` row with `is_guest = true`.
 * They accumulate stats and a rating exactly like anyone else; what they lack is
 * credentials. Later they claim the profile through a link and the SAME row gains
 * a phone, keeping every match they played.
 *
 * `created_by` is the load-bearing field. It records who typed them in, and
 * POST /guests/:id/claim-link authorises on it — so whoever added a guest can
 * always send them their link without any further permission wiring.
 *
 * Lives here because this insert had already been written twice, in the tournament
 * registration path and in POST /users/guest, and pickup games would have made three.
 * The general-purpose endpoint stays referee/admin-only on purpose: a flow that lets
 * ordinary players invent users needs to be deliberate about it, which is why the
 * callers keep their own authorisation rather than this helper carrying any.
 */
export interface NewGuest {
  name: string
  city?: string | null
  /** The user who typed this person in. Never a guest themselves. */
  createdBy: string
}

export async function createGuest(
  db: Kysely<Database> | Transaction<Database>,
  guest: NewGuest
): Promise<{ id: string }> {
  return db
    .insertInto('users')
    .values({
      name: guest.name,
      city: guest.city ?? null,
      phone: null,
      firebase_uid: null,
      is_guest: true,
      created_by: guest.createdBy,
    })
    .returning('id')
    .executeTakeFirstOrThrow()
}
