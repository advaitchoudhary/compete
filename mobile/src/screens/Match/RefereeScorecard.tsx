/**
 * RefereeScorecard — tap-to-score live officiating.
 * Loads both teams' rosters, gives each player a position picker + +/− counters
 * for the rating metrics. Team score auto-derives from goals. Clean-sheet bonus
 * is applied automatically by the engine (by position) when a team concedes 0.
 */
import { useEffect, useMemo, useState } from 'react'
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator } from 'react-native'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api/client'
import { C, FONT, SPACE, RADIUS, SPORT } from '../../theme'
import { notify } from '../../lib/dialog'

const SCORE_KEY: Record<string, string> = { football: 'goals', basketball: 'points', cricket: 'runs', badminton: 'sets_won' }

interface Props {
  matchId: string
  sportSlug: string
  homeTeamId: string
  awayTeamId: string
  homeTeamName: string
  awayTeamName: string
  statSchema: any
  onSaved?: () => void
}

interface PlayerState {
  userId: string
  teamId: string
  name: string
  position: string
  stats: Record<string, number>
}

const label = (k: string) => k.replace(/_/g, ' ')

export default function RefereeScorecard({
  matchId, sportSlug, homeTeamId, awayTeamId, homeTeamName, awayTeamName, statSchema, onSaved,
}: Props) {
  const qc = useQueryClient()
  const [players, setPlayers] = useState<Record<string, PlayerState>>({})
  const [saving, setSaving] = useState(false)

  // Rating metrics worth tapping (exclude clean_sheet — it's automatic)
  const metrics = useMemo(() => {
    const src = {
      ...(statSchema?.primary_metrics ?? {}),
      ...(statSchema?.batting_metrics ?? {}),
      ...(statSchema?.bowling_metrics ?? {}),
      ...(statSchema?.fielding_metrics ?? {}),
    }
    return Object.keys(src).filter((k) => k !== 'clean_sheet')
  }, [statSchema])
  const positions: string[] = statSchema?.positions ?? []

  const homeRoster = useQuery({ queryKey: ['team', homeTeamId], queryFn: () => api.get(`/teams/${homeTeamId}`).then((r) => r.data) })
  const awayRoster = useQuery({ queryKey: ['team', awayTeamId], queryFn: () => api.get(`/teams/${awayTeamId}`).then((r) => r.data) })

  // Seed local state from rosters once loaded
  useEffect(() => {
    if (!homeRoster.data || !awayRoster.data) return
    setPlayers((prev) => {
      if (Object.keys(prev).length) return prev // don't clobber edits on refetch
      const next: Record<string, PlayerState> = {}
      const add = (members: any[], teamId: string) =>
        (members ?? []).forEach((m: any) => {
          next[m.id] = {
            userId: m.id, teamId, name: m.name,
            position: m.position ?? '',
            stats: Object.fromEntries(metrics.map((k) => [k, 0])),
          }
        })
      add(homeRoster.data.members, homeTeamId)
      add(awayRoster.data.members, awayTeamId)
      return next
    })
  }, [homeRoster.data, awayRoster.data, metrics, homeTeamId, awayTeamId])

  const bump = (uid: string, metric: string, delta: number) =>
    setPlayers((prev) => ({
      ...prev,
      [uid]: { ...prev[uid], stats: { ...prev[uid].stats, [metric]: Math.max(0, (prev[uid].stats[metric] ?? 0) + delta) } },
    }))

  const setPos = (uid: string, pos: string) =>
    setPlayers((prev) => ({ ...prev, [uid]: { ...prev[uid], position: prev[uid].position === pos ? '' : pos } }))

  const save = async () => {
    setSaving(true)
    try {
      const all = Object.values(players)
      const k = SCORE_KEY[sportSlug] ?? 'goals'
      let homeGoals = 0, awayGoals = 0
      for (const p of all) {
        const g = Number(p.stats[k] ?? p.stats.goals ?? 0)
        if (p.teamId === homeTeamId) homeGoals += g; else awayGoals += g
      }
      for (const p of all) {
        const stats: Record<string, number> = { ...p.stats }
        // keeper concedes the opponent's goals (drives the GK rating)
        if (p.position === 'GK') stats.goals_conceded = p.teamId === homeTeamId ? awayGoals : homeGoals
        await api.post(`/matches/${matchId}/stats`, {
          user_id: p.userId, team_id: p.teamId, stats, position: p.position || undefined,
        })
      }
      await api.patch(`/matches/${matchId}/score`, { home_score: { [k]: homeGoals }, away_score: { [k]: awayGoals } })
      qc.invalidateQueries({ queryKey: ['match', matchId] })
      onSaved?.()
      notify('Saved', `Score ${homeGoals}–${awayGoals}. Stats recorded for ${all.length} players.`)
    } catch (e: any) {
      notify('Save failed', e?.response?.data?.error ?? 'Try again')
    } finally {
      setSaving(false)
    }
  }

  if (homeRoster.isLoading || awayRoster.isLoading) {
    return <ActivityIndicator color={C.lime} style={{ marginVertical: 40 }} />
  }

  const sport = SPORT[sportSlug] ?? SPORT.football
  const renderTeam = (teamId: string, name: string) => {
    const roster = Object.values(players).filter((p) => p.teamId === teamId)
    return (
      <View style={s.teamBlock}>
        <View style={[s.teamHeader, { borderLeftColor: sport.color }]}>
          <Text style={s.teamName}>{name}</Text>
          <Text style={s.teamCount}>{roster.length} players</Text>
        </View>
        {roster.map((p) => (
          <View key={p.userId} style={s.playerCard}>
            <Text style={s.playerName}>{p.name}</Text>

            {/* position picker */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.posRow}>
              {positions.map((pos) => {
                const on = p.position === pos
                return (
                  <TouchableOpacity key={pos} onPress={() => setPos(p.userId, pos)} activeOpacity={0.8}
                    style={[s.posChip, on && { borderColor: C.lime, backgroundColor: C.limeGlow }]}>
                    <Text style={[s.posText, { color: on ? C.lime : C.t3 }]}>{pos}</Text>
                  </TouchableOpacity>
                )
              })}
            </ScrollView>

            {/* metric counters */}
            <View style={s.metrics}>
              {metrics.map((m) => (
                <View key={m} style={s.metricRow}>
                  <Text style={s.metricLabel}>{label(m)}</Text>
                  <View style={s.stepper}>
                    <TouchableOpacity onPress={() => bump(p.userId, m, -1)} style={s.stepBtn} activeOpacity={0.7}
                      disabled={(p.stats[m] ?? 0) <= 0}>
                      <Text style={[s.stepSign, { opacity: (p.stats[m] ?? 0) <= 0 ? 0.3 : 1 }]}>−</Text>
                    </TouchableOpacity>
                    <Text style={s.stepVal}>{p.stats[m] ?? 0}</Text>
                    <TouchableOpacity onPress={() => bump(p.userId, m, 1)} style={s.stepBtn} activeOpacity={0.7}>
                      <Text style={[s.stepSign, { color: C.lime }]}>+</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ))}
            </View>
          </View>
        ))}
      </View>
    )
  }

  return (
    <View>
      {renderTeam(homeTeamId, homeTeamName)}
      {renderTeam(awayTeamId, awayTeamName)}
      <TouchableOpacity style={[s.saveBtn, saving && { opacity: 0.5 }]} onPress={save} disabled={saving} activeOpacity={0.85}>
        {saving ? <ActivityIndicator color={C.limeText} /> : <Text style={s.saveText}>Save Scorecard</Text>}
      </TouchableOpacity>
      <Text style={s.hint}>Tip: set a keeper/defender position so the clean-sheet bonus applies automatically.</Text>
    </View>
  )
}

const s = StyleSheet.create({
  teamBlock: { marginBottom: SPACE.lg },
  teamHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    borderLeftWidth: 3, paddingLeft: SPACE.md, marginBottom: SPACE.md, marginTop: SPACE.sm,
  },
  teamName: { color: C.t1, fontSize: 16, fontFamily: FONT.bold },
  teamCount: { color: C.t3, fontSize: 11, fontFamily: FONT.medium },

  playerCard: { backgroundColor: C.s1, borderRadius: RADIUS.md, borderWidth: 1, borderColor: C.b1, padding: SPACE.md, marginBottom: SPACE.sm },
  playerName: { color: C.t1, fontSize: 15, fontFamily: FONT.semibold, marginBottom: SPACE.sm },

  posRow: { gap: 6, paddingBottom: SPACE.sm },
  posChip: { borderWidth: 1, borderColor: C.b1, borderRadius: RADIUS.pill, paddingHorizontal: 11, paddingVertical: 5 },
  posText: { fontSize: 11, fontFamily: FONT.bold, letterSpacing: 0.5 },

  metrics: { gap: 4, marginTop: SPACE.xs },
  metricRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 3 },
  metricLabel: { color: C.t2, fontSize: 13, fontFamily: FONT.medium, textTransform: 'capitalize' },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md },
  stepBtn: { width: 34, height: 34, borderRadius: 17, backgroundColor: C.s3, borderWidth: 1, borderColor: C.b2, alignItems: 'center', justifyContent: 'center' },
  stepSign: { color: C.t1, fontSize: 20, fontFamily: FONT.bold, lineHeight: 24 },
  stepVal: { color: C.t1, fontSize: 16, fontFamily: FONT.black, minWidth: 22, textAlign: 'center' },

  saveBtn: { backgroundColor: C.lime, borderRadius: RADIUS.lg, paddingVertical: 16, alignItems: 'center', marginTop: SPACE.md },
  saveText: { color: C.limeText, fontSize: 16, fontFamily: FONT.bold },
  hint: { color: C.t3, fontSize: 11, fontFamily: FONT.regular, textAlign: 'center', marginTop: SPACE.sm, lineHeight: 16 },
})
