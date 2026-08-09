import { getDb } from '../../shared/db/client'

/**
 * Notification delivery.
 *
 * Two-step by design: every notification is PERSISTED first, then pushed. If the
 * push fails — no token, device uninstalled, Expo down — the player still finds it
 * in the app. Delivery is best-effort; the record is not.
 *
 * Sends straight to Expo's HTTP push API rather than through expo-server-sdk. It
 * is one POST, it needs no FCM or APNs credentials, and it avoids a dependency in
 * an environment where installing one is currently unreliable (corporate TLS
 * interception breaks parts of the toolchain).
 */

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send'

/** Expo caps a single request at 100 messages. */
const EXPO_BATCH_SIZE = 100

export type NotificationType =
  | 'fixtures_published'
  | 'match_next'
  | 'rating_ready'
  // Moved off a pickup game's waitlist. The one message a player must not miss —
  // they were not playing, and now they are.
  | 'game_promoted'

export interface NotifyInput {
  userIds: string[]
  type: NotificationType
  title: string
  body: string
  data?: Record<string, unknown>
}

export interface NotifyResult {
  persisted: number
  pushed: number
  skippedGuests: number
}

/**
 * Persist a notification for each user, then push to whatever devices they have.
 *
 * Guests are skipped: they have no app and therefore no token, so a push would be
 * wasted. They are reached by the WhatsApp claim link instead (Phase 6).
 *
 * Never throws. A notification failing must not roll back the tournament action
 * that triggered it — a referee should never see "match completed" fail because
 * a push gateway was down.
 */
export async function notifyUsers(input: NotifyInput): Promise<NotifyResult> {
  const result: NotifyResult = { persisted: 0, pushed: 0, skippedGuests: 0 }
  const unique = [...new Set(input.userIds)].filter(Boolean)
  if (unique.length === 0) return result

  try {
    const db = getDb()

    // Guests have no app to receive anything.
    const recipients = await db
      .selectFrom('users')
      .select(['id'])
      .where('id', 'in', unique)
      .where('is_guest', '=', false)
      .where('is_active', '=', true)
      .execute()

    result.skippedGuests = unique.length - recipients.length
    if (recipients.length === 0) return result

    await db
      .insertInto('notifications')
      .values(
        recipients.map((r) => ({
          user_id: r.id,
          type: input.type,
          title: input.title,
          body: input.body,
          data: input.data ?? {},
        }))
      )
      .execute()
    result.persisted = recipients.length

    const tokens = await db
      .selectFrom('push_tokens')
      .select('token')
      .where(
        'user_id',
        'in',
        recipients.map((r) => r.id)
      )
      .execute()

    if (tokens.length === 0) return result

    result.pushed = await sendExpoPush(
      tokens.map((t) => t.token),
      input.title,
      input.body,
      { type: input.type, ...(input.data ?? {}) }
    )

    return result
  } catch (err) {
    // Deliberately swallowed — see the note above.
    console.error('[notify] failed', err)
    return result
  }
}

/**
 * Push to Expo. Returns how many messages were accepted.
 *
 * Tokens rejected as DeviceNotRegistered are pruned, because a stale token means
 * an uninstalled app and would otherwise be retried forever.
 */
async function sendExpoPush(
  tokens: string[],
  title: string,
  body: string,
  data: Record<string, unknown>
): Promise<number> {
  let accepted = 0

  for (let i = 0; i < tokens.length; i += EXPO_BATCH_SIZE) {
    const batch = tokens.slice(i, i + EXPO_BATCH_SIZE)
    const messages = batch.map((to) => ({ to, title, body, data, sound: 'default' as const }))

    let res: Response
    try {
      res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(messages),
      })
    } catch (err) {
      console.error('[notify] expo unreachable', err)
      continue
    }

    if (!res.ok) {
      console.error('[notify] expo rejected batch', res.status)
      continue
    }

    const payload = (await res.json()) as {
      data?: Array<{ status: string; details?: { error?: string } }>
    }

    const stale: string[] = []
    ;(payload.data ?? []).forEach((ticket, idx) => {
      if (ticket.status === 'ok') accepted++
      else if (ticket.details?.error === 'DeviceNotRegistered') stale.push(batch[idx])
    })

    if (stale.length > 0) {
      await getDb().deleteFrom('push_tokens').where('token', 'in', stale).execute()
    }
  }

  return accepted
}

/** Every non-guest player registered in an event — the audience for event-wide news. */
export async function eventPlayerIds(eventId: string): Promise<string[]> {
  const rows = await getDb()
    .selectFrom('event_teams as et')
    .innerJoin('team_members as tm', 'tm.team_id', 'et.team_id')
    .select('tm.user_id')
    .where('et.event_id', '=', eventId)
    .execute()
  return [...new Set(rows.map((r) => r.user_id))]
}
