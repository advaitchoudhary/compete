import { useState } from 'react'
import {
  ScrollView, View, Text, StyleSheet,
  TextInput, TouchableOpacity, ActivityIndicator,
  KeyboardAvoidingView, Platform, Alert,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { useMutation } from '@tanstack/react-query'
import { api } from '../src/api/client'
import { C, SPORT } from '../src/theme'

const SPORTS_LIST = [
  { slug: 'cricket',    name: 'Cricket',    emoji: '🏏' },
  { slug: 'football',   name: 'Football',   emoji: '⚽' },
  { slug: 'badminton',  name: 'Badminton',  emoji: '🏸' },
  { slug: 'basketball', name: 'Basketball', emoji: '🏀' },
]

const FORMATS = [
  { value: 'knockout',  label: 'Knockout' },
  { value: 'league',    label: 'League'   },
  { value: 'casual',    label: 'Casual'   },
]

const MAX_TEAMS_OPTIONS = [4, 8, 16, 32]

export default function CreateTournamentScreen() {
  const router = useRouter()

  const [sport, setSport] = useState(SPORTS_LIST[0])
  const [name, setName] = useState('')
  const [format, setFormat] = useState('knockout')
  const [city, setCity] = useState('')
  const [venue, setVenue] = useState('')
  const [maxTeams, setMaxTeams] = useState(8)
  const [startsAt, setStartsAt] = useState('')

  const cfg = SPORT[sport.slug]
  const canSubmit = name.trim().length >= 3 && city.trim().length >= 2

  const { mutate, isPending } = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        name:       name.trim(),
        sport_slug: sport.slug,
        format,
        city:       city.trim(),
        max_teams:  maxTeams,
      }
      if (venue.trim()) body.venue = venue.trim()
      if (startsAt.trim()) {
        const d = startsAt.trim()
        // Backend Zod requires full ISO datetime; coerce "YYYY-MM-DD" → "YYYY-MM-DDT00:00:00.000Z"
        body.starts_at = /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00.000Z` : d
      }
      const res = await api.post('/events', body)
      return res.data
    },
    onSuccess: (event: any) => {
      const id = event?.id ?? event?.event?.id
      router.replace({ pathname: '/tournament/[id]', params: { id } })
    },
    onError: (err: any) => {
      const data = err?.response?.data
      const fieldErrors = data?.fieldErrors
        ? Object.values(data.fieldErrors as Record<string, string[]>).flat().join(', ')
        : null
      const msg = fieldErrors ?? data?.message ?? data?.error ?? err?.message ?? 'Something went wrong'
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
            <Text style={s.eyebrow}>NEW TOURNAMENT</Text>
            <Text style={s.title}>Create Tournament</Text>
          </View>
        </View>

        <ScrollView
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: 40 }}
        >
          {/* Sport */}
          <Text style={s.sectionLabel}>SPORT</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={s.pillsRow}
          >
            {SPORTS_LIST.map(sp => {
              const spCfg = SPORT[sp.slug]
              const active = sport.slug === sp.slug
              return (
                <TouchableOpacity
                  key={sp.slug}
                  style={[s.pill, active && { backgroundColor: spCfg.glow, borderColor: spCfg.color }]}
                  onPress={() => setSport(sp)}
                  activeOpacity={0.75}
                >
                  <Text style={{ fontSize: 18 }}>{sp.emoji}</Text>
                  <Text style={[s.pillLabel, active && { color: spCfg.color }]}>{sp.name}</Text>
                </TouchableOpacity>
              )
            })}
          </ScrollView>

          {/* Name */}
          <Text style={s.sectionLabel}>TOURNAMENT NAME</Text>
          <View style={s.inputWrap}>
            <Text style={s.inputIcon}>🏆</Text>
            <TextInput
              style={s.input}
              placeholder="e.g. Summer Cricket League 2026"
              placeholderTextColor={C.t3}
              value={name}
              onChangeText={setName}
              autoCapitalize="words"
              returnKeyType="next"
            />
          </View>

          {/* Format */}
          <Text style={s.sectionLabel}>FORMAT</Text>
          <View style={s.formatRow}>
            {FORMATS.map(f => {
              const active = format === f.value
              return (
                <TouchableOpacity
                  key={f.value}
                  style={[s.formatPill, active && { backgroundColor: C.lime, borderColor: C.lime }]}
                  onPress={() => setFormat(f.value)}
                  activeOpacity={0.75}
                >
                  <Text style={[s.formatLabel, active && { color: C.limeText }]}>{f.label}</Text>
                </TouchableOpacity>
              )
            })}
          </View>

          {/* City */}
          <Text style={s.sectionLabel}>CITY</Text>
          <View style={s.inputWrap}>
            <Text style={s.inputIcon}>🏙️</Text>
            <TextInput
              style={s.input}
              placeholder="Mumbai, Pune, Delhi…"
              placeholderTextColor={C.t3}
              value={city}
              onChangeText={setCity}
              autoCapitalize="words"
              returnKeyType="next"
            />
          </View>

          {/* Venue */}
          <Text style={s.sectionLabel}>VENUE (OPTIONAL)</Text>
          <View style={s.inputWrap}>
            <Text style={s.inputIcon}>📍</Text>
            <TextInput
              style={s.input}
              placeholder="Ground name, arena…"
              placeholderTextColor={C.t3}
              value={venue}
              onChangeText={setVenue}
              autoCapitalize="words"
              returnKeyType="next"
            />
          </View>

          {/* Max teams */}
          <Text style={s.sectionLabel}>MAX TEAMS</Text>
          <View style={s.chipsRow}>
            {MAX_TEAMS_OPTIONS.map(n => {
              const active = maxTeams === n
              return (
                <TouchableOpacity
                  key={n}
                  style={[s.chip, active && { backgroundColor: C.lime, borderColor: C.lime }]}
                  onPress={() => setMaxTeams(n)}
                  activeOpacity={0.75}
                >
                  <Text style={[s.chipLabel, active && { color: C.limeText }]}>{n}</Text>
                </TouchableOpacity>
              )
            })}
          </View>

          {/* Start date */}
          <Text style={s.sectionLabel}>START DATE (OPTIONAL)</Text>
          <View style={s.inputWrap}>
            <Text style={s.inputIcon}>📅</Text>
            <TextInput
              style={s.input}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={C.t3}
              value={startsAt}
              onChangeText={setStartsAt}
              keyboardType="numbers-and-punctuation"
              returnKeyType="done"
            />
          </View>
          <Text style={s.hint}>Leave blank to set the date later.</Text>

          {/* Submit */}
          <TouchableOpacity
            style={[s.submitBtn, (!canSubmit || isPending) && { opacity: 0.45 }]}
            onPress={() => mutate()}
            disabled={!canSubmit || isPending}
            activeOpacity={0.85}
          >
            {isPending ? (
              <ActivityIndicator color={C.limeText} />
            ) : (
              <>
                <Text style={s.submitText}>Create Tournament</Text>
                <Text style={s.submitArrow}>→</Text>
              </>
            )}
          </TouchableOpacity>

          <Text style={s.bottomHint}>
            Register teams and schedule matches after creation.
          </Text>

          {!canSubmit && (
            <Text style={s.validationHint}>
              {name.trim().length < 3
                ? '⚠ Tournament name needs at least 3 characters'
                : '⚠ City is required (at least 2 characters)'}
            </Text>
          )}
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
  backBtn:  {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: C.s2, borderWidth: 1, borderColor: C.b1,
    justifyContent: 'center', alignItems: 'center', marginBottom: 4,
  },
  backArrow: { color: C.t1, fontSize: 20, fontWeight: '600', lineHeight: 22 },
  eyebrow:   { color: C.t3, fontSize: 11, fontWeight: '700', letterSpacing: 2, marginBottom: 3 },
  title:     { color: C.white, fontSize: 28, fontWeight: '800', letterSpacing: -0.5 },

  sectionLabel: {
    color: C.t3, fontSize: 11, fontWeight: '700', letterSpacing: 2,
    marginHorizontal: 20, marginBottom: 10, marginTop: 22,
  },

  pillsRow: { paddingHorizontal: 16, gap: 8, paddingBottom: 4 },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 16, paddingVertical: 10, borderRadius: 24,
    backgroundColor: C.s2, borderWidth: 1, borderColor: C.b1,
  },
  pillLabel: { color: C.t2, fontSize: 14, fontWeight: '600' },

  inputWrap: {
    flexDirection: 'row', alignItems: 'center',
    marginHorizontal: 16, backgroundColor: C.s1,
    borderRadius: 14, borderWidth: 1, borderColor: C.b1,
    paddingHorizontal: 16, paddingVertical: 14, gap: 10,
  },
  inputIcon: { fontSize: 16 },
  input:     { flex: 1, color: C.t1, fontSize: 15, fontWeight: '500' },

  formatRow: {
    flexDirection: 'row', marginHorizontal: 16, gap: 10,
  },
  formatPill: {
    flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: 12,
    backgroundColor: C.s2, borderWidth: 1, borderColor: C.b1,
  },
  formatLabel: { color: C.t2, fontSize: 14, fontWeight: '700' },

  chipsRow: {
    flexDirection: 'row', marginHorizontal: 16, gap: 10,
  },
  chip: {
    flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: 12,
    backgroundColor: C.s2, borderWidth: 1, borderColor: C.b1,
  },
  chipLabel: { color: C.t2, fontSize: 16, fontWeight: '800' },

  hint: {
    color: C.t3, fontSize: 11, marginHorizontal: 20, marginTop: 8,
  },

  submitBtn: {
    marginHorizontal: 16, marginTop: 32,
    backgroundColor: C.lime, borderRadius: 16,
    paddingVertical: 18, paddingHorizontal: 24,
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
  },
  submitText:  { color: C.limeText, fontSize: 17, fontWeight: '800' },
  submitArrow: { color: C.limeText, fontSize: 22, fontWeight: '700', opacity: 0.7 },

  bottomHint: {
    color: C.t3, fontSize: 12, textAlign: 'center',
    lineHeight: 18, marginTop: 16, marginHorizontal: 40,
  },
  validationHint: {
    color: C.amber, fontSize: 12, textAlign: 'center',
    marginTop: 8, marginHorizontal: 40,
  },
})
