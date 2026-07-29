/**
 * ProfileHero — the jumbotron rating card.
 * A massive glowing Elo number (the headline), the tier ladder as prestige
 * badges, a kinetic form trail, and a stat strip. Fully token-driven.
 */
import React from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { C, FONT, SPACE, RADIUS, ELEV, SPORT, TIER, TIER_ORDER, ratingTone } from '../../theme'

interface TierRating { tier: string; rating: number | string; matches_played: number; wins: number }
interface HistoryPoint { performance_score: number | string; delta: number | string }

interface Props {
  sportSlug: string
  currentRating: number       // blended overall "Elo number"
  formRating: number | null
  matchesPlayed: number
  wins: number
  tierRatings: TierRating[]
  ratingHistory: HistoryPoint[]   // newest first
}

export function ProfileHero({
  sportSlug, currentRating, formRating, matchesPlayed, wins, tierRatings, ratingHistory,
}: Props) {
  const sport = SPORT[sportSlug] ?? SPORT.football
  const tone = ratingTone(currentRating)
  const winRate = matchesPlayed > 0 ? Math.round((wins / matchesPlayed) * 100) : 0
  const lastDelta = ratingHistory[0] ? Number(ratingHistory[0].delta) : null

  // Highest tier the player has actually played (for the prestige badge)
  const played = new Set(tierRatings.map((t) => t.tier))
  const topTier = [...TIER_ORDER].reverse().find((t) => played.has(t)) ?? 'amateur'
  const topCfg = TIER[topTier]

  // Form trail: oldest → newest, last 8
  const trail = [...ratingHistory].slice(0, 8).reverse()

  return (
    <View style={[s.card, { borderColor: sport.color + '33' }, ELEV.card]}>
      {/* atmosphere: a soft sport-tinted glow bleed at the top */}
      <View pointerEvents="none" style={[s.glowBleed, { backgroundColor: sport.glow }]} />

      {/* top row — sport + prestige badge */}
      <View style={s.topRow}>
        <View style={s.sportTag}>
          <Text style={s.sportEmoji}>{sport.emoji}</Text>
          <Text style={s.sportName}>{sport.name.toUpperCase()}</Text>
        </View>
        <View style={[s.tierBadge, { borderColor: topCfg.color, backgroundColor: topCfg.glow }]}>
          <View style={[s.tierDot, { backgroundColor: topCfg.color }]} />
          <Text style={[s.tierBadgeText, { color: topCfg.color }]}>{topCfg.label.toUpperCase()}</Text>
        </View>
      </View>

      {/* HERO — the Elo number */}
      <View style={s.heroBlock}>
        <Text
          style={[
            s.eloNumber,
            { color: tone.color, textShadowColor: tone.color },
          ]}
        >
          {currentRating ? currentRating.toFixed(1) : '—'}
        </Text>
        <View style={s.heroMeta}>
          <Text style={s.eloLabel}>OVERALL ELO</Text>
          <Text style={[s.toneLabel, { color: tone.color }]}>{tone.label}</Text>
          {lastDelta !== null && (
            <View style={[s.deltaChip, { backgroundColor: lastDelta >= 0 ? C.limeGlow : 'rgba(239,68,68,0.12)' }]}>
              <Text style={[s.deltaText, { color: lastDelta >= 0 ? C.lime : C.red }]}>
                {lastDelta >= 0 ? '▲' : '▼'} {Math.abs(lastDelta).toFixed(1)}
              </Text>
            </View>
          )}
        </View>
      </View>

      {/* TIER LADDER — your ratings per tier */}
      <Text style={s.sectionCap}>TIER RATINGS</Text>
      <View style={s.tierRow}>
        {TIER_ORDER.map((t) => {
          const tr = tierRatings.find((x) => x.tier === t)
          const cfg = TIER[t]
          const has = !!tr
          return (
            <View
              key={t}
              style={[
                s.tierChip,
                { borderColor: has ? cfg.color + '55' : C.b1, backgroundColor: has ? cfg.glow : 'transparent' },
              ]}
            >
              <Text style={[s.tierChipVal, { color: has ? cfg.color : C.t3 }]}>
                {has ? Number(tr!.rating).toFixed(1) : '–'}
              </Text>
              <Text style={[s.tierChipLabel, { color: has ? cfg.color : C.t3 }]}>{cfg.short}</Text>
            </View>
          )
        })}
      </View>

      {/* FORM trail */}
      {trail.length > 0 && (
        <>
          <Text style={s.sectionCap}>FORM · LAST {trail.length}</Text>
          <View style={s.formRow}>
            {trail.map((h, i) => {
              const v = Number(h.performance_score)              // 0–100 (star × 10)
              const fill = Math.max(0.12, Math.min(1, v / 100))
              return (
                <View key={i} style={s.formCol}>
                  <View style={s.formTrack}>
                    <View
                      style={[
                        s.formFill,
                        { height: `${fill * 100}%`, backgroundColor: ratingTone(v).color },
                      ]}
                    />
                  </View>
                </View>
              )
            })}
          </View>
        </>
      )}

      {/* STAT STRIP */}
      <View style={s.statStrip}>
        <Stat value={String(matchesPlayed)} label="MATCHES" />
        <View style={s.statDivider} />
        <Stat value={String(wins)} label="WINS" />
        <View style={s.statDivider} />
        <Stat value={`${winRate}%`} label="WIN RATE" accent={winRate >= 50} />
        <View style={s.statDivider} />
        <Stat value={formRating ? formRating.toFixed(1) : '—'} label="FORM" />
      </View>
    </View>
  )
}

function Stat({ value, label, accent }: { value: string; label: string; accent?: boolean }) {
  return (
    <View style={s.statBox}>
      <Text style={[s.statValue, accent && { color: C.lime }]}>{value}</Text>
      <Text style={s.statLabel}>{label}</Text>
    </View>
  )
}

const s = StyleSheet.create({
  card: {
    backgroundColor: C.s1,
    borderRadius: RADIUS.xl,
    borderWidth: 1,
    padding: SPACE.xl,
    overflow: 'hidden',
  },
  glowBleed: {
    position: 'absolute', top: -90, left: -40, right: -40, height: 200, borderRadius: 200,
  },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sportTag: { flexDirection: 'row', alignItems: 'center', gap: SPACE.sm },
  sportEmoji: { fontSize: 18 },
  sportName: { color: C.t2, fontSize: 12, fontFamily: FONT.bold, letterSpacing: 2 },
  tierBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    borderWidth: 1, borderRadius: RADIUS.pill, paddingHorizontal: 10, paddingVertical: 5,
  },
  tierDot: { width: 6, height: 6, borderRadius: 3 },
  tierBadgeText: { fontSize: 10, fontFamily: FONT.black, letterSpacing: 1.5 },

  heroBlock: { alignItems: 'center', marginTop: SPACE.lg, marginBottom: SPACE.sm },
  eloNumber: {
    fontSize: 96, fontFamily: FONT.black, letterSpacing: -5, lineHeight: 100,
    textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 26,
  },
  heroMeta: { alignItems: 'center', gap: 6, marginTop: SPACE.xs },
  eloLabel: { color: C.t3, fontSize: 11, fontFamily: FONT.bold, letterSpacing: 3 },
  toneLabel: { fontSize: 13, fontFamily: FONT.black, letterSpacing: 2 },
  deltaChip: { borderRadius: RADIUS.pill, paddingHorizontal: 10, paddingVertical: 3, marginTop: 2 },
  deltaText: { fontSize: 12, fontFamily: FONT.bold, letterSpacing: 0.5 },

  sectionCap: { color: C.t3, fontSize: 10, fontFamily: FONT.bold, letterSpacing: 2, marginTop: SPACE.xl, marginBottom: SPACE.md },

  tierRow: { flexDirection: 'row', gap: SPACE.sm },
  tierChip: {
    flex: 1, alignItems: 'center', borderWidth: 1, borderRadius: RADIUS.md,
    paddingVertical: SPACE.md, gap: 3,
  },
  tierChipVal: { fontSize: 22, fontFamily: FONT.black, letterSpacing: -0.5 },
  tierChipLabel: { fontSize: 9, fontFamily: FONT.bold, letterSpacing: 1.5 },

  formRow: { flexDirection: 'row', gap: SPACE.sm, height: 56, alignItems: 'flex-end' },
  formCol: { flex: 1, height: '100%', justifyContent: 'flex-end' },
  formTrack: {
    width: '100%', height: '100%', backgroundColor: C.s3, borderRadius: RADIUS.sm,
    justifyContent: 'flex-end', overflow: 'hidden',
  },
  formFill: { width: '100%', borderRadius: RADIUS.sm },

  statStrip: {
    flexDirection: 'row', alignItems: 'center', marginTop: SPACE.xl,
    paddingTop: SPACE.lg, borderTopWidth: 1, borderTopColor: C.b1,
  },
  statBox: { flex: 1, alignItems: 'center' },
  statValue: { color: C.t1, fontSize: 22, fontFamily: FONT.black, letterSpacing: -0.5 },
  statLabel: { color: C.t3, fontSize: 9, fontFamily: FONT.bold, letterSpacing: 1.2, marginTop: 3 },
  statDivider: { width: 1, height: 28, backgroundColor: C.b1 },
})
