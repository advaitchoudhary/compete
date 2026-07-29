/**
 * FormCard — compact form snapshot for the feed.
 * Surfaces a player's headline Elo + recent-match form bars for one sport,
 * and acts as the entry point into the in-depth Form Tracker.
 */
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../api/client'
import { C, FONT, SPACE, RADIUS, SPORT, ratingTone, ELEV } from '../../theme'

interface Props {
  userId: string
  sportSlug: string
  onPress: () => void
}

export function FormCard({ userId, sportSlug, onPress }: Props) {
  // Shares the cache key the profile screen uses → no duplicate fetch.
  const { data, isLoading } = useQuery({
    queryKey: ['user-stats', userId, sportSlug],
    queryFn: () => api.get(`/users/${userId}/stats/${sportSlug}`).then((r) => r.data).catch(() => null),
  })

  const sport = SPORT[sportSlug] ?? SPORT.football

  if (isLoading) {
    return (
      <View style={[s.card, { borderColor: sport.color + '33' }]}>
        <ActivityIndicator color={C.lime} />
      </View>
    )
  }
  if (!data || data.current_rating == null) return null

  const rating = Number(data.current_rating)
  const tone = ratingTone(rating)
  const history: any[] = data.rating_history ?? []
  const lastDelta = history[0] ? Number(history[0].delta) : null
  const formRating = data.form_rating != null ? Number(data.form_rating).toFixed(1) : null

  // Oldest → newest, last 7 matches
  const trail = [...history].slice(0, 7).reverse()

  return (
    <TouchableOpacity activeOpacity={0.85} onPress={onPress} style={[s.card, { borderColor: sport.color + '33' }, ELEV.card]}>
      <View pointerEvents="none" style={[s.glow, { backgroundColor: sport.glow }]} />

      {/* top: sport + headline rating */}
      <View style={s.topRow}>
        <View style={s.sportTag}>
          <Text style={s.sportEmoji}>{sport.emoji}</Text>
          <Text style={s.sportName}>{sport.name.toUpperCase()}</Text>
        </View>
        {lastDelta !== null && (
          <View style={[s.deltaChip, { backgroundColor: lastDelta >= 0 ? C.limeGlow : 'rgba(239,68,68,0.12)' }]}>
            <Text style={[s.deltaText, { color: lastDelta >= 0 ? C.lime : C.red }]}>
              {lastDelta >= 0 ? '▲' : '▼'} {Math.abs(lastDelta).toFixed(1)}
            </Text>
          </View>
        )}
      </View>

      <View style={s.ratingRow}>
        <Text style={[s.rating, { color: tone.color, textShadowColor: tone.color }]}>{rating.toFixed(1)}</Text>
        <View style={{ flex: 1 }}>
          <Text style={s.eloLabel}>OVERALL ELO</Text>
          <Text style={[s.toneLabel, { color: tone.color }]}>{tone.label}</Text>
        </View>
        <View style={s.miniStat}>
          <Text style={s.miniVal}>{formRating ?? '—'}</Text>
          <Text style={s.miniLabel}>FORM</Text>
        </View>
      </View>

      {/* form bars */}
      {trail.length > 0 && (
        <View style={s.formRow}>
          {trail.map((h, i) => {
            const v = Number(h.performance_score) // 0–100
            const fill = Math.max(0.12, Math.min(1, v / 100))
            return (
              <View key={i} style={s.formTrack}>
                <View style={[s.formFill, { height: `${fill * 100}%`, backgroundColor: ratingTone(v).color }]} />
              </View>
            )
          })}
        </View>
      )}

      <View style={s.footer}>
        <Text style={s.footerText}>View form tracker</Text>
        <Text style={[s.footerArrow, { color: sport.color }]}>→</Text>
      </View>
    </TouchableOpacity>
  )
}

const s = StyleSheet.create({
  card: {
    backgroundColor: C.s1, borderRadius: RADIUS.lg, borderWidth: 1,
    padding: SPACE.lg, marginHorizontal: 16, overflow: 'hidden',
  },
  glow: { position: 'absolute', top: -80, left: -40, right: -40, height: 160, borderRadius: 160 },

  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sportTag: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  sportEmoji: { fontSize: 16 },
  sportName: { color: C.t2, fontSize: 11, fontFamily: FONT.bold, letterSpacing: 2 },
  deltaChip: { borderRadius: RADIUS.pill, paddingHorizontal: 10, paddingVertical: 3 },
  deltaText: { fontSize: 12, fontFamily: FONT.bold, letterSpacing: 0.5 },

  ratingRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.lg, marginTop: SPACE.md },
  rating: {
    fontSize: 60, fontFamily: FONT.black, letterSpacing: -3, lineHeight: 64,
    textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 20,
  },
  eloLabel: { color: C.t3, fontSize: 10, fontFamily: FONT.bold, letterSpacing: 2 },
  toneLabel: { fontSize: 14, fontFamily: FONT.black, letterSpacing: 1.5, marginTop: 3 },
  miniStat: { alignItems: 'center' },
  miniVal: { color: C.t1, fontSize: 22, fontFamily: FONT.black, letterSpacing: -0.5 },
  miniLabel: { color: C.t3, fontSize: 9, fontFamily: FONT.bold, letterSpacing: 1.2, marginTop: 2 },

  formRow: { flexDirection: 'row', gap: SPACE.sm, height: 44, alignItems: 'flex-end', marginTop: SPACE.lg },
  formTrack: {
    flex: 1, height: '100%', backgroundColor: C.s3, borderRadius: RADIUS.sm,
    justifyContent: 'flex-end', overflow: 'hidden',
  },
  formFill: { width: '100%', borderRadius: RADIUS.sm },

  footer: {
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 6,
    marginTop: SPACE.lg, paddingTop: SPACE.md, borderTopWidth: 1, borderTopColor: C.b1,
  },
  footerText: { color: C.t2, fontSize: 13, fontFamily: FONT.semibold },
  footerArrow: { fontSize: 16, fontFamily: FONT.bold },
})
