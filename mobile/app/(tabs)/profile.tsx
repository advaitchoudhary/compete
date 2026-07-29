import { useState } from 'react'
import { ScrollView, View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { useAuthStore } from '../../src/store/auth.store'
import { api } from '../../src/api/client'
import { C, SPORT, SPACE, RADIUS, FONT } from '../../src/theme'
import { ProfileHero } from '../../src/components/ProfileHero/ProfileHero'

const SPORTS = ['football', 'cricket', 'badminton', 'basketball'] as const

export default function ProfileScreen() {
  const { user, clearAuth } = useAuthStore()
  const router = useRouter()
  const [sport, setSport] = useState<(typeof SPORTS)[number]>('football')

  const { data, isLoading } = useQuery({
    queryKey: ['user-stats', user?.id, sport],
    enabled: !!user,
    queryFn: () =>
      api.get(`/users/${user!.id}/stats/${sport}`).then((r) => r.data).catch(() => null),
  })

  return (
    <SafeAreaView style={s.container} edges={['top']}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 56 }}>
        {/* header */}
        <View style={s.header}>
          <Text style={s.title}>PROFILE</Text>
          <TouchableOpacity style={s.logoutBtn} activeOpacity={0.75} onPress={() => { clearAuth(); router.replace('/auth') }}>
            <Text style={s.logoutText}>Log out</Text>
          </TouchableOpacity>
        </View>

        {/* identity */}
        <View style={s.idRow}>
          <View style={s.avatar}>
            <Text style={s.avatarText}>{user?.name?.[0]?.toUpperCase() ?? '?'}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.userName} numberOfLines={1}>{user?.name ?? '—'}</Text>
            <Text style={s.userMeta}>
              {user?.username ? `@${user.username}  ·  ` : ''}📍 {user?.city ?? 'India'}
            </Text>
          </View>
        </View>

        {/* referee / admin status */}
        {user && <RefereeStatus />}

        {/* sport selector */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={s.selector}
          contentContainerStyle={{ gap: SPACE.sm, paddingHorizontal: SPACE.xl }}
        >
          {SPORTS.map((sp) => {
            const cfg = SPORT[sp]
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

        {/* hero */}
        <View style={s.heroWrap}>
          {isLoading ? (
            <ActivityIndicator color={C.lime} style={{ marginTop: 60 }} />
          ) : data && data.current_rating != null ? (
            <ProfileHero
              sportSlug={sport}
              currentRating={Number(data.current_rating)}
              formRating={data.form_rating != null ? Number(data.form_rating) : null}
              matchesPlayed={data.matches_played ?? 0}
              wins={data.wins ?? 0}
              tierRatings={data.tier_ratings ?? []}
              ratingHistory={data.rating_history ?? []}
            />
          ) : (
            <View style={s.empty}>
              <Text style={s.emptyEmoji}>{SPORT[sport].emoji}</Text>
              <Text style={s.emptyTitle}>No {SPORT[sport].name} rating yet</Text>
              <Text style={s.emptySub}>Play a match to earn your first Elo.</Text>
            </View>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}

// ─── Referee / admin status card (the application flow entry point) ───────────
function RefereeStatus() {
  const router = useRouter()
  const { data } = useQuery({
    queryKey: ['referee-me'],
    queryFn: () => api.get('/referee/me').then((r) => r.data).catch(() => null),
  })
  if (!data) return null

  const role: string = data.role
  const appStatus: string | undefined = data.application?.status
  const tier: string | undefined = data.referee_tier

  // Admin → link to review panel
  if (role === 'admin') {
    return (
      <TouchableOpacity style={[rs.card, { borderColor: C.gold + '55' }]} activeOpacity={0.85} onPress={() => router.push('/admin')}>
        <Text style={rs.emoji}>🛡️</Text>
        <View style={{ flex: 1 }}>
          <Text style={[rs.title, { color: C.gold }]}>ADMIN</Text>
          <Text style={rs.sub}>Review referee applications</Text>
        </View>
        <Text style={[rs.arrow, { color: C.gold }]}>→</Text>
      </TouchableOpacity>
    )
  }

  // Approved referee
  if (role === 'referee') {
    return (
      <View style={[rs.card, { borderColor: C.blue + '55' }]}>
        <Text style={rs.emoji}>🦓</Text>
        <View style={{ flex: 1 }}>
          <Text style={[rs.title, { color: C.blue }]}>REFEREE · {(tier ?? 'amateur').replace('_', '-').toUpperCase()}</Text>
          <Text style={rs.sub}>You can create & officiate matches at this tier</Text>
        </View>
      </View>
    )
  }

  // Pending application
  if (appStatus === 'pending') {
    return (
      <View style={[rs.card, { borderColor: C.amber + '55' }]}>
        <Text style={rs.emoji}>⏳</Text>
        <View style={{ flex: 1 }}>
          <Text style={[rs.title, { color: C.amber }]}>APPLICATION PENDING</Text>
          <Text style={rs.sub}>An admin is reviewing your referee application</Text>
        </View>
      </View>
    )
  }

  // Plain player → CTA to apply
  return (
    <TouchableOpacity style={[rs.card, { borderColor: C.lime + '55', backgroundColor: C.limeGlow }]} activeOpacity={0.85} onPress={() => router.push('/referee-apply')}>
      <Text style={rs.emoji}>🦓</Text>
      <View style={{ flex: 1 }}>
        <Text style={[rs.title, { color: C.lime }]}>BECOME A REFEREE</Text>
        <Text style={rs.sub}>Apply to create & officiate matches</Text>
      </View>
      <Text style={[rs.arrow, { color: C.lime }]}>→</Text>
    </TouchableOpacity>
  )
}

const rs = StyleSheet.create({
  card: {
    flexDirection: 'row', alignItems: 'center', gap: SPACE.md,
    marginHorizontal: SPACE.xl, marginBottom: SPACE.lg,
    backgroundColor: C.s1, borderRadius: RADIUS.lg, borderWidth: 1,
    paddingHorizontal: SPACE.lg, paddingVertical: SPACE.lg,
  },
  emoji: { fontSize: 20 },
  title: { fontSize: 13, fontFamily: FONT.bold, letterSpacing: 1 },
  sub: { color: C.t3, fontSize: 12, fontFamily: FONT.regular, marginTop: 2 },
  arrow: { fontSize: 18, fontFamily: FONT.bold },
})

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: SPACE.xl, paddingTop: SPACE.sm, paddingBottom: SPACE.lg,
  },
  title: { color: C.t1, fontSize: 28, fontFamily: FONT.black, letterSpacing: -0.5 },
  logoutBtn: { paddingHorizontal: SPACE.md, paddingVertical: 7, borderRadius: RADIUS.pill, borderWidth: 1, borderColor: C.b2 },
  logoutText: { color: C.t2, fontSize: 12, fontFamily: FONT.semibold },

  idRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.lg, paddingHorizontal: SPACE.xl, marginBottom: SPACE.xl },
  avatar: {
    width: 56, height: 56, borderRadius: 28, backgroundColor: C.s3,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.b2,
  },
  avatarText: { color: C.lime, fontSize: 24, fontFamily: FONT.black },
  userName: { color: C.t1, fontSize: 20, fontFamily: FONT.bold, letterSpacing: -0.3 },
  userMeta: { color: C.t2, fontSize: 13, fontFamily: FONT.regular, marginTop: 2 },

  selector: { marginBottom: SPACE.lg },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: SPACE.lg, paddingVertical: SPACE.sm,
    borderRadius: RADIUS.pill, borderWidth: 1, borderColor: C.b1, backgroundColor: C.s1,
  },
  chipEmoji: { fontSize: 14 },
  chipText: { fontSize: 13, fontFamily: FONT.semibold },

  heroWrap: { paddingHorizontal: SPACE.xl },

  empty: { alignItems: 'center', paddingVertical: 56, gap: SPACE.sm },
  emptyEmoji: { fontSize: 44, opacity: 0.5 },
  emptyTitle: { color: C.t1, fontSize: 17, fontFamily: FONT.bold },
  emptySub: { color: C.t3, fontSize: 13, fontFamily: FONT.regular },
})
