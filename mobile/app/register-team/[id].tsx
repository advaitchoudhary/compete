/**
 * SQUAD REGISTRATION — a captain enters their team into a tournament.
 *
 * This is the other half of the public link. The page a stranger opens says
 * "enter your team"; this is where that goes.
 *
 * The design assumption that matters: **most players at a turf tournament have no
 * account and will not make one.** So the primary action is typing a name. Those
 * become guests — real identities with real stats and a real rating, claimable
 * later by a WhatsApp link. Linking an existing AllSports account is offered when
 * the typed name matches one, but it is never required.
 *
 * Squad size is enforced by the backend from the event's a-side format
 * (POST /events/:id/register). The counter here mirrors those numbers so the
 * captain isn't told they're short only after pressing submit.
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
import { C, FONT, SPACE, RADIUS, ELEV, TIER } from '../../src/theme'
import { notify } from '../../src/lib/dialog'

/** Matches BENCH_ALLOWANCE in the backend's registration route. */
const BENCH_ALLOWANCE = 7

/**
 * Outfield roles the captain declares. These move ratings — a defender carries a
 * higher baseline and takes the full clean-sheet share — so the form says so
 * plainly, and the backend caps how many defenders a squad may name.
 *
 * GK is not offered: the referee marks the keeper at match time.
 */
type Position = 'DEF' | 'MID' | 'FWD'
const POSITIONS: Array<{ value: Position; label: string }> = [
  { value: 'DEF', label: 'DEF' },
  { value: 'MID', label: 'MID' },
  { value: 'FWD', label: 'FWD' },
]

/** Mirrors MAX_DEFENDERS in the backend so the cap is visible before submitting. */
const MAX_DEFENDERS: Record<string, number> = { '5-a-side': 2, '7-a-side': 3, '11-a-side': 5 }
const DEFAULT_MAX_DEFENDERS = 3

type Player =
  | { kind: 'captain'; name: string; position?: Position }
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

export default function RegisterTeamScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const { user } = useAuthStore()

  const [teamName, setTeamName] = useState('')
  const [query, setQuery] = useState('')
  const [players, setPlayers] = useState<Player[]>([])
  const [captainPos, setCaptainPos] = useState<Position | undefined>()

  // The public endpoint carries everything this form needs (name, a-side format,
  // squad minimum, spots left) and works whether or not the session is fresh.
  const { data: event, isLoading } = useQuery<any>({
    queryKey: ['public-event', id],
    queryFn: async () => (await fetch(`${BASE_URL}/public/events/${id}`)).json(),
    enabled: !!id,
  })

  // Only search once there is something to search for; the API requires 2 chars.
  const { data: found } = useQuery<Found[]>({
    queryKey: ['user-search', query],
    queryFn: async () => (await api.get('/users/search', { params: { q: query.trim() } })).data,
    enabled: query.trim().length >= 2,
  })

  const minSquad: number = event?.min_squad ?? 5
  const maxSquad = minSquad + BENCH_ALLOWANCE
  // The captain is always in the squad and always counts toward the minimum.
  const squad: Player[] = [
    { kind: 'captain', name: user?.name ?? 'You', position: captainPos },
    ...players,
  ]
  const short = Math.max(minSquad - squad.length, 0)
  const spotsLeft = event?.max_teams != null ? event.max_teams - (event.teams?.length ?? 0) : null
  const maxDefenders = MAX_DEFENDERS[event?.match_format as string] ?? DEFAULT_MAX_DEFENDERS
  const defenderCount = squad.filter(p => p.position === 'DEF').length
  const tooManyDefenders = defenderCount > maxDefenders

  const alreadyAdded = (name: string, userId?: string) =>
    squad.some(p =>
      userId ? p.kind === 'user' && p.user_id === userId : p.name.toLowerCase() === name.toLowerCase()
    )

  const addGuest = () => {
    const name = query.trim()
    if (name.length < 2 || alreadyAdded(name) || squad.length >= maxSquad) return
    setPlayers([...players, { kind: 'guest', name }])
    setQuery('')
  }

  const addUser = (u: Found) => {
    if (alreadyAdded(u.name, u.id) || squad.length >= maxSquad) return
    setPlayers([...players, { kind: 'user', name: u.name, user_id: u.id }])
    setQuery('')
  }

  const remove = (i: number) => setPlayers(players.filter((_, n) => n !== i))

  /** index 0 is the captain; the rest map onto `players`. */
  const setPosition = (squadIndex: number, pos: Position) => {
    if (squadIndex === 0) {
      setCaptainPos(captainPos === pos ? undefined : pos)
      return
    }
    const i = squadIndex - 1
    setPlayers(players.map((p, n) => (n === i ? { ...p, position: p.position === pos ? undefined : pos } : p)))
  }

  const { mutate, isPending } = useMutation({
    mutationFn: async () => {
      const res = await api.post(`/events/${id}/register`, {
        team_name: teamName.trim(),
        ...(captainPos ? { captain_position: captainPos } : {}),
        // The captain is added server-side from the caller's token, so only the
        // other players are sent. Sending the captain too would double-count them.
        players: players.map(p => ({
          ...(p.kind === 'user' ? { user_id: p.user_id } : { name: p.name }),
          ...(p.position ? { position: p.position } : {}),
        })),
      })
      return res.data
    },
    onSuccess: () => {
      notify('You’re in', `${teamName.trim()} is registered for ${event?.name ?? 'the tournament'}.`)
      router.replace(`/e/${id}`)
    },
    onError: (e: any) => notify("Couldn't register", errText(e)),
  })

  const canSubmit =
    teamName.trim().length >= 2 && squad.length >= minSquad && squad.length <= maxSquad &&
    !tooManyDefenders && !isPending

  if (isLoading || !event) {
    return <View style={s.fill}><ActivityIndicator color={C.lime} size="large" /></View>
  }

  if (event.status !== 'registration') {
    return (
      <View style={s.fill}>
        <Text style={s.closedTitle}>Sign-ups are closed</Text>
        <Text style={s.closedBody}>
          {event.name} is not accepting teams right now.
        </Text>
        <TouchableOpacity onPress={() => router.replace(`/e/${id}`)}>
          <Text style={s.link}>View the tournament →</Text>
        </TouchableOpacity>
      </View>
    )
  }

  const tier = TIER[event.tier] ?? TIER.amateur

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={s.header}>
          <TouchableOpacity style={s.back} onPress={() => router.back()} activeOpacity={0.7}>
            <Text style={s.backIcon}>←</Text>
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={s.eyebrow}>ENTERING</Text>
            <Text style={s.title} numberOfLines={1}>{event.name}</Text>
          </View>
          <View style={[s.tierChip, { backgroundColor: tier.glow, borderColor: tier.color }]}>
            <Text style={[s.tierChipText, { color: tier.color }]}>{tier.label}</Text>
          </View>
        </View>

        <ScrollView
          contentContainerStyle={{ paddingBottom: 140 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={s.meta}>
            {event.match_format ?? 'Football'} · {event.city}
            {spotsLeft != null ? ` · ${Math.max(spotsLeft, 0)} spots left` : ''}
          </Text>

          {/* Team name */}
          <Text style={s.label}>TEAM NAME</Text>
          <View style={s.inputWrap}>
            <Text style={s.inputIcon}>🛡️</Text>
            <TextInput
              style={s.input}
              placeholder="e.g. Baner Blasters"
              placeholderTextColor={C.t3}
              value={teamName}
              onChangeText={setTeamName}
              maxLength={60}
            />
          </View>

          {/* Squad counter */}
          <View style={s.countHead}>
            <Text style={s.label}>SQUAD</Text>
            <Text style={[s.count, short === 0 && { color: C.lime }]}>
              {squad.length} / {minSquad}
              {short > 0 ? ` · ${short} more needed` : ' ✓'}
            </Text>
          </View>
          <View style={s.track}>
            <View style={[s.trackFill, { width: `${Math.min((squad.length / minSquad) * 100, 100)}%` }]} />
          </View>

          {/* Squad list */}
          <View style={s.squad}>
            {squad.map((p, i) => (
              <View key={`${p.kind}-${p.name}-${i}`} style={s.playerRow}>
                <View style={s.playerTop}>
                  <Text style={s.playerNum}>{i + 1}</Text>
                  <Text style={s.playerName} numberOfLines={1}>{p.name}</Text>
                  {p.kind === 'captain' && <Text style={s.captainTag}>CAPTAIN · YOU</Text>}
                  {p.kind === 'user' && <Text style={s.userTag}>ON ALLSPORTS</Text>}
                  {p.kind === 'guest' && <Text style={s.guestTag}>GUEST</Text>}
                  {p.kind !== 'captain' && (
                    <TouchableOpacity onPress={() => remove(i - 1)} hitSlop={8} activeOpacity={0.6}>
                      <Text style={s.removeIcon}>✕</Text>
                    </TouchableOpacity>
                  )}
                </View>
                <View style={s.posRow}>
                  {POSITIONS.map(op => {
                    const active = p.position === op.value
                    // Block a fourth defender rather than letting the backend reject
                    // the whole registration after they have typed everything in.
                    const blocked =
                      op.value === 'DEF' && !active && defenderCount >= maxDefenders
                    return (
                      <TouchableOpacity
                        key={op.value}
                        style={[
                          s.posPill,
                          active && { backgroundColor: C.lime, borderColor: C.lime },
                          blocked && { opacity: 0.3 },
                        ]}
                        disabled={blocked}
                        onPress={() => setPosition(i, op.value)}
                        activeOpacity={0.75}
                      >
                        <Text style={[s.posPillText, active && { color: C.limeText }]}>
                          {op.label}
                        </Text>
                      </TouchableOpacity>
                    )
                  })}
                  {!p.position && <Text style={s.posHint}>role not set</Text>}
                </View>
              </View>
            ))}
          </View>

          {/* Say plainly that this is not cosmetic. */}
          <View style={s.posNote}>
            <Text style={s.posNoteTitle}>⚖ Positions affect ratings</Text>
            <Text style={s.posNoteBody}>
              Defenders and midfielders earn credit for a clean sheet that forwards
              don't, so a defender who keeps a 0-0 back rates higher than the stat
              sheet alone would show. Set these honestly — at most {maxDefenders}{' '}
              defenders for {event.match_format ?? 'this format'}, and your referee
              can correct them on match day. Leave a player blank and they're rated
              on goals and assists only.
            </Text>
            <Text style={s.posNoteBody}>
              The goalkeeper isn't here — your referee marks the keeper at kick-off.
            </Text>
          </View>

          {/* Add players */}
          {squad.length < maxSquad ? (
            <>
              <Text style={s.label}>ADD A PLAYER</Text>
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
                  {/* Guest first: it is the common case and needs no match. */}
                  <TouchableOpacity style={s.addGuestBtn} onPress={addGuest} activeOpacity={0.85}>
                    <Text style={s.addGuestText}>
                      + Add “{query.trim()}” as a guest
                    </Text>
                    <Text style={s.addGuestSub}>No account needed — they can claim it later</Text>
                  </TouchableOpacity>

                  {(found ?? []).filter(u => !alreadyAdded(u.name, u.id)).slice(0, 5).map(u => (
                    <TouchableOpacity key={u.id} style={s.foundRow} onPress={() => addUser(u)} activeOpacity={0.8}>
                      <Text style={s.foundName}>{u.name}</Text>
                      <Text style={s.foundMeta}>
                        {u.username ? `@${u.username}` : ''}{u.city ? ` · ${u.city}` : ''}
                      </Text>
                      <Text style={s.foundAdd}>on AllSports →</Text>
                    </TouchableOpacity>
                  ))}
                </>
              )}
              <Text style={s.hint}>
                Up to {maxSquad} players ({minSquad} minimum plus a bench of {BENCH_ALLOWANCE}).
              </Text>
            </>
          ) : (
            <Text style={s.hint}>Squad is full at {maxSquad} players.</Text>
          )}
        </ScrollView>

        <View style={s.footer}>
          <TouchableOpacity
            style={[s.submit, !canSubmit && { opacity: 0.4 }]}
            disabled={!canSubmit}
            onPress={() => mutate()}
            activeOpacity={0.85}
          >
            <Text style={s.submitText}>
              {isPending
                ? 'Registering…'
                : teamName.trim().length < 2
                  ? 'Name your team'
                  : short > 0
                    ? `${short} more player${short === 1 ? '' : 's'} needed`
                    : `Register ${teamName.trim()}`}
            </Text>
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
  tierChip: { paddingHorizontal: 9, paddingVertical: 4, borderRadius: RADIUS.sm, borderWidth: 1 },
  tierChipText: { fontSize: 9, fontFamily: FONT.bold, letterSpacing: 0.6 },
  meta: {
    color: C.t2, fontSize: 12, fontFamily: FONT.regular,
    paddingHorizontal: SPACE.lg, paddingBottom: SPACE.lg,
  },

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

  countHead: {
    flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between',
    marginRight: SPACE.lg,
  },
  count: { color: C.amber, fontSize: 12, fontFamily: FONT.bold },
  track: {
    height: 4, backgroundColor: C.s3, borderRadius: 2,
    marginHorizontal: SPACE.lg, overflow: 'hidden',
  },
  trackFill: { height: 4, backgroundColor: C.lime, borderRadius: 2 },

  squad: { marginTop: SPACE.md, marginHorizontal: SPACE.lg, gap: 3 },
  playerRow: {
    backgroundColor: C.s1, borderRadius: RADIUS.md,
    paddingHorizontal: SPACE.md, paddingVertical: 10,
    borderWidth: 1, borderColor: C.b0, gap: 8,
  },
  playerTop: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  posRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  posPill: {
    paddingHorizontal: 12, paddingVertical: 5, borderRadius: RADIUS.sm,
    backgroundColor: C.s3, borderWidth: 1, borderColor: C.b1,
  },
  posPillText: { color: C.t2, fontSize: 11, fontFamily: FONT.bold, letterSpacing: 0.5 },
  posHint: { color: C.t3, fontSize: 10, fontFamily: FONT.regular, marginLeft: 2 },
  posNote: {
    marginHorizontal: SPACE.lg, marginTop: SPACE.md, padding: SPACE.md, gap: 6,
    backgroundColor: 'rgba(245,158,11,0.07)', borderRadius: RADIUS.md,
    borderWidth: 1, borderColor: 'rgba(245,158,11,0.28)',
  },
  posNoteTitle: { color: C.amber, fontSize: 12, fontFamily: FONT.bold },
  posNoteBody: { color: C.t2, fontSize: 12, fontFamily: FONT.regular, lineHeight: 18 },
  playerNum: { color: C.t3, fontSize: 11, fontFamily: FONT.bold, width: 16 },
  playerName: { flex: 1, color: C.t1, fontSize: 14, fontFamily: FONT.semibold },
  captainTag: { color: C.lime, fontSize: 9, fontFamily: FONT.bold, letterSpacing: 0.8 },
  userTag: { color: C.blue, fontSize: 9, fontFamily: FONT.bold, letterSpacing: 0.8 },
  guestTag: { color: C.t3, fontSize: 9, fontFamily: FONT.bold, letterSpacing: 0.8 },
  removeIcon: { color: C.t3, fontSize: 14, fontFamily: FONT.bold, paddingLeft: 4 },

  addGuestBtn: {
    marginHorizontal: SPACE.lg, marginTop: SPACE.sm, padding: SPACE.md,
    backgroundColor: C.limeGlow, borderRadius: RADIUS.md,
    borderWidth: 1, borderColor: C.lime,
  },
  addGuestText: { color: C.lime, fontSize: 14, fontFamily: FONT.bold },
  addGuestSub: { color: C.t2, fontSize: 11, fontFamily: FONT.regular, marginTop: 2 },

  foundRow: {
    marginHorizontal: SPACE.lg, marginTop: 4, padding: SPACE.md,
    backgroundColor: C.s1, borderRadius: RADIUS.md, borderWidth: 1, borderColor: C.b1,
  },
  foundName: { color: C.t1, fontSize: 14, fontFamily: FONT.semibold },
  foundMeta: { color: C.t3, fontSize: 11, fontFamily: FONT.regular },
  foundAdd: { color: C.blue, fontSize: 10, fontFamily: FONT.bold, marginTop: 3 },

  hint: {
    color: C.t3, fontSize: 11, fontFamily: FONT.regular,
    marginHorizontal: SPACE.lg, marginTop: SPACE.sm, lineHeight: 16,
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
