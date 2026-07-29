import { useState } from 'react'
import {
  ScrollView, View, Text, StyleSheet,
  TextInput, TouchableOpacity, ActivityIndicator,
  KeyboardAvoidingView, Platform, Alert,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter, useLocalSearchParams } from 'expo-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '../src/api/client'
import { C, SPORT } from '../src/theme'

const SPORTS_LIST = [
  { slug: 'cricket',    name: 'Cricket',    emoji: '🏏' },
  { slug: 'football',   name: 'Football',   emoji: '⚽' },
  { slug: 'badminton',  name: 'Badminton',  emoji: '🏸' },
  { slug: 'basketball', name: 'Basketball', emoji: '🏀' },
]

const ROUND_OPTIONS = ['Group Stage', 'Round of 16', 'Quarter Finals', 'Semi Finals', 'Final']

async function createTeam(name: string, sport_slug: string) {
  const res = await api.post('/teams', { name, sport_slug })
  return res.data
}

async function createMatch(
  sport_slug: string,
  home_team_id: string,
  away_team_id: string,
  venue: string,
  event_id: string | null,
  round: string,
) {
  const body: any = { sport_slug, home_team_id, away_team_id }
  if (venue.trim())    body.venue    = venue.trim()
  if (event_id)        body.event_id = event_id
  if (round.trim())    body.round    = round.trim()
  const res = await api.post('/matches', body)
  return res.data
}

export default function CreateMatchScreen() {
  const router = useRouter()
  const params = useLocalSearchParams<{ sport?: string; event_id?: string; round?: string }>()

  const initialSport = SPORTS_LIST.find(s => s.slug === params.sport) ?? SPORTS_LIST[0]
  const [sport, setSport]     = useState(initialSport)
  const [homeTeam, setHomeTeam] = useState('')
  const [awayTeam, setAwayTeam] = useState('')
  const [venue, setVenue]     = useState('')
  const [eventId]             = useState(params.event_id ?? null)
  const [round, setRound]     = useState(params.round ?? '')

  const cfg = SPORT[sport.slug]

  // Fetch tournament context if event_id is provided
  const { data: tournamentCtx } = useQuery({
    queryKey: ['event-ctx', eventId],
    queryFn: () => api.get(`/events/${eventId}`).then(r => r.data?.event),
    enabled: !!eventId,
  })

  const { mutate, isPending } = useMutation({
    mutationFn: async () => {
      const home = homeTeam.trim() || `${sport.name} Team A`
      const away = awayTeam.trim() || `${sport.name} Team B`

      const [homeData, awayData] = await Promise.all([
        createTeam(home, sport.slug),
        createTeam(away, sport.slug),
      ])

      return createMatch(sport.slug, homeData.id, awayData.id, venue, eventId, round)
    },
    onSuccess: () => {
      if (eventId) {
        router.replace({ pathname: '/tournament/[id]', params: { id: eventId } })
      } else {
        router.replace('/(tabs)/matches')
      }
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.message ?? err?.message ?? 'Something went wrong'
      Alert.alert('Error', msg)
    },
  })

  return (
    <SafeAreaView style={s.container} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* Header */}
        <View style={s.header}>
          <TouchableOpacity onPress={() => router.back()} style={s.backBtn} activeOpacity={0.7}>
            <Text style={s.backArrow}>←</Text>
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={s.eyebrow}>{eventId ? 'TOURNAMENT MATCH' : 'NEW MATCH'}</Text>
            <Text style={s.title}>Create Match</Text>
          </View>
        </View>

        <ScrollView
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: 40 }}
        >
          {/* Tournament context card (shown when event_id present) */}
          {tournamentCtx && (
            <View style={[s.tournamentCtx, {
              backgroundColor: (SPORT[tournamentCtx.sport_slug]?.glow ?? C.limeGlow),
              borderColor: (SPORT[tournamentCtx.sport_slug]?.color ?? C.lime),
            }]}>
              <Text style={s.tournamentCtxLabel}>TOURNAMENT</Text>
              <Text style={s.tournamentCtxName}>{tournamentCtx.name}</Text>
              <View style={[s.tournamentCtxBadge, { backgroundColor: (SPORT[tournamentCtx.sport_slug]?.color ?? C.lime) + '22' }]}>
                <Text style={[s.tournamentCtxBadgeText, { color: SPORT[tournamentCtx.sport_slug]?.color ?? C.lime }]}>
                  {tournamentCtx.format?.replace('_', ' ').toUpperCase()}
                </Text>
              </View>
            </View>
          )}

          {/* Sport selector */}
          <Text style={s.sectionLabel}>SPORT</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={s.sportsRow}
          >
            {SPORTS_LIST.map(sp => {
              const spCfg = SPORT[sp.slug]
              const active = sport.slug === sp.slug
              return (
                <TouchableOpacity
                  key={sp.slug}
                  style={[s.sportPill, active && { backgroundColor: spCfg.glow, borderColor: spCfg.color }]}
                  onPress={() => setSport(sp)}
                  activeOpacity={0.75}
                >
                  <Text style={{ fontSize: 18 }}>{sp.emoji}</Text>
                  <Text style={[s.sportPillLabel, active && { color: spCfg.color }]}>{sp.name}</Text>
                </TouchableOpacity>
              )
            })}
          </ScrollView>

          {/* Teams */}
          <View style={s.vsCard}>
            {/* Home team */}
            <View style={s.teamBlock}>
              <Text style={s.teamLabel}>HOME TEAM</Text>
              <TextInput
                style={[s.teamInput, { borderColor: cfg.color + '55' }]}
                placeholder={`${sport.name} Team A`}
                placeholderTextColor={C.t3}
                value={homeTeam}
                onChangeText={setHomeTeam}
                autoCapitalize="words"
                returnKeyType="next"
              />
            </View>

            {/* VS divider */}
            <View style={s.vsDivider}>
              <View style={[s.vsDividerLine, { backgroundColor: cfg.color + '33' }]} />
              <View style={[s.vsCircle, { borderColor: cfg.color + '55' }]}>
                <Text style={[s.vsText, { color: cfg.color }]}>VS</Text>
              </View>
              <View style={[s.vsDividerLine, { backgroundColor: cfg.color + '33' }]} />
            </View>

            {/* Away team */}
            <View style={s.teamBlock}>
              <Text style={s.teamLabel}>AWAY TEAM</Text>
              <TextInput
                style={[s.teamInput, { borderColor: cfg.color + '55' }]}
                placeholder={`${sport.name} Team B`}
                placeholderTextColor={C.t3}
                value={awayTeam}
                onChangeText={setAwayTeam}
                autoCapitalize="words"
                returnKeyType="next"
              />
            </View>
          </View>

          {/* Venue */}
          <Text style={s.sectionLabel}>VENUE (OPTIONAL)</Text>
          <View style={s.inputWrap}>
            <Text style={s.inputIcon}>📍</Text>
            <TextInput
              style={s.venueInput}
              placeholder="Ground name, city…"
              placeholderTextColor={C.t3}
              value={venue}
              onChangeText={setVenue}
              autoCapitalize="words"
              returnKeyType={eventId ? 'next' : 'done'}
            />
          </View>

          {/* Round selector (tournament matches only) */}
          {eventId && (
            <>
              <Text style={s.sectionLabel}>ROUND</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={s.sportsRow}
              >
                {ROUND_OPTIONS.map(r => {
                  const active = round === r
                  return (
                    <TouchableOpacity
                      key={r}
                      style={[s.sportPill, active && { backgroundColor: C.limeGlow, borderColor: C.lime }]}
                      onPress={() => setRound(r)}
                      activeOpacity={0.75}
                    >
                      <Text style={[s.sportPillLabel, active && { color: C.lime }]}>{r}</Text>
                    </TouchableOpacity>
                  )
                })}
              </ScrollView>
              <View style={[s.inputWrap, { marginTop: 10 }]}>
                <Text style={s.inputIcon}>🏷️</Text>
                <TextInput
                  style={s.venueInput}
                  placeholder="Or type custom round name…"
                  placeholderTextColor={C.t3}
                  value={round}
                  onChangeText={setRound}
                  returnKeyType="done"
                />
              </View>
            </>
          )}

          {/* Submit */}
          <TouchableOpacity
            style={[s.submitBtn, isPending && { opacity: 0.6 }]}
            onPress={() => mutate()}
            disabled={isPending}
            activeOpacity={0.85}
          >
            {isPending ? (
              <ActivityIndicator color={C.limeText} />
            ) : (
              <>
                <Text style={s.submitText}>{eventId ? 'Create Match' : 'Start Match'}</Text>
                <Text style={s.submitArrow}>→</Text>
              </>
            )}
          </TouchableOpacity>

          <Text style={s.hint}>
            Two teams will be created automatically.{'\n'}You can add players to teams after the match.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },

  header: {
    flexDirection: 'row', alignItems: 'flex-end',
    paddingHorizontal: 20, paddingTop: 8, paddingBottom: 18, gap: 12,
  },
  backBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: C.s2, borderWidth: 1, borderColor: C.b1,
    justifyContent: 'center', alignItems: 'center', marginBottom: 4,
  },
  backArrow: { color: C.t1, fontSize: 20, fontWeight: '600', lineHeight: 22 },
  eyebrow:   { color: C.t3, fontSize: 11, fontWeight: '700', letterSpacing: 2, marginBottom: 3 },
  title:     { color: C.white, fontSize: 28, fontWeight: '800', letterSpacing: -0.5 },

  // Tournament context card
  tournamentCtx: {
    marginHorizontal: 16, marginBottom: 6, marginTop: 4,
    borderRadius: 14, borderWidth: 1, padding: 14, gap: 6,
  },
  tournamentCtxLabel:     { color: C.t3, fontSize: 10, fontWeight: '800', letterSpacing: 2 },
  tournamentCtxName:      { color: C.t1, fontSize: 15, fontWeight: '700' },
  tournamentCtxBadge:     { alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 20 },
  tournamentCtxBadgeText: { fontSize: 10, fontWeight: '800', letterSpacing: 1 },

  sectionLabel: {
    color: C.t3, fontSize: 11, fontWeight: '700', letterSpacing: 2,
    marginHorizontal: 20, marginBottom: 10, marginTop: 22,
  },

  sportsRow: { paddingHorizontal: 16, gap: 8, paddingBottom: 4 },
  sportPill: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 16, paddingVertical: 10, borderRadius: 24,
    backgroundColor: C.s2, borderWidth: 1, borderColor: C.b1,
  },
  sportPillLabel: { color: C.t2, fontSize: 14, fontWeight: '600' },

  vsCard: {
    marginHorizontal: 16, backgroundColor: C.s1,
    borderRadius: 20, borderWidth: 1, borderColor: C.b1,
    padding: 20, gap: 4, marginTop: 6,
  },
  teamBlock: { gap: 8 },
  teamLabel: { color: C.t3, fontSize: 10, fontWeight: '800', letterSpacing: 2 },
  teamInput: {
    backgroundColor: C.s2, borderRadius: 12,
    paddingHorizontal: 16, paddingVertical: 14,
    color: C.t1, fontSize: 16, fontWeight: '600', borderWidth: 1.5,
  },

  vsDivider: { flexDirection: 'row', alignItems: 'center', gap: 12, marginVertical: 8 },
  vsDividerLine: { flex: 1, height: 1 },
  vsCircle: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: C.s3,
    borderWidth: 1.5, justifyContent: 'center', alignItems: 'center',
  },
  vsText: { fontSize: 11, fontWeight: '900', letterSpacing: 1 },

  inputWrap: {
    flexDirection: 'row', alignItems: 'center', marginHorizontal: 16,
    backgroundColor: C.s1, borderRadius: 14, borderWidth: 1, borderColor: C.b1,
    paddingHorizontal: 16, paddingVertical: 14, gap: 10,
  },
  inputIcon:  { fontSize: 16 },
  venueInput: { flex: 1, color: C.t1, fontSize: 15, fontWeight: '500' },

  submitBtn: {
    marginHorizontal: 16, marginTop: 28,
    backgroundColor: C.lime, borderRadius: 16,
    paddingVertical: 18, paddingHorizontal: 24,
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
  },
  submitText:  { color: C.limeText, fontSize: 17, fontWeight: '800' },
  submitArrow: { color: C.limeText, fontSize: 22, fontWeight: '700', opacity: 0.7 },

  hint: {
    color: C.t3, fontSize: 12, textAlign: 'center',
    lineHeight: 18, marginTop: 16, marginHorizontal: 40,
  },
})
