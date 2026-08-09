import type { Kysely } from 'kysely'
import type { FastifyRequest } from 'fastify'
import type { Database } from '../../shared/db/types'

/**
 * Who may hand a guest their claim link.
 *
 * This rule lived only inside POST /guests/:id/claim-link, which meant the match
 * screen had no way to ask it and instead guessed from the viewer's role. The guess
 * was wrong in both directions: it offered the button to every organizer whether or
 * not the guest was anything to do with them, and — the one that matters — hid it
 * from the two people most likely to have the guest's number.
 *
 * A captain typed the guest into a tournament squad. A player brought a mate to a
 * pickup game. Neither is staff, both are authorised by the endpoint, and neither
 * saw a button. The rating was reachable only by someone running curl.
 *
 * So the rule lives here and both sides call it: the endpoint to enforce, the match
 * payload to decide what to render. One definition, no drift.
 */

/** Staff can always share — they run the event and are accountable for it. */
const STAFF_ROLES = new Set(['admin', 'referee', 'organizer'])

export interface ClaimLinkViewer {
  id: string
  role: string
}

/**
 * Pre-loads everything the check needs, then answers per guest without touching the
 * database again — a scorecard asks this once per unclaimed guest, and a query each
 * time would mean a dozen round trips to render one screen.
 */
export async function claimLinkAuthorizer(
  db: Kysely<Database>,
  viewer: ClaimLinkViewer
): Promise<(guest: { id: string; created_by: string | null }) => boolean> {
  if (STAFF_ROLES.has(viewer.role)) return () => true

  // Everyone this viewer plays alongside on a team they captain. Guests are typed
  // in by their captain at registration, so this is the tournament half of the rule.
  const teammates = await db
    .selectFrom('team_members as mine')
    .innerJoin('team_members as theirs', 'theirs.team_id', 'mine.team_id')
    .select('theirs.user_id')
    .where('mine.user_id', '=', viewer.id)
    .where('mine.role', 'in', ['captain', 'vice_captain'])
    .execute()

  const captained = new Set(teammates.map((t) => t.user_id))

  // created_by is the pickup half: whoever typed the name in brought the person.
  return (guest) => guest.created_by === viewer.id || captained.has(guest.id)
}

/**
 * The same question from a route that does not require a session.
 *
 * A match page is readable signed out — you can be sent a link to a game you had
 * nothing to do with. So the token is decoded if there is one and ignored if not,
 * and a viewer we cannot identify simply may not share anything.
 */
export async function resolveViewer(
  request: FastifyRequest,
  db: Kysely<Database>
): Promise<(guest: { id: string; created_by: string | null }) => boolean> {
  let viewerId: string
  try {
    await request.jwtVerify()
    const sub = (request.user as { sub?: string; typ?: string } | null)?.sub
    // A claim link is signed with the same secret; it is not a session.
    if (!sub || (request.user as { typ?: string })?.typ) return () => false
    viewerId = sub
  } catch {
    return () => false
  }

  const viewer = await db
    .selectFrom('users')
    .select('role')
    .where('id', '=', viewerId)
    .where('is_active', '=', true)
    .executeTakeFirst()
  if (!viewer) return () => false

  return claimLinkAuthorizer(db, { id: viewerId, role: viewer.role })
}
