import type { Kysely, Transaction } from 'kysely'
import { getDb } from '../../shared/db/client'
import type { Database, PickupStatus } from '../../shared/db/types'

/**
 * The roster rules for a pickup game: capacity, parties and the waitlist.
 *
 * Kept apart from the routes because this is where the real behaviour lives. A
 * tournament registers whole teams and is done; a pickup game is a queue that
 * reshapes itself every time somebody drops out on a Tuesday afternoon.
 */

export type Db = Kysely<Database> | Transaction<Database>

/** Capacity is always derived. Storing it would be a second source of truth. */
export const capacityOf = (playersPerSide: number | null): number =>
  (playersPerSide ?? 0) * 2

export interface RosterRow {
  user_id: string
  added_by: string | null
  status: PickupStatus
  joined_at: Date
}

/**
 * The party key for a row: the person who brought them, or themselves.
 *
 * Parties join, wait and leave as a unit. Someone's three mates were only coming
 * because that person was — leaving them stranded on the list produces players who
 * do not turn up, which is worse for the game than an empty slot.
 */
export const partyOf = (row: { user_id: string; added_by: string | null }): string =>
  row.added_by ?? row.user_id

export async function rosterFor(db: Db, eventId: string): Promise<RosterRow[]> {
  return db
    .selectFrom('event_players')
    .select(['user_id', 'added_by', 'status', 'joined_at'])
    .where('event_id', '=', eventId)
    .where('status', '!=', 'withdrawn')
    .orderBy('joined_at', 'asc')
    .execute()
}

export const countConfirmed = (roster: RosterRow[]): number =>
  roster.filter((r) => r.status === 'confirmed').length

/**
 * Waitlist parties, in the order they joined, each as the list of its members.
 *
 * A party's position is set by its EARLIEST member, so adding a mate later never
 * pushes a group down the queue.
 */
export function waitlistParties(roster: RosterRow[]): Array<{ key: string; members: string[] }> {
  const byParty = new Map<string, { key: string; members: string[]; first: number }>()

  for (const row of roster) {
    if (row.status !== 'waitlist') continue
    const key = partyOf(row)
    const at = new Date(row.joined_at).getTime()
    const existing = byParty.get(key)
    if (existing) {
      existing.members.push(row.user_id)
      existing.first = Math.min(existing.first, at)
    } else {
      byParty.set(key, { key, members: [row.user_id], first: at })
    }
  }

  return [...byParty.values()]
    .sort((a, b) => a.first - b.first)
    .map(({ key, members }) => ({ key, members }))
}

/**
 * Fill free slots from the waitlist, in join order.
 *
 * A party that does not fit is SKIPPED rather than blocking the queue. Three people
 * waiting on two free slots would otherwise leave the game 6-a-side against 7, and
 * for a weeknight kickabout a full game beats strict fairness. The skipped party
 * keeps its place for a larger opening.
 *
 * Returns the users promoted, so the caller can tell them.
 */
export async function promoteFromWaitlist(db: Db, eventId: string): Promise<string[]> {
  const event = await db
    .selectFrom('events')
    .select('players_per_side')
    .where('id', '=', eventId)
    .executeTakeFirst()

  if (!event) return []
  const capacity = capacityOf(event.players_per_side)
  if (capacity === 0) return []

  const roster = await rosterFor(db, eventId)
  let free = capacity - countConfirmed(roster)
  if (free <= 0) return []

  const promoted: string[] = []
  for (const party of waitlistParties(roster)) {
    if (party.members.length > free) continue
    await db
      .updateTable('event_players')
      .set({ status: 'confirmed' })
      .where('event_id', '=', eventId)
      .where('user_id', 'in', party.members)
      .execute()
    promoted.push(...party.members)
    free -= party.members.length
    if (free === 0) break
  }
  return promoted
}

/**
 * Everyone in the caller's party for this game — them plus anyone they brought.
 *
 * If the caller was themselves brought by someone else, only they leave: pulling
 * the whole group because a guest was removed would be the tail wagging the dog.
 */
export async function partyMembers(
  db: Db,
  eventId: string,
  userId: string
): Promise<string[]> {
  const rows = await db
    .selectFrom('event_players')
    .select(['user_id', 'added_by'])
    .where('event_id', '=', eventId)
    .where('status', '!=', 'withdrawn')
    .execute()

  const me = rows.find((r) => r.user_id === userId)
  if (!me) return []
  if (me.added_by) return [userId]
  return rows.filter((r) => partyOf(r) === userId).map((r) => r.user_id)
}

/** A pickup game, or null if this event id is not one. */
export async function loadGame(eventId: string) {
  return getDb()
    .selectFrom('events')
    .select([
      'id', 'name', 'organizer_id', 'status', 'sport_id', 'city', 'venue',
      'players_per_side', 'match_duration_minutes', 'starts_at', 'format', 'tier',
    ])
    .where('id', '=', eventId)
    .where('format', '=', 'casual')
    .executeTakeFirst()
}
