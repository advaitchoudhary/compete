/**
 * RatingCard — Sofascore-inspired player rating display.
 * Shows current rating, form indicator, and match-by-match history sparkline.
 */

import React from 'react'
import { View, Text, StyleSheet } from 'react-native'

interface Props {
  sportName: string
  currentRating: number
  formRating: number | null
  matchesPlayed: number
  wins: number
  ratingHistory: Array<{ rating_after: number; delta: number }>
}

function getRatingColor(rating: number): string {
  if (rating >= 85) return '#f59e0b'  // gold
  if (rating >= 70) return '#22c55e'  // green
  if (rating >= 55) return '#3b82f6'  // blue
  if (rating >= 40) return '#f97316'  // orange
  return '#ef4444'                      // red
}

function getRatingLabel(rating: number): string {
  if (rating >= 90) return 'Elite'
  if (rating >= 80) return 'Excellent'
  if (rating >= 70) return 'Good'
  if (rating >= 60) return 'Average'
  if (rating >= 50) return 'Below Avg'
  return 'Beginner'
}

export function RatingCard({ sportName, currentRating, formRating, matchesPlayed, wins, ratingHistory }: Props) {
  const ratingColor = getRatingColor(currentRating)
  const formColor = formRating ? getRatingColor(formRating) : '#6b7280'
  const winRate = matchesPlayed > 0 ? Math.round((wins / matchesPlayed) * 100) : 0

  return (
    <View style={styles.card}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.sportName}>{sportName.toUpperCase()}</Text>
        <Text style={styles.label}>{getRatingLabel(currentRating)}</Text>
      </View>

      {/* Main rating display */}
      <View style={styles.ratingRow}>
        <View style={[styles.ratingCircle, { borderColor: ratingColor }]}>
          <Text style={[styles.ratingNumber, { color: ratingColor }]}>
            {currentRating.toFixed(0)}
          </Text>
          <Text style={styles.ratingSubLabel}>RATING</Text>
        </View>

        {/* Stats column */}
        <View style={styles.statsCol}>
          <StatPill label="FORM" value={formRating?.toFixed(0) ?? '–'} color={formColor} />
          <StatPill label="MATCHES" value={matchesPlayed.toString()} color="#9ca3af" />
          <StatPill label="WIN RATE" value={`${winRate}%`} color="#9ca3af" />
        </View>
      </View>

      {/* Mini sparkline of last 10 ratings */}
      {ratingHistory.length > 0 && (
        <View style={styles.sparklineContainer}>
          <Text style={styles.sparklineLabel}>LAST {ratingHistory.length} MATCHES</Text>
          <View style={styles.sparkline}>
            {[...ratingHistory].reverse().map((h, i) => {
              const barHeight = Math.max(4, (h.rating_after / 100) * 40)
              return (
                <View
                  key={i}
                  style={[
                    styles.sparklineBar,
                    {
                      height: barHeight,
                      backgroundColor: getRatingColor(h.rating_after),
                    },
                  ]}
                />
              )
            })}
          </View>
          <View style={styles.deltaRow}>
            {[...ratingHistory].reverse().map((h, i) => (
              <Text
                key={i}
                style={[styles.deltaText, { color: h.delta >= 0 ? '#22c55e' : '#ef4444' }]}
              >
                {h.delta >= 0 ? '+' : ''}{h.delta.toFixed(1)}
              </Text>
            ))}
          </View>
        </View>
      )}
    </View>
  )
}

function StatPill({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={styles.statPill}>
      <Text style={styles.statPillLabel}>{label}</Text>
      <Text style={[styles.statPillValue, { color }]}>{value}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#1c1c1e',
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  sportName: { color: '#6b7280', fontSize: 11, fontWeight: '700', letterSpacing: 1.5 },
  label: { color: '#9ca3af', fontSize: 11, fontWeight: '600' },
  ratingRow: { flexDirection: 'row', alignItems: 'center', gap: 20, marginBottom: 16 },
  ratingCircle: {
    width: 90,
    height: 90,
    borderRadius: 45,
    borderWidth: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ratingNumber: { fontSize: 32, fontWeight: '800', lineHeight: 36 },
  ratingSubLabel: { fontSize: 9, color: '#6b7280', letterSpacing: 2, marginTop: 2 },
  statsCol: { flex: 1, gap: 8 },
  statPill: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: '#2c2c2e',
    borderRadius: 8,
  },
  statPillLabel: { color: '#6b7280', fontSize: 11, fontWeight: '600', letterSpacing: 1 },
  statPillValue: { fontSize: 13, fontWeight: '700' },
  sparklineContainer: { marginTop: 4 },
  sparklineLabel: { color: '#4b5563', fontSize: 9, letterSpacing: 1.5, marginBottom: 6 },
  sparkline: { flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 44 },
  sparklineBar: { flex: 1, borderRadius: 2, minWidth: 6 },
  deltaRow: { flexDirection: 'row', gap: 3, marginTop: 4 },
  deltaText: { flex: 1, fontSize: 8, textAlign: 'center' },
})
