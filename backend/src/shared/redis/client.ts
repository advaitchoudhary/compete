import Redis from 'ioredis'

let redisClient: Redis
let redisPubClient: Redis
let redisSubClient: Redis

export function getRedis(): Redis {
  if (!redisClient) {
    redisClient = new Redis(process.env.REDIS_URL!, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    })
    redisClient.on('error', (err) => {
      console.error('[Redis] Error:', err)
    })
  }
  return redisClient
}

// Separate pub/sub clients — Redis doesn't allow commands on subscribed connections
export function getRedisPub(): Redis {
  if (!redisPubClient) {
    redisPubClient = new Redis(process.env.REDIS_URL!, { lazyConnect: true })
  }
  return redisPubClient
}

export function getRedisSub(): Redis {
  if (!redisSubClient) {
    redisSubClient = new Redis(process.env.REDIS_URL!, { lazyConnect: true })
  }
  return redisSubClient
}

// Key builders — centralized to avoid typos
export const CacheKeys = {
  leaderboard: (sportId: string, city: string, period: string) =>
    `lb:${sportId}:${city}:${period}`,
  userProfile: (userId: string) => `user:${userId}`,
  matchLive: (matchId: string) => `match:live:${matchId}`,
  sportProfile: (userId: string, sportId: string) => `sp:${userId}:${sportId}`,
  feedLock: (userId: string) => `feed:lock:${userId}`,
} as const

export const PubSubChannels = {
  matchUpdate: (matchId: string) => `match:${matchId}`,
  ratingUpdate: (userId: string) => `rating:${userId}`,
} as const
