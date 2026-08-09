/**
 * REFEREE ASSIGNMENT — pick the officials working this tournament and put each on
 * a pitch.
 *
 * Two things make this screen more than a multi-select:
 *
 *  1. A pitch label is what actually matters. The fixture generator derives the
 *     venue's parallel capacity from distinct pitch labels, so a referee with no
 *     pitch contributes nothing to the schedule. The UI says so instead of letting
 *     the organizer discover it from a 400.
 *  2. The roster caps the tournament's grade — the weakest referee sets the
 *     ceiling (spec §3.1.1). The projected ceiling is shown live as you select,
 *     so the trade-off is visible at the moment of choosing.
 */
import { useMemo, useState } from 'react'
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, ActivityIndicator,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../src/api/client'
import { C, FONT, SPACE, RADIUS, TIER, TIER_ORDER, ELEV } from '../../../src/theme'
import { notify } from '../../../src/lib/dialog'

type Referee = {
  id: string
  name: string
  username: string | null
  city: string | null
  referee_tier: string | null
}

/** Pitch choices offered. Turf venues realistically run one to four. */
const PITCHES = ['Pitch 1', 'Pitch 2', 'Pitch 3', 'Pitch 4']

const errText = (e: any): string => {
  const err = e?.response?.data?.error
  if (typeof err === 'string') return err
  if (err?.fieldErrors) return Object.values(err.fieldErrors).flat().join(', ')
  return e?.message ?? 'Something went wrong'
}

export default function AssignRefereesScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const qc = useQueryClient()

  const [q, setQ] = useState('')
  const [saving, setSaving] = useState(false)
  /** user_id → pitch label (or null for "assigned but no pitch yet"). */
  const [picked, setPicked] = useState<Record<string, string | null> | null>(null)

  const { data: setup } = useQuery<any>({
    queryKey: ['organizer', 'setup', id],
    queryFn: async () => (await api.get(`/organizer/events/${id}/setup`)).data,
    enabled: !!id,
  })

  const { data: pool, isLoading } = useQuery<{ referees: Referee[] }>({
    queryKey: ['organizer', 'referees', q],
    queryFn: async () =>
      (await api.get('/organizer/referees', { params: q.trim() ? { q: q.trim() } : {} })).data,
  })

  // Seed the selection from the saved roster the first time setup lands, then let
  // local edits own it. Deriving on every render would discard the user's taps.
  const selection: Record<string, string | null> =
    picked ??
    Object.fromEntries((setup?.referees ?? []).map((r: any) => [r.user_id, r.pitch_label]))

  const referees = pool?.referees ?? []
  const byId = useMemo(() => {
    const m = new Map<string, Referee>()
    for (const r of referees) m.set(r.id, r)
    // Already-assigned referees may not match the current search text, but we
    // still need their tier to project the ceiling.
    for (const r of setup?.referees ?? []) {
      if (!m.has(r.user_id)) {
        m.set(r.user_id, { id: r.user_id, name: r.name, username: null, city: null, referee_tier: r.referee_tier })
      }
    }
    return m
  }, [referees, setup])

  const selectedIds = Object.keys(selection)

  /** The grade this selection could support — the weakest selected referee. */
  const projectedCeiling = useMemo(() => {
    if (selectedIds.length === 0) return 'amateur'
    let worst = TIER_ORDER.length - 1
    for (const uid of selectedIds) {
      const t = byId.get(uid)?.referee_tier ?? 'amateur'
      const rank = TIER_ORDER.indexOf(t as any)
      if (rank >= 0 && rank < worst) worst = rank
    }
    return TIER_ORDER[worst]
  }, [selectedIds, byId])

  const withPitch = selectedIds.filter(uid => selection[uid])
  const pitchesUsed = withPitch.map(uid => selection[uid] as string)
  const duplicatePitch = pitchesUsed.length !== new Set(pitchesUsed).size

  const toggle = (uid: string) => {
    const next = { ...selection }
    if (uid in next) delete next[uid]
    else {
      // Auto-assign the first free pitch — the common case is one referee per
      // pitch, and making that the default saves a tap per official.
      const taken = new Set(Object.values(next).filter(Boolean) as string[])
      next[uid] = PITCHES.find(p => !taken.has(p)) ?? null
    }
    setPicked(next)
  }

  const setPitch = (uid: string, pitch: string | null) =>
    setPicked({ ...selection, [uid]: pitch })

  const save = async () => {
    setSaving(true)
    try {
      await api.post(`/events/${id}/referees`, {
        referees: selectedIds.map(uid => ({
          user_id: uid,
          ...(selection[uid] ? { pitch_label: selection[uid] } : {}),
        })),
      })
      qc.invalidateQueries({ queryKey: ['organizer', 'setup', id] })
      qc.invalidateQueries({ queryKey: ['organizer', 'events'] })
      router.back()
    } catch (e) {
      notify('Could not save', errText(e))
    } finally {
      setSaving(false)
    }
  }

  const ceilTier = TIER[projectedCeiling] ?? TIER.amateur
  const eventTier = setup?.event?.tier
  const wouldBreakTier =
    eventTier && TIER_ORDER.indexOf(projectedCeiling as any) < TIER_ORDER.indexOf(eventTier)

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      <View style={s.header}>
        <TouchableOpacity style={s.back} onPress={() => router.back()} activeOpacity={0.7}>
          <Text style={s.backIcon}>←</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.eyebrow}>STEP 1</Text>
          <Text style={s.title}>Referees & pitches</Text>
        </View>
      </View>

      {/* Live projection of what this selection means */}
      <View style={s.summary}>
        <View style={s.summaryCell}>
          <Text style={s.summaryValue}>{selectedIds.length}</Text>
          <Text style={s.summaryLabel}>SELECTED</Text>
        </View>
        <View style={s.summaryDivider} />
        <View style={s.summaryCell}>
          <Text style={[s.summaryValue, withPitch.length === 0 && { color: C.amber }]}>
            {new Set(pitchesUsed).size}
          </Text>
          <Text style={s.summaryLabel}>PITCHES</Text>
        </View>
        <View style={s.summaryDivider} />
        <View style={s.summaryCell}>
          <Text style={[s.summaryValue, { color: ceilTier.color, fontSize: 15 }]}>
            {ceilTier.label}
          </Text>
          <Text style={s.summaryLabel}>MAX GRADE</Text>
        </View>
      </View>

      {wouldBreakTier && (
        <View style={s.warnBox}>
          <Text style={s.warnText}>
            This selection only supports {ceilTier.label}, but the tournament is set to{' '}
            {TIER[eventTier]?.label}. Lower the grade first, or pick stronger referees.
          </Text>
        </View>
      )}
      {duplicatePitch && (
        <View style={s.warnBox}>
          <Text style={s.warnText}>
            Two referees are on the same pitch. Only one of them will be given those
            matches — give each a different pitch.
          </Text>
        </View>
      )}
      {selectedIds.length > 0 && withPitch.length === 0 && (
        <View style={s.warnBox}>
          <Text style={s.warnText}>
            Nobody has a pitch yet. A referee without a pitch is not counted when the
            schedule is built.
          </Text>
        </View>
      )}

      <View style={s.searchWrap}>
        <Text style={s.searchIcon}>🔍</Text>
        <TextInput
          style={s.search}
          placeholder="Search referees by name"
          placeholderTextColor={C.t3}
          value={q}
          onChangeText={setQ}
          autoCapitalize="none"
        />
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 120 }} showsVerticalScrollIndicator={false}>
        {isLoading && <View style={s.center}><ActivityIndicator color={C.lime} /></View>}

        {!isLoading && referees.length === 0 && (
          <View style={s.center}>
            <Text style={s.emptyText}>
              {q ? `No referees match "${q}".` : 'No approved referees exist yet.'}
            </Text>
            <Text style={s.emptySub}>
              Referees are approved by an admin from their application.
            </Text>
          </View>
        )}

        {referees.map(r => {
          const on = r.id in selection
          const t = TIER[r.referee_tier ?? 'amateur'] ?? TIER.amateur
          return (
            <View key={r.id} style={[s.card, on && { borderColor: C.lime }]}>
              <TouchableOpacity style={s.cardTop} onPress={() => toggle(r.id)} activeOpacity={0.8}>
                <View style={[s.check, on && { backgroundColor: C.lime, borderColor: C.lime }]}>
                  {on && <Text style={s.checkMark}>✓</Text>}
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={s.name}>{r.name}</Text>
                  <Text style={s.meta}>
                    {r.city ?? '—'}
                    {r.username ? ` · @${r.username}` : ''}
                  </Text>
                </View>
                <View style={[s.tierChip, { backgroundColor: t.glow, borderColor: t.color }]}>
                  <Text style={[s.tierChipText, { color: t.color }]}>{t.label}</Text>
                </View>
              </TouchableOpacity>

              {on && (
                <View style={s.pitchRow}>
                  {PITCHES.map(p => {
                    const active = selection[r.id] === p
                    const takenByOther = Object.entries(selection).some(
                      ([uid, val]) => uid !== r.id && val === p
                    )
                    return (
                      <TouchableOpacity
                        key={p}
                        style={[
                          s.pitchPill,
                          active && { backgroundColor: C.lime, borderColor: C.lime },
                          !active && takenByOther && s.pitchTaken,
                        ]}
                        onPress={() => setPitch(r.id, active ? null : p)}
                        activeOpacity={0.8}
                      >
                        <Text style={[s.pitchPillText, active && { color: C.limeText }]}>
                          {p.replace('Pitch ', 'P')}
                        </Text>
                      </TouchableOpacity>
                    )
                  })}
                  {!selection[r.id] && <Text style={s.noPitchHint}>← pick a pitch</Text>}
                </View>
              )}
            </View>
          )
        })}
      </ScrollView>

      <View style={s.footer}>
        <TouchableOpacity
          style={[s.saveBtn, (saving || wouldBreakTier) && s.saveDisabled]}
          onPress={save}
          disabled={saving || !!wouldBreakTier}
          activeOpacity={0.85}
        >
          <Text style={s.saveText}>
            {saving
              ? 'Saving…'
              : selectedIds.length === 0
                ? 'Save (clears the roster)'
                : `Save ${selectedIds.length} referee${selectedIds.length === 1 ? '' : 's'}`}
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  )
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: SPACE.md,
    paddingHorizontal: SPACE.lg, paddingTop: SPACE.sm, paddingBottom: SPACE.md,
  },
  back: {
    width: 40, height: 40, borderRadius: RADIUS.pill, backgroundColor: C.s2,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.b1,
  },
  backIcon: { color: C.t1, fontSize: 18, fontFamily: FONT.bold },
  eyebrow: { color: C.t3, fontSize: 10, fontFamily: FONT.bold, letterSpacing: 2 },
  title: { color: C.t1, fontSize: 22, fontFamily: FONT.black, letterSpacing: -0.4 },

  summary: {
    flexDirection: 'row', alignItems: 'center', marginHorizontal: SPACE.lg,
    backgroundColor: C.s1, borderRadius: RADIUS.lg, borderWidth: 1, borderColor: C.b1,
    paddingVertical: SPACE.md, marginBottom: SPACE.sm,
  },
  summaryCell: { flex: 1, alignItems: 'center' },
  summaryDivider: { width: 1, height: 26, backgroundColor: C.b1 },
  summaryValue: { color: C.t1, fontSize: 20, fontFamily: FONT.black },
  summaryLabel: { color: C.t3, fontSize: 9, fontFamily: FONT.bold, letterSpacing: 1, marginTop: 2 },

  warnBox: {
    marginHorizontal: SPACE.lg, marginBottom: SPACE.sm, padding: SPACE.md,
    backgroundColor: 'rgba(245,158,11,0.08)', borderRadius: RADIUS.md,
    borderWidth: 1, borderColor: 'rgba(245,158,11,0.3)',
  },
  warnText: { color: C.amber, fontSize: 12, fontFamily: FONT.medium, lineHeight: 18 },

  searchWrap: {
    flexDirection: 'row', alignItems: 'center', gap: SPACE.sm,
    marginHorizontal: SPACE.lg, marginBottom: SPACE.md, paddingHorizontal: SPACE.md,
    backgroundColor: C.s1, borderRadius: RADIUS.md, borderWidth: 1, borderColor: C.b1,
  },
  searchIcon: { fontSize: 14 },
  search: {
    flex: 1, paddingVertical: 12, color: C.t1, fontSize: 14, fontFamily: FONT.medium,
    ...(({ outlineStyle: 'none' }) as object),
  },

  center: { paddingVertical: SPACE.xxl, alignItems: 'center', gap: 6 },
  emptyText: { color: C.t2, fontSize: 14, fontFamily: FONT.medium },
  emptySub: { color: C.t3, fontSize: 12, fontFamily: FONT.regular },

  card: {
    marginHorizontal: SPACE.lg, marginBottom: SPACE.sm, padding: SPACE.md,
    backgroundColor: C.s1, borderRadius: RADIUS.lg, borderWidth: 1, borderColor: C.b1,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: SPACE.md },
  check: {
    width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: C.b3,
    alignItems: 'center', justifyContent: 'center',
  },
  checkMark: { color: C.limeText, fontSize: 13, fontFamily: FONT.bold },
  name: { color: C.t1, fontSize: 15, fontFamily: FONT.semibold },
  meta: { color: C.t3, fontSize: 11, fontFamily: FONT.regular, marginTop: 1 },
  tierChip: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: RADIUS.sm, borderWidth: 1 },
  tierChipText: { fontSize: 9, fontFamily: FONT.bold, letterSpacing: 0.5 },

  pitchRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    marginTop: SPACE.md, paddingTop: SPACE.md, borderTopWidth: 1, borderTopColor: C.b0,
  },
  pitchPill: {
    paddingHorizontal: 13, paddingVertical: 7, borderRadius: RADIUS.sm,
    backgroundColor: C.s3, borderWidth: 1, borderColor: C.b1,
  },
  pitchTaken: { opacity: 0.35 },
  pitchPillText: { color: C.t2, fontSize: 12, fontFamily: FONT.bold },
  noPitchHint: { color: C.amber, fontSize: 10, fontFamily: FONT.medium, marginLeft: 4 },

  footer: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    padding: SPACE.lg, paddingBottom: SPACE.xl,
    backgroundColor: C.bg, borderTopWidth: 1, borderTopColor: C.b1,
  },
  saveBtn: {
    backgroundColor: C.lime, borderRadius: RADIUS.lg, paddingVertical: 15,
    alignItems: 'center', ...ELEV.glow(C.lime, 0.3),
  },
  saveDisabled: { opacity: 0.4 },
  saveText: { color: C.limeText, fontSize: 15, fontFamily: FONT.bold },
})
