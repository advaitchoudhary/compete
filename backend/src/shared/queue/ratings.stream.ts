import { getRedis } from '../redis/client'

// Redis Stream that carries match-complete → rating-computation jobs.
// Consumed by the Python rating engine via a consumer group (XREADGROUP).
// Replaces the old SQS FIFO queue — see docs/deployment-fly.md §2.
export const RATING_STREAM_KEY = 'allsports:ratings'

export interface RatingJobMessage {
  match_id: string
  sport_id: string
  triggered_at: string
}

/**
 * Append a rating job to the stream. At-least-once delivery: the consumer's
 * idempotency guard (rating_history is written once per match) makes any
 * redelivery a no-op, so we don't need SQS FIFO's exactly-once dedup.
 *
 * MAXLEN ~ keeps the stream from growing unbounded; the tilde lets Redis trim
 * approximately (cheaper). 10k is far above any realistic unacked backlog.
 */
export async function enqueueRatingJob(payload: RatingJobMessage): Promise<void> {
  await getRedis().xadd(
    RATING_STREAM_KEY,
    'MAXLEN',
    '~',
    10_000,
    '*',
    'match_id',
    payload.match_id,
    'sport_id',
    payload.sport_id,
    'triggered_at',
    payload.triggered_at,
  )
}
