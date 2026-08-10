/**
 * PICKUP GAME CONTROL ROOM.
 *
 * Simpler than the tournament stepper because a pickup game has one real gate: it
 * either has enough players or it does not. Everything above that line is watching
 * the list fill, and everything below it is one press.
 *
 * The organizer's jobs, in order: share the link, watch it fill, pick a referee,
 * draw the sides.
 */
import { useState } from 'react'
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, Platform, Share,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../src/api/client'
import { C, FONT, SPACE, RADIUS, ELEV, TIER } from '../../../src/theme'
import { confirm, notify } from '../../../src/lib/dialog'

type Player = {
  user_id: string
  added_by: string | null
  status: 'confirmed' | 'waitlist' | 'withdrawn'
  position: string | null
  team_id: string | null
  name: string
  is_guest: boolean
  claimed_at: string | null
}

type GameDetail = {
  game: {
    id: string; name: string; status: string; city: string; venue: string | null
    players_per_side: number | null; match_duration_minutes: number | null
    starts_at: string | null; capacity: number; tier: string; organizer_id: string
  }
  /** Null until the sides are drawn. */
  match: {
    id: string
    status: string
    home_score: { goals?: number } | null
    away_score: { goals?: number } | null
    winner_team_id: string | null
  } | null
  confirmed_count: number
  spots_left: number
  waitlist_order: string[]
  players: Player[]
}

const errText = (e: any): string => {
  const err = e?.response?.data?.error
  if (typeof err === 'string') return err
  if (err?.fieldErrors) return Object.values(err.fieldErrors).flat().join(', ')
  return e?.message ?? 'Something went wrong'
}

export default function GameControlRoom() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const qc = useQueryClient()
  const [busy, setBusy] = useState<string | null>(null)

  const { data, isLoading, error } = useQuery<GameDetail>({
    queryKey: ['game', id],
    queryFn: async () => (await api.get(`/games/${id}`)).data,
    enabled: !!id,
    // People join while the organizer is looking at this screen.
    refetchInterval: 20_000,
  })

  const { data: refData } = useQuery<{ referees: any[] }>({
    queryKey: ['organizer', 'referees'],
    queryFn: async () => (await api.get('/organizer/referees')).data,
  })

  const { data: assigned } = useQuery<{ referees: any[] }>({
    queryKey: ['game', id, 'referee'],
    queryFn: async () => (await api.get(`/events/${id}/referees`)).data,
    enabled: !!id,
  })

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['game', id] })
    qc.invalidateQueries({ queryKey: ['organizer', 'games'] })
  }

  const run = async (key: string, fn: () => Promise<any>, onOk?: (r: any) => void) => {
    setBusy(key)
    try {
      const r = await fn()
      refresh()
      onOk?.(r)
    } catch (e) {
      notify('Not allowed', errText(e))
    } finally {
      setBusy(null)
    }
  }

  if (isLoading) return <View style={s.fill}><ActivityIndicator color={C.lime} size="large" /></View>
  if (error || !data) {
    return (
      <View style={s.fill}>
        <Text style={s.err}>{error ? errText(error) : 'Not found'}</Text>
        <TouchableOpacity onPress={() => router.back()}><Text style={s.link}>← Back</Text></TouchableOpacity>
      </View>
    )
  }

  const g = data.game
  const tier = TIER[g.tier] ?? TIER.amateur
  const confirmed = data.players.filter(p => p.status === 'confirmed')
  const waiting = data.players.filter(p => p.status === 'waitlist')
  const currentRef = assigned?.referees?.[0]
  const isFull = data.spots_left === 0
  const drawn = g.status === 'active' || g.status === 'completed'
  const sides = [...new Set(confirmed.map(p => p.team_id).filter(Boolean))] as string[]
  // Three states, not two. A drawn game can still be redrawn; one that has kicked
  // off cannot, and one that has been played is finished with.
  const kickedOff = Boolean(data.match && data.match.status !== 'scheduled')
  const played = data.match?.status === 'completed'
  const score =
    played && data.match?.home_score && data.match?.away_score
      ? `${data.match.home_score.goals ?? 0} – ${data.match.away_score.goals ?? 0}`
      : null

  const shareLink = async () => {
    const base = Platform.OS === 'web' && typeof window !== 'undefined' ? window.location.origin : ''
    const url = `${base}/g/${id}`
    const message =
      `${g.name} — ${g.players_per_side}v${g.players_per_side}${g.venue ? ` at ${g.venue}` : ''}. ` +
      `${data.spots_left} spot${data.spots_left === 1 ? '' : 's'} left. Put your name down: ${url}`
    if (Platform.OS === 'web') {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(message)
        notify('Link copied', 'Paste it into your WhatsApp group.')
      } else notify('Share this link', url)
    } else {
      await Share.share({ message })
    }
  }

  const removePlayer = (p: Player) => {
    const brought = data.players.filter(x => x.added_by === p.user_id && x.status !== 'withdrawn')
    confirm(
      `Remove ${p.name}?`,
      brought.length > 0
        ? `They brought ${brought.length} other player${brought.length === 1 ? '' : 's'}, who leave too — they were only coming along with them.`
        : 'Their spot frees up and the waitlist fills it.',
      () => run(`rm-${p.user_id}`, () => api.delete(`/games/${id}/players/${p.user_id}`)),
      'Remove'
    )
  }

  const draw = () =>
    run('draw', () => api.post(`/games/${id}/draw`, {}), (r) => {
      const d = r.data
      notify(
        'Sides drawn',
        `Colours ${d.sides.colours.average_rating} · Whites ${d.sides.whites.average_rating}\n` +
          `Balanced to within ${d.rating_gap.toFixed(1)} rating points.`
      )
    })

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <View style={s.header}>
        <TouchableOpacity style={s.back} onPress={() => router.back()} activeOpacity={0.7}>
          <Text style={s.backIcon}>←</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.eyebrow}>PICKUP GAME</Text>
          <Text style={s.title} numberOfLines={1}>{g.name}</Text>
        </View>
        <View style={[s.tierChip, { backgroundColor: tier.glow, borderColor: tier.color }]}>
          <Text style={[s.tierChipText, { color: tier.color }]}>{tier.label}</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 60 }} showsVerticalScrollIndicator={false}>
        <Text style={s.meta}>
          {g.players_per_side}v{g.players_per_side}
          {g.venue ? ` · ${g.venue}` : ''} · {g.city}
          {g.match_duration_minutes ? ` · ${g.match_duration_minutes}min` : ''}
        </Text>

        {/* ── How full ─────────────────────────────────────────────── */}
        <View style={s.card}>
          <View style={s.fillRow}>
            <Text style={s.fillCount}>
              {data.confirmed_count}<Text style={s.fillMax}>/{g.capacity}</Text>
            </Text>
            <View style={{ flex: 1 }}>
              <View style={s.track}>
                <View style={[s.trackFill, { width: `${(data.confirmed_count / g.capacity) * 100}%` }]} />
              </View>
              <Text style={s.fillLabel}>
                {isFull
                  ? 'Game is full'
                  : `${data.spots_left} spot${data.spots_left === 1 ? '' : 's'} left`}
                {waiting.length > 0 ? ` · ${waiting.length} waiting` : ''}
              </Text>
            </View>
          </View>

          {!drawn && (
            <TouchableOpacity style={s.shareBtn} onPress={shareLink} activeOpacity={0.85}>
              <Text style={s.shareText}>📋 Share the join link</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* ── Who's in ─────────────────────────────────────────────── */}
        <Text style={s.sectionLabel}>PLAYING</Text>
        <View style={s.card}>
          {confirmed.length === 0 && <Text style={s.emptyRow}>Nobody yet. Share the link.</Text>}
          {confirmed.map((p, i) => (
            <View key={p.user_id} style={s.playerRow}>
              <Text style={s.playerNum}>{i + 1}</Text>
              <View style={{ flex: 1 }}>
                <Text style={s.playerName} numberOfLines={1}>{p.name}</Text>
                <Text style={s.playerMeta}>
                  {p.position ?? 'any position'}
                  {p.added_by ? ' · brought along' : ''}
                  {p.is_guest && !p.claimed_at ? ' · guest' : ''}
                </Text>
              </View>
              {drawn && p.team_id && (
                <Text style={[s.sideTag, { color: p.team_id === sides[0] ? C.lime : C.blue }]}>
                  {p.team_id === sides[0] ? 'COLOURS' : 'WHITES'}
                </Text>
              )}
              {!drawn && (
                <TouchableOpacity onPress={() => removePlayer(p)} hitSlop={8} activeOpacity={0.6}>
                  <Text style={s.remove}>{busy === `rm-${p.user_id}` ? '…' : '✕'}</Text>
                </TouchableOpacity>
              )}
            </View>
          ))}
        </View>

        {/* ── Waitlist ─────────────────────────────────────────────── */}
        {waiting.length > 0 && (
          <>
            <Text style={s.sectionLabel}>WAITING</Text>
            <View style={s.card}>
              {waiting.map((p) => (
                <View key={p.user_id} style={s.playerRow}>
                  <Text style={s.playerNum}>
                    {data.waitlist_order.indexOf(p.user_id) + 1}
                  </Text>
                  <View style={{ flex: 1 }}>
                    <Text style={s.playerName} numberOfLines={1}>{p.name}</Text>
                    <Text style={s.playerMeta}>
                      {p.added_by ? 'brought along' : 'joined themselves'}
                    </Text>
                  </View>
                  {!drawn && (
                    <TouchableOpacity onPress={() => removePlayer(p)} hitSlop={8} activeOpacity={0.6}>
                      <Text style={s.remove}>✕</Text>
                    </TouchableOpacity>
                  )}
                </View>
              ))}
              <Text style={s.waitNote}>
                They come in automatically when a spot frees up. A group too big for
                the gap is skipped rather than left blocking the queue.
              </Text>
            </View>
          </>
        )}

        {/* ── Referee ──────────────────────────────────────────────── */}
        <Text style={s.sectionLabel}>REFEREE</Text>
        <View style={s.card}>
          {currentRef ? (
            <View style={s.playerRow}>
              <Text style={{ fontSize: 15 }}>🦓</Text>
              <View style={{ flex: 1 }}>
                <Text style={s.playerName}>{currentRef.name}</Text>
                <Text style={s.playerMeta}>will score the match</Text>
              </View>
            </View>
          ) : (
            <Text style={s.emptyRow}>Nobody assigned. The sides cannot be drawn without one.</Text>
          )}

          {!drawn && (
            <View style={s.refPicker}>
              {(refData?.referees ?? []).map((r: any) => {
                const on = currentRef?.user_id === r.id
                return (
                  <TouchableOpacity
                    key={r.id}
                    style={[s.refPill, on && { backgroundColor: C.limeGlow, borderColor: C.lime }]}
                    disabled={on || busy !== null}
                    onPress={() => run(`ref-${r.id}`, () => api.post(`/games/${id}/referee`, { user_id: r.id }))}
                    activeOpacity={0.8}
                  >
                    <Text style={[s.refPillText, on && { color: C.lime }]}>
                      {busy === `ref-${r.id}` ? '…' : r.name}
                    </Text>
                  </TouchableOpacity>
                )
              })}
            </View>
          )}
        </View>

        {/* ── Draw ─────────────────────────────────────────────────── */}
        {!drawn ? (
          <View style={s.card}>
            <Text style={s.drawTitle}>Draw the sides</Text>
            <Text style={s.drawBody}>
              Splits everyone into two teams with near-equal average rating. This is
              the bit a group chat can't do.
            </Text>
            {(!isFull || !currentRef) && (
              <View style={s.blockerBox}>
                {!isFull && (
                  <Text style={s.blockerItem}>
                    • {data.spots_left} more player{data.spots_left === 1 ? '' : 's'} needed
                  </Text>
                )}
                {!currentRef && <Text style={s.blockerItem}>• Assign a referee</Text>}
              </View>
            )}
            <TouchableOpacity
              style={[s.drawBtn, (!isFull || !currentRef) && { opacity: 0.35 }]}
              disabled={!isFull || !currentRef || busy !== null}
              onPress={draw}
              activeOpacity={0.85}
            >
              {busy === 'draw'
                ? <ActivityIndicator color={C.limeText} />
                : <Text style={s.drawBtnText}>Draw teams</Text>}
            </TouchableOpacity>
          </View>
        ) : (
          <View style={s.card}>
            <Text style={s.drawTitle}>
              {kickedOff ? (played ? 'Played' : 'Under way') : 'Sides are drawn'}
            </Text>
            <Text style={s.drawBody}>
              {played
                ? 'Everyone who played has a rating from it. Open the scorecard to see how it went.'
                : kickedOff
                  ? 'The referee is scoring it now.'
                  : 'The referee scores it from their own phone. Ratings follow.'}
            </Text>

            {played && score && (
              <Text style={s.finalScore}>{score}</Text>
            )}

            {data.match && (
              <TouchableOpacity
                style={s.secondaryBtn}
                onPress={() => router.push(`/match/${data.match!.id}`)}
                activeOpacity={0.85}
              >
                <Text style={s.secondaryText}>
                  {played ? 'Open the scorecard' : 'Follow the match'}
                </Text>
              </TouchableOpacity>
            )}

            {/* Redrawing tears down the match, so it is only on offer while nothing
                has kicked off — which is exactly what the endpoint enforces. */}
            {!kickedOff && (
              <TouchableOpacity
                style={s.secondaryBtn}
                onPress={() => run('redraw', () => api.post(`/games/${id}/draw`, {}))}
                activeOpacity={0.85}
              >
                <Text style={s.secondaryText}>
                  {busy === 'redraw' ? '…' : 'Redraw the sides'}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  )
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  fill: { flex: 1, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center', gap: SPACE.md },
  err: { color: C.red, fontSize: 14, fontFamily: FONT.medium, paddingHorizontal: SPACE.xl, textAlign: 'center' },
  link: { color: C.lime, fontSize: 14, fontFamily: FONT.semibold },

  header: {
    flexDirection: 'row', alignItems: 'center', gap: SPACE.md,
    paddingHorizontal: SPACE.lg, paddingTop: SPACE.sm, paddingBottom: SPACE.xs,
  },
  back: {
    width: 40, height: 40, borderRadius: RADIUS.pill, backgroundColor: C.s2,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.b1,
  },
  backIcon: { color: C.t1, fontSize: 18, fontFamily: FONT.bold },
  eyebrow: { color: C.t3, fontSize: 10, fontFamily: FONT.bold, letterSpacing: 2 },
  title: { color: C.t1, fontSize: 21, fontFamily: FONT.black, letterSpacing: -0.4 },
  tierChip: { paddingHorizontal: 9, paddingVertical: 4, borderRadius: RADIUS.sm, borderWidth: 1 },
  tierChipText: { fontSize: 9, fontFamily: FONT.bold, letterSpacing: 0.6 },
  meta: {
    color: C.t2, fontSize: 12, fontFamily: FONT.regular,
    paddingHorizontal: SPACE.lg, paddingBottom: SPACE.md,
  },

  sectionLabel: {
    color: C.t3, fontSize: 10, fontFamily: FONT.bold, letterSpacing: 1.5,
    marginHorizontal: SPACE.lg, marginTop: SPACE.lg, marginBottom: SPACE.sm,
  },
  card: {
    marginHorizontal: SPACE.lg, marginBottom: SPACE.sm, padding: SPACE.lg,
    backgroundColor: C.s1, borderRadius: RADIUS.lg, borderWidth: 1, borderColor: C.b1,
    gap: SPACE.sm,
  },

  fillRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md },
  fillCount: { color: C.t1, fontSize: 30, fontFamily: FONT.black },
  fillMax: { color: C.t3, fontSize: 15, fontFamily: FONT.medium },
  track: { height: 6, backgroundColor: C.s3, borderRadius: 3, overflow: 'hidden' },
  trackFill: { height: 6, backgroundColor: C.lime, borderRadius: 3 },
  fillLabel: { color: C.t2, fontSize: 11, fontFamily: FONT.medium, marginTop: 6 },

  shareBtn: {
    backgroundColor: C.s2, borderRadius: RADIUS.md, paddingVertical: 11, alignItems: 'center',
    borderWidth: 1, borderColor: C.b2, borderStyle: 'dashed',
  },
  shareText: { color: C.t1, fontSize: 12, fontFamily: FONT.semibold },

  playerRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingVertical: 7 },
  playerNum: { color: C.t3, fontSize: 11, fontFamily: FONT.bold, width: 18, textAlign: 'center' },
  playerName: { color: C.t1, fontSize: 14, fontFamily: FONT.semibold },
  playerMeta: { color: C.t3, fontSize: 10, fontFamily: FONT.regular, marginTop: 1 },
  sideTag: { fontSize: 9, fontFamily: FONT.bold, letterSpacing: 0.8 },
  remove: { color: C.t3, fontSize: 13, fontFamily: FONT.bold, paddingHorizontal: 4 },
  emptyRow: { color: C.t3, fontSize: 12, fontFamily: FONT.regular, fontStyle: 'italic' },
  waitNote: { color: C.t3, fontSize: 10, fontFamily: FONT.regular, lineHeight: 15, marginTop: 4 },

  refPicker: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: SPACE.sm },
  refPill: {
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: RADIUS.sm,
    backgroundColor: C.s3, borderWidth: 1, borderColor: C.b1,
  },
  refPillText: { color: C.t2, fontSize: 11, fontFamily: FONT.bold },

  drawTitle: { color: C.t1, fontSize: 16, fontFamily: FONT.bold },
  drawBody: { color: C.t2, fontSize: 12, fontFamily: FONT.regular, lineHeight: 18 },
  blockerBox: {
    backgroundColor: 'rgba(245,158,11,0.08)', borderRadius: RADIUS.md,
    borderWidth: 1, borderColor: 'rgba(245,158,11,0.3)', padding: SPACE.md, gap: 3,
  },
  blockerItem: { color: C.amber, fontSize: 12, fontFamily: FONT.medium },
  drawBtn: {
    backgroundColor: C.lime, borderRadius: RADIUS.md, paddingVertical: 14,
    alignItems: 'center', ...ELEV.glow(C.lime, 0.25),
  },
  drawBtnText: { color: C.limeText, fontSize: 15, fontFamily: FONT.bold },
  secondaryBtn: {
    backgroundColor: C.s3, borderRadius: RADIUS.md, paddingVertical: 12,
    alignItems: 'center', borderWidth: 1, borderColor: C.b1,
  },
  secondaryText: { color: C.t1, fontSize: 13, fontFamily: FONT.semibold },
  finalScore: {
    color: C.lime, fontSize: 30, fontFamily: FONT.black,
    letterSpacing: -1, textAlign: 'center', paddingVertical: 4,
  },
})
