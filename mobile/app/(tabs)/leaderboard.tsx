import { useState } from 'react'
import { ScrollView, View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useQuery } from '@tanstack/react-query'
import { useAuthStore } from '../../src/store/auth.store'
import { api } from '../../src/api/client'
import { C, SPORT } from '../../src/theme'

const SPORTS_LIST = [
  { slug: 'cricket',    name: 'Cricket',    emoji: '🏏' },
  { slug: 'football',   name: 'Football',   emoji: '⚽' },
  { slug: 'badminton',  name: 'Badminton',  emoji: '🏸' },
  { slug: 'basketball', name: 'Basketball', emoji: '🏀' },
]

const MEDALS = ['🥇', '🥈', '🥉']
const PODIUM_HEIGHTS = [100, 130, 80]   // silver | gold | bronze
const MEDAL_COLORS   = [C.silver, C.gold, C.bronze]

function ratingColor(r: number) {
  if (r >= 80) return C.amber
  if (r >= 65) return C.green
  if (r >= 50) return C.blue
  return C.t2
}

export default function LeaderboardScreen() {
  const { user } = useAuthStore()
  const [sport, setSport] = useState(SPORTS_LIST[0])
  const cfg = SPORT[sport.slug]

  const { data: raw, isLoading } = useQuery({
    queryKey: ['leaderboard', sport.slug],
    queryFn: () =>
      api.get('/leaderboards', { params: { sport: sport.slug } }).then(r => r.data),
  })

  const players: any[] = Array.isArray(raw) ? raw : (raw?.data ?? raw?.items ?? [])

  return (
    <SafeAreaView style={s.container} edges={['top']}>
      {/* Header */}
      <View style={s.header}>
        <Text style={s.eyebrow}>RANKINGS</Text>
        <Text style={s.title}>Leaderboard</Text>
      </View>

      {/* Sport tabs */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={s.tabsRow}
      >
        {SPORTS_LIST.map(sp => {
          const spCfg = SPORT[sp.slug]
          const active = sport.slug === sp.slug
          return (
            <TouchableOpacity
              key={sp.slug}
              style={[s.tab, active && {
                backgroundColor: spCfg.glow,
                borderColor: spCfg.color,
              }]}
              onPress={() => setSport(sp)}
              activeOpacity={0.75}
            >
              <Text style={{ fontSize: 16 }}>{sp.emoji}</Text>
              <Text style={[s.tabLabel, active && { color: spCfg.color }]}>{sp.name}</Text>
            </TouchableOpacity>
          )
        })}
      </ScrollView>

      <ScrollView showsVerticalScrollIndicator={false}>
        {isLoading ? (
          <View style={s.loading}>
            <ActivityIndicator color={cfg.color} size="large" />
          </View>
        ) : players.length === 0 ? (
          <View style={s.empty}>
            <Text style={{ fontSize: 56, marginBottom: 16 }}>{cfg.emoji}</Text>
            <Text style={s.emptyTitle}>No rankings yet</Text>
            <Text style={s.emptySub}>
              Play and complete {sport.name} matches{'\n'}to earn a rating and appear here.
            </Text>
          </View>
        ) : (
          <>
            {/* Podium — top 3 */}
            {players.length >= 3 && (
              <View style={s.podiumWrap}>
                {/* order: 2nd | 1st | 3rd */}
                {[players[1], players[0], players[2]].map((p, idx) => (
                  <PodiumSlot
                    key={p.user_id ?? idx}
                    player={p}
                    rank={[2, 1, 3][idx]}
                    height={PODIUM_HEIGHTS[idx]}
                    medalColor={MEDAL_COLORS[idx]}
                    sportColor={cfg.color}
                  />
                ))}
              </View>
            )}

            {/* Ranked list */}
            <View style={s.list}>
              {players.map((p: any, i: number) => (
                <PlayerRow
                  key={p.user_id ?? i}
                  rank={i + 1}
                  player={p}
                  isMe={p.user_id === user?.id}
                  sportColor={cfg.color}
                />
              ))}
            </View>
          </>
        )}
        <View style={{ height: 48 }} />
      </ScrollView>
    </SafeAreaView>
  )
}

function PodiumSlot({ player, rank, height, medalColor, sportColor }: {
  player: any; rank: number; height: number; medalColor: string; sportColor: string
}) {
  return (
    <View style={pd.slot}>
      <Text style={{ fontSize: 22, marginBottom: 4 }}>{MEDALS[rank - 1]}</Text>
      <View style={[pd.avatar, { borderColor: medalColor }]}>
        <Text style={pd.initial}>{player.name?.[0]?.toUpperCase() ?? '?'}</Text>
      </View>
      <Text style={pd.name} numberOfLines={1}>{player.name?.split(' ')[0] ?? '—'}</Text>
      <Text style={[pd.rating, { color: ratingColor(player.current_rating ?? 50) }]}>
        {Number(player.current_rating ?? 50).toFixed(1)}
      </Text>
      <View style={[pd.bar, { height, backgroundColor: medalColor + '1a', borderTopColor: medalColor }]}>
        <Text style={[pd.rankLabel, { color: medalColor }]}>#{rank}</Text>
      </View>
    </View>
  )
}

const pd = StyleSheet.create({
  slot:   { flex: 1, alignItems: 'center', gap: 3 },
  avatar: {
    width: 46, height: 46, borderRadius: 23,
    backgroundColor: C.s2, borderWidth: 2,
    justifyContent: 'center', alignItems: 'center',
    marginBottom: 4,
  },
  initial:   { color: C.white, fontSize: 18, fontWeight: '800' },
  name:      { color: C.t1, fontSize: 12, fontWeight: '700', textAlign: 'center', maxWidth: 72 },
  rating:    { fontSize: 19, fontWeight: '900', letterSpacing: -0.5 },
  bar:       { width: '100%', alignItems: 'center', justifyContent: 'flex-end', borderTopWidth: 1.5, borderRadius: 8, paddingBottom: 8 },
  rankLabel: { fontSize: 12, fontWeight: '800' },
})

function PlayerRow({ rank, player, isMe, sportColor }: {
  rank: number; player: any; isMe: boolean; sportColor: string
}) {
  return (
    <View style={[pr.row, isMe && pr.rowMe]}>
      <Text style={pr.rank}>
        {rank <= 3 ? MEDALS[rank - 1] : String(rank).padStart(2, ' ')}
      </Text>
      <View style={[pr.avatar, { borderColor: rank === 1 ? sportColor : C.b2 }]}>
        <Text style={pr.initial}>{player.name?.[0]?.toUpperCase() ?? '?'}</Text>
      </View>
      <View style={pr.info}>
        <Text style={pr.name}>
          {player.name}
          {isMe && <Text style={pr.you}> · you</Text>}
        </Text>
        <Text style={pr.sub}>{player.city ?? '—'} · {player.matches_played ?? 0} matches</Text>
      </View>
      <View style={pr.ratingWrap}>
        <Text style={[pr.rating, { color: ratingColor(player.current_rating ?? 50) }]}>
          {Number(player.current_rating ?? 50).toFixed(1)}
        </Text>
        <Text style={pr.rtgLabel}>RTG</Text>
      </View>
    </View>
  )
}

const pr = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: C.s1, borderRadius: 14, padding: 12,
    marginBottom: 6, borderWidth: 1, borderColor: C.b0,
  },
  rowMe: { backgroundColor: C.limeGlow, borderColor: C.lime + '4d' },
  rank:  { width: 28, color: C.t3, fontSize: 15, fontWeight: '800', textAlign: 'center' },
  avatar: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: C.s3, borderWidth: 1.5,
    justifyContent: 'center', alignItems: 'center',
  },
  initial:    { color: C.t1, fontSize: 15, fontWeight: '700' },
  info:       { flex: 1 },
  name:       { color: C.t1, fontSize: 14, fontWeight: '600' },
  you:        { color: C.lime, fontSize: 12, fontWeight: '700' },
  sub:        { color: C.t3, fontSize: 12, marginTop: 2 },
  ratingWrap: { alignItems: 'center' },
  rating:     { fontSize: 22, fontWeight: '900', letterSpacing: -0.5 },
  rtgLabel:   { color: C.t3, fontSize: 9, fontWeight: '700', letterSpacing: 1, marginTop: -2 },
})

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },

  header:  { paddingHorizontal: 22, paddingTop: 10, paddingBottom: 12 },
  eyebrow: { color: C.t3, fontSize: 11, fontWeight: '700', letterSpacing: 2, marginBottom: 4 },
  title:   { color: C.white, fontSize: 32, fontWeight: '800', letterSpacing: -0.5 },

  tabsRow: { paddingHorizontal: 16, gap: 8, paddingBottom: 12 },
  tab: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    paddingHorizontal: 14, paddingVertical: 9, borderRadius: 22,
    backgroundColor: C.s2, borderWidth: 1, borderColor: C.b1,
  },
  tabLabel: { color: C.t2, fontSize: 13, fontWeight: '600' },

  loading:    { paddingVertical: 80, alignItems: 'center' },
  empty:      { alignItems: 'center', paddingVertical: 64, paddingHorizontal: 40 },
  emptyTitle: { color: C.t1, fontSize: 20, fontWeight: '700', marginBottom: 8 },
  emptySub:   { color: C.t3, fontSize: 14, textAlign: 'center', lineHeight: 22 },

  podiumWrap: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 22,
    paddingTop: 28,
    paddingBottom: 8,
    gap: 8,
  },
  list: { paddingHorizontal: 16, paddingTop: 12 },
})
