/**
 * Public pickup-game page — what lands in the WhatsApp group.
 *
 * No login, no install: someone taps a link and can see whether there is still a
 * spot before deciding anything. Self-contained like the tournament page at
 * e/[id].tsx, calling the unauthenticated endpoint with plain fetch rather than
 * the axios client, which attaches a JWT and redirects on 401.
 *
 * The whole page answers one question — is there room, and can I get in — so the
 * count leads and the button sits under it.
 */
import { useEffect, useState, useCallback } from 'react'
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator,
  RefreshControl, TouchableOpacity,
} from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { BASE_URL, getToken } from '../../src/api/client'
import { C, FONT, SPACE, RADIUS, ELEV } from '../../src/theme'

interface PublicGame {
  id: string
  name: string
  status: string
  players_per_side: number | null
  match_format: string | null
  duration_minutes: number | null
  city: string
  venue: string | null
  starts_at: string | null
  capacity: number
  confirmed_count: number
  spots_left: number
  waitlist_count: number
  playing: Array<{ name: string; position: string | null }>
  waiting: Array<{ name: string }>
  sides: Array<{ name: string; players: string[] }> | null
}

const whenOf = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString([], {
        weekday: 'short', day: 'numeric', month: 'short',
      })
    : null

export default function PublicGamePage() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const [data, setData] = useState<PublicGame | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${BASE_URL}/public/games/${id}`)
      if (!res.ok) {
        setError(res.status === 404 ? 'Game not found' : 'Could not load the game')
        return
      }
      setData(await res.json())
      setError(null)
    } catch {
      setError('Could not reach the server')
    }
  }, [id])

  useEffect(() => {
    load()
    // Spots go while people are looking at this. Poll so the count is honest.
    const t = setInterval(load, 20_000)
    return () => clearInterval(t)
  }, [load])

  if (error) {
    return (
      <View style={s.center}>
        <Text style={s.errorTitle}>{error}</Text>
        <Text style={s.errorSub}>Check the link and try again.</Text>
      </View>
    )
  }
  if (!data) {
    return <View style={s.center}><ActivityIndicator color={C.lime} /></View>
  }

  const open = data.status === 'registration'
  const full = data.spots_left === 0
  const when = whenOf(data.starts_at)

  return (
    <ScrollView
      style={s.page}
      contentContainerStyle={s.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          tintColor={C.lime}
          onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false) }}
        />
      }
    >
      <View style={s.hero}>
        <Text style={s.eyebrow}>PICKUP GAME</Text>
        <Text style={s.title}>{data.name}</Text>
        <Text style={s.subtitle}>
          ⚽ {data.match_format ?? 'Football'}
          {data.venue ? ` · ${data.venue}` : ''} · {data.city}
          {data.duration_minutes ? ` · ${data.duration_minutes}min` : ''}
        </Text>
      </View>

      {/* The only number that matters before the game fills. */}
      <View style={s.card}>
        <View style={s.countRow}>
          <Text style={s.count}>
            {data.confirmed_count}<Text style={s.countMax}>/{data.capacity}</Text>
          </Text>
          <View style={{ flex: 1 }}>
            <View style={s.track}>
              <View
                style={[s.trackFill, { width: `${(data.confirmed_count / data.capacity) * 100}%` }]}
              />
            </View>
            <Text style={s.countLabel}>
              {full
                ? data.waitlist_count > 0
                  ? `Full · ${data.waitlist_count} on the waitlist`
                  : 'Full'
                : `${data.spots_left} spot${data.spots_left === 1 ? '' : 's'} left`}
              {when ? ` · ${when}` : ''}
            </Text>
          </View>
        </View>

        {open && (
          <>
            <TouchableOpacity
              style={s.joinBtn}
              activeOpacity={0.85}
              onPress={() =>
                router.push(
                  getToken()
                    ? `/join-game/${data.id}`
                    : `/auth?next=${encodeURIComponent(`/join-game/${data.id}`)}`
                )
              }
            >
              <Text style={s.joinBtnText}>
                {full ? 'Join the waitlist →' : 'Put your name down →'}
              </Text>
            </TouchableOpacity>
            <Text style={s.joinHint}>
              {full
                ? 'You come straight in if someone drops out.'
                : 'You can bring mates — they do not need an account.'}
            </Text>
          </>
        )}
      </View>

      {/* Once drawn, the two sides are the point of the page. */}
      {data.sides && (
        <>
          <Text style={s.sectionTitle}>The sides</Text>
          {data.sides.map((side, i) => (
            <View key={side.name} style={s.card}>
              <Text style={[s.sideName, { color: i === 0 ? C.lime : C.blue }]}>
                {side.name.split('·').pop()?.trim() ?? side.name}
              </Text>
              {side.players.map((p) => (
                <Text key={p} style={s.sidePlayer}>{p}</Text>
              ))}
            </View>
          ))}
        </>
      )}

      {!data.sides && data.playing.length > 0 && (
        <>
          <Text style={s.sectionTitle}>Playing</Text>
          <View style={s.card}>
            {data.playing.map((p, i) => (
              <View key={`${p.name}-${i}`} style={s.playerRow}>
                <Text style={s.playerNum}>{i + 1}</Text>
                <Text style={s.playerName}>{p.name}</Text>
                {p.position && <Text style={s.playerPos}>{p.position}</Text>}
              </View>
            ))}
          </View>
        </>
      )}

      {data.waiting.length > 0 && (
        <>
          <Text style={s.sectionTitle}>Waiting</Text>
          <View style={s.card}>
            {data.waiting.map((p, i) => (
              <View key={`${p.name}-${i}`} style={s.playerRow}>
                <Text style={s.playerNum}>{i + 1}</Text>
                <Text style={s.playerName}>{p.name}</Text>
              </View>
            ))}
          </View>
        </>
      )}

      <View style={s.footer}>
        <Text style={s.footerTitle}>Sides are picked on rating</Text>
        <Text style={s.footerText}>
          When the game fills, the two teams are split to have near-equal average
          rating — so it should be a real contest, not whoever shouted first. Every
          match you play builds that rating.
        </Text>
      </View>
    </ScrollView>
  )
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: C.bg },
  content: { padding: SPACE.lg, paddingBottom: SPACE.xxxl },
  center: { flex: 1, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center', padding: SPACE.xl, gap: 6 },
  errorTitle: { color: C.t1, fontSize: 18, fontFamily: FONT.bold },
  errorSub: { color: C.t3, fontSize: 13, fontFamily: FONT.regular },

  hero: { marginBottom: SPACE.lg },
  eyebrow: { color: C.t3, fontSize: 10, fontFamily: FONT.bold, letterSpacing: 2 },
  title: { color: C.t1, fontSize: 30, fontFamily: FONT.black, letterSpacing: -0.8, marginTop: 4 },
  subtitle: { color: C.t2, fontSize: 13, fontFamily: FONT.regular, marginTop: 6 },

  card: {
    backgroundColor: C.s1, borderRadius: RADIUS.lg, borderWidth: 1, borderColor: C.b1,
    padding: SPACE.lg, marginBottom: SPACE.sm, gap: SPACE.sm,
  },
  countRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md },
  count: { color: C.t1, fontSize: 34, fontFamily: FONT.black },
  countMax: { color: C.t3, fontSize: 17, fontFamily: FONT.medium },
  track: { height: 6, backgroundColor: C.s3, borderRadius: 3, overflow: 'hidden' },
  trackFill: { height: 6, backgroundColor: C.lime, borderRadius: 3 },
  countLabel: { color: C.t2, fontSize: 12, fontFamily: FONT.medium, marginTop: 6 },

  joinBtn: {
    backgroundColor: C.lime, borderRadius: RADIUS.md, paddingVertical: 15,
    alignItems: 'center', ...ELEV.glow(C.lime, 0.3),
  },
  joinBtnText: { color: C.limeText, fontSize: 15, fontFamily: FONT.bold },
  joinHint: { color: C.t3, fontSize: 11, fontFamily: FONT.regular, textAlign: 'center' },

  sectionTitle: {
    color: C.t3, fontSize: 11, fontFamily: FONT.bold, letterSpacing: 1.5,
    marginTop: SPACE.lg, marginBottom: SPACE.sm, textTransform: 'uppercase',
  },
  sideName: { fontSize: 13, fontFamily: FONT.bold, letterSpacing: 0.5, marginBottom: 2 },
  sidePlayer: { color: C.t1, fontSize: 14, fontFamily: FONT.medium, paddingVertical: 2 },

  playerRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingVertical: 3 },
  playerNum: { color: C.t3, fontSize: 11, fontFamily: FONT.bold, width: 18 },
  playerName: { flex: 1, color: C.t1, fontSize: 14, fontFamily: FONT.medium },
  playerPos: { color: C.t3, fontSize: 10, fontFamily: FONT.bold },

  footer: {
    marginTop: SPACE.xl, padding: SPACE.lg, backgroundColor: C.s1,
    borderRadius: RADIUS.lg, borderWidth: 1, borderColor: C.b1, gap: 6,
  },
  footerTitle: { color: C.lime, fontSize: 15, fontFamily: FONT.bold },
  footerText: { color: C.t2, fontSize: 13, fontFamily: FONT.regular, lineHeight: 20 },
})
