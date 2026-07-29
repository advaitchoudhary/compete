/**
 * AchievementCard — Strava-style shareable milestone card.
 * Use react-native-view-shot to capture as image for Instagram sharing.
 */

import React, { useRef } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, Share } from 'react-native'
import ViewShot from 'react-native-view-shot'

interface Props {
  type: string
  sportName: string
  playerName: string
  data: Record<string, unknown>
  earnedAt: string
}

const ACHIEVEMENT_META: Record<string, { emoji: string; title: string; description: (data: Record<string, unknown>) => string }> = {
  first_match:    { emoji: '🎯', title: 'First Match', description: () => 'Played your first competitive match!' },
  first_win:      { emoji: '🏆', title: 'First Win', description: () => 'Won your first competitive match!' },
  matches_10:     { emoji: '🔟', title: '10 Matches', description: () => 'Played 10 competitive matches!' },
  matches_50:     { emoji: '🌟', title: '50 Matches', description: () => 'Half century! 50 matches played.' },
  matches_100:    { emoji: '💯', title: '100 Matches', description: () => 'Century! 100 matches played.' },
  wins_10:        { emoji: '🎖️', title: '10 Wins', description: () => 'Racked up 10 wins!' },
  rating_60:      { emoji: '📈', title: 'Rising Star', description: (d) => `Rating hit ${d.rating}!` },
  rating_70:      { emoji: '⚡', title: 'Sharp', description: (d) => `Rating hit ${d.rating}!` },
  rating_75:      { emoji: '🔥', title: 'On Fire', description: (d) => `Rating hit ${d.rating}!` },
  rating_80:      { emoji: '💎', title: 'Elite Player', description: (d) => `Rating reached ${d.rating}!` },
  rating_85:      { emoji: '🚀', title: 'Top Tier', description: (d) => `Rating at ${d.rating}!` },
  rating_90:      { emoji: '👑', title: 'Legend', description: (d) => `Rating at ${d.rating}!` },
}

export function AchievementCard({ type, sportName, playerName, data, earnedAt }: Props) {
  const shotRef = useRef<ViewShot>(null)
  const meta = ACHIEVEMENT_META[type] ?? { emoji: '🏅', title: type, description: () => '' }

  const shareCard = async () => {
    try {
      const uri = await (shotRef.current as any)?.capture()
      await Share.share({
        url: uri,
        message: `${meta.emoji} I just earned "${meta.title}" on AllSports! ${meta.description(data)}`,
      })
    } catch (e) {
      console.warn('Share failed:', e)
    }
  }

  return (
    <TouchableOpacity onPress={shareCard} activeOpacity={0.85}>
      <ViewShot ref={shotRef} options={{ format: 'jpg', quality: 0.95 }}>
        <View style={styles.card}>
          {/* Background gradient suggestion — use LinearGradient in production */}
          <View style={styles.gradientBg} />

          <Text style={styles.emoji}>{meta.emoji}</Text>
          <Text style={styles.title}>{meta.title}</Text>
          <Text style={styles.description}>{meta.description(data)}</Text>

          <View style={styles.divider} />

          <View style={styles.footer}>
            <View>
              <Text style={styles.playerName}>{playerName}</Text>
              <Text style={styles.sportName}>{sportName.toUpperCase()}</Text>
            </View>
            <View style={styles.badge}>
              <Text style={styles.badgeText}>AllSports</Text>
            </View>
          </View>

          <Text style={styles.tapToShare}>Tap to share →</Text>
        </View>
      </ViewShot>
    </TouchableOpacity>
  )
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#111827',
    borderRadius: 20,
    padding: 24,
    borderWidth: 1,
    borderColor: '#1f2937',
    overflow: 'hidden',
    position: 'relative',
  },
  gradientBg: {
    position: 'absolute',
    top: -60,
    right: -60,
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: '#1d4ed8',
    opacity: 0.15,
  },
  emoji: { fontSize: 52, marginBottom: 12 },
  title: { color: '#fff', fontSize: 26, fontWeight: '800', marginBottom: 6 },
  description: { color: '#9ca3af', fontSize: 15, lineHeight: 22, marginBottom: 20 },
  divider: { height: 1, backgroundColor: '#1f2937', marginBottom: 16 },
  footer: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  playerName: { color: '#fff', fontSize: 16, fontWeight: '700' },
  sportName: { color: '#6b7280', fontSize: 11, letterSpacing: 1.5, marginTop: 2 },
  badge: {
    backgroundColor: '#1d4ed8',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 20,
  },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  tapToShare: { color: '#4b5563', fontSize: 11, textAlign: 'right', marginTop: 12 },
})
