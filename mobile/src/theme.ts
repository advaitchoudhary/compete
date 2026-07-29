// AllSports Design System
// Dark-first, energy-forward, sport-coded

export const C = {
  // Backgrounds — cool near-black (matches the data-viz kit palette)
  bg:  '#0a0e13',
  s1:  '#12161c',   // card
  s2:  '#181d24',   // raised card
  s3:  '#232932',   // chips / tracks
  bgGlow: 'rgba(46,120,130,0.08)' as string,  // faint teal atmosphere

  // Borders — white at low opacity
  b0: 'rgba(255,255,255,0.04)' as string,
  b1: 'rgba(255,255,255,0.08)' as string,
  b2: 'rgba(255,255,255,0.14)' as string,
  b3: 'rgba(255,255,255,0.22)' as string,

  // Text
  white: '#ffffff',
  t1:    '#f4f6fa',   // primary
  t2:    '#8b93a1',   // secondary (blue-gray)
  t3:    '#474e59',   // muted

  // ─── PRIMARY ENERGY ACCENT ───────────────────────────────────────────────
  // Chartreuse from the kit — punchy yellow-lime on cool dark
  lime:     '#D4F23C',               // main accent
  limeDeep: '#aecf2c',               // pressed / hover variant
  limeGlow: 'rgba(212,242,60,0.14)' as string, // glow tint
  limeText: '#0a0f00',               // dark text ON lime backgrounds

  // ─── Sport & secondary accents ───────────────────────────────────────────
  blue:   '#3b82f6',   // football sport color (only)
  indigo: '#818cf8',
  green:  '#22c55e',
  amber:  '#f59e0b',
  red:    '#ef4444',
  orange: '#f97316',
  purple: '#a855f7',

  // Podium
  gold:   '#fbbf24',
  silver: '#94a3b8',
  bronze: '#b45309',
}

export const SPORT: Record<string, { color: string; glow: string; emoji: string; name: string }> = {
  cricket:    { color: '#22c55e', glow: 'rgba(34,197,94,0.10)',   emoji: '🏏', name: 'Cricket'    },
  football:   { color: '#3b82f6', glow: 'rgba(59,130,246,0.10)',  emoji: '⚽', name: 'Football'   },
  badminton:  { color: '#f59e0b', glow: 'rgba(245,158,11,0.10)',  emoji: '🏸', name: 'Badminton'  },
  basketball: { color: '#ef4444', glow: 'rgba(239,68,68,0.10)',   emoji: '🏀', name: 'Basketball' },
}

// ─── TIER LADDER (ascending prestige) ────────────────────────────────────────
export const TIER: Record<string, { color: string; glow: string; label: string; short: string }> = {
  amateur:  { color: '#94a3b8', glow: 'rgba(148,163,184,0.14)', label: 'Amateur',  short: 'AMA'  },
  semi_pro: { color: '#3b82f6', glow: 'rgba(59,130,246,0.16)',  label: 'Semi-Pro', short: 'SEMI' },
  pro:      { color: '#D4F23C', glow: 'rgba(212,242,60,0.18)',  label: 'Pro',      short: 'PRO'  },
  legends:  { color: '#fbbf24', glow: 'rgba(251,191,36,0.20)',  label: 'Legends',  short: 'LGND' },
}
export const TIER_ORDER = ['amateur', 'semi_pro', 'pro', 'legends'] as const

// ─── SPATIAL SCALE — consistent rhythm (map your design tokens here) ──────────
export const SPACE  = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 }
export const RADIUS = { sm: 8, md: 12, lg: 18, xl: 28, pill: 999 }

// ─── ELEVATION / GLOW — depth + atmosphere ───────────────────────────────────
export const ELEV = {
  card: {
    shadowColor: '#000', shadowOpacity: 0.45, shadowRadius: 16,
    shadowOffset: { width: 0, height: 10 }, elevation: 8,
  },
  glow: (color: string, intensity = 0.55) => ({
    shadowColor: color, shadowOpacity: intensity, shadowRadius: 22,
    shadowOffset: { width: 0, height: 0 }, elevation: 10,
  }),
}

export const MOTION = { fast: 140, base: 240, slow: 420 }

// Rating → meaning. Single source of truth for rating color + label everywhere.
export function ratingTone(r: number): { color: string; label: string } {
  if (r >= 85) return { color: C.gold,  label: 'ELITE'     }
  if (r >= 70) return { color: C.green, label: 'EXCELLENT' }
  if (r >= 58) return { color: C.lime,  label: 'STRONG'    }
  if (r >= 45) return { color: C.blue,  label: 'STEADY'    }
  if (r >= 32) return { color: C.amber, label: 'RISING'    }
  return { color: C.red, label: 'ROOKIE' }
}

// ─── FONT FAMILIES ───────────────────────────────────────────────────────────
// Plus Jakarta Sans (geometric, rounded — matches the kit). In React Native each
// weight is its OWN family name; reference these via fontFamily, not fontWeight.
export const FONT = {
  black:    'PlusJakartaSans_800ExtraBold',  // hero numbers, display
  bold:     'PlusJakartaSans_700Bold',       // headings
  semibold: 'PlusJakartaSans_600SemiBold',   // sub-headings, labels
  medium:   'PlusJakartaSans_500Medium',     // emphasised body
  regular:  'PlusJakartaSans_400Regular',    // body
}

export const TYPE = {
  display: { fontFamily: FONT.black,    fontSize: 46, letterSpacing: -2,    color: C.t1 },
  h1:      { fontFamily: FONT.black,    fontSize: 32, letterSpacing: -0.5,  color: C.t1 },
  h2:      { fontFamily: FONT.bold,     fontSize: 22, letterSpacing: -0.3,  color: C.t1 },
  h3:      { fontFamily: FONT.semibold, fontSize: 17, letterSpacing: 0,     color: C.t1 },
  body:    { fontFamily: FONT.regular,  fontSize: 15, letterSpacing: 0,     color: C.t2 },
  label:   { fontFamily: FONT.bold,     fontSize: 11, letterSpacing: 2,     color: C.t3 },
  micro:   { fontFamily: FONT.medium,   fontSize: 11, letterSpacing: 0.4,   color: C.t3 },
}
