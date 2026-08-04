/**
 * TournamentScorecard — scoring built for a tournament day, not a single match.
 *
 * The design constraint is the referee: ~90 seconds between whistles, outdoors,
 * often one-handed, 12 players to account for, 16 matches to get through. So the
 * governing rule here is **doing nothing must be correct** — every default is
 * already right and the referee only touches what they disagree with.
 *
 * Concretely, versus RefereeScorecard (which stays for standalone matches):
 *   - 3 tappable stats (goals, assists, saves) instead of every schema metric.
 *     For football that is ~36 controls instead of ~144.
 *   - one GK tap per team instead of a 10-position picker per player. GK is the
 *     only position with a large rating baseline difference, and tapping it also
 *     fills goals_conceded automatically.
 *   - one batched request instead of a sequential POST per player.
 *   - score → review → end in a single screen, so the referee never navigates.
 *
 * Flow (spec §3.4 / §3.4.1). Completion must stay last: it is what locks ratings.
 *   1. POST /matches/:id/stats/batch
 *   2. PATCH /matches/:id/score
 *   3. POST /matches/:id/rating-suggestions   → algorithm's 0–10 per player
 *   4. POST /matches/:id/ratings              → referee's values, each within ±4
 *   5. POST /matches/:id/complete             → locks ratings, advances bracket
 */
import { useEffect, useMemo, useState } from 'react'
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
} from 'react-native'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { v4 as uuidv4 } from 'uuid'
import { api } from '../../api/client'
import { C, FONT, SPACE, RADIUS, TIER, ELEV, ratingTone } from '../../theme'
import { notify } from '../../lib/dialog'

/** The only stats worth a tap when there are 90 seconds between whistles. */
const FAST_STATS = [
  { key: 'goals', badge: 'G', label: 'Goals' },
  { key: 'assists', badge: 'A', label: 'Assists' },
  { key: 'saves', badge: 'SV', label: 'Saves' },
] as const

type StatKey = (typeof FAST_STATS)[number]['key']

interface Props {
  matchId: string
  tier?: string
  durationMinutes?: number | null
  homeTeamId: string
  awayTeamId: string
  homeTeamName: string
  awayTeamName: string
  onFinished?: () => void
  /**
   * The score already saved on the match, if any. Used as the displayed score
   * until the referee starts tapping — otherwise resuming into the review phase
   * would show 0–0 for a match that already has a scoreline.
   */
  savedHomeGoals?: number
  savedAwayGoals?: number
  /** Dev-only: jump straight to the review phase so it can be inspected. */
  startPhase?: 'score' | 'rate'
}

interface PlayerRow {
  userId: string
  teamId: string
  name: string
  isGk: boolean
  stats: Record<StatKey, number>
}

interface Suggestion {
  userId: string
  name: string
  teamId: string
  suggested: number
  value: number
}

export default function TournamentScorecard({
  matchId,
  tier = 'amateur',
  durationMinutes,
  homeTeamId,
  awayTeamId,
  homeTeamName,
  awayTeamName,
  onFinished,
  savedHomeGoals = 0,
  savedAwayGoals = 0,
  startPhase = 'score',
}: Props) {
  const qc = useQueryClient()
  const [players, setPlayers] = useState<Record<string, PlayerRow>>({})
  const [phase, setPhase] = useState<'score' | 'rate'>(startPhase)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [bound, setBound] = useState(4)
  const [busy, setBusy] = useState(false)

  const homeRoster = useQuery({
    queryKey: ['team', homeTeamId],
    queryFn: () => api.get(`/teams/${homeTeamId}`).then((r) => r.data),
  })
  const awayRoster = useQuery({
    queryKey: ['team', awayTeamId],
    queryFn: () => api.get(`/teams/${awayTeamId}`).then((r) => r.data),
  })

  useEffect(() => {
    if (!homeRoster.data || !awayRoster.data) return
    setPlayers((prev) => {
      if (Object.keys(prev).length) return prev // never clobber in-progress edits
      const next: Record<string, PlayerRow> = {}
      const add = (members: any[], teamId: string) =>
        (members ?? []).forEach((m: any) => {
          next[m.id] = {
            userId: m.id,
            teamId,
            name: m.name,
            isGk: false,
            stats: { goals: 0, assists: 0, saves: 0 },
          }
        })
      add(homeRoster.data.members, homeTeamId)
      add(awayRoster.data.members, awayTeamId)
      return next
    })
  }, [homeRoster.data, awayRoster.data, homeTeamId, awayTeamId])

  const roster = useMemo(() => Object.values(players), [players])

  // The score is derived from goals — never typed separately, so it can't disagree
  // with the stats. Until a goal has actually been tapped we show whatever score
  // is already saved on the match, so resuming into review doesn't read 0–0 for a
  // match that was already scored.
  const { homeGoals, awayGoals } = useMemo(() => {
    let h = 0
    let a = 0
    let tapped = 0
    for (const p of roster) {
      tapped += p.stats.goals
      if (p.teamId === homeTeamId) h += p.stats.goals
      else a += p.stats.goals
    }
    if (tapped === 0) return { homeGoals: savedHomeGoals, awayGoals: savedAwayGoals }
    return { homeGoals: h, awayGoals: a }
  }, [roster, homeTeamId, savedHomeGoals, savedAwayGoals])

  const bump = (uid: string, key: StatKey, delta: number) =>
    setPlayers((prev) => ({
      ...prev,
      [uid]: {
        ...prev[uid],
        stats: {
          ...prev[uid].stats,
          [key]: Math.max(0, prev[uid].stats[key] + delta),
        },
      },
    }))

  /** One keeper per team — tapping a new one releases the old. */
  const setGk = (uid: string, teamId: string) =>
    setPlayers((prev) => {
      const next = { ...prev }
      for (const id of Object.keys(next)) {
        if (next[id].teamId !== teamId) continue
        next[id] = { ...next[id], isGk: id === uid ? !next[id].isGk : false }
      }
      return next
    })

  /**
   * Pull the algorithm's 0–10 per player and pre-fill the review list.
   *
   * Pre-fills with the referee's own earlier value when one exists, otherwise the
   * algorithm's suggestion — so accepting everything requires no input at all,
   * which is the normal case.
   */
  const loadSuggestions = async () => {
    const res = await api.post(`/matches/${matchId}/rating-suggestions`, {})
    const data = res.data as {
      bound: number
      players: Array<{
        user_id: string
        name: string
        team_id: string
        suggested_rating: string | number | null
        match_rating: string | number | null
      }>
    }
    setBound(data.bound ?? 4)
    setSuggestions(
      data.players.map((p) => {
        const suggested = Number(p.suggested_rating ?? 0)
        const existing = p.match_rating === null ? null : Number(p.match_rating)
        return {
          userId: p.user_id,
          name: p.name,
          teamId: p.team_id,
          suggested,
          value: existing ?? suggested,
        }
      })
    )
  }

  // Resuming straight into review (dev preview, or an app reload mid-review).
  useEffect(() => {
    if (startPhase !== 'rate' || suggestions.length > 0) return
    loadSuggestions().catch(() => {
      notify('Could not load ratings', 'Save the stats first.')
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startPhase])

  // ── Step 1: save stats + score, then pull the algorithm's suggestions ──────
  const review = async () => {
    setBusy(true)
    try {
      const now = new Date().toISOString()
      const entries = roster.map((p) => {
        const stats: Record<string, number> = { ...p.stats }
        if (p.isGk) {
          // A keeper's rating hinges on what they conceded — derive it so the
          // referee never has to enter the opponent's total by hand.
          stats.goals_conceded = p.teamId === homeTeamId ? awayGoals : homeGoals
        }
        return {
          user_id: p.userId,
          team_id: p.teamId,
          stats,
          position: p.isGk ? 'GK' : undefined,
          client_event_id: uuidv4(),
          client_timestamp: now,
        }
      })

      await api.post(`/matches/${matchId}/stats/batch`, { entries })
      await api.patch(`/matches/${matchId}/score`, {
        home_score: { goals: homeGoals },
        away_score: { goals: awayGoals },
      })

      await loadSuggestions()
      setPhase('rate')
    } catch (e: any) {
      notify('Could not save', e?.response?.data?.error ?? 'Check your connection and try again')
    } finally {
      setBusy(false)
    }
  }

  const nudge = (uid: string, delta: number) =>
    setSuggestions((prev) =>
      prev.map((s) => {
        if (s.userId !== uid) return s
        const raw = Math.round((s.value + delta) * 10) / 10
        // Hard-bound to ±bound of the suggestion so an out-of-range value is
        // impossible to enter, rather than rejected after the fact.
        const lo = Math.max(0, s.suggested - bound)
        const hi = Math.min(10, s.suggested + bound)
        return { ...s, value: Math.min(hi, Math.max(lo, raw)) }
      })
    )

  // ── Step 2: approve ratings, then complete. Completion locks the ratings, so
  // it must be the last thing that happens.
  const endMatch = async () => {
    setBusy(true)
    try {
      await api.post(`/matches/${matchId}/ratings`, {
        ratings: suggestions.map((s) => ({ user_id: s.userId, rating: s.value })),
      })
      await api.post(`/matches/${matchId}/complete`)
      qc.invalidateQueries({ queryKey: ['match', matchId] })
      onFinished?.()
      notify('Match complete', `${homeGoals}–${awayGoals} recorded. Ratings locked in.`)
    } catch (e: any) {
      notify('Could not finish', e?.response?.data?.error ?? 'Try again')
    } finally {
      setBusy(false)
    }
  }

  if (homeRoster.isLoading || awayRoster.isLoading) {
    return <ActivityIndicator color={C.lime} style={{ marginVertical: 40 }} />
  }

  const tierCfg = TIER[tier] ?? TIER.amateur
  const changed = suggestions.filter((s) => Math.abs(s.value - s.suggested) > 0.05).length

  return (
    <View>
      {/* ── Scoreboard ─────────────────────────────────────────────────────── */}
      <View style={[s.board, ELEV.card]}>
        <View style={s.boardMeta}>
          <View style={[s.tierChip, { borderColor: tierCfg.color, backgroundColor: tierCfg.glow }]}>
            <Text style={[s.tierText, { color: tierCfg.color }]}>{tierCfg.short}</Text>
          </View>
          {durationMinutes ? <Text style={s.metaText}>{durationMinutes} MIN</Text> : null}
        </View>

        <View style={s.scoreRow}>
          <Text style={s.scoreNum}>{homeGoals}</Text>
          <Text style={s.scoreDash}>–</Text>
          <Text style={s.scoreNum}>{awayGoals}</Text>
        </View>

        <View style={s.scoreNames}>
          <Text style={s.scoreTeam} numberOfLines={1}>{homeTeamName}</Text>
          <Text style={s.scoreTeam} numberOfLines={1}>{awayTeamName}</Text>
        </View>
      </View>

      {phase === 'score' ? (
        <>
          {[
            { id: homeTeamId, name: homeTeamName },
            { id: awayTeamId, name: awayTeamName },
          ].map((team) => {
            const squad = roster.filter((p) => p.teamId === team.id)
            return (
            <View key={team.id} style={s.teamBlock}>
              <Text style={s.teamName}>{team.name}</Text>
              {/* An empty squad must say so. Rendering a blank team would leave a
                  referee tapping at nothing and wondering why. */}
              {squad.length === 0 && (
                <View style={s.emptySquad}>
                  <Text style={s.emptySquadText}>
                    No players registered for this team — nothing to score yet.
                  </Text>
                </View>
              )}
              {squad
                .map((p) => (
                  <View key={p.userId} style={[s.card, p.isGk && s.cardGk]}>
                    <View style={s.cardTop}>
                      <Text style={s.playerName} numberOfLines={1}>{p.name}</Text>
                      <TouchableOpacity
                        onPress={() => setGk(p.userId, p.teamId)}
                        activeOpacity={0.8}
                        style={[s.gkBtn, p.isGk && { borderColor: C.lime, backgroundColor: C.limeGlow }]}
                      >
                        <Text style={[s.gkText, { color: p.isGk ? C.lime : C.t3 }]}>GK</Text>
                      </TouchableOpacity>
                    </View>

                    <View style={s.statRow}>
                      {FAST_STATS.map((stat) => {
                        const val = p.stats[stat.key]
                        const on = val > 0
                        return (
                          <View key={stat.key} style={s.statGroup}>
                            <TouchableOpacity
                              onPress={() => bump(p.userId, stat.key, -1)}
                              disabled={val <= 0}
                              activeOpacity={0.7}
                              style={s.tapMinus}
                            >
                              <Text style={[s.tapSign, { opacity: val <= 0 ? 0.25 : 0.75 }]}>−</Text>
                            </TouchableOpacity>

                            <TouchableOpacity
                              onPress={() => bump(p.userId, stat.key, 1)}
                              activeOpacity={0.75}
                              style={[s.tapMain, on && { borderColor: C.lime, backgroundColor: C.limeGlow }]}
                            >
                              <Text style={[s.tapVal, on && { color: C.lime }]}>{val}</Text>
                              <Text style={[s.tapBadge, on && { color: C.lime }]}>{stat.badge}</Text>
                            </TouchableOpacity>
                          </View>
                        )
                      })}
                    </View>
                  </View>
                ))}
            </View>
            )
          })}

          <TouchableOpacity
            style={[s.primary, (busy || roster.length === 0) && { opacity: 0.5 }]}
            onPress={review}
            disabled={busy || roster.length === 0}
            activeOpacity={0.85}
          >
            {busy ? (
              <ActivityIndicator color={C.limeText} />
            ) : (
              <Text style={s.primaryText}>Review ratings →</Text>
            )}
          </TouchableOpacity>
          <Text style={s.hint}>
            Tap a number to add, − to correct. Mark each keeper so their clean sheet counts.
          </Text>
        </>
      ) : (
        <>
          <View style={s.reviewHead}>
            <Text style={s.reviewTitle}>Approve ratings</Text>
            <Text style={s.reviewSub}>
              Pre-filled by the algorithm — change only what you disagree with. Limit ±{bound}.
            </Text>
          </View>

          {suggestions.map((sg) => {
            const tone = ratingTone(sg.value * 10)
            const moved = Math.abs(sg.value - sg.suggested) > 0.05
            return (
              <View key={sg.userId} style={s.rateCard}>
                <View style={{ flex: 1 }}>
                  <Text style={s.playerName} numberOfLines={1}>{sg.name}</Text>
                  <Text style={s.rateMeta}>
                    {moved ? `algorithm said ${sg.suggested.toFixed(1)}` : 'algorithm’s rating'}
                  </Text>
                </View>

                <TouchableOpacity onPress={() => nudge(sg.userId, -0.5)} activeOpacity={0.7} style={s.rateBtn}>
                  <Text style={s.tapSign}>−</Text>
                </TouchableOpacity>

                <Text style={[s.rateVal, { color: moved ? tone.color : C.t1 }]}>
                  {sg.value.toFixed(1)}
                </Text>

                <TouchableOpacity onPress={() => nudge(sg.userId, 0.5)} activeOpacity={0.7} style={s.rateBtn}>
                  <Text style={[s.tapSign, { color: C.lime }]}>+</Text>
                </TouchableOpacity>
              </View>
            )
          })}

          <TouchableOpacity
            style={[s.primary, busy && { opacity: 0.5 }]}
            onPress={endMatch}
            disabled={busy}
            activeOpacity={0.85}
          >
            {busy ? (
              <ActivityIndicator color={C.limeText} />
            ) : (
              <Text style={s.primaryText}>End match · {homeGoals}–{awayGoals}</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity onPress={() => setPhase('score')} activeOpacity={0.7} style={s.back}>
            <Text style={s.backText}>← Back to stats</Text>
          </TouchableOpacity>

          <Text style={s.hint}>
            {changed === 0
              ? 'Accepting every suggestion as-is is fine — that is the normal case.'
              : `${changed} rating${changed === 1 ? '' : 's'} adjusted. Ending the match locks them.`}
          </Text>
        </>
      )}
    </View>
  )
}

const s = StyleSheet.create({
  // ── scoreboard ──────────────────────────────────────────────────────────────
  board: {
    backgroundColor: C.s1,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: C.b1,
    paddingVertical: SPACE.lg,
    paddingHorizontal: SPACE.lg,
    marginBottom: SPACE.lg,
  },
  boardMeta: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  tierChip: {
    borderWidth: 1,
    borderRadius: RADIUS.pill,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  tierText: { fontSize: 10, fontFamily: FONT.bold, letterSpacing: 1 },
  metaText: { color: C.t3, fontSize: 10, fontFamily: FONT.bold, letterSpacing: 1 },

  scoreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACE.lg,
    marginTop: SPACE.sm,
  },
  scoreNum: { color: C.t1, fontSize: 56, fontFamily: FONT.black, letterSpacing: -3, minWidth: 64, textAlign: 'center' },
  scoreDash: { color: C.t3, fontSize: 30, fontFamily: FONT.black },
  scoreNames: { flexDirection: 'row', justifyContent: 'space-between', marginTop: SPACE.xs },
  scoreTeam: { color: C.t2, fontSize: 12, fontFamily: FONT.semibold, flex: 1, textAlign: 'center' },

  // ── score phase ─────────────────────────────────────────────────────────────
  teamBlock: { marginBottom: SPACE.md },
  teamName: {
    color: C.t3,
    fontSize: 11,
    fontFamily: FONT.bold,
    letterSpacing: 2,
    textTransform: 'uppercase',
    marginBottom: SPACE.sm,
  },

  card: {
    backgroundColor: C.s1,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: C.b1,
    padding: SPACE.md,
    marginBottom: SPACE.sm,
  },
  cardGk: { borderColor: C.b2, backgroundColor: C.s2 },
  emptySquad: {
    backgroundColor: C.s1,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: C.b0,
    borderStyle: 'dashed',
    padding: SPACE.md,
    marginBottom: SPACE.sm,
  },
  emptySquadText: { color: C.t3, fontSize: 12, fontFamily: FONT.regular, lineHeight: 17 },
  cardTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: SPACE.md },
  playerName: { color: C.t1, fontSize: 15, fontFamily: FONT.semibold, flex: 1 },

  gkBtn: {
    borderWidth: 1,
    borderColor: C.b1,
    borderRadius: RADIUS.sm,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginLeft: SPACE.sm,
  },
  gkText: { fontSize: 11, fontFamily: FONT.bold, letterSpacing: 1 },

  statRow: { flexDirection: 'row', justifyContent: 'space-between', gap: SPACE.sm },
  statGroup: { flexDirection: 'row', alignItems: 'center', flex: 1, gap: 6 },
  // Deliberately large: this gets tapped with cold hands in bright sun.
  tapMain: {
    flex: 1,
    height: 52,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: C.b1,
    backgroundColor: C.s3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tapVal: { color: C.t1, fontSize: 20, fontFamily: FONT.black, lineHeight: 22 },
  tapBadge: { color: C.t3, fontSize: 9, fontFamily: FONT.bold, letterSpacing: 1, marginTop: 1 },
  tapMinus: { width: 26, height: 52, alignItems: 'center', justifyContent: 'center' },
  tapSign: { color: C.t1, fontSize: 22, fontFamily: FONT.bold, lineHeight: 26 },

  // ── rate phase ──────────────────────────────────────────────────────────────
  reviewHead: { marginBottom: SPACE.md },
  reviewTitle: { color: C.t1, fontSize: 18, fontFamily: FONT.bold },
  reviewSub: { color: C.t2, fontSize: 12, fontFamily: FONT.regular, marginTop: 3, lineHeight: 17 },

  rateCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: C.s1,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: C.b1,
    paddingVertical: SPACE.sm,
    paddingHorizontal: SPACE.md,
    marginBottom: 6,
    gap: SPACE.xs,
  },
  rateMeta: { color: C.t3, fontSize: 10, fontFamily: FONT.medium, marginTop: 2 },
  rateBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: C.s3,
    borderWidth: 1,
    borderColor: C.b2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rateVal: { fontSize: 20, fontFamily: FONT.black, minWidth: 46, textAlign: 'center' },

  // ── actions ─────────────────────────────────────────────────────────────────
  primary: {
    backgroundColor: C.lime,
    borderRadius: RADIUS.lg,
    paddingVertical: 17,
    alignItems: 'center',
    marginTop: SPACE.md,
    ...ELEV.glow(C.lime, 0.3),
  },
  primaryText: { color: C.limeText, fontSize: 16, fontFamily: FONT.bold, letterSpacing: 0.2 },
  back: { alignItems: 'center', paddingVertical: SPACE.md },
  backText: { color: C.t2, fontSize: 13, fontFamily: FONT.medium },
  hint: {
    color: C.t3,
    fontSize: 11,
    fontFamily: FONT.regular,
    textAlign: 'center',
    marginTop: SPACE.sm,
    lineHeight: 16,
  },
})
