/**
 * MY TOURNAMENTS — the organizer's home.
 *
 * Every tournament they run, with a one-glance read on how far setup has got.
 * A turf owner's real question is never "what are the fields on this record" but
 * "which of my events still needs something from me before Sunday", so each row
 * leads with the next action rather than with metadata.
 */
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../src/api/client'
import { C, FONT, SPACE, RADIUS, TIER, ELEV } from '../../src/theme'

type OrgEvent = {
  id: string
  name: string
  status: string
  tier: string
  format: string
  city: string
  venue: string | null
  match_format: string | null
  match_duration_minutes: number | null
  max_teams: number | null
  starts_at: string | null
  sport_slug: string
  teams_count: number
  referees_count: number
  fixtures_count: number
  completed_count: number
}

const STATUS_STYLE: Record<string, { color: string; label: string }> = {
  upcoming:     { color: C.t2,     label: 'DRAFT' },
  registration: { color: C.blue,   label: 'SIGN-UPS OPEN' },
  active:       { color: C.lime,   label: 'LIVE' },
  completed:    { color: C.green,  label: 'FINISHED' },
  cancelled:    { color: C.red,    label: 'CANCELLED' },
}

/**
 * The single next thing this event needs. Mirrors the order the control room
 * enforces — referees before tier, teams before fixtures — so the list and the
 * detail screen never disagree about what comes next.
 */
function nextAction(e: OrgEvent): { text: string; urgent: boolean } {
  if (e.status === 'cancelled') return { text: 'Cancelled', urgent: false }
  if (e.status === 'completed') return { text: 'View results', urgent: false }
  if (e.fixtures_count > 0) {
    const total = e.fixtures_count
    if (e.completed_count >= total) return { text: 'All matches played — finish it', urgent: true }
    return { text: `${e.completed_count}/${total} matches played`, urgent: false }
  }
  if (e.referees_count === 0) return { text: 'Assign referees', urgent: true }
  if (e.status === 'upcoming') return { text: 'Open sign-ups', urgent: true }
  if (e.teams_count < 2) return { text: `Waiting for teams (${e.teams_count})`, urgent: false }
  return { text: 'Generate fixtures', urgent: true }
}

export default function MyTournamentsScreen() {
  const router = useRouter()

  const { data, isLoading, error } = useQuery<{ items: OrgEvent[] }>({
    queryKey: ['organizer', 'events'],
    queryFn: async () => (await api.get('/organizer/events')).data,
  })

  const events = data?.items ?? []

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <View style={s.header}>
        <TouchableOpacity style={s.back} onPress={() => router.back()} activeOpacity={0.7}>
          <Text style={s.backIcon}>←</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.eyebrow}>ORGANIZER</Text>
          <Text style={s.title}>My Tournaments</Text>
        </View>
        <TouchableOpacity style={s.newBtn} onPress={() => router.push('/create-tournament')} activeOpacity={0.8}>
          <Text style={s.newBtnText}>+ New</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
        {isLoading && (
          <View style={s.center}><ActivityIndicator color={C.lime} /></View>
        )}

        {error && (
          <View style={s.center}>
            <Text style={s.err}>Couldn't load your tournaments.</Text>
          </View>
        )}

        {!isLoading && !error && events.length === 0 && (
          <View style={s.empty}>
            <Text style={s.emptyEmoji}>🏟️</Text>
            <Text style={s.emptyTitle}>No tournaments yet</Text>
            <Text style={s.emptyBody}>
              Create one, assign your referees, open sign-ups, and the bracket builds itself.
            </Text>
            <TouchableOpacity style={s.emptyBtn} onPress={() => router.push('/create-tournament')} activeOpacity={0.85}>
              <Text style={s.emptyBtnText}>Create your first tournament</Text>
            </TouchableOpacity>
          </View>
        )}

        {events.map(e => {
          const st = STATUS_STYLE[e.status] ?? STATUS_STYLE.upcoming
          const tier = TIER[e.tier] ?? TIER.amateur
          const action = nextAction(e)
          return (
            <TouchableOpacity
              key={e.id}
              style={s.card}
              activeOpacity={0.85}
              onPress={() => router.push(`/organizer/${e.id}`)}
            >
              <View style={s.cardTop}>
                <View style={[s.statusDot, { backgroundColor: st.color }]} />
                <Text style={[s.statusText, { color: st.color }]}>{st.label}</Text>
                <View style={{ flex: 1 }} />
                <View style={[s.tierChip, { backgroundColor: tier.glow, borderColor: tier.color }]}>
                  <Text style={[s.tierChipText, { color: tier.color }]}>{tier.short}</Text>
                </View>
              </View>

              <Text style={s.cardName}>{e.name}</Text>
              <Text style={s.cardMeta}>
                {e.venue ? `${e.venue} · ` : ''}{e.city}
                {e.match_format ? ` · ${e.match_format}` : ''}
                {e.match_duration_minutes ? ` · ${e.match_duration_minutes}m` : ''}
              </Text>

              <View style={s.statsRow}>
                <Stat value={e.teams_count} max={e.max_teams} label="TEAMS" />
                <Stat value={e.referees_count} label="REFS" />
                <Stat value={e.fixtures_count} label="FIXTURES" />
                <Stat value={e.completed_count} label="PLAYED" />
              </View>

              <View style={[s.actionRow, action.urgent && { backgroundColor: C.limeGlow }]}>
                <Text style={[s.actionText, action.urgent && { color: C.lime }]}>{action.text}</Text>
                <Text style={[s.actionArrow, action.urgent && { color: C.lime }]}>→</Text>
              </View>
            </TouchableOpacity>
          )
        })}
      </ScrollView>
    </SafeAreaView>
  )
}

function Stat({ value, max, label }: { value: number; max?: number | null; label: string }) {
  return (
    <View style={s.stat}>
      <Text style={s.statValue}>
        {value}
        {max ? <Text style={s.statMax}>/{max}</Text> : null}
      </Text>
      <Text style={s.statLabel}>{label}</Text>
    </View>
  )
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: SPACE.md,
    paddingHorizontal: SPACE.lg, paddingTop: SPACE.sm, paddingBottom: SPACE.lg,
  },
  back: {
    width: 40, height: 40, borderRadius: RADIUS.pill, backgroundColor: C.s2,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.b1,
  },
  backIcon: { color: C.t1, fontSize: 18, fontFamily: FONT.bold },
  eyebrow: { color: C.t3, fontSize: 10, fontFamily: FONT.bold, letterSpacing: 2 },
  title: { color: C.t1, fontSize: 24, fontFamily: FONT.black, letterSpacing: -0.5 },
  newBtn: {
    backgroundColor: C.lime, borderRadius: RADIUS.pill,
    paddingHorizontal: SPACE.lg, paddingVertical: SPACE.sm,
  },
  newBtnText: { color: C.limeText, fontSize: 13, fontFamily: FONT.bold },

  center: { paddingVertical: SPACE.xxxl, alignItems: 'center' },
  err: { color: C.red, fontSize: 14, fontFamily: FONT.medium },

  empty: { alignItems: 'center', paddingHorizontal: SPACE.xl, paddingTop: SPACE.xxl },
  emptyEmoji: { fontSize: 52, marginBottom: SPACE.md },
  emptyTitle: { color: C.t1, fontSize: 20, fontFamily: FONT.bold, marginBottom: SPACE.sm },
  emptyBody: {
    color: C.t2, fontSize: 14, fontFamily: FONT.regular,
    textAlign: 'center', lineHeight: 21, marginBottom: SPACE.xl,
  },
  emptyBtn: {
    backgroundColor: C.lime, borderRadius: RADIUS.lg,
    paddingHorizontal: SPACE.xl, paddingVertical: SPACE.md, ...ELEV.glow(C.lime, 0.3),
  },
  emptyBtnText: { color: C.limeText, fontSize: 15, fontFamily: FONT.bold },

  card: {
    marginHorizontal: SPACE.lg, marginBottom: SPACE.md, padding: SPACE.lg,
    backgroundColor: C.s1, borderRadius: RADIUS.lg, borderWidth: 1, borderColor: C.b1,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: SPACE.sm },
  statusDot: { width: 7, height: 7, borderRadius: 4 },
  statusText: { fontSize: 10, fontFamily: FONT.bold, letterSpacing: 1.2 },
  tierChip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: RADIUS.sm, borderWidth: 1 },
  tierChipText: { fontSize: 9, fontFamily: FONT.bold, letterSpacing: 0.8 },

  cardName: { color: C.t1, fontSize: 18, fontFamily: FONT.bold, marginBottom: 3 },
  cardMeta: { color: C.t2, fontSize: 12, fontFamily: FONT.regular, marginBottom: SPACE.md },

  statsRow: {
    flexDirection: 'row', backgroundColor: C.bg, borderRadius: RADIUS.md,
    paddingVertical: SPACE.md, marginBottom: SPACE.md,
  },
  stat: { flex: 1, alignItems: 'center' },
  statValue: { color: C.t1, fontSize: 17, fontFamily: FONT.black },
  statMax: { color: C.t3, fontSize: 12, fontFamily: FONT.medium },
  statLabel: { color: C.t3, fontSize: 9, fontFamily: FONT.bold, letterSpacing: 1, marginTop: 2 },

  actionRow: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: C.s3,
    borderRadius: RADIUS.md, paddingHorizontal: SPACE.md, paddingVertical: 10,
  },
  actionText: { flex: 1, color: C.t2, fontSize: 13, fontFamily: FONT.semibold },
  actionArrow: { color: C.t2, fontSize: 15, fontFamily: FONT.bold },
})
