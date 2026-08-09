/**
 * CREATE A PICKUP GAME.
 *
 * Deliberately shorter than creating a tournament. A turf owner setting up
 * Tuesday's kickabout wants four decisions, not a form: how many a side, how long,
 * where, and when. Everything else is derived — capacity is always twice the
 * players per side, sign-ups open immediately, and the grade is fixed at amateur.
 */
import { useState } from 'react'
import {
  ScrollView, View, Text, StyleSheet, TextInput, TouchableOpacity,
  ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../src/api/client'
import { C, FONT, SPACE, RADIUS, ELEV } from '../src/theme'
import { notify } from '../src/lib/dialog'

/**
 * A side, not a squad. Tournaments store `match_format` as a three-value enum that
 * cannot express 9v9, so a pickup game stores the number instead.
 */
const PER_SIDE = [5, 6, 7, 8, 9, 11]

/** Slot lengths a weeknight game actually runs to. Feeds the rating weight. */
const DURATIONS = [30, 45, 60, 90]

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December']
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Same tolerant parser as the tournament form — people type dates every which way. */
function parseDate(raw: string): { iso: string; pretty: string } | { error: string } | null {
  const input = raw.trim()
  if (!input) return null
  const parts = input.split(/[-/.\s]+/).filter(Boolean)
  if (parts.length !== 3 || parts.some(p => !/^\d+$/.test(p))) {
    return { error: 'Use a date like 2026-08-14 or 14/08/2026' }
  }
  let y: number, m: number, d: number
  if (parts[0].length === 4) [y, m, d] = parts.map(Number)
  else if (parts[2].length === 4) [d, m, y] = parts.map(Number)
  else return { error: 'Include the full 4-digit year' }

  if (m < 1 || m > 12) return { error: `There is no month ${m}` }
  const date = new Date(Date.UTC(y, m - 1, d))
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return { error: `${MONTHS[m - 1]} doesn't have ${d} days` }
  }
  return {
    iso: date.toISOString(),
    pretty: `${DAYS[date.getUTCDay()]}, ${d} ${MONTHS[m - 1]} ${y}`,
  }
}

const errText = (e: any): string => {
  const err = e?.response?.data?.error
  if (typeof err === 'string') return err
  if (err?.fieldErrors) {
    return Object.entries(err.fieldErrors as Record<string, string[]>)
      .map(([f, m]) => `${f}: ${m.join(', ')}`).join('\n')
  }
  return e?.message ?? 'Something went wrong'
}

export default function CreateGameScreen() {
  const router = useRouter()
  const qc = useQueryClient()

  const [name, setName] = useState('')
  const [perSide, setPerSide] = useState(7)
  const [duration, setDuration] = useState(60)
  const [city, setCity] = useState('')
  const [venue, setVenue] = useState('')
  const [startsAt, setStartsAt] = useState('')

  const parsed = parseDate(startsAt)
  const dateError = parsed && 'error' in parsed ? parsed.error : null
  const canSubmit = name.trim().length >= 3 && city.trim().length >= 2 && !dateError

  const { mutate, isPending } = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        name: name.trim(),
        sport_slug: 'football',
        players_per_side: perSide,
        // Never optional here. A NULL duration reaches the rating engine as a full
        // 90 minutes, so an hour-long kickabout would move Elo like a league game.
        match_duration_minutes: duration,
        city: city.trim(),
      }
      if (venue.trim()) body.venue = venue.trim()
      if (parsed && 'iso' in parsed) body.starts_at = parsed.iso
      return (await api.post('/games', body)).data
    },
    onSuccess: (game: any) => {
      qc.invalidateQueries({ queryKey: ['organizer', 'games'] })
      router.replace(`/organizer/game/${game.id}`)
    },
    onError: (e) => notify("Couldn't create the game", errText(e)),
  })

  return (
    <SafeAreaView style={s.container} edges={['top', 'bottom']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={s.header}>
          <TouchableOpacity onPress={() => router.back()} style={s.backBtn} activeOpacity={0.7}>
            <Text style={s.backArrow}>←</Text>
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={s.eyebrow}>NEW PICKUP GAME</Text>
            <Text style={s.title}>Set up a game</Text>
          </View>
        </View>

        <ScrollView
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: 40 }}
        >
          <Text style={s.label}>GAME NAME</Text>
          <View style={s.inputWrap}>
            <Text style={s.inputIcon}>⚽</Text>
            <TextInput
              style={s.input}
              placeholder="e.g. Tuesday Night Football"
              placeholderTextColor={C.t3}
              value={name}
              onChangeText={setName}
              maxLength={100}
            />
          </View>

          <Text style={s.label}>PLAYERS PER SIDE</Text>
          <View style={s.pillRow}>
            {PER_SIDE.map(n => {
              const on = perSide === n
              return (
                <TouchableOpacity
                  key={n}
                  style={[s.pill, on && { backgroundColor: C.lime, borderColor: C.lime }]}
                  onPress={() => setPerSide(n)}
                  activeOpacity={0.75}
                >
                  <Text style={[s.pillText, on && { color: C.limeText }]}>{n}v{n}</Text>
                </TouchableOpacity>
              )
            })}
          </View>
          <Text style={s.hint}>
            {perSide * 2} players needed. Anyone after that waits, and comes straight
            in if someone drops.
          </Text>

          <Text style={s.label}>MATCH LENGTH</Text>
          <View style={s.pillRow}>
            {DURATIONS.map(d => {
              const on = duration === d
              return (
                <TouchableOpacity
                  key={d}
                  style={[s.pill, on && { backgroundColor: C.lime, borderColor: C.lime }]}
                  onPress={() => setDuration(d)}
                  activeOpacity={0.75}
                >
                  <Text style={[s.pillText, on && { color: C.limeText }]}>{d}m</Text>
                </TouchableOpacity>
              )
            })}
          </View>
          <Text style={s.hint}>A shorter game moves ratings less than a full one.</Text>

          <Text style={s.label}>CITY</Text>
          <View style={s.inputWrap}>
            <Text style={s.inputIcon}>🏙️</Text>
            <TextInput
              style={s.input}
              placeholder="Mumbai, Pune, Delhi…"
              placeholderTextColor={C.t3}
              value={city}
              onChangeText={setCity}
              autoCapitalize="words"
            />
          </View>

          <Text style={s.label}>VENUE (OPTIONAL)</Text>
          <View style={s.inputWrap}>
            <Text style={s.inputIcon}>📍</Text>
            <TextInput
              style={s.input}
              placeholder="Turf name"
              placeholderTextColor={C.t3}
              value={venue}
              onChangeText={setVenue}
              autoCapitalize="words"
            />
          </View>

          <Text style={s.label}>DATE (OPTIONAL)</Text>
          <View style={[s.inputWrap, dateError ? { borderColor: C.amber } : null]}>
            <Text style={s.inputIcon}>📅</Text>
            <TextInput
              style={s.input}
              placeholder="2026-08-14  or  14/08/2026"
              placeholderTextColor={C.t3}
              value={startsAt}
              onChangeText={setStartsAt}
              keyboardType="numbers-and-punctuation"
            />
          </View>
          {dateError ? (
            <Text style={s.dateError}>⚠ {dateError}</Text>
          ) : parsed && 'pretty' in parsed ? (
            <Text style={s.dateOk}>→ {parsed.pretty}</Text>
          ) : (
            <Text style={s.hint}>Leave blank to sort it out later.</Text>
          )}

          <View style={s.note}>
            <Text style={s.noteText}>
              Sign-ups open straight away. Pickup games always count at amateur
              grade — you pick the game and the sides, so they cannot be graded higher.
            </Text>
          </View>
        </ScrollView>

        <View style={s.footer}>
          <TouchableOpacity
            style={[s.submit, (!canSubmit || isPending) && { opacity: 0.4 }]}
            disabled={!canSubmit || isPending}
            onPress={() => mutate()}
            activeOpacity={0.85}
          >
            {isPending
              ? <ActivityIndicator color={C.limeText} />
              : <Text style={s.submitText}>Create game · {perSide}v{perSide}</Text>}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: SPACE.md,
    paddingHorizontal: SPACE.lg, paddingTop: SPACE.sm, paddingBottom: SPACE.lg,
  },
  backBtn: {
    width: 40, height: 40, borderRadius: RADIUS.pill, backgroundColor: C.s2,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.b1,
  },
  backArrow: { color: C.t1, fontSize: 18, fontFamily: FONT.bold },
  eyebrow: { color: C.t3, fontSize: 10, fontFamily: FONT.bold, letterSpacing: 2 },
  title: { color: C.t1, fontSize: 24, fontFamily: FONT.black, letterSpacing: -0.5 },

  label: {
    color: C.t3, fontSize: 10, fontFamily: FONT.bold, letterSpacing: 1.5,
    marginHorizontal: SPACE.lg, marginTop: SPACE.lg, marginBottom: SPACE.sm,
  },
  inputWrap: {
    flexDirection: 'row', alignItems: 'center', gap: SPACE.sm,
    marginHorizontal: SPACE.lg, paddingHorizontal: SPACE.md,
    backgroundColor: C.s1, borderRadius: RADIUS.md, borderWidth: 1, borderColor: C.b1,
  },
  inputIcon: { fontSize: 15 },
  input: {
    flex: 1, paddingVertical: 14, color: C.t1, fontSize: 15, fontFamily: FONT.medium,
    ...(({ outlineStyle: 'none' }) as object),
  },

  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, marginHorizontal: SPACE.lg },
  pill: {
    paddingHorizontal: 16, paddingVertical: 11, borderRadius: RADIUS.md,
    backgroundColor: C.s2, borderWidth: 1, borderColor: C.b1,
  },
  pillText: { color: C.t2, fontSize: 13, fontFamily: FONT.bold },

  hint: {
    color: C.t3, fontSize: 11, fontFamily: FONT.regular, lineHeight: 16,
    marginHorizontal: SPACE.lg, marginTop: 6,
  },
  dateOk: { color: C.lime, fontSize: 12, fontFamily: FONT.medium, marginHorizontal: SPACE.lg, marginTop: 6 },
  dateError: { color: C.amber, fontSize: 12, fontFamily: FONT.medium, marginHorizontal: SPACE.lg, marginTop: 6 },

  note: {
    marginHorizontal: SPACE.lg, marginTop: SPACE.xl, padding: SPACE.md,
    backgroundColor: C.s1, borderRadius: RADIUS.md, borderWidth: 1, borderColor: C.b1,
  },
  noteText: { color: C.t2, fontSize: 12, fontFamily: FONT.regular, lineHeight: 18 },

  footer: {
    padding: SPACE.lg, borderTopWidth: 1, borderTopColor: C.b1, backgroundColor: C.bg,
  },
  submit: {
    backgroundColor: C.lime, borderRadius: RADIUS.lg, paddingVertical: 16,
    alignItems: 'center', ...ELEV.glow(C.lime, 0.3),
  },
  submitText: { color: C.limeText, fontSize: 16, fontFamily: FONT.bold },
})
