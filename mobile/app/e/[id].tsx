/**
 * Public tournament page — the one screen a stranger sees.
 *
 * No login, no download, no app install: a spectator on the sideline opens a link
 * and gets the live bracket, the group tables and the day's top scorers. This is
 * the acquisition loop, so it has to read as something worth being part of — and
 * it has to work for someone who has never heard of AllSports.
 *
 * Deliberately self-contained: it calls the unauthenticated endpoint directly
 * rather than the axios client, because that client attaches a JWT and redirects
 * on 401. A public page must never depend on auth state existing.
 */
import { useEffect, useState, useCallback } from 'react'
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  RefreshControl,
} from 'react-native'
import { useLocalSearchParams } from 'expo-router'
import { BASE_URL } from '../../src/api/client'
import { C, FONT, SPACE, RADIUS, TIER, ELEV, SPORT } from '../../src/theme'

interface Fixture {
  round: string
  round_label?: string
  slot_no: number
  pitch_label: string | null
  scheduled_at: string | null
  match_id: string | null
  match_status: string | null
  home_label: string
  away_label: string
  home_goals: number | null
  away_goals: number | null
}

interface PublicEvent {
  id: string
  name: string
  status: string
  format: string
  match_format: string | null
  tier: string
  sport_slug: string
  city: string
  venue: string | null
  starts_at: string | null
  teams: Array<{ name: string; group: string | null }>
  fixtures: Fixture[]
  standings: Array<{
    group: string
    table: Array<{
      position: number
      team_name: string
      points: number
      goal_difference: number
      goals_for: number
    }>
  }>
  top_scorers: Array<{
    name: string
    is_guest: boolean
    team_name: string
    goals: number
    assists: number
  }>
}

/** 'group_a' → 'Group A', 'play_in' → 'Play-in', 'semi' → 'Semi-final'. */
/** Fallback only — the API now sends `round_label`. Kept so an older cached
 * response still renders something readable. */
function roundLabel(round: string): string {
  if (round.startsWith('group_')) return `Group ${round.slice(6).toUpperCase()}`
  if (round === 'play_in') return 'Play-in'
  if (round === 'quarter') return 'Quarter-final'
  if (round === 'semi') return 'Semi-final'
  if (round === 'final') return 'Final'
  return round.replace(/_/g, ' ')
}

const timeOf = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''

export default function PublicTournamentPage() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const [data, setData] = useState<PublicEvent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${BASE_URL}/public/events/${id}`)
      if (!res.ok) {
        setError(res.status === 404 ? 'Tournament not found' : 'Could not load tournament')
        return
      }
      setData(await res.json())
      setError(null)
    } catch {
      setError('Could not reach the server')
    }
  }, [id])

  useEffect(() => {
    load()
    // A tournament day is live for hours; poll so the sideline sees scores land.
    const t = setInterval(load, 30_000)
    return () => clearInterval(t)
  }, [load])

  if (error) {
    return (
      <View style={s.center}>
        <Text style={s.errorTitle}>{error}</Text>
        <Text style={s.errorSub}>Check the link and try again.</Text>
      </View>
    )
  }

  if (!data) {
    return (
      <View style={s.center}>
        <ActivityIndicator color={C.lime} />
      </View>
    )
  }

  const tierCfg = TIER[data.tier] ?? TIER.amateur
  const sportCfg = SPORT[data.sport_slug] ?? SPORT.football
  const isLive = data.status === 'active'

  // Deliberately chronological, not grouped by round. A spectator on the sideline
  // wants "what is on now and next", and group fixtures interleave across pitches
  // anyway — grouping by round produced a stutter of repeating Group A / Group B
  // headers. The round is shown per row instead.
  const nextUp = data.fixtures.find((f) => f.match_status !== 'completed')

  return (
    <ScrollView
      style={s.page}
      contentContainerStyle={s.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          tintColor={C.lime}
          onRefresh={async () => {
            setRefreshing(true)
            await load()
            setRefreshing(false)
          }}
        />
      }
    >
      {/* ── Masthead ────────────────────────────────────────────────────────── */}
      <View style={s.hero}>
        <View style={s.heroTop}>
          <View style={[s.tierChip, { borderColor: tierCfg.color, backgroundColor: tierCfg.glow }]}>
            <Text style={[s.tierText, { color: tierCfg.color }]}>{tierCfg.label}</Text>
          </View>
          {isLive && (
            <View style={s.liveChip}>
              <View style={s.liveDot} />
              <Text style={s.liveText}>LIVE</Text>
            </View>
          )}
        </View>

        <Text style={s.title}>{data.name}</Text>
        <Text style={s.subtitle}>
          {sportCfg.emoji} {data.match_format ?? sportCfg.name}
          {data.venue ? ` · ${data.venue}` : ''} · {data.city}
        </Text>

        <View style={s.statStrip}>
          <Stat value={String(data.teams.length)} label="TEAMS" />
          <Stat value={String(data.fixtures.length)} label="MATCHES" />
          <Stat
            value={String(data.fixtures.filter((f) => f.match_status === 'completed').length)}
            label="PLAYED"
          />
        </View>
      </View>

      {/* ── Group tables ────────────────────────────────────────────────────── */}
      {data.standings.map((g) => (
        <View key={g.group} style={s.section}>
          <Text style={s.sectionTitle}>Group {g.group.toUpperCase()}</Text>
          <View style={s.card}>
            <View style={[s.tableRow, s.tableHead]}>
              <Text style={[s.thPos]}>#</Text>
              <Text style={[s.thTeam]}>TEAM</Text>
              <Text style={s.thNum}>GD</Text>
              <Text style={s.thNum}>PTS</Text>
            </View>
            {g.table.map((row) => (
              <View key={row.team_name} style={s.tableRow}>
                <Text style={[s.tdPos, row.position <= 2 && { color: C.lime }]}>{row.position}</Text>
                <Text style={s.tdTeam} numberOfLines={1}>{row.team_name}</Text>
                <Text style={s.tdNum}>
                  {row.goal_difference > 0 ? '+' : ''}
                  {row.goal_difference}
                </Text>
                <Text style={[s.tdNum, s.tdPts]}>{row.points}</Text>
              </View>
            ))}
          </View>
        </View>
      ))}

      {/* ── Bracket / schedule ──────────────────────────────────────────────── */}
      <View style={s.section}>
        <Text style={s.sectionTitle}>Schedule</Text>
        {data.fixtures.map((f, fi) => {
          const played = f.match_status === 'completed'
          const homeWon = played && (f.home_goals ?? 0) > (f.away_goals ?? 0)
          const awayWon = played && (f.away_goals ?? 0) > (f.home_goals ?? 0)
          const isNext = f === nextUp
          return (
            <View
              key={`${f.round}-${f.slot_no}-${fi}`}
              style={[s.fixture, isNext && s.fixtureNext, played && s.fixturePlayed]}
            >
              <View style={s.fixtureMeta}>
                <Text style={[s.fixtureTime, isNext && { color: C.lime }]}>
                  {timeOf(f.scheduled_at)}
                </Text>
                {f.pitch_label ? <Text style={s.fixturePitch}>{f.pitch_label}</Text> : null}
              </View>

              <View style={s.fixtureTeams}>
                <View style={s.fixtureCaption}>
                  <Text style={s.roundLabel}>{f.round_label ?? roundLabel(f.round)}</Text>
                  {isNext && <Text style={s.nextLabel}>NEXT UP</Text>}
                </View>

                <View style={s.side}>
                  <Text
                    style={[s.sideName, homeWon && s.sideWon, !f.match_id && s.sidePending]}
                    numberOfLines={1}
                  >
                    {f.home_label}
                  </Text>
                  {played && <Text style={[s.goals, homeWon && s.goalsWon]}>{f.home_goals}</Text>}
                </View>
                <View style={s.side}>
                  <Text
                    style={[s.sideName, awayWon && s.sideWon, !f.match_id && s.sidePending]}
                    numberOfLines={1}
                  >
                    {f.away_label}
                  </Text>
                  {played && <Text style={[s.goals, awayWon && s.goalsWon]}>{f.away_goals}</Text>}
                </View>
              </View>
            </View>
          )
        })}
      </View>

      {/* ── Top scorers ─────────────────────────────────────────────────────── */}
      {data.top_scorers.length > 0 && (
        <View style={s.section}>
          <Text style={s.sectionTitle}>Top scorers</Text>
          <View style={s.card}>
            {data.top_scorers.map((p, i) => (
              <View key={`${p.name}-${i}`} style={s.scorerRow}>
                <Text style={[s.scorerRank, i === 0 && { color: C.lime }]}>{i + 1}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={s.scorerName} numberOfLines={1}>{p.name}</Text>
                  <Text style={s.scorerTeam} numberOfLines={1}>{p.team_name}</Text>
                </View>
                {p.assists > 0 && <Text style={s.scorerAssists}>{p.assists} A</Text>}
                <Text style={s.scorerGoals}>{p.goals}</Text>
              </View>
            ))}
          </View>
        </View>
      )}

      {/* ── The ask ─────────────────────────────────────────────────────────── */}
      <View style={s.footer}>
        <Text style={s.footerTitle}>Played today?</Text>
        <Text style={s.footerText}>
          Every player here is rated on AllSports. Find your name and claim your profile to keep
          your rating for every match you play.
        </Text>
      </View>
    </ScrollView>
  )
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <View style={s.stat}>
      <Text style={s.statValue}>{value}</Text>
      <Text style={s.statLabel}>{label}</Text>
    </View>
  )
}

const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: C.bg },
  content: { padding: SPACE.lg, paddingBottom: SPACE.xxxl },
  center: { flex: 1, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center', padding: SPACE.xl },
  errorTitle: { color: C.t1, fontSize: 18, fontFamily: FONT.bold },
  errorSub: { color: C.t3, fontSize: 13, fontFamily: FONT.regular, marginTop: SPACE.xs },

  // ── masthead ────────────────────────────────────────────────────────────────
  hero: { marginBottom: SPACE.xl },
  heroTop: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, marginBottom: SPACE.md },
  tierChip: { borderWidth: 1, borderRadius: RADIUS.pill, paddingHorizontal: 10, paddingVertical: 4 },
  tierText: { fontSize: 10, fontFamily: FONT.bold, letterSpacing: 1.4 },
  liveChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: RADIUS.pill,
    paddingHorizontal: 9,
    paddingVertical: 4,
    backgroundColor: 'rgba(239,68,68,0.14)',
  },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: C.red },
  liveText: { color: C.red, fontSize: 10, fontFamily: FONT.bold, letterSpacing: 1.4 },

  title: { color: C.t1, fontSize: 34, fontFamily: FONT.black, letterSpacing: -1.2, lineHeight: 38 },
  subtitle: { color: C.t2, fontSize: 13, fontFamily: FONT.medium, marginTop: SPACE.xs },

  statStrip: {
    flexDirection: 'row',
    marginTop: SPACE.lg,
    backgroundColor: C.s1,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: C.b1,
    paddingVertical: SPACE.md,
    ...ELEV.card,
  },
  stat: { flex: 1, alignItems: 'center' },
  statValue: { color: C.t1, fontSize: 24, fontFamily: FONT.black, letterSpacing: -0.5 },
  statLabel: { color: C.t3, fontSize: 9, fontFamily: FONT.bold, letterSpacing: 1.6, marginTop: 2 },

  // ── sections ────────────────────────────────────────────────────────────────
  section: { marginBottom: SPACE.xl },
  sectionTitle: {
    color: C.t3,
    fontSize: 11,
    fontFamily: FONT.bold,
    letterSpacing: 2,
    textTransform: 'uppercase',
    marginBottom: SPACE.sm,
  },
  card: {
    backgroundColor: C.s1,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: C.b1,
    overflow: 'hidden',
  },

  // ── group table ─────────────────────────────────────────────────────────────
  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 11,
    paddingHorizontal: SPACE.md,
    borderTopWidth: 1,
    borderTopColor: C.b0,
  },
  tableHead: { borderTopWidth: 0, paddingVertical: 8, backgroundColor: C.s2 },
  thPos: { width: 22, color: C.t3, fontSize: 9, fontFamily: FONT.bold, letterSpacing: 1 },
  thTeam: { flex: 1, color: C.t3, fontSize: 9, fontFamily: FONT.bold, letterSpacing: 1 },
  thNum: { width: 38, textAlign: 'right', color: C.t3, fontSize: 9, fontFamily: FONT.bold, letterSpacing: 1 },
  tdPos: { width: 22, color: C.t3, fontSize: 13, fontFamily: FONT.bold },
  tdTeam: { flex: 1, color: C.t1, fontSize: 14, fontFamily: FONT.semibold },
  tdNum: { width: 38, textAlign: 'right', color: C.t2, fontSize: 13, fontFamily: FONT.medium },
  tdPts: { color: C.t1, fontFamily: FONT.black },

  // ── fixtures ────────────────────────────────────────────────────────────────
  fixtureCaption: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, marginBottom: 4 },
  roundLabel: { color: C.t3, fontSize: 9, fontFamily: FONT.bold, letterSpacing: 1.2, textTransform: 'uppercase' },
  nextLabel: { color: C.lime, fontSize: 9, fontFamily: FONT.bold, letterSpacing: 1.2 },
  fixtureNext: { borderColor: C.b3, backgroundColor: C.s2 },
  fixturePlayed: { opacity: 0.82 },
  fixture: {
    flexDirection: 'row',
    backgroundColor: C.s1,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: C.b1,
    padding: SPACE.md,
    marginBottom: 6,
    gap: SPACE.md,
  },
  fixtureMeta: { width: 58, borderRightWidth: 1, borderRightColor: C.b0, paddingRight: SPACE.sm },
  fixtureTime: { color: C.t1, fontSize: 13, fontFamily: FONT.bold },
  fixturePitch: { color: C.t3, fontSize: 9, fontFamily: FONT.medium, marginTop: 2 },
  fixtureTeams: { flex: 1, gap: 5 },
  side: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sideName: { color: C.t2, fontSize: 14, fontFamily: FONT.medium, flex: 1 },
  sideWon: { color: C.t1, fontFamily: FONT.bold },
  sidePending: { color: C.t3, fontStyle: 'italic' },
  goals: { color: C.t2, fontSize: 15, fontFamily: FONT.bold, marginLeft: SPACE.sm },
  goalsWon: { color: C.lime },

  // ── scorers ─────────────────────────────────────────────────────────────────
  scorerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: SPACE.md,
    borderTopWidth: 1,
    borderTopColor: C.b0,
    gap: SPACE.md,
  },
  scorerRank: { width: 18, color: C.t3, fontSize: 13, fontFamily: FONT.black },
  scorerName: { color: C.t1, fontSize: 14, fontFamily: FONT.semibold },
  scorerTeam: { color: C.t3, fontSize: 10, fontFamily: FONT.regular, marginTop: 1 },
  scorerAssists: { color: C.t3, fontSize: 11, fontFamily: FONT.medium },
  scorerGoals: { color: C.lime, fontSize: 18, fontFamily: FONT.black, minWidth: 20, textAlign: 'right' },

  // ── the ask ─────────────────────────────────────────────────────────────────
  footer: {
    backgroundColor: C.s1,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: C.b1,
    padding: SPACE.lg,
    marginTop: SPACE.sm,
  },
  footerTitle: { color: C.lime, fontSize: 17, fontFamily: FONT.bold },
  footerText: { color: C.t2, fontSize: 13, fontFamily: FONT.regular, lineHeight: 19, marginTop: 5 },
})
