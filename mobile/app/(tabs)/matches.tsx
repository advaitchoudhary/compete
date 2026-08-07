import { useState } from 'react'
import { ScrollView, View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, RefreshControl } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { useAuthStore } from '../../src/store/auth.store'
import { api } from '../../src/api/client'
import { C, SPORT } from '../../src/theme'
import type { EventSummary } from '../../src/types/tournament'

const FILTERS = ['All', 'Live', 'Upcoming', 'Completed'] as const
type Filter = typeof FILTERS[number]

const SPORT_LIST = [
  { slug: 'cricket',    name: 'Cricket',    emoji: '🏏' },
  { slug: 'football',   name: 'Football',   emoji: '⚽' },
  { slug: 'badminton',  name: 'Badminton',  emoji: '🏸' },
  { slug: 'basketball', name: 'Basketball', emoji: '🏀' },
]

const MATCH_STATUS_CFG = {
  live:      { label: 'LIVE',      color: C.green, bg: 'rgba(34,197,94,0.14)'  },
  scheduled: { label: 'UPCOMING',  color: C.amber, bg: 'rgba(245,158,11,0.14)' },
  completed: { label: 'COMPLETED', color: C.t3,    bg: C.s3                    },
}

const EVENT_STATUS_CFG: Record<string, { label: string; color: string; bg: string }> = {
  upcoming:     { label: 'UPCOMING', color: C.amber, bg: 'rgba(245,158,11,0.14)' },
  registration: { label: 'OPEN',     color: C.lime,  bg: C.limeGlow              },
  active:       { label: 'ACTIVE',   color: C.green, bg: 'rgba(34,197,94,0.14)'  },
  completed:    { label: 'DONE',     color: C.t3,    bg: C.s3                    },
}

function normalise(raw: any): any[] {
  return Array.isArray(raw) ? raw : (raw?.data ?? raw?.items ?? [])
}

// ─── TournamentCard ───────────────────────────────────────────────────────────

function TournamentCard({ event, onPress }: { event: EventSummary; onPress: () => void }) {
  const spCfg = SPORT[event.sport_slug] ?? { color: C.blue, glow: 'rgba(59,130,246,0.10)', emoji: '🏅', name: event.sport_slug }
  const stCfg = EVENT_STATUS_CFG[event.status] ?? EVENT_STATUS_CFG.upcoming

  return (
    <TouchableOpacity
      style={[tc.card, { borderTopColor: spCfg.color, backgroundColor: spCfg.glow }]}
      onPress={onPress}
      activeOpacity={0.78}
    >
      <View style={tc.topRow}>
        <Text style={{ fontSize: 18 }}>{spCfg.emoji}</Text>
        <View style={[tc.formatBadge, { backgroundColor: spCfg.color + '22' }]}>
          <Text style={[tc.formatText, { color: spCfg.color }]}>{event.format.toUpperCase()}</Text>
        </View>
      </View>
      <Text style={tc.name} numberOfLines={2}>{event.name}</Text>
      <View style={tc.bottomRow}>
        <View style={[tc.statusPill, { backgroundColor: stCfg.bg }]}>
          <Text style={[tc.statusText, { color: stCfg.color }]}>{stCfg.label}</Text>
        </View>
        {event.max_teams != null && (
          <Text style={tc.teamsCount}>{event.max_teams} teams max</Text>
        )}
      </View>
      <Text style={tc.city} numberOfLines={1}>📍 {event.city}</Text>
    </TouchableOpacity>
  )
}

const tc = StyleSheet.create({
  card: {
    width: 190, borderRadius: 16,
    borderWidth: 1, borderTopWidth: 2.5, borderColor: C.b1,
    padding: 14, gap: 6,
  },
  topRow:     { flexDirection: 'row', alignItems: 'center', gap: 8 },
  formatBadge:{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20 },
  formatText: { fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  name:       { color: C.t1, fontSize: 14, fontWeight: '700', lineHeight: 20, minHeight: 40 },
  bottomRow:  { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20 },
  statusText: { fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  teamsCount: { color: C.t3, fontSize: 11 },
  city:       { color: C.t3, fontSize: 11, marginTop: 2 },
})

// ─── CreateTournamentTile ─────────────────────────────────────────────────────

function CreateTournamentTile({ onPress }: { onPress: () => void }) {
  return (
    <TouchableOpacity style={ct.tile} onPress={onPress} activeOpacity={0.78}>
      <Text style={ct.plus}>+</Text>
      <Text style={ct.label}>New{'\n'}Tournament</Text>
    </TouchableOpacity>
  )
}

const ct = StyleSheet.create({
  tile: {
    width: 120, borderRadius: 16,
    borderWidth: 1.5, borderColor: C.lime,
    alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 28,
  },
  plus:  { color: C.lime, fontSize: 28, fontWeight: '700' },
  label: { color: C.lime, fontSize: 12, fontWeight: '700', textAlign: 'center', lineHeight: 18 },
})

// ─── MatchCard ────────────────────────────────────────────────────────────────

function MatchCard({ match }: { match: any }) {
  const router = useRouter()
  const cfg = MATCH_STATUS_CFG[match.status as keyof typeof MATCH_STATUS_CFG] ?? MATCH_STATUS_CFG.scheduled
  return (
    <TouchableOpacity
      style={mc.card}
      onPress={() => router.push({ pathname: '/match/[id]', params: { id: match.id } })}
      activeOpacity={0.75}
    >
      <View style={mc.topRow}>
        <View style={[mc.badge, { backgroundColor: cfg.bg }]}>
          <Text style={[mc.badgeText, { color: cfg.color }]}>{cfg.label}</Text>
        </View>
        <Text style={mc.date}>
          {match.scheduled_at
            ? new Date(match.scheduled_at).toLocaleDateString('en-IN')
            : '—'}
        </Text>
      </View>
      <View style={mc.teamsRow}>
        <Text style={mc.team}>{match.home_team_name ?? 'TBD'}</Text>
        <Text style={mc.vs}>VS</Text>
        <Text style={[mc.team, mc.teamRight]}>{match.away_team_name ?? 'TBD'}</Text>
      </View>
      {match.venue && <Text style={mc.venue}>📍 {match.venue}</Text>}
    </TouchableOpacity>
  )
}

const mc = StyleSheet.create({
  card: {
    backgroundColor: C.s1, borderRadius: 16,
    padding: 16, marginBottom: 8,
    borderWidth: 1, borderColor: C.b0,
  },
  topRow:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  badge:     { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 },
  badgeText: { fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  date:      { color: C.t3, fontSize: 12 },
  teamsRow:  { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  team:      { flex: 1, color: C.t1, fontSize: 16, fontWeight: '700' },
  teamRight: { textAlign: 'right' },
  vs:        { color: C.t3, fontSize: 12, fontWeight: '800', paddingHorizontal: 12 },
  venue:     { color: C.t3, fontSize: 12 },
})

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function MatchesScreen() {
  const { user } = useAuthStore()
  const router = useRouter()
  const [filter, setFilter] = useState<Filter>('All')

  // A referee's own fixtures. This is the match-day view: an official arriving at
  // the turf needs to know what they are refereeing and which one is next, without
  // navigating a tournament by name. Polls while the app is open so a bracket
  // generated mid-session appears without a manual refresh.
  const isRef = user?.role === 'referee' || user?.role === 'admin'
  const { data: refDuty } = useQuery({
    queryKey: ['referee', 'matches'],
    queryFn: () => api.get('/referee/matches').then(r => r.data),
    enabled: !!user && isRef,
    refetchInterval: 60_000,
  })
  const duty: any[] = refDuty?.matches ?? []

  // Tournament queries — merge active + registration events
  const { data: activeRaw, isLoading: activeLoading } = useQuery({
    queryKey: ['events', 'active'],
    queryFn: () => api.get('/events', { params: { status: 'active' } }).then(r => r.data),
    enabled: !!user,
  })
  const { data: regRaw, isLoading: regLoading } = useQuery({
    queryKey: ['events', 'registration'],
    queryFn: () => api.get('/events', { params: { status: 'registration' } }).then(r => r.data),
    enabled: !!user,
  })

  const events: EventSummary[] = [...normalise(activeRaw), ...normalise(regRaw)]
  const eventsLoading = activeLoading || regLoading

  const STATUS_MAP: Record<Filter, string | undefined> = {
    All:       undefined,
    Live:      'live',
    Upcoming:  'scheduled',
    Completed: 'completed',
  }
  const { data: matchesData, isLoading: matchesLoading, refetch: refetchMatches } = useQuery({
    queryKey: ['matches', filter],
    queryFn: () => {
      const params: Record<string, string> = {}
      const st = STATUS_MAP[filter]
      if (st) params.status = st
      return api.get('/matches', { params }).then(r => normalise(r.data))
    },
    enabled: !!user,
  })
  const matches: any[] = matchesData ?? []

  return (
    <SafeAreaView style={s.container} edges={['top']}>
      {/* Header */}
      <View style={s.header}>
        <Text style={s.title}>Matches</Text>
        <TouchableOpacity
          style={s.newBtn}
          activeOpacity={0.85}
          onPress={() => router.push('/create-match')}
        >
          <Text style={s.newBtnText}>+ New</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={matchesLoading && matches.length > 0}
            onRefresh={refetchMatches}
            tintColor={C.lime}
          />
        }
      >

        {/* ── YOUR MATCHES (referees) ──────────────────────────
            Pinned above tournaments: on a match day this is the only thing the
            referee opened the app for. */}
        {isRef && duty.length > 0 && (
          <>
            <View style={s.sectionHeaderRow}>
              <Text style={s.sectionLabel}>🦓 YOUR MATCHES</Text>
              <Text style={s.dutyCount}>{duty.length} to officiate</Text>
            </View>
            <View style={s.dutyList}>
              {duty.map(m => {
                const isNext = m.id === refDuty?.next_match_id
                const live = m.status === 'live'
                const time = m.scheduled_at
                  ? new Date(m.scheduled_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
                  : '—'
                return (
                  <TouchableOpacity
                    key={m.id}
                    style={[du.row, isNext && du.rowNext]}
                    activeOpacity={0.85}
                    onPress={() => router.push({ pathname: '/match/[id]', params: { id: m.id } })}
                  >
                    <View style={du.when}>
                      <Text style={[du.time, isNext && { color: C.lime }]}>{time}</Text>
                      <Text style={du.pitch} numberOfLines={1}>
                        {m.pitch_label ?? m.venue ?? '—'}
                      </Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={du.caption}>
                        {(m.event_name ?? 'Casual match')}{m.round_label ? ` · ${m.round_label}` : ''}
                      </Text>
                      <Text style={du.teams} numberOfLines={1}>
                        {m.home_team_name} <Text style={{ color: C.t3 }}>v</Text> {m.away_team_name}
                      </Text>
                    </View>
                    {live
                      ? <Text style={du.live}>● LIVE</Text>
                      : isNext
                        ? <Text style={du.nextTag}>NEXT →</Text>
                        : <Text style={du.chev}>›</Text>}
                  </TouchableOpacity>
                )
              })}
            </View>
            <View style={s.divider} />
          </>
        )}

        {/* ── TOURNAMENTS SECTION ─────────────────────────────── */}
        <View style={s.sectionHeaderRow}>
          <Text style={s.sectionLabel}>TOURNAMENTS</Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {/* Organizers get the control room; everyone else only sees Create,
                which is itself gated server-side by requireRole. */}
            {(user?.role === 'organizer' || user?.role === 'admin') && (
              <TouchableOpacity style={s.sectionBtn} onPress={() => router.push('/organizer')}>
                <Text style={s.sectionBtnText}>🏟️ Manage</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={s.sectionBtn} onPress={() => router.push('/create-tournament')}>
              <Text style={s.sectionBtnText}>+ Create</Text>
            </TouchableOpacity>
          </View>
        </View>

        {eventsLoading ? (
          <ActivityIndicator color={C.lime} style={{ marginLeft: 22, marginBottom: 20 }} />
        ) : (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={s.tournamentsRow}
          >
            {events.map(ev => (
              <TournamentCard
                key={ev.id}
                event={ev}
                onPress={() => router.push({ pathname: '/tournament/[id]', params: { id: ev.id } })}
              />
            ))}
            <CreateTournamentTile onPress={() => router.push('/create-tournament')} />
          </ScrollView>
        )}

        {/* Divider */}
        <View style={s.divider} />

        {/* ── CASUAL MATCHES SECTION ──────────────────────────── */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={s.filtersRow}
        >
          {FILTERS.map(f => {
            const active = filter === f
            return (
              <TouchableOpacity
                key={f}
                style={[s.pill, active && s.pillActive]}
                onPress={() => setFilter(f)}
                activeOpacity={0.75}
              >
                {f === 'Live' && (
                  <View style={[s.liveDot, active && { backgroundColor: C.limeText }]} />
                )}
                <Text style={[s.pillText, active && s.pillTextActive]}>{f}</Text>
              </TouchableOpacity>
            )
          })}
        </ScrollView>

        {matchesLoading ? (
          <ActivityIndicator color={C.lime} style={{ marginVertical: 24, marginLeft: 22 }} />
        ) : matches.length > 0 ? (
          <View style={s.matchList}>
            {matches.map((m: any, i: number) => (
              <MatchCard key={m.id ?? i} match={m} />
            ))}
          </View>
        ) : (
          <View style={s.emptyWrap}>
            <Text style={s.emptyEmoji}>🏟️</Text>
            <Text style={s.emptyTitle}>
              {filter === 'All' ? 'No matches yet' : `No ${filter.toLowerCase()} matches`}
            </Text>
            <Text style={s.emptySub}>
              {filter === 'Live'
                ? 'No live matches right now.'
                : filter === 'Upcoming'
                ? 'Schedule a match to see it here.'
                : filter === 'Completed'
                ? 'Play your first match to see results.'
                : 'Create a match, add players, and\nstart tracking stats in real time.'}
            </Text>
          </View>
        )}

        {/* Quick start grid */}
        <Text style={s.quickLabel}>START A MATCH IN</Text>
        <View style={s.sportGrid}>
          {SPORT_LIST.map(sport => {
            const cfg = SPORT[sport.slug]
            return (
              <TouchableOpacity
                key={sport.slug}
                style={[s.sportCard, { borderColor: cfg.color, backgroundColor: cfg.glow }]}
                activeOpacity={0.78}
                onPress={() => router.push({ pathname: '/create-match', params: { sport: sport.slug } })}
              >
                <Text style={s.sportCardEmoji}>{sport.emoji}</Text>
                <Text style={[s.sportCardName, { color: cfg.color }]}>{sport.name}</Text>
              </TouchableOpacity>
            )
          })}
        </View>

        <View style={{ height: 48 }} />
      </ScrollView>
    </SafeAreaView>
  )
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },

  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 22,
    paddingTop: 10,
    paddingBottom: 18,
  },
  title:      { color: C.white, fontSize: 32, fontWeight: '800', letterSpacing: -0.5 },
  newBtn:     { backgroundColor: C.lime, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 22 },
  newBtnText: { color: C.limeText, fontSize: 14, fontWeight: '800' },

  // Tournaments
  dutyCount: { color: C.t3, fontSize: 11, fontWeight: '700' },
  dutyList:  { marginHorizontal: 22, marginBottom: 4, gap: 6 },
  sectionHeaderRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 22, marginBottom: 12,
  },
  sectionLabel:   { color: C.t3, fontSize: 11, fontWeight: '700', letterSpacing: 2 },
  sectionBtn:     { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, backgroundColor: C.s2, borderWidth: 1, borderColor: C.b1 },
  sectionBtnText: { color: C.t2, fontSize: 12, fontWeight: '700' },
  tournamentsRow: { paddingHorizontal: 16, gap: 10, paddingBottom: 8 },

  divider: { height: 1, backgroundColor: C.b0, marginHorizontal: 16, marginVertical: 8 },

  // Matches filters
  filtersRow: { paddingHorizontal: 16, gap: 8, paddingBottom: 14 },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 16, paddingVertical: 8, borderRadius: 22,
    backgroundColor: C.s2, borderWidth: 1, borderColor: C.b1,
  },
  pillActive:     { backgroundColor: C.lime, borderColor: C.lime },
  pillText:       { color: C.t2, fontSize: 14, fontWeight: '600' },
  pillTextActive: { color: C.limeText, fontWeight: '800' },
  liveDot:        { width: 6, height: 6, borderRadius: 3, backgroundColor: C.t3 },
  matchList:      { paddingHorizontal: 16, marginTop: 4 },

  emptyWrap:  { alignItems: 'center', paddingVertical: 36, paddingHorizontal: 40 },
  emptyEmoji: { fontSize: 52, marginBottom: 16 },
  emptyTitle: { color: C.t1, fontSize: 20, fontWeight: '700', marginBottom: 8 },
  emptySub:   { color: C.t3, fontSize: 14, textAlign: 'center', lineHeight: 22 },

  quickLabel: {
    color: C.t3, fontSize: 11, fontWeight: '700', letterSpacing: 2,
    marginHorizontal: 22, marginTop: 16, marginBottom: 12,
  },
  sportGrid: {
    paddingHorizontal: 16, flexDirection: 'row', flexWrap: 'wrap', gap: 10,
  },
  sportCard: {
    width: '47%', borderRadius: 16, borderWidth: 1,
    paddingVertical: 20, alignItems: 'center', gap: 8,
  },
  sportCardEmoji: { fontSize: 32 },
  sportCardName:  { fontSize: 14, fontWeight: '700' },
})

// Referee duty row — deliberately chunky. This is tapped outdoors, in sunlight,
// usually one-handed while holding a whistle.
const du = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    backgroundColor: C.s1, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 14,
    borderWidth: 1, borderColor: C.b1, minHeight: 64,
  },
  rowNext: { borderColor: C.lime, backgroundColor: C.limeGlow },
  when:    { width: 62 },
  time:    { color: C.t1, fontSize: 15, fontWeight: '800' },
  pitch:   { color: C.t3, fontSize: 11, fontWeight: '600', marginTop: 1 },
  caption: { color: C.t3, fontSize: 10, fontWeight: '700', letterSpacing: 0.6 },
  teams:   { color: C.t1, fontSize: 15, fontWeight: '700', marginTop: 2 },
  live:    { color: C.green, fontSize: 11, fontWeight: '800', letterSpacing: 0.5 },
  nextTag: { color: C.lime, fontSize: 11, fontWeight: '800', letterSpacing: 0.5 },
  chev:    { color: C.t3, fontSize: 18, fontWeight: '700' },
})
