/**
 * Storage adapters for the mandate store.
 *
 * The Store keeps its working state in memory, because the demo has to be
 * inspectable and fast. Persistence is a separate concern: a small adapter
 * writes a consistent snapshot after every mutation and reads it back at boot.
 *
 * SQLite is the durable backend. It uses `node:sqlite`, which ships with Node
 * 22.5+ and needs no native dependency, so the demo stays a single `npm install`
 * away from running.
 */

import { mkdirSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname } from "node:path"
import type { LedgerEntry, MandateEnvelope, MandateState } from "./types.js"
import type { PendingApproval } from "./store.js"

export interface ReservationRecord {
  id: string
  mandateId: string
  amount: number
  currency: string
}

/** Everything the Store needs to come back exactly as it was. */
export interface StoreSnapshot {
  mandates: Array<{ envelope: MandateEnvelope; state: MandateState }>
  ledger: LedgerEntry[]
  approvals: PendingApproval[]
  reservations: ReservationRecord[]
}

export interface Persistence {
  load(): StoreSnapshot | null
  save(snapshot: StoreSnapshot): void
  close?(): void
}

interface SqliteStatement {
  run(...params: unknown[]): unknown
  get(...params: unknown[]): unknown
}

interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  close(): void
}

const require = createRequire(import.meta.url)

/**
 * Durable snapshot storage in a single SQLite row. A snapshot write is atomic,
 * which is all this demo needs: mandates, ledger and approvals are always
 * persisted together, never half-written.
 */
export class SqlitePersistence implements Persistence {
  private readonly db: SqliteDatabase

  constructor(path: string) {
    let DatabaseSync: new (path: string) => SqliteDatabase
    try {
      ;({ DatabaseSync } = require("node:sqlite") as {
        DatabaseSync: new (path: string) => SqliteDatabase
      })
    } catch {
      throw new Error(
        "node:sqlite is unavailable. Use Node 22.5+ or unset STORE_BACKEND to keep state in memory.",
      )
    }

    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS store_snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)",
    )
  }

  load(): StoreSnapshot | null {
    const row = this.db.prepare("SELECT json FROM store_snapshot WHERE id = 1").get() as
      | { json?: string }
      | undefined
    if (!row?.json) return null
    try {
      return JSON.parse(row.json) as StoreSnapshot
    } catch {
      return null
    }
  }

  save(snapshot: StoreSnapshot): void {
    this.db
      .prepare(
        "INSERT INTO store_snapshot (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json",
      )
      .run(JSON.stringify(snapshot))
  }

  close(): void {
    this.db.close()
  }
}

/** In-memory adapter used by tests to prove the Store round-trips. */
export class MemoryPersistence implements Persistence {
  private snapshot: StoreSnapshot | null = null

  load(): StoreSnapshot | null {
    return this.snapshot ? structuredClone(this.snapshot) : null
  }

  save(snapshot: StoreSnapshot): void {
    this.snapshot = structuredClone(snapshot)
  }
}
