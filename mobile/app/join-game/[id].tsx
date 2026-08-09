/**
 * JOIN A PICKUP GAME — you, plus anyone you are bringing.
 *
 * The party is the unit. Whatever you put down here goes in together or waits
 * together, and if you later drop out it all leaves with you, because your mates
 * were only coming because you were.
 *
 * So the screen has to be honest before you commit: if your group is bigger than
 * the spots left, it says you will all be on the waitlist rather than letting you
 * find out afterwards.
 */
import { useState } from 'react'
import {
  View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity,
  ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useQuery, useMutation } from '@tanstack/react-query'
import { api, BASE_URL } from '../../src/api/client'
import { useAuthStore } from '../../src/store/auth.store'
import { C, FONT, SPACE, RADIUS, ELEV } from '../../src/theme'
import { notify } from '../../src/lib/dialog'

type Position = 'DEF' | 'MID' | 'FWD'
const POSITIONS: Position[] = ['DEF', 'MID', 'FWD']

type Mate =
  | { kind: 'guest'; name: string; position?: Position }
  | { kind: 'user'; name: string; user_id: string; position?: Position }

type Found = { id: string; name: string; username: string | null; city: string | null }

const errText = (e: any): string => {
  const err = e?.response?.data?.error
  if (typeof err === 'string') return err
  if (err?.fieldErrors) {
    return Object.values(err.fieldErrors as Record<string, string[]>).flat().join('\n')
  }
  return e?.message ?? 'Something went wrong'
}

export default function JoinGameScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const { user } = useAuthStore()

  const [myPosition, setMyPosition] = useState<Position | undefined>()
  const [query, setQuery] = useState('')
  const [mates, setMates] = useState<Mate[]>([])

  // The unauthenticated endpoint carries everything this screen needs and works
  // whether or not the session is fresh.
  const { data: game, isLoading } = useQuery<any>({
    queryKey: ['public-game', id],
    queryFn: async () => (await fetch(`${BASE_URL}/public/games/${id}`)).json(),
    enabled: !!id,
  })

  const { data: found } = useQuery<Found[]>({
    queryKey: ['user-search', query],
    queryFn: async () => (await api.get('/users/search', { params: { q: query.trim() } })).data,
    enabled: query.trim().length >= 2,
  })

  const partySize = 1 + mates.length
  const spotsLeft: number = game?.spots_left ?? 0
  // The one thing worth knowing before pressing the button.
  const willWait = partySize > spotsLeft

  const alreadyAdded = (name: string, userId?: string) =>
    mates.some(m =>
      userId ? m.kind === 'user' && m.user_id === userId : m.name.toLowerCase() === name.toLowerCase()
    ) || name.toLowerCase() === (user?.name ?? '').toLowerCase()

  const addGuest = () => {
    const name = query.trim()
    if (name.length < 2 || alreadyAdded(name)) return
    setMates([...mates, { kind: 'guest', name }])
    setQuery('')
  }

  const addUser = (u: Found) => {
    if (alreadyAdded(u.name, u.id)) return
    setMates([...mates, { kind: 'user', name: u.name, user_id: u.id }])
    setQuery('')
  }

  const setMatePosition = (i: number, p: Position) =>
    setMates(mates.map((m, n) => (n === i ? { ...m, position: m.position === p ? undefined : p } : m)))

  const { mutate, isPending } = useMutation({
    mutationFn: async () =>
      (await api.post(`/games/${id}/join`, {
        ...(myPosition ? { position: myPosition } : {}),
        players: mates.map(m => ({
          ...(m.kind === 'user' ? { user_id: m.user_id } : { name: m.name }),
          ...(m.position ? { position: m.position } : {}),
        })),
      })).data,
    onSuccess: (res: any) => {
      notify(
        res.status === 'confirmed' ? "You're in" : "You're on the waitlist",
        res.status === 'confirmed'
          ? `${res.joined} spot${res.joined === 1 ? '' : 's'} taken. ${res.spots_left} left.`
          : `Number ${res.waitlist_position} in line. You'll come straight in if someone drops out.`
      )
      router.replace(`/g/${id}`)
    },
    onError: (e) => notify("Couldn't join", errText(e)),
  })

  if (isLoading || !game) {
    return <View style={s.fill}><ActivityIndicator color={C.lime} size="large" /></View>
  }

  if (game.status !== 'registration') {
    return (
      <View style={s.fill}>
        <Text style={s.closedTitle}>Sign-ups are closed</Text>
        <Text style={s.closedBody}>{game.name} is not taking players right now.</Text>
        <TouchableOpacity onPress={() => router.replace(`/g/${id}`)}>
          <Text style={s.link}>View the game →</Text>
        </TouchableOpacity>
      </View>
    )
  }

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={s.header}>
          <TouchableOpacity style={s.back} onPress={() => router.back()} activeOpacity={0.7}>
            <Text style={s.backIcon}>←</Text>
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={s.eyebrow}>JOINING</Text>
            <Text style={s.title} numberOfLines={1}>{game.name}</Text>
          </View>
        </View>

        <ScrollView
          contentContainerStyle={{ paddingBottom: 140 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Text style={s.meta}>
            {game.match_format} · {game.venue ? `${game.venue} · ` : ''}{game.city}
            {' · '}{spotsLeft} spot{spotsLeft === 1 ? '' : 's'} left
          </Text>

          {/* Said up front, not after pressing the button. */}
          {willWait && (
            <View style={s.warnBox}>
              <Text style={s.warnText}>
                {spotsLeft === 0
                  ? 'The game is full, so your group goes on the waitlist.'
                  : `Only ${spotsLeft} spot${spotsLeft === 1 ? '' : 's'} left and there are ${partySize} of you, so you'll all wait together — a group is never split across the cut.`}
                {' '}You come straight in when enough spots free up.
              </Text>
            </View>
          )}

          <Text style={s.label}>YOU</Text>
          <View style={s.playerRow}>
            <Text style={s.playerName}>{user?.name ?? 'You'}</Text>
            <View style={s.posRow}>
              {POSITIONS.map(p => {
                const on = myPosition === p
                return (
                  <TouchableOpacity
                    key={p}
                    style={[s.posPill, on && { backgroundColor: C.lime, borderColor: C.lime }]}
                    onPress={() => setMyPosition(on ? undefined : p)}
                    activeOpacity={0.75}
                  >
                    <Text style={[s.posText, on && { color: C.limeText }]}>{p}</Text>
                  </TouchableOpacity>
                )
              })}
            </View>
          </View>

          {mates.length > 0 && (
            <>
              <Text style={s.label}>BRINGING ({mates.length})</Text>
              {mates.map((m, i) => (
                <View key={`${m.name}-${i}`} style={s.playerRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.playerName}>{m.name}</Text>
                    <Text style={s.playerTag}>
                      {m.kind === 'user' ? 'on AllSports' : 'guest · can claim their rating later'}
                    </Text>
                  </View>
                  <View style={s.posRow}>
                    {POSITIONS.map(p => {
                      const on = m.position === p
                      return (
                        <TouchableOpacity
                          key={p}
                          style={[s.posPill, on && { backgroundColor: C.lime, borderColor: C.lime }]}
                          onPress={() => setMatePosition(i, p)}
                          activeOpacity={0.75}
                        >
                          <Text style={[s.posText, on && { color: C.limeText }]}>{p}</Text>
                        </TouchableOpacity>
                      )
                    })}
                    <TouchableOpacity onPress={() => setMates(mates.filter((_, n) => n !== i))} hitSlop={8}>
                      <Text style={s.remove}>✕</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ))}
            </>
          )}

          <Text style={s.label}>BRINGING ANYONE?</Text>
          <View style={s.inputWrap}>
            <Text style={s.inputIcon}>👤</Text>
            <TextInput
              style={s.input}
              placeholder="Type their name"
              placeholderTextColor={C.t3}
              value={query}
              onChangeText={setQuery}
              onSubmitEditing={addGuest}
              returnKeyType="done"
              maxLength={80}
            />
          </View>

          {query.trim().length >= 2 && (
            <>
              <TouchableOpacity style={s.addGuestBtn} onPress={addGuest} activeOpacity={0.85}>
                <Text style={s.addGuestText}>+ Add “{query.trim()}”</Text>
                <Text style={s.addGuestSub}>No account needed — they can claim their rating later</Text>
              </TouchableOpacity>
              {(found ?? []).filter(u => !alreadyAdded(u.name, u.id)).slice(0, 4).map(u => (
                <TouchableOpacity key={u.id} style={s.foundRow} onPress={() => addUser(u)} activeOpacity={0.8}>
                  <Text style={s.foundName}>{u.name}</Text>
                  <Text style={s.foundMeta}>
                    {u.username ? `@${u.username}` : ''}{u.city ? ` · ${u.city}` : ''} · on AllSports →
                  </Text>
                </TouchableOpacity>
              ))}
            </>
          )}

          <Text style={s.hint}>
            Whoever you bring joins and leaves with you. If you drop out, they do too.
          </Text>
        </ScrollView>

        <View style={s.footer}>
          <TouchableOpacity
            style={[s.submit, isPending && { opacity: 0.5 }]}
            disabled={isPending}
            onPress={() => mutate()}
            activeOpacity={0.85}
          >
            {isPending ? (
              <ActivityIndicator color={C.limeText} />
            ) : (
              <Text style={s.submitText}>
                {willWait ? 'Join the waitlist' : 'Confirm'} · {partySize} player{partySize === 1 ? '' : 's'}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  fill: { flex: 1, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center', gap: SPACE.sm, padding: SPACE.xl },
  closedTitle: { color: C.t1, fontSize: 20, fontFamily: FONT.bold },
  closedBody: { color: C.t2, fontSize: 14, fontFamily: FONT.regular, textAlign: 'center' },
  link: { color: C.lime, fontSize: 14, fontFamily: FONT.semibold, marginTop: SPACE.md },

  header: {
    flexDirection: 'row', alignItems: 'center', gap: SPACE.md,
    paddingHorizontal: SPACE.lg, paddingTop: SPACE.sm, paddingBottom: SPACE.xs,
  },
  back: {
    width: 40, height: 40, borderRadius: RADIUS.pill, backgroundColor: C.s2,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.b1,
  },
  backIcon: { color: C.t1, fontSize: 18, fontFamily: FONT.bold },
  eyebrow: { color: C.t3, fontSize: 10, fontFamily: FONT.bold, letterSpacing: 2 },
  title: { color: C.t1, fontSize: 21, fontFamily: FONT.black, letterSpacing: -0.4 },
  meta: { color: C.t2, fontSize: 12, fontFamily: FONT.regular, paddingHorizontal: SPACE.lg, paddingBottom: SPACE.md },

  warnBox: {
    marginHorizontal: SPACE.lg, padding: SPACE.md,
    backgroundColor: 'rgba(245,158,11,0.08)', borderRadius: RADIUS.md,
    borderWidth: 1, borderColor: 'rgba(245,158,11,0.3)',
  },
  warnText: { color: C.amber, fontSize: 12, fontFamily: FONT.medium, lineHeight: 18 },

  label: {
    color: C.t3, fontSize: 10, fontFamily: FONT.bold, letterSpacing: 1.5,
    marginHorizontal: SPACE.lg, marginTop: SPACE.lg, marginBottom: SPACE.sm,
  },
  playerRow: {
    flexDirection: 'row', alignItems: 'center', gap: SPACE.sm,
    marginHorizontal: SPACE.lg, marginBottom: 4, paddingHorizontal: SPACE.md, paddingVertical: 10,
    backgroundColor: C.s1, borderRadius: RADIUS.md, borderWidth: 1, borderColor: C.b0,
  },
  playerName: { flex: 1, color: C.t1, fontSize: 14, fontFamily: FONT.semibold },
  playerTag: { color: C.t3, fontSize: 10, fontFamily: FONT.regular, marginTop: 1 },
  posRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  posPill: {
    paddingHorizontal: 9, paddingVertical: 5, borderRadius: RADIUS.sm,
    backgroundColor: C.s3, borderWidth: 1, borderColor: C.b1,
  },
  posText: { color: C.t2, fontSize: 10, fontFamily: FONT.bold },
  remove: { color: C.t3, fontSize: 13, fontFamily: FONT.bold, paddingLeft: 4 },

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

  addGuestBtn: {
    marginHorizontal: SPACE.lg, marginTop: SPACE.sm, padding: SPACE.md,
    backgroundColor: C.limeGlow, borderRadius: RADIUS.md, borderWidth: 1, borderColor: C.lime,
  },
  addGuestText: { color: C.lime, fontSize: 14, fontFamily: FONT.bold },
  addGuestSub: { color: C.t2, fontSize: 11, fontFamily: FONT.regular, marginTop: 2 },
  foundRow: {
    marginHorizontal: SPACE.lg, marginTop: 4, padding: SPACE.md,
    backgroundColor: C.s1, borderRadius: RADIUS.md, borderWidth: 1, borderColor: C.b1,
  },
  foundName: { color: C.t1, fontSize: 14, fontFamily: FONT.semibold },
  foundMeta: { color: C.t3, fontSize: 11, fontFamily: FONT.regular },

  hint: {
    color: C.t3, fontSize: 11, fontFamily: FONT.regular, lineHeight: 16,
    marginHorizontal: SPACE.lg, marginTop: SPACE.md,
  },

  footer: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    padding: SPACE.lg, paddingBottom: SPACE.xl,
    backgroundColor: C.bg, borderTopWidth: 1, borderTopColor: C.b1,
  },
  submit: {
    backgroundColor: C.lime, borderRadius: RADIUS.lg, paddingVertical: 16,
    alignItems: 'center', ...ELEV.glow(C.lime, 0.3),
  },
  submitText: { color: C.limeText, fontSize: 16, fontFamily: FONT.bold },
})
