/**
 * DEV-ONLY component preview.
 *
 * Exists so a referee-gated screen can be inspected from a plain URL during
 * development, instead of clicking through auth on a real device. It signs in via
 * the dev-token endpoint and renders the component against a real match.
 *
 *   http://localhost:8081/dev-preview?match=<uuid>&as=ref
 *
 * Renders nothing outside __DEV__, so it cannot appear in a production build.
 */
import { useEffect, useState } from 'react'
import { View, Text, ScrollView, StyleSheet, ActivityIndicator } from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { api, setToken } from '../src/api/client'
import { C, FONT, SPACE } from '../src/theme'
import TournamentScorecard from '../src/screens/Match/TournamentScorecard'

export default function DevPreview() {
  const params = useLocalSearchParams<{ match?: string; as?: string; phase?: string }>()
  const matchId = params.match ?? ''
  const asKey = params.as ?? 'ref'
  const phase = params.phase === 'rate' ? 'rate' : 'score'

  const [match, setMatch] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!__DEV__ || !matchId) return
    ;(async () => {
      try {
        const auth = await api.post('/auth/dev-token', { key: asKey })
        setToken(auth.data.access_token)
        const res = await api.get(`/matches/${matchId}`)
        setMatch(res.data)
      } catch (e: any) {
        setError(e?.response?.data?.error ?? e?.message ?? 'failed')
      }
    })()
  }, [matchId, asKey])

  if (!__DEV__) return null

  if (!matchId) {
    return (
      <View style={s.wrap}>
        <Text style={s.note}>Pass ?match=&lt;uuid&gt; to preview a scorecard.</Text>
      </View>
    )
  }

  if (error) {
    return (
      <View style={s.wrap}>
        <Text style={[s.note, { color: C.red }]}>{error}</Text>
      </View>
    )
  }

  if (!match) {
    return (
      <View style={s.wrap}>
        <ActivityIndicator color={C.lime} />
      </View>
    )
  }

  return (
    <ScrollView style={s.wrap} contentContainerStyle={s.content}>
      <Text style={s.banner}>DEV PREVIEW · TournamentScorecard · {phase.toUpperCase()}</Text>
      <TournamentScorecard
        startPhase={phase}
        matchId={match.id}
        tier={match.tier}
        durationMinutes={match.duration_minutes}
        homeTeamId={match.home_team_id}
        awayTeamId={match.away_team_id}
        homeTeamName={match.home_team_name}
        awayTeamName={match.away_team_name}
        savedHomeGoals={Number(match.home_score?.goals ?? 0)}
        savedAwayGoals={Number(match.away_score?.goals ?? 0)}
      />
    </ScrollView>
  )
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: C.bg },
  content: { padding: SPACE.lg, paddingBottom: SPACE.xxxl },
  banner: {
    color: C.amber,
    fontSize: 10,
    fontFamily: FONT.bold,
    letterSpacing: 2,
    marginBottom: SPACE.md,
  },
  note: { color: C.t2, fontSize: 13, fontFamily: FONT.regular, padding: SPACE.xl },
})
