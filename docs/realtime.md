# Real-time Service

Node.js 20 · Socket.IO v4 · Redis Pub/Sub
Location: `realtime/`
Port: `3001`

---

## Start

```bash
cd realtime
npm install
npm run dev
```

---

## Directory Structure

```
realtime/
├── src/
│   └── index.ts    # everything — Socket.IO server + Redis bridge
├── Dockerfile
└── package.json
```

---

## Purpose

This service does exactly one thing: **bridge Redis Pub/Sub to Socket.IO WebSocket connections**.

The backend never talks to Socket.IO directly. It publishes messages to Redis channels. This service subscribes to those channels and broadcasts the messages to the right WebSocket clients.

```
Backend publishes:
  Redis channel "match:abc123" → { type: "score_update", home_goals: 2 }

Real-time service:
  Receives from Redis
  Broadcasts to Socket.IO room "match:abc123"

Mobile apps subscribed to that match:
  Receive the update in real time
```

This decoupling means:
- Backend doesn't know Socket.IO exists — it just writes to Redis
- Real-time service doesn't know the backend exists — it just reads from Redis
- Either can be restarted independently without breaking the other
- Either can be scaled independently

---

## `src/index.ts`

### Setup

Three connections are established on start:
- `redisSub` — subscribes to Redis channels (listen-only connection)
- `redisPub` — publishes to Redis if needed (currently unused, reserved for future use)
- Socket.IO server on HTTP server

### JWT Authentication

Every WebSocket connection is authenticated before it's accepted:

```typescript
io.use((socket, next) => {
  const token = socket.handshake.auth.token
  // same JWT the backend issues — same secret
  const payload = jwt.verify(token, JWT_SECRET) as { sub: string }
  socket.data.userId = payload.sub
  next()
})
```

The mobile app sends the token in `socket.handshake.auth.token`. If the token is missing or invalid, the connection is rejected before it's established. Every authenticated socket has `socket.data.userId` populated.

---

### Socket.IO Events (Client → Server)

**`join_match`**
```typescript
socket.emit('join_match', { match_id: 'abc123' })
```
Adds this socket to the Socket.IO room `match:abc123`. From this point, any match update published to Redis channel `match:abc123` is broadcast to this client.

Use case: scorer opens a live match card → joins the room → receives every score update in real time.

**`leave_match`**
```typescript
socket.emit('leave_match', { match_id: 'abc123' })
```
Removes the socket from the room. Called when the user navigates away from the match screen.

**`watch_ratings`**
```typescript
socket.emit('watch_ratings')
```
Adds this socket to the room `rating:{userId}`. From this point, any rating update published for this user is pushed to their phone.

Use case: player opens their profile → watches rating → after their match completes, rating engine publishes their new rating → phone receives it and animates the change.

---

### Redis → Socket.IO Bridge

The service uses **pattern subscribe** (`psubscribe`) to subscribe to all channels matching a wildcard:

```typescript
redisSub.psubscribe('match:*')    // all match channels
redisSub.psubscribe('rating:*')   // all rating channels
```

This is more efficient than subscribing to individual channels — as thousands of matches run concurrently, there's no need to re-subscribe for each one.

The `pmessage` handler fires for every message on any matching channel:

```typescript
redisSub.on('pmessage', (_pattern, channel, message) => {
  const data = JSON.parse(message)

  if (channel.startsWith('match:')) {
    io.to(channel).emit('match_update', data)
  } else if (channel.startsWith('rating:')) {
    io.to(channel).emit('rating_update', data)
  }
})
```

**The `channel` name equals the Socket.IO room name.** This is intentional. When the backend publishes to `match:abc123`, this handler broadcasts to Socket.IO room `match:abc123` — which is exactly where all clients watching that match are sitting.

---

### Socket.IO Events (Server → Client)

**`joined_match`**
Confirmation sent to the client after `join_match` is received.

**`match_update`**
Broadcast to all clients in a match room. Payload varies by what happened:

```json
// Score update (from PATCH /matches/:id/score)
{ "type": "score_update", "match_id": "abc123", "home_score": {"goals": 2}, "away_score": {"goals": 1} }

// Stats submitted for a player (from POST /matches/:id/stats)
{ "type": "stats_update", "player_id": "user-uuid", "stats": {"goals": 1, "assists": 0} }

// Match started
{ "type": "match_started", "match_id": "abc123", "started_at": "2024-..." }

// Both captains confirmed — match complete
{ "type": "match_completed", "match_id": "abc123" }
```

**`rating_update`**
Sent to a specific user's room. Payload from rating engine:

```json
{
  "user_id": "...",
  "sport_id": "...",
  "old_rating": 63.0,
  "new_rating": 67.2,
  "delta": 4.2,
  "match_rating": 7.8
}
```

---

### Reconnection

Socket.IO handles reconnection automatically with exponential backoff. The mobile client is configured with:

```typescript
{
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 2000
}
```

When a client reconnects after a brief network blip, it re-emits `join_match` to re-join the room and resumes receiving updates. Any events missed during disconnection would not be replayed (real-time only) — but the client can call `GET /matches/:id` to fetch the current state.

---

### Graceful Shutdown

```typescript
process.on('SIGTERM', async () => {
  await redisSub.quit()   // close Redis subscription
  await redisPub.quit()
  io.close()              // close all WebSocket connections
  process.exit(0)
})
```

ECS sends `SIGTERM` before terminating a container. This ensures existing connections are closed cleanly rather than abruptly.

---

## Scaling

When running multiple real-time service instances (for high traffic), Socket.IO needs an **adapter** so all instances share room membership. The `socket.io-redis` adapter (v8+) uses Redis to synchronize — any instance can broadcast to a room regardless of which instance the client connected to.

This is not yet implemented (Phase 2 concern — single instance handles ~10,000 concurrent connections).

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `REDIS_URL` | ✓ | Redis connection URL |
| `JWT_SECRET` | ✓ | Must match backend's JWT_SECRET |
| `REALTIME_PORT` | — | Default: 3001 |
