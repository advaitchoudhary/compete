/**
 * LiveScorecard screen — works online AND offline.
 *
 * Online: stats submitted immediately via REST → Redis → WebSocket
 * Offline: stats buffered to SQLite → synced on reconnect
 */

import React, { useState, useEffect, useCallback } from 'react'
import {
  View, Text, TextInput, TouchableOpacity,
  ScrollView, StyleSheet, Alert
} from 'react-native'
import NetInfo from '@react-native-community/netinfo'
import { v4 as uuidv4 } from 'uuid'
import { api } from '../../api/client'
import { queueStatEntry } from '../../offline/scorecard-queue'
import { onMatchUpdate, joinMatchRoom, leaveMatchRoom } from '../../realtime/socket'
import { useAuthStore } from '../../store/auth.store'

interface Props {
  matchId: string
  sportSlug: string
  teamId: string
  statSchema: {
    match_stats: string[]
    positions?: string[]
  }
}

interface PlayerStatRow {
  userId: string
  name: string
  stats: Record<string, string>
}

export default function LiveScorecard({ matchId, sportSlug, teamId, statSchema }: Props) {
  const { user } = useAuthStore()
  const [isOnline, setIsOnline] = useState(true)
  const [players, setPlayers] = useState<PlayerStatRow[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [liveUpdates, setLiveUpdates] = useState<Record<string, unknown>[]>([])

  useEffect(() => {
    const unsubNet = NetInfo.addEventListener((state) => {
      setIsOnline(!!state.isConnected)
    })

    // Subscribe to live match updates from Socket.IO
    const unsubSocket = onMatchUpdate(matchId, (update) => {
      setLiveUpdates((prev) => [update, ...prev.slice(0, 49)])
    })

    return () => {
      unsubNet()
      unsubSocket()
      leaveMatchRoom(matchId)
    }
  }, [matchId])

  const addPlayer = useCallback(() => {
    setPlayers((prev) => [
      ...prev,
      {
        userId: user?.id ?? '',  // default to current user; captain can change for other players
        name: user?.name ?? '',
        stats: Object.fromEntries(statSchema.match_stats.map((s) => [s, ''])),
      },
    ])
  }, [statSchema.match_stats, user])

  const updateStat = (playerIndex: number, statKey: string, value: string) => {
    setPlayers((prev) =>
      prev.map((p, i) =>
        i === playerIndex ? { ...p, stats: { ...p.stats, [statKey]: value } } : p
      )
    )
  }

  const submitStats = async () => {
    if (!user) return
    setSubmitting(true)

    const timestamp = new Date().toISOString()

    for (const player of players) {
      if (!player.userId) continue

      const numericStats = Object.fromEntries(
        Object.entries(player.stats).map(([k, v]) => [k, isNaN(Number(v)) ? v : Number(v)])
      )
      const clientEventId = uuidv4()

      if (isOnline) {
        try {
          await api.post(`/matches/${matchId}/stats`, {
            user_id: player.userId,
            team_id: teamId,
            stats: numericStats,
            client_event_id: clientEventId,
          })
        } catch {
          // Fall back to offline queue
          await queueStatEntry({
            match_id: matchId,
            user_id: player.userId,
            team_id: teamId,
            stats: numericStats,
            client_event_id: clientEventId,
            client_timestamp: timestamp,
          })
        }
      } else {
        await queueStatEntry({
          match_id: matchId,
          user_id: player.userId,
          team_id: teamId,
          stats: numericStats,
          client_event_id: clientEventId,
          client_timestamp: timestamp,
        })
      }
    }

    setSubmitting(false)
    Alert.alert(
      isOnline ? 'Stats saved!' : 'Stats queued (offline)',
      isOnline
        ? 'Stats submitted. Ask opponent captain to confirm.'
        : 'Stats saved locally. Will sync when back online.',
      [{ text: 'OK' }]
    )
  }

  return (
    <ScrollView style={styles.container}>
      {/* Connection status banner */}
      {!isOnline && (
        <View style={styles.offlineBanner}>
          <Text style={styles.offlineText}>OFFLINE — stats will sync when reconnected</Text>
        </View>
      )}

      <Text style={styles.title}>Enter Player Stats</Text>
      <Text style={styles.subtitle}>{sportSlug.toUpperCase()} · Match</Text>

      {players.map((player, pIdx) => (
        <View key={pIdx} style={styles.playerCard}>
          <View style={styles.playerHeader}>
            <Text style={styles.playerNumber}>Player {pIdx + 1}</Text>
            <TouchableOpacity
              onPress={() => setPlayers((prev) => prev.filter((_, i) => i !== pIdx))}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={styles.removeBtn}>✕</Text>
            </TouchableOpacity>
          </View>
          <TextInput
            placeholder="Player name"
            value={player.name}
            onChangeText={(v) =>
              setPlayers((prev) => prev.map((p, i) => (i === pIdx ? { ...p, name: v } : p)))
            }
            style={styles.playerNameInput}
          />
          <TextInput
            placeholder="Player User ID (UUID)"
            value={player.userId}
            onChangeText={(v) =>
              setPlayers((prev) => prev.map((p, i) => (i === pIdx ? { ...p, userId: v.trim() } : p)))
            }
            style={[styles.playerNameInput, { marginBottom: 12, fontSize: 12, color: '#9ca3af' }]}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <View style={styles.statsGrid}>
            {statSchema.match_stats.map((stat) => (
              <View key={stat} style={styles.statCell}>
                <Text style={styles.statLabel}>{stat.replace(/_/g, ' ')}</Text>
                <TextInput
                  value={player.stats[stat]}
                  onChangeText={(v) => updateStat(pIdx, stat, v)}
                  keyboardType="numeric"
                  style={styles.statInput}
                  placeholder="0"
                />
              </View>
            ))}
          </View>
        </View>
      ))}

      <TouchableOpacity style={styles.addButton} onPress={addPlayer}>
        <Text style={styles.addButtonText}>+ Add Player</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.submitButton, submitting && styles.submitDisabled]}
        onPress={submitStats}
        disabled={submitting}
      >
        <Text style={styles.submitButtonText}>
          {submitting ? 'Saving...' : isOnline ? 'Submit Stats' : 'Queue Stats (Offline)'}
        </Text>
      </TouchableOpacity>

      {/* Live updates ticker */}
      {liveUpdates.length > 0 && (
        <View style={styles.liveTicker}>
          <Text style={styles.liveLabel}>LIVE</Text>
          {liveUpdates.slice(0, 5).map((update, i) => (
            <Text key={i} style={styles.liveItem}>
              {JSON.stringify(update)}
            </Text>
          ))}
        </View>
      )}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0f0f0f', padding: 16 },
  offlineBanner: { backgroundColor: '#b45309', padding: 8, borderRadius: 8, marginBottom: 12 },
  offlineText: { color: '#fff', textAlign: 'center', fontWeight: '600', fontSize: 13 },
  title: { color: '#fff', fontSize: 22, fontWeight: '700', marginBottom: 4 },
  subtitle: { color: '#9ca3af', fontSize: 13, marginBottom: 20, letterSpacing: 1 },
  playerCard: {
    backgroundColor: '#1c1c1e',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
  },
  playerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  playerNumber: { color: '#e5e7eb', fontSize: 13, fontWeight: '700' },
  removeBtn: { color: '#ef4444', fontSize: 14, fontWeight: '700' },
  playerNameInput: {
    backgroundColor: '#2c2c2e',
    color: '#fff',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 12,
    fontSize: 15,
  },
  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  statCell: { width: '30%' },
  statLabel: { color: '#9ca3af', fontSize: 11, marginBottom: 4, textTransform: 'capitalize' },
  statInput: {
    backgroundColor: '#2c2c2e',
    color: '#fff',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontSize: 16,
    textAlign: 'center',
  },
  addButton: {
    borderWidth: 1,
    borderColor: '#3b82f6',
    borderRadius: 10,
    padding: 12,
    alignItems: 'center',
    marginBottom: 12,
  },
  addButtonText: { color: '#3b82f6', fontWeight: '600', fontSize: 15 },
  submitButton: {
    backgroundColor: '#3b82f6',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    marginBottom: 24,
  },
  submitDisabled: { opacity: 0.5 },
  submitButtonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  liveTicker: { backgroundColor: '#1c1c1e', borderRadius: 10, padding: 12 },
  liveLabel: { color: '#ef4444', fontWeight: '700', fontSize: 11, letterSpacing: 2, marginBottom: 8 },
  liveItem: { color: '#9ca3af', fontSize: 12, marginBottom: 4 },
})
