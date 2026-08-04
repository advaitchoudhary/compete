/**
 * TOURNAMENT CONTROL ROOM — the organizer's single screen for running an event.
 *
 * Built as a stepper rather than a settings form because the steps genuinely
 * depend on each other: the grade is capped by the referees you assigned, and the
 * bracket needs both teams and a refereed pitch. A flat form would let an
 * organizer press things in an order the backend refuses. Here each stage renders
 * as DONE, ACTIVE, or LOCKED-with-a-reason, so the order is visible instead of
 * being discovered through error toasts.
 *
 * The backend stays the authority on every rule (spec §3.1.1). This screen only
 * renders the `blockers` and `tier_options` that /organizer/events/:id/setup
 * reports, so the two cannot drift apart.
 */
import { useState } from 'react'
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, Platform,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../src/api/client'
import { C, FONT, SPACE, RADIUS, TIER, ELEV } from '../../src/theme'
import { confirm, notify } from '../../src/lib/dialog'

type Setup = {
  event: {
    id: string; name: string; status: string; tier: string; format: string
    city: string; venue: string | null; match_format: string | null
    match_duration_minutes: number | null; max_teams: number | null
    starts_at: string | null; sport_slug: string
  }
  referees: Array<{ user_id: string; pitch_label: string | null; name: string; referee_tier: string | null; role: string }>
  teams: Array<{ id: string; name: string; seed: number | null; group_no: string | null }>
  fixtures_count: number
  played_count: number
  pitch_count: number
  max_tier: string
  blockers: string[]
  tier_locked: boolean
  tier_options: Array<{ tier: string; allowed: boolean }>
  can_generate_fixtures: boolean
  can_open_registration: boolean
}

type Fixture = {
  id: string; round: string; round_label?: string; slot_no: number; pitch_label: string | null
  scheduled_at: string | null; referee_name: string | null
  match_id: string | null; match_status: string | null
  home_label: string; away_label: string
  home_score: { goals?: number } | null
  away_score: { goals?: number } | null
}

type Bracket = {
  fixtures: Fixture[]
  standings: Array<{ group: string; table: Array<{ team_id: string; team_name?: string; name?: string; points: number; played: number; won: number; drawn: number; lost: number; goals_for: number; goals_against: number }> }>
}

const errText = (e: any): string => {
  const err = e?.response?.data?.error
  if (typeof err === 'string') return err
  if (err?.fieldErrors) return Object.values(err.fieldErrors).flat().join(', ')
  return e?.message ?? 'Something went wrong'
}

const fmtTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—'

export default function ControlRoomScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const qc = useQueryClient()
  const [busy, setBusy] = useState<string | null>(null)

  const { data: setup, isLoading, error } = useQuery<Setup>({
    queryKey: ['organizer', 'setup', id],
    queryFn: async () => (await api.get(`/organizer/events/${id}/setup`)).data,
    enabled: !!id,
  })

  // Only fetched once a bracket exists — before that there is nothing to show.
  const { data: bracket } = useQuery<Bracket>({
    queryKey: ['organizer', 'bracket', id],
    queryFn: async () => (await api.get(`/events/${id}/fixtures`)).data,
    enabled: !!id && (setup?.fixtures_count ?? 0) > 0,
  })

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['organizer', 'setup', id] })
    qc.invalidateQueries({ queryKey: ['organizer', 'bracket', id] })
    qc.invalidateQueries({ queryKey: ['organizer', 'events'] })
  }

  const run = async (key: string, fn: () => Promise<any>, onOk?: (r: any) => void) => {
    setBusy(key)
    try {
      const r = await fn()
      refresh()
      onOk?.(r)
    } catch (e) {
      notify('Not allowed', errText(e))
    } finally {
      setBusy(null)
    }
  }

  const setTier = (tier: string) =>
    run('tier', () => api.patch(`/events/${id}/tier`, { tier }))

  const setStatus = (status: string) =>
    run(`status-${status}`, () => api.patch(`/events/${id}/status`, { status }))

  const generate = () =>
    run('fixtures', () => api.post(`/events/${id}/fixtures`, {}), (r) => {
      const d = r.data
      notify(
        'Bracket built',
        `${d.fixtures} fixtures, ${d.matches} matches ready.` +
          (d.fell_back ? `\n\nFell back to a straight knockout: ${d.fallback_reason}` : '')
      )
    })

  if (isLoading) {
    return <View style={s.fill}><ActivityIndicator color={C.lime} size="large" /></View>
  }
  if (error || !setup) {
    return (
      <View style={s.fill}>
        <Text style={s.err}>{error ? errText(error) : 'Not found'}</Text>
        <TouchableOpacity onPress={() => router.back()}><Text style={s.link}>← Back</Text></TouchableOpacity>
      </View>
    )
  }

  const ev = setup.event
  const tier = TIER[ev.tier] ?? TIER.amateur
  const refsWithPitch = setup.referees.filter(r => r.pitch_label)
  const hasBracket = setup.fixtures_count > 0
  const playedAll = hasBracket && setup.played_count >= setup.fixtures_count

  // Stage completion. Each is a fact about the event, not a UI flag, so the
  // stepper cannot claim a step is done when the backend disagrees.
  const stage = {
    referees: refsWithPitch.length > 0,
    // A grade is always set, but the choice is only meaningful once there are
    // referees to authorise it — every option above amateur is locked until then.
    // Tying it to the roster keeps the checklist monotonic rather than showing a
    // tick on step 2 while step 1 is still open.
    grade:    refsWithPitch.length > 0,
    signups:  setup.teams.length >= 2,
    bracket:  hasBracket,
    finish:   ev.status === 'completed',
  }

  return (
    <SafeAreaView style={s.safe} edges={['top']}>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <View style={s.header}>
        <TouchableOpacity style={s.back} onPress={() => router.back()} activeOpacity={0.7}>
          <Text style={s.backIcon}>←</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={s.eyebrow}>CONTROL ROOM</Text>
          <Text style={s.title} numberOfLines={1}>{ev.name}</Text>
        </View>
        <View style={[s.tierChip, { backgroundColor: tier.glow, borderColor: tier.color }]}>
          <Text style={[s.tierChipText, { color: tier.color }]}>{tier.label}</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: 60 }} showsVerticalScrollIndicator={false}>
        <Text style={s.subMeta}>
          {ev.venue ? `${ev.venue} · ` : ''}{ev.city}
          {ev.match_format ? ` · ${ev.match_format}` : ''}
          {ev.match_duration_minutes ? ` · ${ev.match_duration_minutes}min` : ''}
          {' · '}{ev.format === 'group_knockout' ? 'Groups + Knockout' : 'Knockout'}
        </Text>

        {/* ── STAGE 1 · Referees ───────────────────────────────────────── */}
        <Stage n={1} title="Referees & pitches" done={stage.referees}
          hint="Each refereed pitch is a game that can run in parallel — this is what sets your schedule.">
          {setup.referees.length === 0 ? (
            <Text style={s.stageEmpty}>Nobody assigned yet.</Text>
          ) : (
            setup.referees.map(r => {
              const rt = TIER[r.referee_tier ?? 'amateur'] ?? TIER.amateur
              return (
                <View key={r.user_id} style={s.refRow}>
                  <Text style={s.refName}>{r.name}</Text>
                  <View style={[s.miniChip, { backgroundColor: rt.glow, borderColor: rt.color }]}>
                    <Text style={[s.miniChipText, { color: rt.color }]}>{rt.short}</Text>
                  </View>
                  <Text style={r.pitch_label ? s.pitchOk : s.pitchNone}>
                    {r.pitch_label ?? 'no pitch'}
                  </Text>
                </View>
              )
            })
          )}
          <TouchableOpacity
            style={s.stageBtn}
            onPress={() => router.push(`/organizer/referees/${id}`)}
            activeOpacity={0.85}
          >
            <Text style={s.stageBtnText}>
              {setup.referees.length === 0 ? 'Assign referees' : 'Change referees'}
            </Text>
          </TouchableOpacity>
          {refsWithPitch.length > 0 && (
            <Text style={s.stageNote}>
              {setup.pitch_count} pitch{setup.pitch_count === 1 ? '' : 'es'} → up to{' '}
              {setup.pitch_count} match{setup.pitch_count === 1 ? '' : 'es'} at once
            </Text>
          )}
        </Stage>

        {/* ── STAGE 2 · Grade ─────────────────────────────────────────── */}
        <Stage n={2} title="Competition grade" done={stage.grade}
          hint="Grade decides how much these results move a player's rating. It is capped by your weakest referee.">
          <View style={s.pillWrap}>
            {setup.tier_options.map(o => {
              const t = TIER[o.tier] ?? TIER.amateur
              const active = ev.tier === o.tier
              const disabled = !o.allowed || setup.tier_locked || busy === 'tier'
              return (
                <TouchableOpacity
                  key={o.tier}
                  style={[
                    s.tierPill,
                    active && { backgroundColor: t.glow, borderColor: t.color },
                    disabled && !active && s.pillDisabled,
                  ]}
                  disabled={disabled}
                  onPress={() => setTier(o.tier)}
                  activeOpacity={0.8}
                >
                  <Text style={[s.tierPillText, active && { color: t.color }, disabled && !active && { color: C.t3 }]}>
                    {t.label}
                  </Text>
                  {!o.allowed && <Text style={s.lockIcon}>🔒</Text>}
                </TouchableOpacity>
              )
            })}
          </View>
          {setup.tier_locked ? (
            <Text style={s.stageWarn}>
              Locked — the bracket is built. Grade can't change once results are being recorded.
            </Text>
          ) : (
            <Text style={s.stageNote}>
              Your roster supports up to <Text style={{ color: TIER[setup.max_tier]?.color }}>
                {TIER[setup.max_tier]?.label}
              </Text>. Assign higher-tier referees to unlock more.
            </Text>
          )}
        </Stage>

        {/* ── STAGE 3 · Sign-ups ──────────────────────────────────────── */}
        <Stage n={3} title="Team sign-ups" done={stage.signups}
          hint="Captains register their own squads. You never type in a team list.">
          <View style={s.countRow}>
            <Text style={s.bigCount}>{setup.teams.length}</Text>
            <Text style={s.bigCountLabel}>
              team{setup.teams.length === 1 ? '' : 's'} in
              {ev.max_teams ? ` · max ${ev.max_teams}` : ''}
            </Text>
          </View>

          {setup.teams.length > 0 && (
            <View style={s.teamList}>
              {setup.teams.map((t, i) => (
                <View key={t.id} style={s.teamRow}>
                  <Text style={s.teamSeed}>{t.seed ?? i + 1}</Text>
                  <Text style={s.teamName} numberOfLines={1}>{t.name}</Text>
                  {t.group_no && <Text style={s.teamGroup}>Group {t.group_no}</Text>}
                </View>
              ))}
            </View>
          )}

          {ev.status === 'upcoming' && (
            <TouchableOpacity
              style={[s.stageBtn, s.stageBtnPrimary]}
              onPress={() => setStatus('registration')}
              disabled={busy !== null}
              activeOpacity={0.85}
            >
              <Text style={[s.stageBtnText, { color: C.limeText }]}>
                {busy === 'status-registration' ? 'Opening…' : 'Open sign-ups'}
              </Text>
            </TouchableOpacity>
          )}
          {ev.status === 'registration' && (
            <>
              <View style={s.openBanner}>
                <Text style={s.openBannerText}>● SIGN-UPS ARE OPEN</Text>
              </View>
              <TouchableOpacity
                style={s.shareBtn}
                onPress={() => {
                  const url = `${Platform.OS === 'web' && typeof window !== 'undefined' ? window.location.origin : ''}/e/${id}`
                  if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
                    navigator.clipboard.writeText(url)
                    notify('Link copied', url)
                  } else {
                    notify('Share this link', url)
                  }
                }}
                activeOpacity={0.8}
              >
                <Text style={s.shareBtnText}>📋 Copy public link for WhatsApp</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={s.stageBtn}
                onPress={() => setStatus('upcoming')}
                disabled={busy !== null}
                activeOpacity={0.85}
              >
                <Text style={s.stageBtnText}>Close sign-ups</Text>
              </TouchableOpacity>
            </>
          )}
        </Stage>

        {/* ── STAGE 4 · Bracket ───────────────────────────────────────── */}
        <Stage n={4} title="Build the bracket" done={stage.bracket}
          hint="Groups, knockout rounds, kick-off times, pitches and referees — generated in one go.">
          {!hasBracket ? (
            <>
              {setup.blockers.length > 0 && (
                <View style={s.blockerBox}>
                  <Text style={s.blockerTitle}>Before you can build:</Text>
                  {setup.blockers.map((b, i) => (
                    <Text key={i} style={s.blockerItem}>• {b}</Text>
                  ))}
                </View>
              )}
              <TouchableOpacity
                style={[s.stageBtn, setup.blockers.length === 0 && s.stageBtnPrimary,
                        setup.blockers.length > 0 && s.pillDisabled]}
                disabled={setup.blockers.length > 0 || busy !== null}
                onPress={generate}
                activeOpacity={0.85}
              >
                <Text style={[s.stageBtnText, setup.blockers.length === 0 && { color: C.limeText }]}>
                  {busy === 'fixtures' ? 'Building…' : 'Generate fixtures'}
                </Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <View style={s.countRow}>
                <Text style={s.bigCount}>{setup.fixtures_count}</Text>
                <Text style={s.bigCountLabel}>
                  fixtures · {setup.played_count} played
                </Text>
              </View>

              {(bracket?.standings ?? []).map(g => (
                <View key={g.group} style={s.groupBlock}>
                  <Text style={s.groupTitle}>GROUP {g.group}</Text>
                  <View style={s.tableHead}>
                    <Text style={[s.thTeam]}>TEAM</Text>
                    <Text style={s.th}>P</Text>
                    <Text style={s.th}>W</Text>
                    <Text style={s.th}>D</Text>
                    <Text style={s.th}>L</Text>
                    <Text style={s.th}>GD</Text>
                    <Text style={[s.th, { color: C.lime }]}>PTS</Text>
                  </View>
                  {g.table.map((row, i) => (
                    <View key={row.team_id} style={[s.tableRow, i < 2 && s.qualifyRow]}>
                      <Text style={s.tdTeam} numberOfLines={1}>
                        {row.team_name ?? row.name ?? '—'}
                      </Text>
                      <Text style={s.td}>{row.played}</Text>
                      <Text style={s.td}>{row.won}</Text>
                      <Text style={s.td}>{row.drawn}</Text>
                      <Text style={s.td}>{row.lost}</Text>
                      <Text style={s.td}>{row.goals_for - row.goals_against}</Text>
                      <Text style={[s.td, { color: C.lime, fontFamily: FONT.black }]}>{row.points}</Text>
                    </View>
                  ))}
                </View>
              ))}

              <Text style={s.groupTitle}>SCHEDULE</Text>
              {(bracket?.fixtures ?? []).map(f => {
                const live = f.match_status === 'live'
                const done = f.match_status === 'completed'
                return (
                  <TouchableOpacity
                    key={f.id}
                    style={[s.fxRow, live && { borderColor: C.lime, backgroundColor: C.limeGlow }]}
                    activeOpacity={f.match_id ? 0.8 : 1}
                    disabled={!f.match_id}
                    onPress={() => f.match_id && router.push(`/match/${f.match_id}`)}
                  >
                    <View style={s.fxTime}>
                      <Text style={s.fxTimeText}>{fmtTime(f.scheduled_at)}</Text>
                      <Text style={s.fxPitch}>{f.pitch_label ?? '—'}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={s.fxRound}>{(f.round_label ?? f.round).toUpperCase()}</Text>
                      <Text style={s.fxTeams} numberOfLines={1}>
                        {f.home_label} <Text style={{ color: C.t3 }}>v</Text> {f.away_label}
                      </Text>
                      {f.referee_name && <Text style={s.fxRef}>🦓 {f.referee_name}</Text>}
                    </View>
                    {done ? (
                      <Text style={s.fxScore}>
                        {f.home_score?.goals ?? 0}–{f.away_score?.goals ?? 0}
                      </Text>
                    ) : live ? (
                      <Text style={s.fxLive}>LIVE</Text>
                    ) : (
                      <Text style={s.fxPending}>›</Text>
                    )}
                  </TouchableOpacity>
                )
              })}

              {setup.can_generate_fixtures && (
                <TouchableOpacity
                  style={s.dangerBtn}
                  onPress={() =>
                    confirm(
                      'Rebuild the bracket?',
                      'This throws away the current fixtures and re-seeds from scratch. Only possible because no match has kicked off yet.',
                      generate,
                      'Rebuild'
                    )
                  }
                  activeOpacity={0.85}
                >
                  <Text style={s.dangerBtnText}>Rebuild bracket</Text>
                </TouchableOpacity>
              )}
            </>
          )}
        </Stage>

        {/* ── STAGE 5 · Match day ─────────────────────────────────────── */}
        <Stage n={5} title="Match day & wrap-up" done={stage.finish}
          hint="Referees score from their own phones. You only step in to start and finish the day.">
          {ev.status === 'registration' && hasBracket && (
            <TouchableOpacity
              style={[s.stageBtn, s.stageBtnPrimary]}
              onPress={() => setStatus('active')}
              disabled={busy !== null}
              activeOpacity={0.85}
            >
              <Text style={[s.stageBtnText, { color: C.limeText }]}>
                {busy === 'status-active' ? 'Starting…' : 'Start tournament'}
              </Text>
            </TouchableOpacity>
          )}
          {ev.status === 'active' && (
            <>
              <View style={s.openBanner}>
                <Text style={s.openBannerText}>● TOURNAMENT IS LIVE</Text>
              </View>
              <TouchableOpacity
                style={[s.stageBtn, playedAll && s.stageBtnPrimary]}
                onPress={() =>
                  confirm(
                    'Finish the tournament?',
                    playedAll
                      ? 'All matches are played. This publishes the final result and locks the event.'
                      : `${setup.fixtures_count - setup.played_count} matches have not been played. Finishing now locks the event anyway.`,
                    () => setStatus('completed'),
                    'Finish'
                  )
                }
                disabled={busy !== null}
                activeOpacity={0.85}
              >
                <Text style={[s.stageBtnText, playedAll && { color: C.limeText }]}>
                  {busy === 'status-completed' ? 'Finishing…' : 'Finish tournament'}
                </Text>
              </TouchableOpacity>
            </>
          )}
          {ev.status === 'completed' && (
            <View style={s.doneBanner}>
              <Text style={s.doneBannerText}>🏆 Tournament complete</Text>
            </View>
          )}

          <TouchableOpacity style={s.stageBtn} onPress={() => router.push(`/e/${id}`)} activeOpacity={0.85}>
            <Text style={s.stageBtnText}>View the public page</Text>
          </TouchableOpacity>
        </Stage>
      </ScrollView>
    </SafeAreaView>
  )
}

/** One step of the run-of-play. `done` drives the numbered badge's colour. */
function Stage({
  n, title, hint, done, children,
}: { n: number; title: string; hint: string; done: boolean; children: React.ReactNode }) {
  return (
    <View style={s.stage}>
      <View style={s.stageHead}>
        <View style={[s.stageNum, done && { backgroundColor: C.lime, borderColor: C.lime }]}>
          <Text style={[s.stageNumText, done && { color: C.limeText }]}>{done ? '✓' : n}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={s.stageTitle}>{title}</Text>
          <Text style={s.stageHint}>{hint}</Text>
        </View>
      </View>
      <View style={s.stageBody}>{children}</View>
    </View>
  )
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg },
  fill: { flex: 1, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center', gap: SPACE.md },
  err: { color: C.red, fontSize: 14, fontFamily: FONT.medium, paddingHorizontal: SPACE.xl, textAlign: 'center' },
  link: { color: C.lime, fontSize: 14, fontFamily: FONT.semibold },

  header: {
    flexDirection: 'row', alignItems: 'center', gap: SPACE.md,
    paddingHorizontal: SPACE.lg, paddingTop: SPACE.sm, paddingBottom: SPACE.sm,
  },
  back: {
    width: 40, height: 40, borderRadius: RADIUS.pill, backgroundColor: C.s2,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.b1,
  },
  backIcon: { color: C.t1, fontSize: 18, fontFamily: FONT.bold },
  eyebrow: { color: C.t3, fontSize: 10, fontFamily: FONT.bold, letterSpacing: 2 },
  title: { color: C.t1, fontSize: 21, fontFamily: FONT.black, letterSpacing: -0.4 },
  tierChip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: RADIUS.sm, borderWidth: 1 },
  tierChipText: { fontSize: 10, fontFamily: FONT.bold, letterSpacing: 0.6 },
  subMeta: {
    color: C.t2, fontSize: 12, fontFamily: FONT.regular,
    paddingHorizontal: SPACE.lg, paddingBottom: SPACE.lg,
  },

  stage: {
    marginHorizontal: SPACE.lg, marginBottom: SPACE.md,
    backgroundColor: C.s1, borderRadius: RADIUS.lg, borderWidth: 1, borderColor: C.b1,
    padding: SPACE.lg,
  },
  stageHead: { flexDirection: 'row', gap: SPACE.md, marginBottom: SPACE.md },
  stageNum: {
    width: 28, height: 28, borderRadius: RADIUS.pill, borderWidth: 1, borderColor: C.b2,
    backgroundColor: C.s3, alignItems: 'center', justifyContent: 'center',
  },
  stageNumText: { color: C.t2, fontSize: 13, fontFamily: FONT.bold },
  stageTitle: { color: C.t1, fontSize: 16, fontFamily: FONT.bold },
  stageHint: { color: C.t3, fontSize: 11, fontFamily: FONT.regular, lineHeight: 16, marginTop: 2 },
  stageBody: { gap: SPACE.sm },
  stageEmpty: { color: C.t3, fontSize: 13, fontFamily: FONT.regular, fontStyle: 'italic' },
  stageNote: { color: C.t2, fontSize: 11, fontFamily: FONT.medium, lineHeight: 16 },
  stageWarn: { color: C.amber, fontSize: 11, fontFamily: FONT.medium, lineHeight: 16 },

  stageBtn: {
    backgroundColor: C.s3, borderRadius: RADIUS.md, paddingVertical: 12,
    alignItems: 'center', borderWidth: 1, borderColor: C.b1,
  },
  stageBtnPrimary: { backgroundColor: C.lime, borderColor: C.lime, ...ELEV.glow(C.lime, 0.25) },
  stageBtnText: { color: C.t1, fontSize: 14, fontFamily: FONT.bold },

  refRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingVertical: 5 },
  refName: { color: C.t1, fontSize: 13, fontFamily: FONT.semibold, flexShrink: 1 },
  miniChip: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, borderWidth: 1 },
  miniChipText: { fontSize: 8, fontFamily: FONT.bold, letterSpacing: 0.5 },
  pitchOk: { marginLeft: 'auto', color: C.lime, fontSize: 11, fontFamily: FONT.bold },
  pitchNone: { marginLeft: 'auto', color: C.amber, fontSize: 11, fontFamily: FONT.medium },

  pillWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACE.sm },
  tierPill: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 14, paddingVertical: 9, borderRadius: RADIUS.md,
    backgroundColor: C.s3, borderWidth: 1, borderColor: C.b1,
  },
  pillDisabled: { opacity: 0.4 },
  tierPillText: { color: C.t2, fontSize: 12, fontFamily: FONT.bold },
  lockIcon: { fontSize: 9 },

  countRow: { flexDirection: 'row', alignItems: 'baseline', gap: SPACE.sm },
  bigCount: { color: C.t1, fontSize: 30, fontFamily: FONT.black },
  bigCountLabel: { color: C.t2, fontSize: 12, fontFamily: FONT.medium },

  teamList: { gap: 2 },
  teamRow: {
    flexDirection: 'row', alignItems: 'center', gap: SPACE.sm,
    backgroundColor: C.bg, borderRadius: RADIUS.sm, paddingHorizontal: SPACE.sm, paddingVertical: 7,
  },
  teamSeed: {
    color: C.t3, fontSize: 10, fontFamily: FONT.bold, width: 16, textAlign: 'center',
  },
  teamName: { color: C.t1, fontSize: 13, fontFamily: FONT.medium, flex: 1 },
  teamGroup: { color: C.t2, fontSize: 10, fontFamily: FONT.bold, letterSpacing: 0.5 },

  openBanner: {
    backgroundColor: C.limeGlow, borderRadius: RADIUS.md, paddingVertical: 9, alignItems: 'center',
    borderWidth: 1, borderColor: C.lime,
  },
  openBannerText: { color: C.lime, fontSize: 11, fontFamily: FONT.bold, letterSpacing: 1.2 },
  doneBanner: {
    backgroundColor: 'rgba(34,197,94,0.12)', borderRadius: RADIUS.md, paddingVertical: 12,
    alignItems: 'center', borderWidth: 1, borderColor: C.green,
  },
  doneBannerText: { color: C.green, fontSize: 14, fontFamily: FONT.bold },
  shareBtn: {
    backgroundColor: C.s2, borderRadius: RADIUS.md, paddingVertical: 11, alignItems: 'center',
    borderWidth: 1, borderColor: C.b2, borderStyle: 'dashed',
  },
  shareBtnText: { color: C.t1, fontSize: 12, fontFamily: FONT.semibold },

  blockerBox: {
    backgroundColor: 'rgba(245,158,11,0.08)', borderRadius: RADIUS.md,
    borderWidth: 1, borderColor: 'rgba(245,158,11,0.3)', padding: SPACE.md, gap: 3,
  },
  blockerTitle: { color: C.amber, fontSize: 11, fontFamily: FONT.bold, letterSpacing: 0.8, marginBottom: 2 },
  blockerItem: { color: C.t1, fontSize: 12, fontFamily: FONT.regular, lineHeight: 18 },

  groupBlock: { marginTop: SPACE.sm },
  groupTitle: {
    color: C.t3, fontSize: 10, fontFamily: FONT.bold, letterSpacing: 1.5,
    marginTop: SPACE.sm, marginBottom: 6,
  },
  tableHead: { flexDirection: 'row', paddingHorizontal: SPACE.sm, paddingBottom: 4 },
  thTeam: { flex: 1, color: C.t3, fontSize: 9, fontFamily: FONT.bold, letterSpacing: 0.8 },
  th: { width: 26, textAlign: 'center', color: C.t3, fontSize: 9, fontFamily: FONT.bold },
  tableRow: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACE.sm,
    paddingVertical: 7, backgroundColor: C.bg, borderRadius: RADIUS.sm, marginBottom: 2,
  },
  qualifyRow: { borderLeftWidth: 2, borderLeftColor: C.lime },
  tdTeam: { flex: 1, color: C.t1, fontSize: 12, fontFamily: FONT.medium },
  td: { width: 26, textAlign: 'center', color: C.t2, fontSize: 12, fontFamily: FONT.medium },

  fxRow: {
    flexDirection: 'row', alignItems: 'center', gap: SPACE.md,
    backgroundColor: C.bg, borderRadius: RADIUS.md, padding: SPACE.sm,
    borderWidth: 1, borderColor: C.b0, marginBottom: 3,
  },
  fxTime: { width: 54 },
  fxTimeText: { color: C.t1, fontSize: 12, fontFamily: FONT.bold },
  fxPitch: { color: C.t3, fontSize: 9, fontFamily: FONT.medium },
  fxRound: { color: C.t3, fontSize: 8, fontFamily: FONT.bold, letterSpacing: 1 },
  fxTeams: { color: C.t1, fontSize: 13, fontFamily: FONT.semibold },
  fxRef: { color: C.t3, fontSize: 10, fontFamily: FONT.regular, marginTop: 1 },
  fxScore: { color: C.t1, fontSize: 15, fontFamily: FONT.black },
  fxLive: { color: C.lime, fontSize: 10, fontFamily: FONT.bold, letterSpacing: 1 },
  fxPending: { color: C.t3, fontSize: 16, fontFamily: FONT.bold },

  dangerBtn: {
    marginTop: SPACE.sm, borderRadius: RADIUS.md, paddingVertical: 11, alignItems: 'center',
    borderWidth: 1, borderColor: 'rgba(239,68,68,0.4)',
  },
  dangerBtnText: { color: C.red, fontSize: 13, fontFamily: FONT.semibold },
})
