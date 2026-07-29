import 'dotenv/config'
import { createServer } from 'http'
import { Server } from 'socket.io'
import jwt from 'jsonwebtoken'
import Redis from 'ioredis'
import pino from 'pino'

const logger = pino({ transport: { target: 'pino-pretty' } })
const PORT = Number(process.env.REALTIME_PORT ?? 3001)
const JWT_SECRET = process.env.JWT_SECRET!
const REDIS_URL = process.env.REDIS_URL!

// ── Redis Pub/Sub ────────────────────────────────────────────────────────────
const redisSub = new Redis(REDIS_URL)
const redisPub = new Redis(REDIS_URL)

// ── HTTP + Socket.IO ─────────────────────────────────────────────────────────
// Plain HTTP handler serves /health for Fly's load-balancer checks. Socket.IO
// attaches its own request listener for /socket.io/ paths and delegates everything
// else here, so the two coexist on one port.
const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('ok')
    return
  }
  res.writeHead(404)
  res.end()
})
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  // Websocket-only: the mobile client connects websocket-only (see
  // mobile/src/realtime/socket.ts), and HTTP long-polling across >1 instance
  // would need sticky sessions to keep a client pinned to one node. Dropping
  // polling makes this service safe to run multi-instance behind the Fly proxy.
  // Cross-instance fan-out is already handled by the Redis pub/sub bridge below
  // (each instance relays to its own local sockets), so no Redis adapter is needed.
  transports: ['websocket'],
  pingTimeout: 30_000,
  pingInterval: 10_000,
})

// ── Auth middleware ──────────────────────────────────────────────────────────
io.use((socket, next) => {
  const token = socket.handshake.auth.token as string
  if (!token) return next(new Error('Authentication required'))

  try {
    const payload = jwt.verify(token, JWT_SECRET) as { sub: string }
    socket.data.userId = payload.sub
    next()
  } catch {
    next(new Error('Invalid token'))
  }
})

// ── Connection handler ───────────────────────────────────────────────────────
io.on('connection', (socket) => {
  const userId = socket.data.userId as string
  logger.info({ userId, socketId: socket.id }, 'Client connected')

  /**
   * JOIN_MATCH: Client subscribes to live score updates for a match
   * Payload: { match_id: string }
   */
  socket.on('join_match', ({ match_id }: { match_id: string }) => {
    if (!match_id) return
    socket.join(`match:${match_id}`)
    logger.debug({ userId, match_id }, 'Joined match room')
    socket.emit('joined_match', { match_id })
  })

  socket.on('leave_match', ({ match_id }: { match_id: string }) => {
    socket.leave(`match:${match_id}`)
  })

  /**
   * JOIN_RATING_UPDATES: Client subscribes to their own rating updates
   * Fires after match confirmation + rating engine runs
   */
  socket.on('watch_ratings', () => {
    socket.join(`rating:${userId}`)
  })

  socket.on('disconnect', (reason) => {
    logger.debug({ userId, reason }, 'Client disconnected')
  })
})

// ── Redis → Socket.IO bridge ─────────────────────────────────────────────────
// Subscribe to match update channels (pattern: match:*)
redisSub.psubscribe('match:*', (err) => {
  if (err) logger.error({ err }, 'Failed to subscribe to match channels')
})

// Subscribe to rating update channels (pattern: rating:*)
redisSub.psubscribe('rating:*', (err) => {
  if (err) logger.error({ err }, 'Failed to subscribe to rating channels')
})

redisSub.on('pmessage', (_pattern: string, channel: string, message: string) => {
  try {
    const data = JSON.parse(message)

    if (channel.startsWith('match:')) {
      // Broadcast to all clients in this match room
      io.to(channel).emit('match_update', data)
    } else if (channel.startsWith('rating:')) {
      // Send rating update to specific user's room
      io.to(channel).emit('rating_update', data)
    }
  } catch (err) {
    logger.error({ err, channel }, 'Failed to parse Redis message')
  }
})

// ── Start ─────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  logger.info(`AllSports Real-time service running on :${PORT}`)
})

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('Shutting down real-time service...')
  await redisSub.quit()
  await redisPub.quit()
  io.close()
  process.exit(0)
})
