import { useMemo } from 'react'
import { ScrollView, View, Text, StyleSheet, TouchableOpacity, RefreshControl } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { useAuthStore } from '../../src/store/auth.store'
import { api } from '../../src/api/client'
import { C } from '../../src/theme'
import { FormCard } from '../../src/components/FormCard/FormCard'

const ACTION_META: Record<string, { label: string; color: string; emoji: string }> = {
  match_completed:    { label: 'Match completed',    color: C.lime,  emoji: '🏆' },
  achievement_earned: { label: 'Achievement earned', color: C.amber, emoji: '⭐' },
  rating_updated:     { label: 'Rating updated',     color: C.lime,  emoji: '📈' },
}

function timeGreeting() {
  const h = new Date().getHours()
  if (h < 12) return 'GOOD MORNING'
  if (h < 17) return 'GOOD AFTERNOON'
  return 'GOOD EVENING'
}

function todayStr() {
  return new Date()
    .toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })
    .toUpperCase()
}

export default function FeedScreen() {
  const { user } = useAuthStore()
  // Creating a match makes you its referee (POST /matches stamps referee_id from
  // the caller), so the entry point has to match the endpoint's referee/admin gate.
  // It was open to everyone, which meant a player filled the form, two orphan teams
  // were created, and only then did the match POST 403.
  const canCreateMatch = user?.role === 'referee' || user?.role === 'admin'
  const router = useRouter()
  const firstName = user?.name?.split(' ')[0] ?? 'Player'

  // The player's sport profiles → pick their primary sport (most matches, then rating)
  const { data: profile } = useQuery({
    queryKey: ['user-profile', user?.id],
    enabled: !!user,
    queryFn: () => (user ? api.get(`/users/${user.id}`).then(r => r.data).catch(() => null) : null),
  })

  const primarySport: string | null = useMemo(() => {
    const profiles: any[] = profile?.sport_profiles ?? []
    if (profiles.length === 0) return null
    return [...profiles].sort(
      (a, b) =>
        (b.matches_played ?? 0) - (a.matches_played ?? 0) ||
        Number(b.current_rating ?? 0) - Number(a.current_rating ?? 0)
    )[0].sport_slug
  }, [profile])

  const { data: feedRaw, refetch, isRefetching } = useQuery({
    queryKey: ['feed', user?.id],
    queryFn: () => (user ? api.get(`/users/${user.id}/feed`).then(r => r.data) : []),
    enabled: !!user,
  })

  const feed: any[] = Array.isArray(feedRaw)
    ? feedRaw
    : (feedRaw?.data ?? feedRaw?.items ?? [])

  return (
    <SafeAreaView style={s.container} edges={['top']}>
      {/* Header */}
      <View style={s.header}>
        <Text style={s.logo}>AllSports</Text>
        <TouchableOpacity style={s.notifBtn} activeOpacity={0.7}>
          <Text style={{ fontSize: 16 }}>🔔</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={C.lime} />
        }
      >
        {/* Hero */}
        <View style={s.hero}>
          <Text style={s.eyebrow}>{timeGreeting()} · {todayStr()}</Text>
          <Text style={s.heroName}>Hey {firstName}.</Text>
          <Text style={s.heroSub}>Every match builds{'\n'}your legacy.</Text>
          {canCreateMatch && (
            <TouchableOpacity style={s.cta} activeOpacity={0.88} onPress={() => router.push('/create-match')}>
              <Text style={s.ctaText}>+ Create a Match</Text>
              <Text style={s.ctaArrow}>→</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Your form snapshot → tap to open the in-depth tracker */}
        {primarySport && (
          <>
            <Text style={s.sectionLabel}>YOUR FORM</Text>
            <FormCard
              userId={user!.id}
              sportSlug={primarySport}
              onPress={() => router.push({ pathname: '/form-tracker', params: { sport: primarySport } })}
            />
          </>
        )}

        {/* Activity */}
        <Text style={s.sectionLabel}>ACTIVITY</Text>
        {feed.length === 0 ? (
          <EmptyFeed />
        ) : (
          <View style={s.feedList}>
            {feed.map((item: any, i: number) => (
              <FeedCard key={i} item={item} />
            ))}
          </View>
        )}

        <View style={{ height: 48 }} />
      </ScrollView>
    </SafeAreaView>
  )
}

function EmptyFeed() {
  return (
    <View style={s.emptyWrap}>
      <Text style={s.emptyEmoji}>🏟️</Text>
      <Text style={s.emptyTitle}>No activity yet</Text>
      <Text style={s.emptySub}>
        Create your first match and start building your legacy.
      </Text>
    </View>
  )
}

function FeedCard({ item }: { item: any }) {
  const meta = ACTION_META[item.action_type] ?? {
    label: item.action_type, color: C.blue, emoji: '📌',
  }
  const diffDays = Math.floor((Date.now() - new Date(item.created_at).getTime()) / 86_400_000)
  const timeStr = diffDays === 0 ? 'Today' : diffDays === 1 ? 'Yesterday' : `${diffDays}d ago`

  return (
    <View style={s.feedItem}>
      <View style={[s.feedDot, { backgroundColor: meta.color }]} />
      <View style={s.feedBody}>
        <Text style={s.feedAction}>{meta.label}</Text>
        <Text style={s.feedDate}>{timeStr}</Text>
      </View>
      <Text style={{ fontSize: 18 }}>{meta.emoji}</Text>
    </View>
  )
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },

  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 22,
    paddingVertical: 12,
  },
  logo: { color: C.white, fontSize: 20, fontWeight: '800', letterSpacing: -0.3 },
  notifBtn: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: C.s2, borderWidth: 1, borderColor: C.b1,
    justifyContent: 'center', alignItems: 'center',
  },

  // Hero
  hero: { paddingHorizontal: 22, paddingTop: 12, paddingBottom: 30 },
  eyebrow: { color: C.lime, fontSize: 11, fontWeight: '700', letterSpacing: 1.8, marginBottom: 14, opacity: 0.7 },
  heroName: {
    color: C.white, fontSize: 46, fontWeight: '900',
    letterSpacing: -2, lineHeight: 50, marginBottom: 10,
  },
  heroSub: { color: C.t2, fontSize: 16, lineHeight: 24, marginBottom: 28 },
  cta: {
    backgroundColor: C.lime, borderRadius: 14,
    paddingHorizontal: 22, paddingVertical: 16,
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
  },
  ctaText:  { color: C.limeText, fontSize: 16, fontWeight: '800' },
  ctaArrow: { color: C.limeText, fontSize: 20, fontWeight: '700', opacity: 0.6 },

  sectionLabel: {
    color: C.t3, fontSize: 11, fontWeight: '700', letterSpacing: 2,
    marginHorizontal: 22, marginBottom: 12, marginTop: 6,
  },

  // Feed
  feedList: { paddingHorizontal: 16, gap: 6 },
  feedItem: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: C.s1, borderRadius: 13, padding: 14,
    borderWidth: 1, borderColor: C.b0,
  },
  feedDot:    { width: 8, height: 8, borderRadius: 4 },
  feedBody:   { flex: 1 },
  feedAction: { color: C.t1, fontSize: 14, fontWeight: '500' },
  feedDate:   { color: C.t3, fontSize: 12, marginTop: 2 },

  emptyWrap:  { alignItems: 'center', paddingVertical: 56, paddingHorizontal: 40 },
  emptyEmoji: { fontSize: 52, marginBottom: 16 },
  emptyTitle: { color: C.t1, fontSize: 20, fontWeight: '700', marginBottom: 8 },
  emptySub:   { color: C.t3, fontSize: 14, textAlign: 'center', lineHeight: 22 },
})
