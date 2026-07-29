/**
 * Sync engine — runs on reconnect / app foreground.
 * Drains all unsynced pending stat entries to the backend.
 */

import NetInfo from '@react-native-community/netinfo'
import { api } from '../api/client'
import {
  getAllUnsyncedMatches,
  getPendingEntries,
  markSynced,
} from './scorecard-queue'

let isSyncing = false

export async function syncPendingStats(): Promise<void> {
  if (isSyncing) return

  const netState = await NetInfo.fetch()
  if (!netState.isConnected) return

  isSyncing = true
  try {
    const matchIds = await getAllUnsyncedMatches()
    if (matchIds.length === 0) return

    for (const matchId of matchIds) {
      const entries = await getPendingEntries(matchId)
      if (entries.length === 0) continue

      try {
        const response = await api.post(`/matches/${matchId}/stats/batch`, {
          entries: entries.map((e) => ({
            user_id: e.user_id,
            team_id: e.team_id,
            stats: e.stats,
            client_event_id: e.client_event_id,
            client_timestamp: e.client_timestamp,
          })),
        })

        if (response.data.synced > 0) {
          await markSynced(entries.map((e) => e.client_event_id))
        }
      } catch (err) {
        // Network error — will retry on next sync attempt
        console.warn(`[sync] Failed to sync match ${matchId}:`, err)
      }
    }
  } finally {
    isSyncing = false
  }
}

// Register network change listener for auto-sync on reconnect
export function registerSyncListener(): () => void {
  const unsubscribe = NetInfo.addEventListener((state) => {
    if (state.isConnected) {
      syncPendingStats().catch(console.error)
    }
  })
  return unsubscribe
}
