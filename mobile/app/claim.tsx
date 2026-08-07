/**
 * Guest claim page — the far end of the WhatsApp link.
 *
 * Someone played in a tournament, was typed in by their captain, and earned a real
 * rating. They tap a link and this page hands them the profile. No account, no
 * password, no download: possession of the link is the credential, exactly like a
 * magic link.
 *
 * Deliberately unauthenticated and self-contained — it uses raw fetch rather than
 * the axios client, because that client attaches a JWT and clears state on 401,
 * and the person opening this has no session yet.
 */
import { useEffect, useState } from 'react'
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { BASE_URL, setToken, saveUser } from '../src/api/client'
import {
  sendOtp, phoneAuthMessage, normalisePhoneInput, isCompletePhone,
  type PendingVerification,
} from '../src/lib/phone-auth'
import { C, FONT, SPACE, RADIUS, ELEV } from '../src/theme'

type State = 'ready' | 'claiming' | 'done' | 'error'

export default function ClaimPage() {
  const { token } = useLocalSearchParams<{ token?: string }>()
  const router = useRouter()

  const [name, setName] = useState('')
  // Claiming now requires proving who you are, not just holding the link — the
  // verified phone becomes the credential that lets this person come back.
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [pending, setPending] = useState<PendingVerification | null>(null)
  const [state, setState] = useState<State>('ready')
  const [error, setError] = useState<string | null>(null)
  const [claimedName, setClaimedName] = useState('')

  useEffect(() => {
    if (!token) {
      setState('error')
      setError('This link is missing its claim code.')
    }
  }, [token])

  const requestOtp = async () => {
    setState('claiming')
    setError(null)
    try {
      setPending(await sendOtp(phone))
      setState('ready')
    } catch (e) {
      setState('ready')
      setError(phoneAuthMessage(e))
    }
  }

  const claim = async () => {
    if (!pending) return
    setState('claiming')
    setError(null)
    try {
      const idToken = await pending.confirm(code.trim())
      const res = await fetch(`${BASE_URL}/auth/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token,
          firebase_id_token: idToken,
          ...(name.trim() ? { name: name.trim() } : {}),
        }),
      })
      const body = await res.json()

      if (!res.ok) {
        setState('error')
        setError(body?.error ?? 'This link could not be used.')
        return
      }

      // Straight into a session — the point is that claiming IS signing in.
      setToken(body.access_token)
      saveUser(body.user)
      setClaimedName(body.user.name)
      setState('done')
    } catch (e) {
      setState('ready')
      setError(phoneAuthMessage(e))
    }
  }

  if (state === 'error') {
    return (
      <View style={s.page}>
        <View style={s.card}>
          <Text style={s.badge}>CLAIM FAILED</Text>
          <Text style={s.title}>{error}</Text>
          <Text style={s.body}>
            Claim links expire, and each profile can only be claimed once. Ask whoever ran your
            tournament to send a fresh link.
          </Text>
        </View>
      </View>
    )
  }

  if (state === 'done') {
    return (
      <View style={s.page}>
        <View style={s.card}>
          <Text style={[s.badge, { color: C.lime }]}>PROFILE CLAIMED</Text>
          <Text style={s.title}>Welcome, {claimedName}.</Text>
          <Text style={s.body}>
            Every match you have already played is on your profile, with the rating you earned. It
            keeps building from here.
          </Text>
          <TouchableOpacity style={s.primary} onPress={() => router.replace('/(tabs)')} activeOpacity={0.85}>
            <Text style={s.primaryText}>See my profile</Text>
          </TouchableOpacity>
        </View>
      </View>
    )
  }

  return (
    <View style={s.page}>
      <View style={s.card}>
        <Text style={s.badge}>YOU PLAYED TODAY</Text>
        <Text style={s.title}>Claim your profile</Text>
        <Text style={s.body}>
          Your captain entered you into a tournament, and you have been rated on every match you
          played. Claim the profile to keep it.
        </Text>

        <Text style={s.label}>YOUR NAME</Text>
        <TextInput
          style={s.input}
          value={name}
          onChangeText={setName}
          placeholder="Leave blank to keep the name you were entered under"
          placeholderTextColor={C.t3}
          autoCapitalize="words"
        />

        {/* Verifying a number is what turns this into an account you can come back
            to. Without it the profile would be yours only until the session ran
            out, and the link is already spent. */}
        <Text style={s.label}>YOUR MOBILE NUMBER</Text>
        <TextInput
          style={s.input}
          value={phone}
          onChangeText={(v) => { setPhone(normalisePhoneInput(v)); setPending(null); setCode('') }}
          placeholder="98765 43210"
          placeholderTextColor={C.t3}
          keyboardType="phone-pad"
          editable={!pending}
        />

        {pending && (
          <>
            <Text style={s.label}>THE 6-DIGIT CODE WE SENT</Text>
            <TextInput
              style={[s.input, { fontSize: 22, letterSpacing: 10, textAlign: 'center' }]}
              value={code}
              onChangeText={setCode}
              placeholder="––––––"
              placeholderTextColor={C.t3}
              keyboardType="number-pad"
              maxLength={6}
              autoFocus
            />
          </>
        )}

        {error && <Text style={s.inlineError}>{error}</Text>}

        <TouchableOpacity
          style={[
            s.primary,
            (state === 'claiming' || (!pending && !isCompletePhone(phone)) || (pending && code.length < 6)) &&
              { opacity: 0.5 },
          ]}
          onPress={pending ? claim : requestOtp}
          disabled={
            state === 'claiming' || (!pending ? !isCompletePhone(phone) : code.length < 6)
          }
          activeOpacity={0.85}
        >
          {state === 'claiming' ? (
            <ActivityIndicator color={C.limeText} />
          ) : (
            <Text style={s.primaryText}>
              {pending ? 'Verify & claim my profile' : 'Send me a code'}
            </Text>
          )}
        </TouchableOpacity>

        <Text style={s.fine}>
          The link says which profile; the code proves it is you. Your number becomes how
          you sign in from now on.
        </Text>
      </View>
    </View>
  )
}

const s = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: C.bg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: SPACE.lg,
  },
  card: {
    width: '100%',
    maxWidth: 440,
    backgroundColor: C.s1,
    borderRadius: RADIUS.xl,
    borderWidth: 1,
    borderColor: C.b1,
    padding: SPACE.xl,
    ...ELEV.card,
  },
  badge: { color: C.t3, fontSize: 10, fontFamily: FONT.bold, letterSpacing: 2 },
  title: {
    color: C.t1,
    fontSize: 26,
    fontFamily: FONT.black,
    letterSpacing: -0.8,
    marginTop: SPACE.sm,
    lineHeight: 31,
  },
  body: { color: C.t2, fontSize: 14, fontFamily: FONT.regular, lineHeight: 21, marginTop: SPACE.sm },

  label: {
    color: C.t3,
    fontSize: 10,
    fontFamily: FONT.bold,
    letterSpacing: 1.6,
    marginTop: SPACE.xl,
    marginBottom: 6,
  },
  input: {
    backgroundColor: C.s3,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: C.b1,
    paddingHorizontal: SPACE.md,
    paddingVertical: 13,
    color: C.t1,
    fontSize: 14,
    fontFamily: FONT.medium,
  },

  primary: {
    backgroundColor: C.lime,
    borderRadius: RADIUS.lg,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: SPACE.lg,
    ...ELEV.glow(C.lime, 0.3),
  },
  primaryText: { color: C.limeText, fontSize: 15, fontFamily: FONT.bold },
  inlineError: { color: C.amber, fontSize: 12, lineHeight: 18 },
  fine: {
    color: C.t3,
    fontSize: 11,
    fontFamily: FONT.regular,
    lineHeight: 16,
    marginTop: SPACE.md,
    textAlign: 'center',
  },
})
