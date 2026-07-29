/**
 * Offline scorecard buffer using expo-sqlite.
 *
 * When the device loses connectivity mid-match, stat entries are queued here.
 * On reconnect, the sync engine drains this table via POST /matches/:id/stats/batch.
 */

import * as SQLite from 'expo-sqlite'

let db: SQLite.SQLiteDatabase

async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!db) {
    db = await SQLite.openDatabaseAsync('allsports_offline.db')
    await initSchema(db)
  }
  return db
}

async function initSchema(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS pending_stats (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id         TEXT NOT NULL,
      user_id          TEXT NOT NULL,
      team_id          TEXT NOT NULL,
      stats_json       TEXT NOT NULL,
      client_event_id  TEXT NOT NULL UNIQUE,
      client_timestamp TEXT NOT NULL,
      synced           INTEGER NOT NULL DEFAULT 0,
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_pending_stats_match ON pending_stats(match_id, synced);
  `)
}

export interface PendingStatEntry {
  match_id: string
  user_id: string
  team_id: string
  stats: Record<string, unknown>
  client_event_id: string
  client_timestamp: string
}

export async function queueStatEntry(entry: PendingStatEntry): Promise<void> {
  const db = await getDb()
  await db.runAsync(
    `INSERT OR IGNORE INTO pending_stats
      (match_id, user_id, team_id, stats_json, client_event_id, client_timestamp)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      entry.match_id,
      entry.user_id,
      entry.team_id,
      JSON.stringify(entry.stats),
      entry.client_event_id,
      entry.client_timestamp,
    ]
  )
}

export async function getPendingEntries(matchId: string): Promise<PendingStatEntry[]> {
  const db = await getDb()
  const rows = await db.getAllAsync<{
    match_id: string
    user_id: string
    team_id: string
    stats_json: string
    client_event_id: string
    client_timestamp: string
  }>(
    `SELECT match_id, user_id, team_id, stats_json, client_event_id, client_timestamp
     FROM pending_stats
     WHERE match_id = ? AND synced = 0
     ORDER BY client_timestamp ASC`,
    [matchId]
  )

  return rows.map((r) => ({
    match_id: r.match_id,
    user_id: r.user_id,
    team_id: r.team_id,
    stats: JSON.parse(r.stats_json),
    client_event_id: r.client_event_id,
    client_timestamp: r.client_timestamp,
  }))
}

export async function markSynced(clientEventIds: string[]): Promise<void> {
  if (clientEventIds.length === 0) return
  const db = await getDb()
  const placeholders = clientEventIds.map(() => '?').join(',')
  await db.runAsync(
    `UPDATE pending_stats SET synced = 1 WHERE client_event_id IN (${placeholders})`,
    clientEventIds
  )
}

export async function getAllUnsyncedMatches(): Promise<string[]> {
  const db = await getDb()
  const rows = await db.getAllAsync<{ match_id: string }>(
    `SELECT DISTINCT match_id FROM pending_stats WHERE synced = 0`
  )
  return rows.map((r) => r.match_id)
}
