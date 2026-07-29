/**
 * RatingOverride — referee "eye test" on top of the algorithm.
 *
 * 1. Ask the engine for a suggested 0–10 star for every player
 *    (POST /matches/:id/rating-suggestions → persists suggested_rating).
 * 2. The referee nudges each rating, but only within ±bound of the suggestion.
 * 3. Save the final ratings (POST /matches/:id/ratings).
 *
 * Only usable before the match is completed — afterwards ratings are locked.
 */
import { useState } from 'react'
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/client'
import { C, FONT, SPACE, RADIUS } from '../../theme'
import { notify } from '../../lib/dialog'

interface Props {
  matchId: string
  homeTeamId: string
  awayTeamId: string
  homeTeamName: string
  awayTeamName: string
  onSaved?: () => void
}

interface SuggestPlayer {
  user_id: string
  name: string
  team_id: string
  stats: Record<string, number | string>
  suggested_rating: string | number | null
  match_rating: string | number | null
  rating_overridden: boolean
}

const STEP = 0.5
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const round1 = (v: number) => Math.round(v * 2) / 2 // snap to 0.5

export default function RatingOverride({
  matchId, homeTeamId, awayTeamId, homeTeamName, awayTeamName, onSaved,
}: Props) {
  const qc = useQueryClient()
  const [bound, setBound] = useState(4)
  const [players, setPlayers] = useState<SuggestPlayer[] | null>(null)
  // edited rating per user_id
  const [edits, setEdits] = useState<Record<string, number>>({})

  const fetchSuggestions = useMutation({
    mutationFn: () =>
      api.post(`/matches/${matchId}/rating-suggestions`, {}).then((r) => r.data as {
        match_id: string; bound: number; players: SuggestPlayer[]
      }),
    onSuccess: (data) => {
      setBound(data.bound)
      setPlayers(data.players)
      // seed edits with the existing final rating, else the suggestion
      const seed: Record<string, number> = {}
      for (const p of data.players) {
        const base = p.match_rating ?? p.suggested_rating
        if (base != null) seed[p.user_id] = round1(Number(base))
      }
      setEdits(seed)
    },
    onError: (err: any) =>
      notify('Error', err?.response?.data?.error ?? 'Rating engine unavailable'),
  })

  const saveRatings = useMutation({
    mutationFn: () => {
      const ratings = (players ?? [])
        .filter((p) => p.suggested_rating != null && edits[p.user_id] != null)
        .map((p) => ({ user_id: p.user_id, rating: edits[p.user_id] }))
      return api.post(`/matches/${matchId}/ratings`, { ratings }).then((r) => r.data)
    },
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ['match', matchId] })
      onSaved?.()
      notify('Ratings saved', `${data?.saved ?? 0} player ratings updated.`)
    },
    onError: (err: any) => {
      const d = err?.response?.data
      const detail = Array.isArray(d?.details) ? `\n\n${d.details.join('\n')}` : ''
      notify('Error', `${d?.error ?? 'Failed to save ratings'}${detail}`)
    },
  })

  const bump = (p: SuggestPlayer, delta: number) => {
    if (p.suggested_rating == null) return
    const s = Number(p.suggested_rating)
    const lo = Math.max(0, s - bound)
    const hi = Math.min(10, s + bound)
    setEdits((prev) => ({
      ...prev,
      [p.user_id]: clamp(round1((prev[p.user_id] ?? s) + delta), lo, hi),
    }))
  }

  // ── Before suggestions are loaded: a single call-to-action ──────────────────
  if (!players) {
    return (
      <View style={s.card}>
        <Text style={s.title}>Referee rating override</Text>
        <Text style={s.subtitle}>
          Get the algorithm's suggested ratings from the current scorecard, then fine-tune
          each within ±{bound} stars before you complete the match.
        </Text>
        <TouchableOpacity
          style={[s.primaryBtn, fetchSuggestions.isPending && { opacity: 0.6 }]}
          onPress={() => fetchSuggestions.mutate()}
          disabled={fetchSuggestions.isPending}
          activeOpacity={0.85}
        >
          {fetchSuggestions.isPending
            ? <ActivityIndicator color={C.limeText} />
            : <Text style={s.primaryBtnText}>Get rating suggestions</Text>}
        </TouchableOpacity>
      </View>
    )
  }

  // ── Suggestions loaded: editable list grouped by team ───────────────────────
  const renderTeam = (teamId: string, name: string) => {
    const rows = players.filter((p) => p.team_id === teamId)
    if (rows.length === 0) return null
    return (
      <View key={teamId} style={{ marginBottom: SPACE.md }}>
        <Text style={s.teamHeader}>{name}</Text>
        {rows.map((p) => {
          const s0 = p.suggested_rating == null ? null : Number(p.suggested_rating)
          const val = edits[p.user_id] ?? (s0 ?? 0)
          const noSuggestion = s0 == null
          const overridden = s0 != null && Math.abs(val - s0) > 0.001
          const lo = s0 == null ? 0 : Math.max(0, s0 - bound)
          const hi = s0 == null ? 10 : Math.min(10, s0 + bound)
          return (
            <View key={p.user_id} style={s.playerRow}>
              <View style={{ flex: 1 }}>
                <Text style={s.playerName}>{p.name}</Text>
                <Text style={s.suggestText}>
                  {noSuggestion
                    ? 'no suggestion yet'
                    : `algo ${s0.toFixed(1)} · range ${lo.toFixed(1)}–${hi.toFixed(1)}`}
                </Text>
              </View>
              <View style={s.stepper}>
                <TouchableOpacity
                  onPress={() => bump(p, -STEP)} style={s.stepBtn} activeOpacity={0.7}
                  disabled={noSuggestion || val <= lo + 0.001}
                >
                  <Text style={[s.stepSign, { opacity: noSuggestion || val <= lo + 0.001 ? 0.3 : 1 }]}>−</Text>
                </TouchableOpacity>
                <Text style={[s.stepVal, overridden && { color: C.amber }]}>
                  {noSuggestion ? '—' : val.toFixed(1)}
                </Text>
                <TouchableOpacity
                  onPress={() => bump(p, STEP)} style={s.stepBtn} activeOpacity={0.7}
                  disabled={noSuggestion || val >= hi - 0.001}
                >
                  <Text style={[s.stepSign, { color: C.lime, opacity: noSuggestion || val >= hi - 0.001 ? 0.3 : 1 }]}>+</Text>
                </TouchableOpacity>
              </View>
            </View>
          )
        })}
      </View>
    )
  }

  return (
    <View style={s.card}>
      <View style={s.headerRow}>
        <Text style={s.title}>Adjust ratings</Text>
        <TouchableOpacity onPress={() => fetchSuggestions.mutate()} disabled={fetchSuggestions.isPending}>
          <Text style={s.refresh}>{fetchSuggestions.isPending ? '…' : '↻ re-suggest'}</Text>
        </TouchableOpacity>
      </View>
      <Text style={s.subtitle}>Within ±{bound} of the algorithm. Amber = overridden.</Text>

      {renderTeam(homeTeamId, homeTeamName)}
      {renderTeam(awayTeamId, awayTeamName)}

      <TouchableOpacity
        style={[s.primaryBtn, saveRatings.isPending && { opacity: 0.6 }]}
        onPress={() => saveRatings.mutate()}
        disabled={saveRatings.isPending}
        activeOpacity={0.85}
      >
        {saveRatings.isPending
          ? <ActivityIndicator color={C.limeText} />
          : <Text style={s.primaryBtnText}>Save ratings</Text>}
      </TouchableOpacity>
    </View>
  )
}

const s = StyleSheet.create({
  card: {
    backgroundColor: C.s1, borderRadius: RADIUS.md, borderWidth: 1, borderColor: C.b1,
    padding: SPACE.md, marginTop: SPACE.md,
  },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { color: C.t1, fontSize: 16, fontFamily: FONT.bold },
  refresh: { color: C.lime, fontSize: 12, fontFamily: FONT.semibold },
  subtitle: { color: C.t3, fontSize: 12, fontFamily: FONT.regular, marginTop: 4, marginBottom: SPACE.md, lineHeight: 17 },

  teamHeader: { color: C.t2, fontSize: 12, fontFamily: FONT.bold, letterSpacing: 0.5, marginBottom: SPACE.sm, marginTop: SPACE.xs },
  playerRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: SPACE.sm, borderBottomWidth: 1, borderBottomColor: C.b0,
  },
  playerName: { color: C.t1, fontSize: 14, fontFamily: FONT.semibold },
  suggestText: { color: C.t3, fontSize: 11, fontFamily: FONT.regular, marginTop: 2 },

  stepper: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  stepBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: C.s3, borderWidth: 1, borderColor: C.b2, alignItems: 'center', justifyContent: 'center' },
  stepSign: { color: C.t1, fontSize: 18, fontFamily: FONT.bold, lineHeight: 22 },
  stepVal: { color: C.t1, fontSize: 16, fontFamily: FONT.black, minWidth: 40, textAlign: 'center' },

  primaryBtn: { backgroundColor: C.lime, borderRadius: RADIUS.lg, paddingVertical: 14, alignItems: 'center', marginTop: SPACE.sm },
  primaryBtnText: { color: C.limeText, fontSize: 15, fontFamily: FONT.bold },
})
