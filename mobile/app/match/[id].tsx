/**
 * Match detail + live scoring screen.
 *
 * Sections:
 *  1. VS card (home vs away, live score)
 *  2. Score update panel (live matches only)
 *  3. Player stats (embeds LiveScorecard component for offline-aware submission)
 *  4. Bottom action button (Start / Confirm / Done)
 */

import { useState, useEffect, useMemo } from 'react'
import {
  ScrollView, View, Text, StyleSheet, Image,
  TouchableOpacity, ActivityIndicator, RefreshControl, Share, Platform,
} from 'react-native'
import { confirm, notify } from '../../src/lib/dialog'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuthStore } from '../../src/store/auth.store'
import { api } from '../../src/api/client'
import { C, SPORT } from '../../src/theme'
import RefereeScorecard from '../../src/screens/Match/RefereeScorecard'
import TournamentScorecard from '../../src/screens/Match/TournamentScorecard'
import RatingOverride from '../../src/screens/Match/RatingOverride'
import type { MatchDetail } from '../../src/types/tournament'

const STATUS_CFG = {
  scheduled: { label: 'SCHEDULED', color: C.amber, bg: 'rgba(245,158,11,0.14)' },
  live:      { label: 'LIVE',      color: C.green, bg: 'rgba(34,197,94,0.14)'  },
  completed: { label: 'COMPLETED', color: C.t3,    bg: C.s3                    },
  cancelled: { label: 'CANCELLED', color: C.t3,    bg: C.s3                    },
}

// Scores are stored as sport-agnostic JSON objects ({goals:2}, {points:78}, …).
const SCORE_KEY: Record<string, string> = {
  football: 'goals', basketball: 'points', cricket: 'runs', badminton: 'sets_won',
}
const scoreKeyFor = (slug?: string) => SCORE_KEY[slug ?? ''] ?? 'goals'

function scoreNum(score: any, slug?: string): number {
  if (score == null) return 0
  if (typeof score === 'number') return score
  const v = score[scoreKeyFor(slug)]
  return typeof v === 'number' ? v : Number(v) || 0
}

// ─── ScoreControl ─────────────────────────────────────────────────────────────

function ScoreControl({
  label, score, onIncrement, onDecrement,
}: {
  label: string; score: number; onIncrement: () => void; onDecrement: () => void
}) {
  return (
    <View style={sc.wrap}>
      <Text style={sc.label}>{label}</Text>
      <View style={sc.controls}>
        <TouchableOpacity
          style={[sc.btn, score <= 0 && { opacity: 0.3 }]}
          onPress={onDecrement}
          disabled={score <= 0}
          activeOpacity={0.7}
        >
          <Text style={sc.minus}>−</Text>
        </TouchableOpacity>
        <Text style={sc.score}>{score}</Text>
        <TouchableOpacity style={sc.btn} onPress={onIncrement} activeOpacity={0.7}>
          <Text style={sc.plus}>+</Text>
        </TouchableOpacity>
      </View>
    </View>
  )
}

const sc = StyleSheet.create({
  wrap:     { flex: 1, alignItems: 'center', gap: 10 },
  label:    { color: C.t3, fontSize: 10, fontWeight: '800', letterSpacing: 1.5 },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  btn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: C.s2, borderWidth: 1, borderColor: C.b2,
    justifyContent: 'center', alignItems: 'center',
  },
  minus: { color: C.t2, fontSize: 22, fontWeight: '600', lineHeight: 28 },
  plus:  { color: C.lime, fontSize: 22, fontWeight: '600', lineHeight: 28 },
  score: { color: C.white, fontSize: 32, fontWeight: '900', letterSpacing: -1, minWidth: 44, textAlign: 'center' },
})

// ─── PlayerStatRow ────────────────────────────────────────────────────────────

// Fallback avatar when a player has no avatar_url — initials generated from name.
const DEFAULT_AVATAR = (name?: string) =>
  `https://ui-avatars.com/api/?background=1f2937&color=fff&bold=true&name=${encodeURIComponent(name || 'Player')}`

/**
 * Colour per stat so a contribution is visible at a glance. A referee scanning
 * fourteen rows should not have to read "0 goals" and "1 goals" to tell them
 * apart — they were previously the same dim grey chip.
 */
const STAT_COLOR: Record<string, string> = {
  goals: C.lime,
  assists: C.blue,
  saves: C.amber,
  clean_sheet: C.green,
  tackles: C.indigo,
  interceptions: C.indigo,
  shots_on_target: C.purple,
}

/** "1 goals" reads like a bug. Only touches the plain trailing -s. */
const statLabel = (key: string, value: unknown) => {
  const words = key.replace(/_/g, ' ')
  return Number(value) === 1 && words.endsWith('s') ? words.slice(0, -1) : words
}

const isContribution = (v: unknown) => v === true || (typeof v === 'number' && v > 0)

function PlayerStatRow({
  stat, sportColor, onSendClaimLink, sending,
}: {
  stat: any
  sportColor: string
  onSendClaimLink?: (userId: string, name: string) => void
  sending?: boolean
}) {
  // Only an unclaimed guest has anything to claim. Someone who already owns their
  // profile must not be offered a link that would 409.
  const claimable = Boolean(onSendClaimLink && stat.is_guest && !stat.claimed_at)
  const stats: Record<string, unknown> = stat.stats ?? {}
  // Non-zero first, so the four we show are the four that say something. Sorting
  // after slicing would have let a lone goal fall off the end of a long stat line.
  const keys = Object.keys(stats)
    .sort((a, b) => Number(isContribution(stats[b])) - Number(isContribution(stats[a])))
    .slice(0, 4)
  const avatarUri = stat.avatar_url || DEFAULT_AVATAR(stat.name)

  return (
    <View style={ps.row}>
      <Image source={{ uri: avatarUri }} style={[ps.avatar, { borderColor: sportColor + '55' }]} />
      <View style={ps.info}>
        <Text style={ps.name}>{stat.name ?? '—'}</Text>
        {keys.length > 0 && (
          <View style={ps.statChips}>
            {keys.map(k => {
              const value = stats[k]
              const on = isContribution(value)
              const color = STAT_COLOR[k] ?? C.lime
              return (
                <View
                  key={k}
                  style={[ps.chip, on && { backgroundColor: color + '22', borderColor: color + '66' }]}
                >
                  <Text style={[ps.chipText, on && { color, fontWeight: '800' }]}>
                    {value === true ? '' : `${value} `}{statLabel(k, value)}
                  </Text>
                </View>
              )
            })}
          </View>
        )}
      </View>
      {claimable && (
        <TouchableOpacity
          style={ps.claimBtn}
          onPress={() => onSendClaimLink!(stat.user_id, stat.name)}
          disabled={sending}
          activeOpacity={0.8}
        >
          <Text style={ps.claimBtnText}>{sending ? '…' : 'Send link'}</Text>
        </TouchableOpacity>
      )}
      {stat.match_rating != null && (
        <Text style={[ps.rating, { color: sportColor }]}>
          {Number(stat.match_rating).toFixed(2)}
        </Text>
      )}
    </View>
  )
}

const ps = StyleSheet.create({
  row:      { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: C.b0 },
  avatar:   { width: 36, height: 36, borderRadius: 18, backgroundColor: C.s3, borderWidth: 1.5 },
  info:     { flex: 1, gap: 4 },
  name:     { color: C.t1, fontSize: 14, fontWeight: '600' },
  statChips:{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  chip:     { backgroundColor: C.s3, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 2,
              borderWidth: 1, borderColor: 'transparent' },
  chipText: { color: C.t3, fontSize: 10, fontWeight: '600' },
  rating:   { fontSize: 20, fontWeight: '900', letterSpacing: -0.5 },
  claimBtn: {
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8,
    borderWidth: 1, borderColor: C.lime + '77', backgroundColor: C.lime + '18',
  },
  claimBtnText: { color: C.lime, fontSize: 10, fontWeight: '800', letterSpacing: 0.3 },
})

// ─── Screen ───────────────────────────────────────────────────────────────────

export default function MatchDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const queryClient = useQueryClient()
  const { user } = useAuthStore()
  const [sendingClaim, setSendingClaim] = useState<string | null>(null)

  /**
   * Mint a claim link for a guest and hand it straight to WhatsApp.
   *
   * This is the moment that matters for the growth loop: the match has just been
   * rated, the guest is standing right there, and their captain or the referee has
   * their number. Until now the endpoint existed with nothing calling it, so a
   * guest's rating was unreachable unless someone ran curl.
   *
   * Native gets the OS share sheet (WhatsApp in one tap); web has no share sheet
   * worth using, so it copies instead.
   */
  const sendClaimLink = async (userId: string, name: string) => {
    setSendingClaim(userId)
    try {
      const res = await api.post(`/guests/${userId}/claim-link`, {})
      const url: string = res.data.claim_url
      const message =
        `${name} — you played today and you've been rated on every match. ` +
        `Claim your AllSports profile to keep it: ${url}`

      if (Platform.OS === 'web') {
        if (typeof navigator !== 'undefined' && navigator.clipboard) {
          await navigator.clipboard.writeText(message)
          notify('Link copied', `Paste it to ${name} on WhatsApp.\n\n${url}`)
        } else {
          notify(`Claim link for ${name}`, url)
        }
      } else {
        await Share.share({ message })
      }
      // The guest is unchanged until they actually claim, so nothing to refetch.
    } catch (e: any) {
      const err = e?.response?.data?.error
      notify("Couldn't create the link", typeof err === 'string' ? err : (e?.message ?? 'Failed'))
    } finally {
      setSendingClaim(null)
    }
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  const { data: match, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ['match', id],
    queryFn: () => api.get(`/matches/${id}`).then(r => r.data as MatchDetail),
    enabled: !!id,
    refetchInterval: (query) => {
      return query.state.data?.status === 'live' ? 10_000 : false
    },
  })

  const { data: sportsRaw } = useQuery({
    queryKey: ['sports'],
    queryFn: () => api.get('/sports').then(r => r.data),
  })

  const sportSchema = useMemo(() => {
    if (!match || !sportsRaw) return null
    const sports = Array.isArray(sportsRaw) ? sportsRaw : (sportsRaw?.data ?? [])
    const sport = sports.find((s: any) => s.slug === match.sport_slug)
    return sport?.stat_schema ?? null
  }, [match, sportsRaw])

  const spCfg = match
    ? (SPORT[match.sport_slug] ?? { color: C.blue, glow: 'rgba(59,130,246,0.10)', emoji: '🏅' })
    : { color: C.blue, glow: 'rgba(59,130,246,0.10)', emoji: '🏅' }

  const stCfg = match
    ? (STATUS_CFG[match.status as keyof typeof STATUS_CFG] ?? STATUS_CFG.scheduled)
    : STATUS_CFG.scheduled

  // ── Local score state (buffered for update panel) ──────────────────────────

  const [localHome, setLocalHome] = useState(0)
  const [localAway, setLocalAway] = useState(0)

  useEffect(() => {
    if (match) {
      setLocalHome(scoreNum(match.home_score, match.sport_slug))
      setLocalAway(scoreNum(match.away_score, match.sport_slug))
    }
  }, [match?.home_score, match?.away_score, match?.sport_slug])

  // ── Mutations ──────────────────────────────────────────────────────────────

  const startMatch = useMutation({
    mutationFn: () => api.patch(`/matches/${id}/start`, {}).then(r => r.data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['match', id] }),
    onError: (err: any) => {
      const d = err?.response?.data
      notify('Error', d?.error ?? d?.message ?? 'Failed to start match')
    },
  })

  const updateScore = useMutation({
    mutationFn: ({ home, away }: { home: number; away: number }) => {
      const k = scoreKeyFor(match?.sport_slug)
      return api
        .patch(`/matches/${id}/score`, { home_score: { [k]: home }, away_score: { [k]: away } })
        .then(r => r.data)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['match', id] }),
    onError: (err: any) => {
      const d = err?.response?.data
      notify('Error', d?.error ?? d?.message ?? 'Score update failed')
    },
  })

  const completeMatch = useMutation({
    mutationFn: () => api.post(`/matches/${id}/complete`, {}).then(r => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['match', id] })
      notify('✅ Match complete', 'The result is final — ratings are being computed.')
    },
    onError: (err: any) => {
      const d = err?.response?.data
      notify('Error', d?.error ?? d?.message ?? 'Failed to complete match')
    },
  })

  // ── Determine which team the current user captains ─────────────────────────
  // Simplified: pass home_team_id by default; backend enforces actual access control
  const myTeamId = match?.home_team_id ?? ''

  // ── Loading / Error ────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg }}>
        <ActivityIndicator color={C.lime} size="large" style={{ marginTop: 80 }} />
      </SafeAreaView>
    )
  }

  if (!match) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: C.bg, justifyContent: 'center', alignItems: 'center' }}>
        <Text style={{ color: C.t3, fontSize: 16 }}>Match not found.</Text>
        <TouchableOpacity onPress={() => router.back()} style={{ marginTop: 16 }}>
          <Text style={{ color: C.lime, fontSize: 15, fontWeight: '600' }}>← Go back</Text>
        </TouchableOpacity>
      </SafeAreaView>
    )
  }

  // ── Main render ────────────────────────────────────────────────────────────

  const isLive      = match.status === 'live'
  const isScheduled = match.status === 'scheduled'
  const isCompleted = match.status === 'completed'
  const hasScore    = match.home_score != null || match.away_score != null
  const isReferee   = !!user && (user.id === match.referee_id || (user as any).role === 'admin')
  // Roles the backend lets mint a claim link and that we can identify from the
  // session alone. Captains qualify too but the match payload doesn't say who
  // captains which team — see the note at the call site.
  const canSendClaimLinks =
    user?.role === 'referee' || user?.role === 'organizer' || user?.role === 'admin'

  return (
    <SafeAreaView style={s.container} edges={['top']}>
      {/* Header row */}
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()} style={s.backBtn} activeOpacity={0.7}>
          <Text style={s.backArrow}>←</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.eyebrow}>MATCH</Text>
          {match.round && <Text style={s.roundLabel}>{match.round.toUpperCase()}</Text>}
        </View>
        <View style={[s.statusBadge, { backgroundColor: stCfg.bg }]}>
          {isLive && <View style={s.livePulse} />}
          <Text style={[s.statusText, { color: stCfg.color }]}>{stCfg.label}</Text>
        </View>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={C.lime} />}
      >
        {/* ── VS CARD ────────────────────────────────────────── */}
        <View style={[s.vsCard, { borderTopColor: spCfg.color }]}>
          {/* Teams row */}
          <View style={s.teamsRow}>
            {/* Home team */}
            <View style={[s.teamSide, { alignItems: 'flex-start' }]}>
              <View style={[s.teamAvatar, { borderColor: spCfg.color + '66' }]}>
                <Text style={s.teamAvatarText}>{match.home_team_name?.[0]?.toUpperCase() ?? 'H'}</Text>
              </View>
              <Text style={s.teamName} numberOfLines={2}>{match.home_team_name}</Text>
            </View>

            {/* Score box */}
            <View style={s.scoreBox}>
              {(isLive || isCompleted) && hasScore ? (
                <Text style={s.scoreText}>
                  {scoreNum(match.home_score, match.sport_slug)} — {scoreNum(match.away_score, match.sport_slug)}
                </Text>
              ) : (
                <Text style={s.vsText}>VS</Text>
              )}
              {match.home_confirmed && (
                <Text style={s.confirmDots}>✓ {match.away_confirmed ? '✓' : '·'}</Text>
              )}
            </View>

            {/* Away team */}
            <View style={[s.teamSide, { alignItems: 'flex-end' }]}>
              <View style={[s.teamAvatar, { borderColor: spCfg.color + '66' }]}>
                <Text style={s.teamAvatarText}>{match.away_team_name?.[0]?.toUpperCase() ?? 'A'}</Text>
              </View>
              <Text style={[s.teamName, { textAlign: 'right' }]} numberOfLines={2}>
                {match.away_team_name}
              </Text>
            </View>
          </View>

          {/* Meta row */}
          <View style={s.metaRow}>
            {match.venue && <Text style={s.metaText}>📍 {match.venue}</Text>}
            {match.scheduled_at && (
              <Text style={s.metaText}>
                📅 {new Date(match.scheduled_at).toLocaleDateString('en-IN', {
                  weekday: 'short', day: 'numeric', month: 'short',
                })}
              </Text>
            )}
          </View>
        </View>

        {/* ── SCORE UPDATE PANEL (live only) ─────────────────── */}
        {isLive && (
          <>
            <Text style={s.sectionLabel}>UPDATE SCORE</Text>
            <View style={s.scorePanel}>
              <ScoreControl
                label={match.home_team_name.split(' ')[0].toUpperCase()}
                score={localHome}
                onIncrement={() => setLocalHome(v => v + 1)}
                onDecrement={() => setLocalHome(v => Math.max(0, v - 1))}
              />
              <View style={s.scorePanelDivider} />
              <ScoreControl
                label={match.away_team_name.split(' ')[0].toUpperCase()}
                score={localAway}
                onIncrement={() => setLocalAway(v => v + 1)}
                onDecrement={() => setLocalAway(v => Math.max(0, v - 1))}
              />
            </View>
            <TouchableOpacity
              style={[s.updateScoreBtn, updateScore.isPending && { opacity: 0.6 }]}
              onPress={() => updateScore.mutate({ home: localHome, away: localAway })}
              disabled={updateScore.isPending}
              activeOpacity={0.78}
            >
              {updateScore.isPending
                ? <ActivityIndicator color={C.lime} />
                : <Text style={s.updateScoreBtnText}>Update Score →</Text>
              }
            </TouchableOpacity>
          </>
        )}

        {/* ── PLAYER STATS ───────────────────────────────────── */}
        <Text style={s.sectionLabel}>PLAYER STATS</Text>

        {/* Existing stats from server — grouped by team */}
        {match.player_stats && match.player_stats.length > 0 && (
          <>
            {[
              { id: match.home_team_id, name: match.home_team_name },
              { id: match.away_team_id, name: match.away_team_name },
            ].map((team) => {
              const teamStats = match.player_stats.filter((p) => p.team_id === team.id)
              if (teamStats.length === 0) return null
              return (
                <View key={team.id}>
                  <Text style={[s.teamStatsHeader, { color: spCfg.color }]}>{team.name}</Text>
                  <View style={s.statsCard}>
                    {teamStats.map((stat, i) => (
                      <PlayerStatRow
                        key={stat.user_id ?? i}
                        stat={stat}
                        sportColor={spCfg.color}
                        // Captains may also mint links, but the match payload does
                        // not say who captains which team, so the button is shown
                        // to the roles we can identify here. The backend is the
                        // authority either way.
                        onSendClaimLink={canSendClaimLinks ? sendClaimLink : undefined}
                        sending={sendingClaim === stat.user_id}
                      />
                    ))}
                  </View>
                </View>
              )
            })}
          </>
        )}

        {/*
          Scoring. A tournament match gets the fast, single-screen scorecard —
          score → review → end — because a referee has ~90 seconds between
          whistles across 16 matches. A standalone match keeps the detailed
          scorecard plus the separate rating-override step, where there is time
          to record every metric and set positions properly.
        */}
        {(isLive || isScheduled) && isReferee && match.event_id && (
          <View style={{ marginHorizontal: 16, marginTop: 4 }}>
            <TournamentScorecard
              matchId={id}
              tier={match.tier}
              durationMinutes={match.duration_minutes}
              homeTeamId={match.home_team_id}
              awayTeamId={match.away_team_id}
              homeTeamName={match.home_team_name}
              awayTeamName={match.away_team_name}
              savedHomeGoals={Number((match.home_score as any)?.goals ?? 0)}
              savedAwayGoals={Number((match.away_score as any)?.goals ?? 0)}
              onFinished={() => refetch()}
            />
          </View>
        )}

        {(isLive || isScheduled) && sportSchema && isReferee && !match.event_id && (
          <View style={{ marginHorizontal: 16, marginTop: 4 }}>
            <RefereeScorecard
              matchId={id}
              sportSlug={match.sport_slug}
              homeTeamId={match.home_team_id}
              awayTeamId={match.away_team_id}
              homeTeamName={match.home_team_name}
              awayTeamName={match.away_team_name}
              statSchema={sportSchema}
              onSaved={() => refetch()}
            />
          </View>
        )}

        {/* Rating override — separate step for standalone matches only; the
            tournament scorecard has it built into its review phase. */}
        {isLive && isReferee && !match.event_id && (
          <View style={{ marginHorizontal: 16 }}>
            <RatingOverride
              matchId={id}
              homeTeamId={match.home_team_id}
              awayTeamId={match.away_team_id}
              homeTeamName={match.home_team_name}
              awayTeamName={match.away_team_name}
              onSaved={() => refetch()}
            />
          </View>
        )}

        {isCompleted && match.player_stats?.length === 0 && (
          <View style={s.emptyStats}>
            <Text style={s.emptyStatsText}>No player stats recorded for this match.</Text>
          </View>
        )}

        <View style={{ height: 120 }} />
      </ScrollView>

      {/* ── BOTTOM ACTION ──────────────────────────────────── */}
      <View style={s.bottomAction}>
        {isScheduled && (
          <TouchableOpacity
            style={[s.actionBtn, startMatch.isPending && { opacity: 0.6 }]}
            onPress={() =>
              confirm('Start Match?', 'This will set the match to Live.', () => startMatch.mutate(), 'Start')
            }
            disabled={startMatch.isPending}
            activeOpacity={0.85}
          >
            {startMatch.isPending
              ? <ActivityIndicator color={C.limeText} />
              : <>
                  <Text style={s.actionBtnText}>Start Match</Text>
                  <Text style={s.actionBtnArrow}>→</Text>
                </>
            }
          </TouchableOpacity>
        )}

        {isLive && isReferee && (
          <TouchableOpacity
            style={[s.actionBtn, completeMatch.isPending && { opacity: 0.6 }]}
            onPress={() =>
              confirm('Complete Match?', 'This finalizes the result and computes ratings. Make sure the scorecard is saved first.', () => completeMatch.mutate(), 'Complete')
            }
            disabled={completeMatch.isPending}
            activeOpacity={0.85}
          >
            {completeMatch.isPending
              ? <ActivityIndicator color={C.limeText} />
              : <>
                  <Text style={s.actionBtnText}>Complete Match</Text>
                  <Text style={s.actionBtnArrow}>✓</Text>
                </>
            }
          </TouchableOpacity>
        )}
        {isLive && !isReferee && (
          <View style={s.completedBadge}>
            <Text style={s.completedText}>Match in progress — the referee will finalize it</Text>
          </View>
        )}

        {isCompleted && (
          <View style={s.completedBadge}>
            <Text style={s.completedText}>Match Complete ✓</Text>
            {match.winner_team_id === match.home_team_id && (
              <Text style={s.winnerText}>🏆 {match.home_team_name} won</Text>
            )}
            {match.winner_team_id === match.away_team_id && (
              <Text style={s.winnerText}>🏆 {match.away_team_name} won</Text>
            )}
          </View>
        )}
      </View>
    </SafeAreaView>
  )
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },

  // Header
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 20, paddingTop: 8, paddingBottom: 12, gap: 12,
  },
  backBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: C.s2, borderWidth: 1, borderColor: C.b1,
    justifyContent: 'center', alignItems: 'center',
  },
  backArrow:   { color: C.t1, fontSize: 20, fontWeight: '600', lineHeight: 22 },
  eyebrow:     { color: C.t3, fontSize: 11, fontWeight: '700', letterSpacing: 2 },
  roundLabel:  { color: C.t2, fontSize: 12, fontWeight: '600', marginTop: 2 },
  statusBadge: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20 },
  statusText:  { fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  livePulse:   { width: 6, height: 6, borderRadius: 3, backgroundColor: C.green },

  // VS card
  vsCard: {
    marginHorizontal: 16, marginTop: 4,
    backgroundColor: C.s1, borderRadius: 20,
    borderWidth: 1, borderColor: C.b1, borderTopWidth: 2.5,
    padding: 20, gap: 16,
  },
  teamsRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  teamSide: { flex: 1, gap: 8 },
  teamAvatar: {
    width: 48, height: 48, borderRadius: 24,
    backgroundColor: C.s3, borderWidth: 2,
    justifyContent: 'center', alignItems: 'center',
  },
  teamAvatarText: { color: C.white, fontSize: 20, fontWeight: '800' },
  teamName:       { color: C.t1, fontSize: 14, fontWeight: '700', lineHeight: 20 },
  scoreBox:       { alignItems: 'center', gap: 4 },
  scoreText:      { color: C.white, fontSize: 36, fontWeight: '900', letterSpacing: -1 },
  vsText:         { color: C.t3, fontSize: 20, fontWeight: '800', letterSpacing: 2 },
  confirmDots:    { color: C.lime, fontSize: 12, fontWeight: '700' },
  metaRow:        { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  metaText:       { color: C.t3, fontSize: 12 },

  // Score update panel
  sectionLabel: {
    color: C.t3, fontSize: 11, fontWeight: '700', letterSpacing: 2,
    marginHorizontal: 22, marginTop: 24, marginBottom: 12,
  },
  scorePanel: {
    flexDirection: 'row', marginHorizontal: 16,
    backgroundColor: C.s1, borderRadius: 16,
    borderWidth: 1, borderColor: C.b0, padding: 20, gap: 8,
  },
  scorePanelDivider: { width: 1, backgroundColor: C.b1, marginVertical: 4 },
  updateScoreBtn: {
    marginHorizontal: 16, marginTop: 10,
    backgroundColor: C.s2, borderRadius: 12, borderWidth: 1, borderColor: C.b2,
    paddingVertical: 13, alignItems: 'center',
  },
  updateScoreBtnText: { color: C.lime, fontSize: 14, fontWeight: '700' },

  // Player stats
  teamStatsHeader: {
    fontSize: 13, fontWeight: '800', letterSpacing: 0.5,
    marginHorizontal: 22, marginTop: 16, marginBottom: 8,
  },
  statsCard: {
    marginHorizontal: 16, backgroundColor: C.s1,
    borderRadius: 16, borderWidth: 1, borderColor: C.b0, overflow: 'hidden',
  },
  liveScorecardWrap: {
    marginHorizontal: 16, marginTop: 12,
    backgroundColor: C.s1, borderRadius: 16,
    borderWidth: 1, borderColor: C.b0, overflow: 'hidden',
    padding: 4,
  },
  emptyStats: { alignItems: 'center', paddingVertical: 24 },
  emptyStatsText: { color: C.t3, fontSize: 13 },

  // Bottom action
  bottomAction: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: C.bg + 'f0',
    paddingHorizontal: 16, paddingVertical: 14,
    borderTopWidth: 1, borderTopColor: C.b1,
  },
  actionBtn: {
    backgroundColor: C.lime, borderRadius: 16,
    paddingVertical: 18, paddingHorizontal: 24,
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
  },
  actionBtnText:  { color: C.limeText, fontSize: 17, fontWeight: '800' },
  actionBtnArrow: { color: C.limeText, fontSize: 22, fontWeight: '700' },
  completedBadge: {
    backgroundColor: C.s1, borderRadius: 14, borderWidth: 1, borderColor: C.b1,
    paddingVertical: 14, paddingHorizontal: 20, alignItems: 'center', gap: 4,
  },
  completedText: { color: C.t2, fontSize: 14, fontWeight: '700' },
  winnerText:    { color: C.lime, fontSize: 15, fontWeight: '800' },
})
