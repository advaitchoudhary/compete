/**
 * Form Tracker — the in-depth view behind the feed's FormCard.
 * Sport selector → full ProfileHero jumbotron → a per-match history list
 * (performance score, Elo delta, date) where each row opens that match.
 */
import { useMemo, useState } from 'react'
import { ScrollView, View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useQuery } from '@tanstack/react-query'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useAuthStore } from '../src/store/auth.store'
import { api } from '../src/api/client'
import { C, SPORT, SPACE, RADIUS, FONT, ratingTone, TIER } from '../src/theme'
import { ProfileHero } from '../src/components/ProfileHero/ProfileHero'

const ALL_SPORTS = ['football', 'cricket', 'badminton', 'basketball'] as const

export default function FormTrackerScreen() {
  const { user } = useAuthStore()
  const router = useRouter()
  const params = useLocalSearchParams<{ sport?: string }>()
  const [sport, setSport] = useState<string>(params.sport ?? 'football')

  // Which sports the player actually has a profile in (drives the selector).
  const { data: profile } = useQuery({
    queryKey: ['user-profile', user?.id],
    enabled: !!user,
    queryFn: () => api.get(`/users/${user!.id}`).then((r) => r.data).catch(() => null),
  })
  const playedSports: string[] = useMemo(() => {
    const slugs = (profile?.sport_profiles ?? []).map((p: any) => p.sport_slug)
    return ALL_SPORTS.filter((s) => slugs.includes(s))
  }, [profile])
  const selector = playedSports.length > 0 ? playedSports : [sport]

  const { data, isLoading } = useQuery({
    queryKey: ['user-stats', user?.id, sport],
    enabled: !!user,
    queryFn: () => api.get(`/users/${user!.id}/stats/${sport}`).then((r) => r.data).catch(() => null),
  })

  const history: any[] = data?.rating_history ?? []

  return (
    <SafeAreaView style={s.container} edges={['top']}>
      {/* header */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} activeOpacity={0.7}>
          <Text style={s.backArrow}>←</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.eyebrow}>FORM TRACKER</Text>
        </View>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 56 }}>
        {/* sport selector */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={s.selectorWrap}
          contentContainerStyle={{ gap: SPACE.sm, paddingHorizontal: SPACE.xl }}
        >
          {selector.map((sp) => {
            const cfg = SPORT[sp] ?? SPORT.football
            const active = sp === sport
            return (
              <TouchableOpacity
                key={sp}
                activeOpacity={0.8}
                onPress={() => setSport(sp)}
                style={[s.chip, active && { borderColor: cfg.color, backgroundColor: cfg.glow }]}
              >
                <Text style={s.chipEmoji}>{cfg.emoji}</Text>
                <Text style={[s.chipText, { color: active ? cfg.color : C.t2 }]}>{cfg.name}</Text>
              </TouchableOpacity>
            )
          })}
        </ScrollView>

        {isLoading ? (
          <ActivityIndicator color={C.lime} style={{ marginTop: 60 }} />
        ) : data && data.current_rating != null ? (
          <>
            <View style={{ paddingHorizontal: SPACE.xl }}>
              <ProfileHero
                sportSlug={sport}
                currentRating={Number(data.current_rating)}
                formRating={data.form_rating != null ? Number(data.form_rating) : null}
                matchesPlayed={data.matches_played ?? 0}
                wins={data.wins ?? 0}
                tierRatings={data.tier_ratings ?? []}
                ratingHistory={history}
              />
            </View>

            {/* per-match history */}
            <Text style={s.sectionLabel}>RECENT MATCHES</Text>
            {history.length === 0 ? (
              <View style={s.empty}>
                <Text style={s.emptySub}>No rated matches yet for {SPORT[sport]?.name ?? sport}.</Text>
              </View>
            ) : (
              <View style={s.list}>
                {history.map((h, i) => (
                  <MatchRow
                    key={h.match_id ?? i}
                    entry={h}
                    onPress={() => h.match_id && router.push(`/match/${h.match_id}`)}
                  />
                ))}
              </View>
            )}
          </>
        ) : (
          <View style={s.empty}>
            <Text style={s.emptyEmoji}>{SPORT[sport]?.emoji ?? '🏅'}</Text>
            <Text style={s.emptyTitle}>No {SPORT[sport]?.name ?? sport} rating yet</Text>
            <Text style={s.emptySub}>Play a match to start tracking your form.</Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  )
}

function MatchRow({ entry, onPress }: { entry: any; onPress: () => void }) {
  const perf = Number(entry.performance_score) // 0–100
  const star = (perf / 10).toFixed(1)          // 0–10
  const delta = entry.delta != null ? Number(entry.delta) : null
  const ratingAfter = entry.rating_after != null ? Number(entry.rating_after).toFixed(1) : null
  const tone = ratingTone(perf)
  const tierCfg = entry.tier ? TIER[entry.tier] : null
  const date = entry.created_at
    ? new Date(entry.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
    : ''

  return (
    <TouchableOpacity activeOpacity={0.8} onPress={onPress} style={s.row}>
      {/* performance badge */}
      <View style={[s.perfBadge, { borderColor: tone.color + '66', backgroundColor: tone.color + '14' }]}>
        <Text style={[s.perfVal, { color: tone.color }]}>{star}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <View style={s.titleRow}>
          <Text style={s.rowTitle}>{tone.label}</Text>
          {tierCfg && (
            <View style={[s.tierPill, { borderColor: tierCfg.color + '66', backgroundColor: tierCfg.glow }]}>
              <Text style={[s.tierPillText, { color: tierCfg.color }]}>{tierCfg.label.toUpperCase()}</Text>
            </View>
          )}
        </View>
        <Text style={s.rowSub}>{date}{ratingAfter != null ? `  ·  Elo ${ratingAfter}` : ''}</Text>
      </View>
      {delta !== null && (
        <Text style={[s.rowDelta, { color: delta >= 0 ? C.lime : C.red }]}>
          {delta >= 0 ? '▲' : '▼'} {Math.abs(delta).toFixed(1)}
        </Text>
      )}
    </TouchableOpacity>
  )
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: SPACE.md,
    paddingHorizontal: SPACE.lg, paddingTop: SPACE.sm, paddingBottom: SPACE.md,
  },
  backBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: C.s2, borderWidth: 1, borderColor: C.b1,
    justifyContent: 'center', alignItems: 'center',
  },
  backArrow: { color: C.t1, fontSize: 20, fontFamily: FONT.bold, lineHeight: 22 },
  eyebrow: { color: C.t3, fontSize: 11, fontFamily: FONT.bold, letterSpacing: 2 },

  selectorWrap: { marginBottom: SPACE.lg },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: SPACE.lg, paddingVertical: SPACE.sm,
    borderRadius: RADIUS.pill, borderWidth: 1, borderColor: C.b1, backgroundColor: C.s1,
  },
  chipEmoji: { fontSize: 14 },
  chipText: { fontSize: 13, fontFamily: FONT.semibold },

  sectionLabel: {
    color: C.t3, fontSize: 11, fontFamily: FONT.bold, letterSpacing: 2,
    marginHorizontal: SPACE.xl, marginTop: SPACE.xl, marginBottom: SPACE.md,
  },
  list: { paddingHorizontal: 16, gap: 8 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: SPACE.md,
    backgroundColor: C.s1, borderRadius: RADIUS.md, padding: SPACE.md,
    borderWidth: 1, borderColor: C.b0,
  },
  perfBadge: {
    width: 46, height: 46, borderRadius: RADIUS.md, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  perfVal: { fontSize: 18, fontFamily: FONT.black, letterSpacing: -0.5 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  rowTitle: { color: C.t1, fontSize: 14, fontFamily: FONT.bold, letterSpacing: 0.5 },
  tierPill: { borderWidth: 1, borderRadius: RADIUS.pill, paddingHorizontal: 8, paddingVertical: 2 },
  tierPillText: { fontSize: 9, fontFamily: FONT.bold, letterSpacing: 1 },
  rowSub: { color: C.t3, fontSize: 12, fontFamily: FONT.regular, marginTop: 2 },
  rowDelta: { fontSize: 14, fontFamily: FONT.bold },

  empty: { alignItems: 'center', paddingVertical: 48, gap: SPACE.sm },
  emptyEmoji: { fontSize: 44, opacity: 0.5 },
  emptyTitle: { color: C.t1, fontSize: 17, fontFamily: FONT.bold },
  emptySub: { color: C.t3, fontSize: 13, fontFamily: FONT.regular },
})
