import { describe, it, expect } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MemoryPersistence, SqlitePersistence } from "../src/core/persistence.js"
import { Store } from "../src/core/store.js"
import { TEST_KEY } from "./helpers.js"

const PROPOSAL = {
  action: "pay_order",
  merchant: "acme-supplies",
  amount: 1_000,
  currency: "USD",
  description: "capture order",
}

function issue(store: Store): string {
  const { envelope } = store.issue({
    principal: "filippo@example.com",
    agentId: "agent-procurement-01",
    budget: { amount: 5_000, currency: "USD" },
    purpose: "Restock office supplies",
    now: new Date(),
  })
  return envelope.claims.id
}

describe("store persistence", () => {
  it("restores mandates, ledger, approvals and reservations", () => {
    const persistence = new MemoryPersistence()
    const store = new Store(TEST_KEY, persistence)
    const mandateId = issue(store)

    const decision = store.evaluate(mandateId, PROPOSAL)
    store.record({
      mandateId,
      agentId: "agent-procurement-01",
      action: PROPOSAL.action,
      proposal: PROPOSAL,
      decision,
    })
    const reservation = store.reserve(mandateId, 1_000)
    expect(reservation.ok).toBe(true)
    store.parkForApproval({
      mandateId,
      agentId: "agent-procurement-01",
      action: PROPOSAL.action,
      proposal: PROPOSAL,
      decision,
    })

    const restored = new Store(TEST_KEY, persistence)
    const state = restored.get(mandateId)?.state
    expect(state?.reservedToDate.amount).toBe(1_000)
    expect(restored.ledger.list()).toHaveLength(2)
    expect(restored.listApprovals()).toHaveLength(1)
    expect(restored.evaluate(mandateId, PROPOSAL).allowed).toBe(true)
    expect(restored.effectiveRemaining(mandateId)?.amount).toBe(4_000)
  })

  it("persists to SQLite and reloads it", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-mandate-"))
    const file = join(dir, "store.sqlite")
    let first: SqlitePersistence | undefined
    let second: SqlitePersistence | undefined
    try {
      first = new SqlitePersistence(file)
      const store = new Store(TEST_KEY, first)
      const mandateId = issue(store)
      store.reserve(mandateId, 1_000)
      store.revoke(mandateId)
      first.close()
      first = undefined

      second = new SqlitePersistence(file)
      const restored = new Store(TEST_KEY, second)
      expect(restored.get(mandateId)?.state.revokedAt).not.toBeNull()
      expect(restored.get(mandateId)?.state.reservedToDate.amount).toBe(1_000)
      expect(restored.effectiveRemaining(mandateId)?.amount).toBe(4_000)
    } finally {
      first?.close()
      second?.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
