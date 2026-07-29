import { io, Socket } from 'socket.io-client'
import { getToken } from '../api/client'

const REALTIME_URL = process.env.EXPO_PUBLIC_REALTIME_URL ?? 'http://localhost:3001'

let socket: Socket | null = null

export function getSocket(): Socket {
  if (!socket || !socket.connected) {
    const token = getToken()
    socket = io(REALTIME_URL, {
      auth: { token },
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 2000,
    })

    socket.on('connect', () => console.log('[socket] Connected'))
    socket.on('disconnect', (reason) => console.log('[socket] Disconnected:', reason))
    socket.on('connect_error', (err) => console.warn('[socket] Connection error:', err.message))
  }
  return socket
}

export function joinMatchRoom(matchId: string): void {
  getSocket().emit('join_match', { match_id: matchId })
}

export function leaveMatchRoom(matchId: string): void {
  getSocket().emit('leave_match', { match_id: matchId })
}

export function onMatchUpdate(
  matchId: string,
  handler: (data: Record<string, unknown>) => void
): () => void {
  const socket = getSocket()
  socket.emit('join_match', { match_id: matchId })
  socket.on('match_update', handler)
  return () => socket.off('match_update', handler)
}

export function onRatingUpdate(
  handler: (data: { old_rating: number; new_rating: number; delta: number }) => void
): () => void {
  const socket = getSocket()
  socket.emit('watch_ratings')
  socket.on('rating_update', handler)
  return () => socket.off('rating_update', handler)
}

export function disconnectSocket(): void {
  socket?.disconnect()
  socket = null
}
