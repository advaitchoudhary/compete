import { useMemo } from 'react'
import {
  ScrollView, View, Text, StyleSheet,
  TouchableOpacity, ActivityIndicator, Alert, RefreshControl,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuthStore } from '../../src/store/auth.store'
import { api } from '../../src/api/client'
import { C, SPORT } from '../../src/theme'
import type { EventDetail, EventSummary, EventTeam, MatchSummary } from '../../src/types/tournament'

const EVENT_STATUS_CFG: Record<string, { label: string; color: string; bg: string }> = {
  upcoming:     { label: 'UPCOMING', color: C.amber, bg: 'rgba(245,158,11,0.14)' },
  registration: { label: 'OPEN',     color: C.lime,  bg: C.limeGlow              },
  active:       { label: 'ACTIVE',   color: C.green, bg: 'rgba(34,197,94,0.14)'  },
  completed:    { label: 'DONE',     color: C.t3,    bg: C.s3                    },
  cancelled:    { label: 'CANCELLED',color: C.t3,    bg: C.s3                    },
}

const MATCH_STATUS_CFG: Record<string, { label: string; color: string; bg: string }> = {
  live:      { label: 'LIVE',      color: C.green, bg: 'rgba(34,197,94,0.14)'  },
  scheduled: { label: 'UPCOMING',  color: C.amber, bg: 'rgba(245,158,11,0.14)' },
  completed: { label: 'DONE',      color: C.t3,    bg: C.s3                    },
  cancelled: { label: 'CANCELLED', color: C.t3,    bg: C.s3                    },
}

function normalise(raw: any): any[] {
  return Array.isArray(raw) ? raw : (raw?.data ?? raw?.items ?? [])
}

// ─── TournamentMatchRow ───────────────────────────────────────────────────────

function TournamentMatchRow({ match, onPress }: { match: MatchSummary; onPress: () => void }) {
  const stCfg = MATCH_STATUS_CFG[match.status] ?? MATCH_STATUS_CFG.scheduled
  const hasScore = match.home_score != null || match.away_score != null

  return (
    <TouchableOpacity style={mr.row} onPress={onPress} activeOpacity={0.78}>
      <View style={[mr.badge, { backgroundColor: stCfg.bg }]}>
        <Text style={[mr.badgeText, { color: stCfg.color }]}>{stCfg.label}</Text>
      </View>
      <View style={mr.teams}>
        <Text style={mr.teamName} numberOfLines={1}>{match.home_team_name}</Text>
        <Text style={mr.scoreOrVs}>
          {hasScore
            ? `${match.home_score ?? 0} — ${match.away_score ?? 0}`
            : 'vs'}
        </Text>
        <Text style={[mr.teamName, { textAlign: 'right' }]} numberOfLines={1}>
          {match.away_team_name}
        </Text>
      </View>
      {match.scheduled_at && (
        <Text style={mr.date}>
          {new Date(match.scheduled_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
        </Text>
      )}
    </TouchableOpacity>
  )
}

const mr = StyleSheet.create({
  row: {
    backgroundColor: C.s1, borderRadius: 14, padding: 12, marginBottom: 6,
    borderWidth: 1, borderColor: C.b0, gap: 8,
  },
  badge:     { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20 },
  badgeText: { fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  teams:     { flexDirection: 'row', alignItems: 'center', gap: 8 },
  teamName:  { flex: 1, color: C.t1, fontSize: 13, fontWeight: '600' },
  scoreOrVs: { color: C.t2, fontSize: 13, fontWeight: '800', minWidth: 60, textAlign: 'center' },
  date:      { color: C.t3, fontSize: 11, alignSelf: 'flex-end' },
})

// ─── TeamRow ──────────────────────────────────────────────────────────────────

function TeamRow({ team, sportColor }: { team: EventTeam; sportColor: string }) {
  return (
    <View style={tr.row}>
      <View style={[tr.dot, { backgroundColor: sportColor }]} />
      <Text style={tr.name}>{team.name}</Text>
      {team.seed != null && (
        <View style={tr.seedBadge}>
          <Text style={tr.seedText}>#{team.seed}</Text>
        </View>
      )}
      {team.points > 0 && (
        <Text style={tr.points}>{team.points} pts</Text>
      )}
    </View>
  )
}

const tr = StyleSheet.create({
  row:       { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: C.b0 },
  dot:       { width: 8, height: 8, borderRadius: 4 },
  name:      { flex: 1, color: C.t1, fontSize: 14, fontWeight: '600' },
  seedBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 20, backgroundColor: C.s3 },
  seedText:  { color: C.t3, fontSize: 11, fontWeight: '700' },
  points:    { color: C.lime, fontSize: 13, fontWeight: '800' },
})

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function TournamentDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const queryClient = useQueryClient()
  const { user } = useAuthStore()

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['event', id],
    queryFn: () => api.get(`/events/${id}`).then(r => r.data as EventDetail),
    enabled: !!id,
  })

  const eventMeta: EventSummary | undefined = data?.event
  const teams: EventTeam[]     = data?.teams   ?? []
  const matches: MatchSummary[] = data?.matches ?? []

  const spCfg = eventMeta
    ? (SPORT[eventMeta.sport_slug] ?? { color: C.blue, glow: 'rgba(59,130,246,0.10)', emoji: '🏅', name: eventMeta.sport_slug })
    : { color: C.blue, glow: 'rgba(59,130,246,0.10)', emoji: '🏅', name: '' }
  const stCfg = eventMeta ? (EVENT_STATUS_CFG[eventMeta.status] ?? EVENT_STATUS_CFG.upcoming) : EVENT_STATUS_CFG.upcoming

  const isOrganizer = !!user && user.id === eventMeta?.organizer_id
  const canRegister = !!eventMeta && ['upcoming', 'registration'].includes(eventMeta.status)

  // Group matches by round
  const byRound = useMemo(() => {
    return matches.reduce((acc, m) => {
      const key = m.round ?? 'General'
      ;(acc[key] = acc[key] ?? []).push(m)
      return acc
    }, {} as Record<string, MatchSummary[]>)
  }, [matches])
  const rounds = Object.keys(byRound)

  // Fetch user's captained teams (for register flow)
  const { data: myTeamsRaw } = useQuery({
    queryKey: ['my-teams', user?.id, eventMeta?.sport_slug],
    queryFn: () =>
      api.get('/teams', { params: { sport: eventMeta?.sport_slug } })
        .then(r => {
          const all = normalise(r.data)
          return all.filter((t: any) => t.organizer_id === user?.id)
        }),
    enabled: !!user && !!eventMeta && canRegister,
  })
  const myTeams: any[] = myTeamsRaw ?? []
  const registeredTeamIds = new Set(teams.map(t => t.id))
  const eligibleTeams = myTeams.filter((t: any) => !registeredTeamIds.has(t.id))

  // Register team mutation
  const registerMutation = useMutation({
    mutationFn: (teamId: string) =>
      api.post(`/events/${id}/teams`, { team_id: teamId }).then(r => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['event', id] })
      Alert.alert('Registered!', 'Your team has been added to this tournament.')
    },
    onError: (err: any) => {
      Alert.alert('Error', err?.response?.data?.message ?? err?.message ?? 'Registration failed')
    },
  })

  function handleRegister() {
    if (eligibleTeams.length === 0) {
      Alert.alert(
        'No Eligible Team',
        'You need to be the captain of a team to register. Create a team first.',
        [{ text: 'OK' }],
      )
      return
    }
    if (eligibleTeams.length === 1) {
      Alert.alert(
        'Register Team',
        `Register "${eligibleTeams[0].name}" for this tournament?`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Register', onPress: () => registerMutation.mutate(eligibleTeams[0].id) },
        ],
      )
      return
    }
    // Multiple teams — show picker
    const buttons = [
      ...eligibleTeams.map((t: any) => ({
        text: t.name,
        onPress: () => registerMutation.mutate(t.id),
      })),
      { text: 'Cancel', style: 'cancel' as const },
    ]
    Alert.alert('Select Team', 'Which team would you like to register?', buttons)
  }

  // ── Loading / Error states ────────────────────────────────────────────────

  if (isLoading) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <ActivityIndicator color={C.lime} size="large" style={{ marginTop: 80 }} />
      </SafeAreaView>
    )
  }

  if (!eventMeta) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg, justifyContent: 'center', alignItems: 'center' }}>
        <Text style={{ color: C.t3, fontSize: 16 }}>Tournament not found.</Text>
        <TouchableOpacity onPress={() => router.back()} style={{ marginTop: 16 }}>
          <Text style={{ color: C.lime, fontSize: 15, fontWeight: '600' }}>← Go back</Text>
        </TouchableOpacity>
      </SafeAreaView>
    )
  }

  // ── Main render ───────────────────────────────────────────────────────────

  return (
    <SafeAreaView style={s.container} edges={['top']}>
      {/* Back button */}
      <View style={s.topBar}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} activeOpacity={0.7}>
          <Text style={s.backArrow}>←</Text>
        </TouchableOpacity>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={C.lime} />}
      >
        {/* ── HEADER CARD ──────────────────────────────────────── */}
        <View style={[s.headerCard, { backgroundColor: spCfg.glow, borderBottomColor: spCfg.color }]}>
          <View style={s.headerBadgeRow}>
            <Text style={{ fontSize: 24 }}>{spCfg.emoji}</Text>
            <View style={[s.formatBadge, { backgroundColor: spCfg.color + '22' }]}>
              <Text style={[s.formatBadgeText, { color: spCfg.color }]}>
                {eventMeta.format.replace('_', ' ').toUpperCase()}
              </Text>
            </View>
            <View style={[s.statusBadge, { backgroundColor: stCfg.bg }]}>
              <Text style={[s.statusBadgeText, { color: stCfg.color }]}>{stCfg.label}</Text>
            </View>
          </View>
          <Text style={s.eventName}>{eventMeta.name}</Text>
          <View style={s.locationRow}>
            {eventMeta.venue && <Text style={s.locationText}>📍 {eventMeta.venue}</Text>}
            <Text style={s.locationText}>🏙️ {eventMeta.city}</Text>
            {eventMeta.starts_at && (
              <Text style={s.locationText}>
                📅 {new Date(eventMeta.starts_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
              </Text>
            )}
          </View>
        </View>

        {/* ── STATS STRIP ──────────────────────────────────────── */}
        <View style={s.statsStrip}>
          <View style={s.statCell}>
            <Text style={s.statValue}>{teams.length}/{eventMeta.max_teams ?? '∞'}</Text>
            <Text style={s.statLabel}>TEAMS</Text>
          </View>
          <View style={s.stripDivider} />
          <View style={s.statCell}>
            <Text style={s.statValue}>{matches.length}</Text>
            <Text style={s.statLabel}>MATCHES</Text>
          </View>
          <View style={s.stripDivider} />
          <View style={s.statCell}>
            <Text style={[s.statValue, { color: spCfg.color }]}>
              {eventMeta.format.replace('_', ' ').toUpperCase()}
            </Text>
            <Text style={s.statLabel}>FORMAT</Text>
          </View>
        </View>

        {/* ── TEAMS SECTION ────────────────────────────────────── */}
        <View style={s.sectionHeader}>
          <Text style={s.sectionLabel}>TEAMS</Text>
          {canRegister && eligibleTeams.length > 0 && (
            <TouchableOpacity
              style={s.sectionAction}
              onPress={handleRegister}
              disabled={registerMutation.isPending}
              activeOpacity={0.75}
            >
              <Text style={s.sectionActionText}>
                {registerMutation.isPending ? 'Registering…' : '+ Register'}
              </Text>
            </TouchableOpacity>
          )}
        </View>

        {teams.length === 0 ? (
          <View style={s.emptySection}>
            <Text style={s.emptyText}>No teams registered yet.</Text>
            {canRegister && (
              <TouchableOpacity
                style={[s.sectionCtaBtn, { borderColor: spCfg.color }]}
                onPress={handleRegister}
                activeOpacity={0.75}
              >
                <Text style={[s.sectionCtaText, { color: spCfg.color }]}>Register Your Team</Text>
              </TouchableOpacity>
            )}
          </View>
        ) : (
          <View style={s.card}>
            {teams.map(team => (
              <TeamRow key={team.id} team={team} sportColor={spCfg.color} />
            ))}
          </View>
        )}

        {/* ── MATCHES SECTION ──────────────────────────────────── */}
        <View style={s.sectionHeader}>
          <Text style={s.sectionLabel}>MATCHES</Text>
          {isOrganizer && (
            <TouchableOpacity
              style={s.sectionAction}
              onPress={() => router.push({
                pathname: '/create-match',
                params: { event_id: id, sport: eventMeta.sport_slug },
              })}
              activeOpacity={0.75}
            >
              <Text style={s.sectionActionText}>+ Add Match</Text>
            </TouchableOpacity>
          )}
        </View>

        {matches.length === 0 ? (
          <View style={s.emptySection}>
            <Text style={s.emptyText}>No matches scheduled yet.</Text>
            {isOrganizer && (
              <TouchableOpacity
                style={s.limeCtaBtn}
                onPress={() => router.push({
                  pathname: '/create-match',
                  params: { event_id: id, sport: eventMeta.sport_slug },
                })}
                activeOpacity={0.85}
              >
                <Text style={s.limeCtaText}>Create First Match →</Text>
              </TouchableOpacity>
            )}
          </View>
        ) : (
          <View style={s.matchesContainer}>
            {rounds.map(round => (
              <View key={round}>
                <Text style={s.roundLabel}>{round.toUpperCase()}</Text>
                {byRound[round].map(m => (
                  <TournamentMatchRow
                    key={m.id}
                    match={m}
                    onPress={() => router.push({ pathname: '/match/[id]', params: { id: m.id } })}
                  />
                ))}
              </View>
            ))}
          </View>
        )}

        <View style={{ height: 100 }} />
      </ScrollView>

      {/* ── STICKY BOTTOM ACTION ─────────────────────────────── */}
      {(canRegister && eligibleTeams.length > 0) && (
        <View style={s.stickyBottom}>
          <TouchableOpacity
            style={[s.limeCtaBtn, { flex: 1, marginHorizontal: 0, flexDirection: 'row', justifyContent: 'center', gap: 8 }]}
            onPress={handleRegister}
            disabled={registerMutation.isPending}
            activeOpacity={0.85}
          >
            {registerMutation.isPending
              ? <ActivityIndicator color={C.limeText} />
              : <Text style={s.limeCtaText}>Register Your Team →</Text>
            }
          </TouchableOpacity>
        </View>
      )}
    </SafeAreaView>
  )
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },

  topBar: {
    flexDirection: 'row', paddingHorizontal: 20, paddingTop: 4, paddingBottom: 8,
  },
  backBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: C.s2, borderWidth: 1, borderColor: C.b1,
    justifyContent: 'center', alignItems: 'center',
  },
  backArrow: { color: C.t1, fontSize: 20, fontWeight: '600', lineHeight: 22 },

  // Header card
  headerCard: {
    marginHorizontal: 16, borderRadius: 20, padding: 20, gap: 10,
    borderWidth: 1, borderColor: C.b1,
    borderBottomWidth: 2,
  },
  headerBadgeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  formatBadge:    { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 },
  formatBadgeText:{ fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  statusBadge:    { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 },
  statusBadgeText:{ fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  eventName:      { color: C.white, fontSize: 26, fontWeight: '800', letterSpacing: -0.5 },
  locationRow:    { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  locationText:   { color: C.t2, fontSize: 12 },

  // Stats strip
  statsStrip: {
    flexDirection: 'row', marginHorizontal: 16, marginTop: 10,
    backgroundColor: C.s1, borderRadius: 16, borderWidth: 1, borderColor: C.b0,
    paddingVertical: 16,
  },
  statCell:     { flex: 1, alignItems: 'center' },
  statValue:    { color: C.t1, fontSize: 22, fontWeight: '900', letterSpacing: -0.5 },
  statLabel:    { color: C.t3, fontSize: 10, fontWeight: '700', letterSpacing: 1.2, marginTop: 3 },
  stripDivider: { width: 1, backgroundColor: C.b1, marginVertical: 6 },

  // Section headers
  sectionHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginHorizontal: 22, marginTop: 24, marginBottom: 10,
  },
  sectionLabel:      { color: C.t3, fontSize: 11, fontWeight: '700', letterSpacing: 2 },
  sectionAction:     { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, backgroundColor: C.s2, borderWidth: 1, borderColor: C.b1 },
  sectionActionText: { color: C.lime, fontSize: 12, fontWeight: '700' },

  // Card container for teams
  card: {
    marginHorizontal: 16, backgroundColor: C.s1,
    borderRadius: 16, borderWidth: 1, borderColor: C.b0, overflow: 'hidden',
  },

  // Matches
  matchesContainer: { paddingHorizontal: 16 },
  roundLabel: {
    color: C.t3, fontSize: 10, fontWeight: '800', letterSpacing: 2,
    marginBottom: 8, marginTop: 6,
  },

  // Empty states
  emptySection: { alignItems: 'center', paddingVertical: 28, paddingHorizontal: 40, gap: 12 },
  emptyText:    { color: C.t3, fontSize: 14, textAlign: 'center' },
  sectionCtaBtn: {
    borderWidth: 1.5, borderRadius: 12,
    paddingHorizontal: 20, paddingVertical: 10,
  },
  sectionCtaText: { fontSize: 14, fontWeight: '700' },

  // Lime CTA
  limeCtaBtn: {
    marginHorizontal: 16, marginTop: 4,
    backgroundColor: C.lime, borderRadius: 14,
    paddingVertical: 16, paddingHorizontal: 22,
    alignItems: 'center',
  },
  limeCtaText: { color: C.limeText, fontSize: 15, fontWeight: '800' },

  // Sticky bottom
  stickyBottom: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: C.bg + 'ee',
    paddingHorizontal: 16, paddingVertical: 14,
    borderTopWidth: 1, borderTopColor: C.b1,
    flexDirection: 'row', gap: 10,
  },
})
