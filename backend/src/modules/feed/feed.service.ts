import { getDb } from '../../shared/db/client'

interface FeedEventInput {
  actor_id: string
  action_type: string
  entity_type: string
  entity_id: string
  payload: Record<string, unknown>
}

export async function emitFeedEvent(input: FeedEventInput): Promise<void> {
  const db = getDb()
  await db
    .insertInto('feed_events')
    .values({
      actor_id: input.actor_id,
      action_type: input.action_type,
      entity_type: input.entity_type,
      entity_id: input.entity_id,
      payload: JSON.stringify(input.payload) as unknown as Record<string, unknown>,
    })
    .execute()
}
