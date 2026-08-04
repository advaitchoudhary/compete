import { useState } from 'react'
import {
  ScrollView, View, Text, StyleSheet,
  TextInput, TouchableOpacity, ActivityIndicator,
  KeyboardAvoidingView, Platform,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { useMutation } from '@tanstack/react-query'
import { api } from '../src/api/client'
import { C, SPORT, FONT } from '../src/theme'
import { notify } from '../src/lib/dialog'

// Football leads and is the default: it is the only sport with the full
// tournament-day pipeline behind it (players-per-side, goals/assists/saves,
// fixture generation). The others create an event shell only.
const SPORTS_LIST = [
  { slug: 'football',   name: 'Football',   emoji: '⚽' },
  { slug: 'cricket',    name: 'Cricket',    emoji: '🏏' },
  { slug: 'badminton',  name: 'Badminton',  emoji: '🏸' },
  { slug: 'basketball', name: 'Basketball', emoji: '🏀' },
]

// Only the two structures the fixture generator can actually build. 'league' and
// 'casual' remain valid in the DB but POST /events/:id/fixtures rejects them, so
// offering them here would produce a tournament that can never be scheduled.
const FORMATS = [
  { value: 'knockout',        label: 'Knockout' },
  { value: 'group_knockout',  label: 'Groups + Knockout' },
]

/** Players per side. Drives the squad minimum at registration. */
const MATCH_FORMATS = ['5-a-side', '7-a-side', '11-a-side'] as const

/** Slot length. Also weights the rating — a 12-minute game moves Elo less. */
const DURATIONS = [10, 12, 15, 20, 30, 45]

const MAX_TEAMS_OPTIONS = [4, 8, 16, 32]

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December']
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * Turn what a person actually types into the ISO datetime the API requires.
 *
 * The API takes a full ISO datetime and nothing else. The field used to coerce only
 * `YYYY-MM-DD`, so typing `2026/08/06` — the same date with slashes — was passed
 * through untouched and came back as a 400 "Invalid datetime". Accepting the obvious
 * separators costs nothing and removes a whole class of dead end.
 *
 * Year-last input is read day-first (`06/08/2026` is 6 August), which is the Indian
 * convention this app is built for. That is a guess, so the caller echoes the parsed
 * date back to the organizer — a misread is then visible before they submit rather
 * than after their tournament is scheduled in the wrong month.
 */
function parseStartDate(raw: string): { iso: string; pretty: string } | { error: string } | null {
  const input = raw.trim()
  if (!input) return null

  const parts = input.split(/[-/.\s]+/).filter(Boolean)
  if (parts.length !== 3 || parts.some(p => !/^\d+$/.test(p))) {
    return { error: 'Use a date like 2026-08-06 or 06/08/2026' }
  }

  let y: number, m: number, d: number
  if (parts[0].length === 4) [y, m, d] = parts.map(Number)          // 2026-08-06
  else if (parts[2].length === 4) [d, m, y] = parts.map(Number)     // 06/08/2026
  else return { error: 'Include the full 4-digit year' }

  if (m < 1 || m > 12) return { error: `There is no month ${m}` }
  if (d < 1 || d > 31) return { error: `There is no day ${d}` }

  const date = new Date(Date.UTC(y, m - 1, d))
  // Catches 31 February, which Date would silently roll into March.
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return { error: `${MONTHS[m - 1]} doesn't have ${d} days` }
  }

  return {
    iso: date.toISOString(),
    pretty: `${DAYS[date.getUTCDay()]}, ${d} ${MONTHS[m - 1]} ${y}`,
  }
}

/** Unwrap the several error shapes the API can return into one line. */
function errText(err: any): string {
  const data = err?.response?.data
  const fieldErrors = data?.error?.fieldErrors ?? data?.fieldErrors
  if (fieldErrors) {
    return Object.entries(fieldErrors as Record<string, string[]>)
      .map(([field, msgs]) => `${field}: ${msgs.join(', ')}`)
      .join('\n')
  }
  if (typeof data?.error === 'string') return data.error
  return data?.message ?? err?.message ?? 'Something went wrong'
}

export default function CreateTournamentScreen() {
  const router = useRouter()

  const [sport, setSport] = useState(SPORTS_LIST[0])
  const [name, setName] = useState('')
  const [format, setFormat] = useState('group_knockout')
  const [matchFormat, setMatchFormat] = useState<(typeof MATCH_FORMATS)[number]>('5-a-side')
  const [duration, setDuration] = useState(12)
  const [city, setCity] = useState('')
  const [venue, setVenue] = useState('')
  const [maxTeams, setMaxTeams] = useState(8)
  const [startsAt, setStartsAt] = useState('')

  const cfg = SPORT[sport.slug]
  const parsedDate = parseStartDate(startsAt)
  const dateError = parsedDate && 'error' in parsedDate ? parsedDate.error : null
  // A bad date blocks submit here rather than at the API, so the organizer is told
  // which field is wrong instead of being handed a validation dump.
  const canSubmit = name.trim().length >= 3 && city.trim().length >= 2 && !dateError

  const { mutate, isPending } = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        name:       name.trim(),
        sport_slug: sport.slug,
        format,
        city:       city.trim(),
        max_teams:  maxTeams,
        // Both are needed before fixtures can be generated: match_format sets the
        // squad minimum at registration, duration sets the slot length and weights
        // the rating. Tier is deliberately NOT sent — it is not settable at
        // creation and is raised later, capped by the assigned referees.
        match_format: matchFormat,
        match_duration_minutes: duration,
      }
      if (venue.trim()) body.venue = venue.trim()
      // The API only accepts a full ISO datetime — see parseStartDate.
      if (parsedDate && 'iso' in parsedDate) body.starts_at = parsedDate.iso
      const res = await api.post('/events', body)
      return res.data
    },
    onSuccess: (event: any) => {
      const id = event?.id ?? event?.event?.id
      router.replace({ pathname: '/tournament/[id]', params: { id } })
    },
    // notify(), not Alert.alert(): on react-native-web Alert.alert is a no-op, so
    // every failure here — including the 400 above — used to produce no feedback at
    // all. The form just appeared to do nothing.
    onError: (err: any) => notify("Couldn't create tournament", errText(err)),
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
              placeholder={`e.g. Sunday ${sport.name} Cup 2026`}
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

          {/* Players per side */}
          <Text style={s.sectionLabel}>PLAYERS PER SIDE</Text>
          <View style={s.formatRow}>
            {MATCH_FORMATS.map(mf => {
              const active = matchFormat === mf
              return (
                <TouchableOpacity
                  key={mf}
                  style={[s.formatPill, active && { backgroundColor: C.lime, borderColor: C.lime }]}
                  onPress={() => setMatchFormat(mf)}
                  activeOpacity={0.75}
                >
                  <Text style={[s.formatLabel, active && { color: C.limeText }]}>{mf}</Text>
                </TouchableOpacity>
              )
            })}
          </View>

          {/* Match length */}
          <Text style={s.sectionLabel}>MATCH LENGTH</Text>
          <View style={s.formatRow}>
            {DURATIONS.map(d => {
              const active = duration === d
              return (
                <TouchableOpacity
                  key={d}
                  style={[s.formatPill, active && { backgroundColor: C.lime, borderColor: C.lime }]}
                  onPress={() => setDuration(d)}
                  activeOpacity={0.75}
                >
                  <Text style={[s.formatLabel, active && { color: C.limeText }]}>{d}m</Text>
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
          <View style={[s.inputWrap, dateError ? { borderColor: C.amber } : null]}>
            <Text style={s.inputIcon}>📅</Text>
            <TextInput
              style={s.input}
              placeholder="2026-08-06  or  06/08/2026"
              placeholderTextColor={C.t3}
              value={startsAt}
              onChangeText={setStartsAt}
              keyboardType="numbers-and-punctuation"
              returnKeyType="done"
            />
          </View>
          {/* Echo the interpretation. Day-first is a guess for year-last input, so
              showing the result is how a misread month gets caught. */}
          {dateError ? (
            <Text style={s.dateError}>⚠ {dateError}</Text>
          ) : parsedDate && 'pretty' in parsedDate ? (
            <Text style={s.dateOk}>→ {parsedDate.pretty}</Text>
          ) : (
            <Text style={s.hint}>Leave blank to set the date later.</Text>
          )}

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

  dateOk:    { color: C.lime,  fontSize: 12, fontFamily: FONT.medium, marginHorizontal: 16, marginTop: 6 },
  dateError: { color: C.amber, fontSize: 12, fontFamily: FONT.medium, marginHorizontal: 16, marginTop: 6 },
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
