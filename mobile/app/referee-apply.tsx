import { useState } from 'react'
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ScrollView, ActivityIndicator, Alert, KeyboardAvoidingView, Platform,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { useQueryClient } from '@tanstack/react-query'
import { useAuthStore } from '../src/store/auth.store'
import { api } from '../src/api/client'
import { C, FONT, SPACE, RADIUS, SPORT } from '../src/theme'
import { notify } from '../src/lib/dialog'

const SPORTS = ['football', 'cricket', 'badminton', 'basketball'] as const

export default function RefereeApplyScreen() {
  const router = useRouter()
  const qc = useQueryClient()
  const { user } = useAuthStore()

  const [fullName, setFullName] = useState(user?.name ?? '')
  const [city, setCity] = useState(user?.city ?? '')
  const [phone, setPhone] = useState('')
  const [experience, setExperience] = useState('')
  const [sports, setSports] = useState<string[]>(['football'])
  const [certification, setCertification] = useState('')
  const [bio, setBio] = useState('')
  const [busy, setBusy] = useState(false)

  const toggleSport = (s: string) =>
    setSports((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]))

  const canSubmit = fullName.trim().length >= 2 && city.trim().length >= 2 && sports.length > 0

  const submit = async () => {
    if (!canSubmit) return
    setBusy(true)
    try {
      await api.post('/referee/apply', {
        full_name: fullName.trim(),
        city: city.trim(),
        phone: phone.trim() || undefined,
        experience_years: experience ? Number(experience) : undefined,
        sports,
        certification: certification.trim() || undefined,
        bio: bio.trim() || undefined,
      })
      qc.invalidateQueries({ queryKey: ['referee-me'] })
      notify('Application sent', 'An admin will review your referee application.')
      router.back()
    } catch (e: any) {
      notify('Could not apply', e?.response?.data?.error ?? 'Try again')
    } finally {
      setBusy(false)
    }
  }

  return (
    <SafeAreaView style={s.container} edges={['top']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        {/* header */}
        <View style={s.header}>
          <TouchableOpacity onPress={() => router.back()} hitSlop={12}>
            <Text style={s.back}>✕</Text>
          </TouchableOpacity>
          <Text style={s.headerTitle}>Become a Referee</Text>
          <View style={{ width: 20 }} />
        </View>

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ padding: SPACE.xl, paddingBottom: 40 }}>
          <Text style={s.intro}>
            Referees create & officiate matches. Start at Amateur tier; climb by getting approved for higher tiers.
          </Text>

          <Field label="FULL NAME" value={fullName} onChangeText={setFullName} placeholder="Your name" />
          <Field label="CITY" value={city} onChangeText={setCity} placeholder="e.g. Pune" />
          <Field label="CONTACT PHONE" value={phone} onChangeText={setPhone} placeholder="Optional" keyboardType="phone-pad" />
          <Field label="YEARS OF EXPERIENCE" value={experience} onChangeText={setExperience} placeholder="Optional" keyboardType="number-pad" />

          <Text style={s.label}>SPORTS YOU CAN OFFICIATE</Text>
          <View style={s.sportRow}>
            {SPORTS.map((sp) => {
              const cfg = SPORT[sp]
              const on = sports.includes(sp)
              return (
                <TouchableOpacity
                  key={sp}
                  activeOpacity={0.85}
                  onPress={() => toggleSport(sp)}
                  style={[s.sportChip, on && { borderColor: cfg.color, backgroundColor: cfg.glow }]}
                >
                  <Text style={s.sportEmoji}>{cfg.emoji}</Text>
                  <Text style={[s.sportText, { color: on ? cfg.color : C.t2 }]}>{cfg.name}</Text>
                </TouchableOpacity>
              )
            })}
          </View>

          <Field label="CERTIFICATION" value={certification} onChangeText={setCertification} placeholder="e.g. AIFF Grade C (optional)" />
          <Field label="ABOUT YOU" value={bio} onChangeText={setBio} placeholder="A line on your officiating experience (optional)" multiline />

          <TouchableOpacity
            activeOpacity={0.85}
            style={[s.submit, { opacity: canSubmit && !busy ? 1 : 0.4 }]}
            onPress={submit}
            disabled={!canSubmit || busy}
          >
            {busy ? <ActivityIndicator color={C.limeText} /> : <Text style={s.submitText}>Submit Application</Text>}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

function Field({ label, multiline, ...props }: any) {
  return (
    <View style={{ marginBottom: SPACE.lg }}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        {...props}
        placeholderTextColor={C.t3}
        multiline={multiline}
        style={[s.input, multiline && { height: 88, textAlignVertical: 'top', paddingTop: 12 }]}
      />
    </View>
  )
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: SPACE.xl, paddingVertical: SPACE.md, borderBottomWidth: 1, borderBottomColor: C.b1,
  },
  back: { color: C.t2, fontSize: 20, fontFamily: FONT.bold },
  headerTitle: { color: C.t1, fontSize: 17, fontFamily: FONT.bold },
  intro: { color: C.t2, fontSize: 14, fontFamily: FONT.regular, lineHeight: 20, marginBottom: SPACE.xl },

  label: { color: C.t3, fontSize: 11, fontFamily: FONT.bold, letterSpacing: 1.5, marginBottom: SPACE.sm },
  input: {
    backgroundColor: C.s1, borderRadius: RADIUS.md, borderWidth: 1, borderColor: C.b1,
    paddingHorizontal: 16, paddingVertical: 13, color: C.t1, fontSize: 15, fontFamily: FONT.medium,
  },

  sportRow: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm, marginBottom: SPACE.lg },
  sportChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: C.b1,
    backgroundColor: C.s1, borderRadius: RADIUS.pill, paddingHorizontal: SPACE.lg, paddingVertical: SPACE.sm,
  },
  sportEmoji: { fontSize: 14 },
  sportText: { fontSize: 13, fontFamily: FONT.semibold },

  submit: {
    backgroundColor: C.lime, borderRadius: RADIUS.lg, paddingVertical: 16,
    alignItems: 'center', justifyContent: 'center', marginTop: SPACE.md, minHeight: 56,
  },
  submitText: { color: C.limeText, fontSize: 16, fontFamily: FONT.bold },
})
