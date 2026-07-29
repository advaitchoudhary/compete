import { Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import type { Database } from './types'

let db: Kysely<Database>

export function getDb(): Kysely<Database> {
  if (!db) {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    })

    db = new Kysely<Database>({
      dialect: new PostgresDialect({ pool }),
    })
  }
  return db
}
