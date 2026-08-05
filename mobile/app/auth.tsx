import { useState } from 'react'
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, KeyboardAvoidingView, Platform,
  ActivityIndicator, Alert,
} from 'react-native'
import { useRouter, useLocalSearchParams } from 'expo-router'
import { useAuthStore } from '../src/store/auth.store'
import { api } from '../src/api/client'
import { C, FONT, SPACE, RADIUS, ELEV } from '../src/theme'
import { notify } from '../src/lib/dialog'

// Dev quick-login presets → /auth/dev-token bodies
const ROLES = [
  { key: 'p05',    role: undefined,     label: 'Player',    who: 'Devansh · rated',        accent: C.lime,   emoji: '⚽' },
  { key: 'org',    role: 'organizer',   label: 'Organizer', who: 'Rohan · runs tournaments', accent: C.orange, emoji: '🏟️' },
  { key: 'ref',    role: 'referee',     label: 'Referee',   who: 'Vikram · officiator',    accent: C.blue,   emoji: '🦓' },
  { key: 'ranjit', role: 'admin',       label: 'Admin',     who: 'Ranjit · you',           accent: C.gold,   emoji: '🛡️' },
] as const

export default function AuthScreen() {
  const router = useRouter()
  // Set when a visitor arrived from the public tournament link wanting to enter a
  // team. Without it they'd land on the home tab after signing in and have to find
  // the tournament again, which is where that intent goes to die.
  const { next } = useLocalSearchParams<{ next?: string }>()
  const { setAuth } = useAuthStore()
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const devLogin = async (preset: (typeof ROLES)[number]) => {
    setBusy(preset.key)
    try {
      const res = await api.post('/auth/dev-token', {
        key: preset.key,
        role: preset.role,
        // Name the seeded account so it is recognisable rather than "Dev <key>".
        name: preset.who.split(' · ')[0],
      })
      setAuth(res.data.access_token, res.data.user)
      router.replace((next ?? '/(tabs)') as any)
    } catch (e: any) {
      notify('Error', e?.response?.data?.error ?? 'Login failed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <KeyboardAvoidingView style={s.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      {/* brand */}
      <View style={s.logoSection}>
        <View style={s.logoBadge}>
          <Text style={s.logoText}>A</Text>
        </View>
        <Text style={s.appName}>AllSports</Text>
        <Text style={s.tagline}>Track · Compete · Get Rated</Text>
      </View>

      {/* phone (real auth — coming soon) */}
      <View style={s.form}>
        <Text style={s.label}>MOBILE NUMBER</Text>
        <View style={s.phoneRow}>
          <View style={s.prefix}><Text style={s.prefixText}>🇮🇳 +91</Text></View>
          <TextInput
            style={s.phoneInput}
            placeholder="98765 43210"
            placeholderTextColor={C.t3}
            keyboardType="phone-pad"
            maxLength={10}
            value={phone}
            onChangeText={setPhone}
          />
        </View>
        <TouchableOpacity style={[s.btnPrimary, { opacity: phone.length === 10 ? 1 : 0.35 }]} disabled>
          <Text style={s.btnPrimaryText}>Send OTP</Text>
          <Text style={s.btnPrimarySub}>Firebase phone auth · coming soon</Text>
        </TouchableOpacity>

        <View style={s.dividerRow}>
          <View style={s.dividerLine} />
          <Text style={s.dividerText}>DEV QUICK LOGIN</Text>
          <View style={s.dividerLine} />
        </View>

        {/* role quick-login */}
        <View style={s.roles}>
          {ROLES.map((r) => (
            <TouchableOpacity
              key={r.key}
              activeOpacity={0.85}
              style={[s.roleBtn, { borderColor: r.accent + '44' }, busy === r.key && ELEV.glow(r.accent, 0.35)]}
              onPress={() => devLogin(r)}
              disabled={!!busy}
            >
              {busy === r.key ? (
                <ActivityIndicator color={r.accent} />
              ) : (
                <>
                  <Text style={s.roleEmoji}>{r.emoji}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={[s.roleLabel, { color: r.accent }]}>{r.label}</Text>
                    <Text style={s.roleWho}>{r.who}</Text>
                  </View>
                  <Text style={[s.roleArrow, { color: r.accent }]}>→</Text>
                </>
              )}
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <Text style={s.terms}>By continuing you agree to our Terms & Privacy Policy</Text>
    </KeyboardAvoidingView>
  )
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg, paddingHorizontal: 28, justifyContent: 'center' },

  logoSection: { alignItems: 'center', marginBottom: 44 },
  logoBadge: {
    width: 72, height: 72, borderRadius: RADIUS.lg, backgroundColor: C.lime,
    justifyContent: 'center', alignItems: 'center', marginBottom: 14, ...ELEV.glow(C.lime, 0.4),
  },
  logoText: { color: C.limeText, fontSize: 38, fontFamily: FONT.black },
  appName: { color: C.t1, fontSize: 30, fontFamily: FONT.black, letterSpacing: -0.5 },
  tagline: { color: C.t2, fontSize: 13, fontFamily: FONT.medium, marginTop: 6, letterSpacing: 0.5 },

  form: { gap: SPACE.md },
  label: { color: C.t3, fontSize: 11, fontFamily: FONT.bold, letterSpacing: 1.5 },

  phoneRow: { flexDirection: 'row', gap: SPACE.sm },
  prefix: {
    backgroundColor: C.s1, borderRadius: RADIUS.md, paddingHorizontal: 14,
    justifyContent: 'center', borderWidth: 1, borderColor: C.b1,
  },
  prefixText: { color: C.t1, fontSize: 15, fontFamily: FONT.semibold },
  phoneInput: {
    flex: 1, backgroundColor: C.s1, borderRadius: RADIUS.md, paddingHorizontal: 16,
    paddingVertical: 14, color: C.t1, fontSize: 17, fontFamily: FONT.medium,
    borderWidth: 1, borderColor: C.b1, letterSpacing: 1,
  },

  btnPrimary: {
    backgroundColor: C.lime, borderRadius: RADIUS.lg, paddingVertical: 15,
    alignItems: 'center', justifyContent: 'center', minHeight: 56,
  },
  btnPrimaryText: { color: C.limeText, fontFamily: FONT.bold, fontSize: 16 },
  btnPrimarySub: { color: 'rgba(10,15,0,0.55)', fontSize: 11, fontFamily: FONT.medium, marginTop: 2 },

  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginVertical: SPACE.sm },
  dividerLine: { flex: 1, height: 1, backgroundColor: C.b1 },
  dividerText: { color: C.t3, fontSize: 10, fontFamily: FONT.bold, letterSpacing: 1.5 },

  roles: { gap: SPACE.sm },
  roleBtn: {
    flexDirection: 'row', alignItems: 'center', gap: SPACE.md,
    backgroundColor: C.s1, borderRadius: RADIUS.lg, borderWidth: 1,
    paddingHorizontal: SPACE.lg, paddingVertical: SPACE.lg, minHeight: 64,
  },
  roleEmoji: { fontSize: 22 },
  roleLabel: { fontSize: 16, fontFamily: FONT.bold },
  roleWho: { color: C.t3, fontSize: 12, fontFamily: FONT.medium, marginTop: 1 },
  roleArrow: { fontSize: 18, fontFamily: FONT.bold },

  terms: { color: C.t3, fontSize: 12, fontFamily: FONT.regular, textAlign: 'center', marginTop: 36, lineHeight: 18 },
})
