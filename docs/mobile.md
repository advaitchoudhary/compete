# Mobile App

React Native · Expo SDK 51 · TypeScript
Location: `mobile/`

---

## Start

```bash
cd mobile
npm install
npx expo start
# Press 'i' for iOS simulator, 'a' for Android
```

---

## Directory Structure

```
mobile/src/
├── api/
│   └── client.ts              # Axios + token injection + 401 handling
├── store/
│   └── auth.store.ts          # Zustand auth state
├── offline/
│   ├── scorecard.db.ts        # SQLite buffer for offline stats
│   └── sync.engine.ts         # Auto-sync on network reconnect
├── realtime/
│   └── socket.ts              # Socket.IO client wrapper
├── screens/
│   └── Match/
│       └── LiveScorecard.tsx  # Online + offline scoring screen
└── components/
    ├── RatingCard/
    │   └── RatingCard.tsx     # Sofascore-style rating display
    └── AchievementCard/
        └── AchievementCard.tsx # Strava-style shareable badge card
```

---

## Key Design Principles

### Offline-First

India's mobile networks are unreliable. The most critical user action — entering match stats — must work without internet. Every stat entry:
1. Gets a UUID generated on the device (`client_event_id`)
2. Gets a timestamp (`client_timestamp`)
3. Online: submits immediately to the API
4. Offline: saves to SQLite on device
5. On reconnect: syncs automatically with idempotency guaranteed

### State Split

| Type of state | Tool | Why |
|---------------|------|-----|
| Authentication (token, user) | Zustand + MMKV | Persists across app restarts, instant read |
| Server data (profiles, matches) | React Query | Cache, background refetch, stale-while-revalidate |
| UI state (modals, tabs) | Zustand | Lightweight, no boilerplate |
| Offline score buffer | expo-sqlite | Persistent, survives app kill |
| Live scores | Socket.IO + Zustand | Push updates to local state |

---

## `api/client.ts`

Axios instance with base URL pointing to the backend.

**Request interceptor:** Reads the JWT from MMKV storage and attaches it as `Authorization: Bearer {token}` on every request. MMKV is ~10× faster than AsyncStorage for token reads.

**Response interceptor:** If any response is 401 (token expired or invalid), clears the stored token and signals the auth store to log the user out.

```typescript
api.interceptors.request.use((config) => {
  const token = storage.getString('access_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})
```

---

## `store/auth.store.ts`

Zustand store. Simple, no reducers.

**`setAuth(token, user)`**
- Writes token to MMKV (persists across app restarts)
- Updates in-memory state: `isAuthenticated = true`, `user = {...}`, `token = "..."`

**`clearAuth()`**
- Deletes token from MMKV
- Resets state

**Initial state** reads from MMKV at module load time — if a token exists, the user is immediately authenticated without making an API call on startup.

---

## `offline/scorecard.db.ts`

SQLite database embedded in the device using `expo-sqlite`. Has one table: `pending_stats`.

### Schema

```sql
CREATE TABLE IF NOT EXISTS pending_stats (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id         TEXT NOT NULL,
  user_id          TEXT NOT NULL,
  team_id          TEXT NOT NULL,
  stats_json       TEXT NOT NULL,
  client_event_id  TEXT NOT NULL UNIQUE,   -- idempotency key
  client_timestamp TEXT NOT NULL,           -- for ordering on sync
  synced           INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
)
```

The database is lazy-initialized on first call — only opens when needed.

### Exported Functions

**`queueStatEntry(entry)`**
Inserts one stat entry. Uses `INSERT OR IGNORE` — if the same `client_event_id` is queued twice (e.g., double-tap), the second insert is silently ignored.

**`getPendingEntries(matchId)`**
Returns all un-synced entries for a match, ordered by `client_timestamp` (ascending). This ordering ensures events are replayed in the correct sequence on sync.

**`markSynced(clientEventIds)`**
Marks a batch of entries as synced after successful upload. Uses `WHERE client_event_id IN (...)` — updates all at once.

**`getAllUnsyncedMatches()`**
Returns distinct match IDs that have at least one pending entry. Called by the sync engine on app startup to catch any matches that were scored offline in a previous session.

---

## `offline/sync.engine.ts`

The sync engine runs whenever internet is restored.

**`registerSyncListener()`**
Registers a `NetInfo` event listener. When `state.isConnected` flips from false to true, `syncPendingStats()` is called automatically.

**`syncPendingStats()`**

1. Checks connectivity (exits if offline)
2. Sets `isSyncing = true` (prevents concurrent sync runs)
3. Gets all matches with pending entries (`getAllUnsyncedMatches`)
4. For each match:
   - Gets all pending entries (`getPendingEntries`)
   - Posts to `POST /matches/:id/stats/batch`
   - If successful: marks entries as synced (`markSynced`)
   - If network error: logs and moves to next match (will retry on next sync)
5. Sets `isSyncing = false`

The backend's batch endpoint is idempotent — sending the same entries twice (e.g., on a flaky connection that sent but timed out) is safe. The `client_event_id` unique constraint silently skips duplicates and returns `synced: 0`.

---

## `realtime/socket.ts`

Socket.IO client wrapper. Singleton — one connection per session.

**`getSocket()`**
Creates or returns the existing socket. Configured with:
- `auth: { token }` — JWT from MMKV, sent on WebSocket handshake
- `transports: ['websocket']` — skip long-polling, go straight to WebSocket
- `reconnection: true, reconnectionAttempts: 10, reconnectionDelay: 2000`

**`joinMatchRoom(matchId)` / `leaveMatchRoom(matchId)`**
Emits Socket.IO events to join/leave a match room. Called by the LiveScorecard screen.

**`onMatchUpdate(matchId, handler)`**
Joins the match room and attaches a handler for `match_update` events. Returns an unsubscribe function — React `useEffect` calls it on cleanup to prevent memory leaks.

**`onRatingUpdate(handler)`**
Watches for rating updates for the current user. Returns unsubscribe function.

---

## `screens/Match/LiveScorecard.tsx`

The scoring screen. The most complex screen in the app. Handles both online and offline mode transparently.

### State

- `isOnline` — updated by `NetInfo` listener
- `players` — array of player rows, each with a name and stats object
- `liveUpdates` — ticker of recent match events from Socket.IO

### Offline Banner

When `isOnline = false`, an amber banner appears: "OFFLINE — stats will sync when reconnected." The user can continue scoring normally — the UI experience is identical.

### Stat Form

Reads `statSchema.match_stats` to render input fields. This is why the stat schema lives in the database — the same screen renders correctly for cricket, football, badminton, and basketball without any sport-specific code.

```tsx
{statSchema.match_stats.map((stat) => (
  <View key={stat}>
    <Text>{stat.replace(/_/g, ' ')}</Text>
    <TextInput keyboardType="numeric" ... />
  </View>
))}
```

### Submit Logic

```
On submit:
  For each player:
    Generate client_event_id = uuid()
    Generate client_timestamp = new Date().toISOString()

    If online:
      POST /matches/:id/stats  ← try API
      If API fails:
        queueStatEntry() → SQLite  ← fallback to offline
    Else:
      queueStatEntry() → SQLite
```

### Live Ticker

Socket.IO `match_update` events are stored in `liveUpdates` state (capped at 50). Displayed as a scrolling ticker at the bottom of the screen — all participants watching the match see updates in real time.

---

## `components/RatingCard/RatingCard.tsx`

Sofascore-inspired player rating card.

**Props:** `currentRating`, `formRating`, `matchesPlayed`, `wins`, `ratingHistory` (array of last 10 entries from `rating_history` table)

### Color System

| Rating | Color | Label |
|--------|-------|-------|
| 85–100 | Gold `#f59e0b` | Elite |
| 70–84 | Green `#22c55e` | Excellent |
| 55–69 | Blue `#3b82f6` | Good |
| 40–54 | Orange `#f97316` | Average |
| 0–39 | Red `#ef4444` | Beginner |

### Sparkline

The `ratingHistory` array is rendered as a bar chart where each bar's height is proportional to `rating_after`. Color changes per bar using the same rating color system. Delta values (`+4.2`, `-2.1`) are shown below each bar. This is the "rating over time" visualization.

### Stat Pills

Three pills alongside the rating circle:
- **FORM** — `formRating` in its color
- **MATCHES** — career match count
- **WIN RATE** — `wins / matchesPlayed × 100`%

---

## `components/AchievementCard/AchievementCard.tsx`

Strava-style shareable badge card.

When a player earns an achievement (first match, 100 matches, rating 80, etc.), this card displays with:
- Large emoji
- Achievement title and description
- Player name and sport
- AllSports badge

### Sharing

Uses `react-native-view-shot` to capture the card as a JPEG image, then `Share.share` to open the native share sheet. The player can share directly to Instagram Stories, WhatsApp Status, or any other app.

This is the viral loop: a player shares "I hit Rating 80 in Football on AllSports 🏆" → friends see it → download the app.

### Achievement Type Registry

All 15 achievement types and their display metadata are defined in `ACHIEVEMENT_META`:

```typescript
const ACHIEVEMENT_META = {
  first_match:  { emoji: '🎯', title: 'First Match', ... },
  rating_80:    { emoji: '💎', title: 'Elite Player', ... },
  matches_100:  { emoji: '💯', title: '100 Matches', ... },
  // ...
}
```

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `expo-sqlite` | SQLite offline buffer |
| `expo-secure-store` | Secure storage for sensitive data |
| `react-native-mmkv` | Fast key-value store for token |
| `@tanstack/react-query` | Server state management, caching |
| `zustand` | Client UI state |
| `socket.io-client` | WebSocket connection to real-time service |
| `axios` | HTTP client |
| `react-native-view-shot` | Capture components as images |
| `react-native-reanimated` | Smooth rating change animations |
| `date-fns` | Date formatting in feed |
| `@react-native-community/netinfo` | Network connectivity detection |
