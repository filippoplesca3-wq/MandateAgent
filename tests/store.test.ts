import { describe, it, expect } from "vitest"
import { Store } from "../src/core/store.js"
import type { IssueMandateSpec } from "../src/core/mandate.js"
import { EUR, TEST_KEY, goodProposal } from "./helpers.js"

const NOW = new Date()

function makeStore(): Store {
  return new Store(TEST_KEY)
}

function issue(store: Store, overrides: Partial<IssueMandateSpec> = {}) {
  return store.issue({
    principal: "filippo@example.com",
    agentId: "agent-procurement-01",
    budget: EUR(50_000),
    purpose: "Restock office supplies",
    now: NOW,
    ...overrides,
  })
}

describe("Store construction", () => {
  it("refuses to start without a real signing key", () => {
    expect(() => new Store("")).toThrow(/signing key/i)
    expect(() => new Store("short")).toThrow(/signing key/i)
  })
})

describe("Store mandates", () => {
  it("issues a mandate that can be retrieved by id", () => {
    const store = makeStore()
    const { envelope } = issue(store)
    const found = store.get(envelope.claims.id)
    expect(found?.envelope.claims.principal).toBe("filippo@example.com")
  })

  it("starts every mandate with a zeroed spend counter", () => {
    const store = makeStore()
    const { envelope, state } = issue(store)
    expect(state.spendToDate).toEqual(EUR(0))
    expect(state.transactionCount).toBe(0)
    expect(store.get(envelope.claims.id)?.state.spendToDate).toEqual(EUR(0))
  })

  it("returns undefined for an unknown mandate", () => {
    expect(makeStore().get("nope")).toBeUndefined()
  })

  it("revokes a mandate in place", () => {
    const store = makeStore()
    const { envelope } = issue(store)
    expect(store.revoke(envelope.claims.id)).toBe(true)
    expect(store.get(envelope.claims.id)?.state.revokedAt).not.toBeNull()
  })

  it("reports false when revoking an unknown mandate", () => {
    expect(makeStore().revoke("nope")).toBe(false)
  })

  it("lists mandates newest first", () => {
    const store = makeStore()
    const first = issue(store)
    const second = issue(store)
    expect(store.list().map((m) => m.envelope.claims.id)).toEqual([
      second.envelope.claims.id,
      first.envelope.claims.id,
    ])
  })
})

describe("Store evaluation", () => {
  it("permits a compliant payment", () => {
    const store = makeStore()
    const { envelope } = issue(store)
    const decision = store.evaluate(envelope.claims.id, goodProposal())
    expect(decision.allowed).toBe(true)
  })

  it("refuses a payment for an unknown mandate instead of throwing", () => {
    const decision = makeStore().evaluate("nope", goodProposal())
    expect(decision.allowed).toBe(false)
    expect(decision.code).toBe("MALFORMED_MANDATE")
  })

  it("refuses a payment once the mandate is revoked", () => {
    const store = makeStore()
    const { envelope } = issue(store)
    store.revoke(envelope.claims.id)
    expect(store.evaluate(envelope.claims.id, goodProposal()).code).toBe("MANDATE_REVOKED")
  })
})

describe("Store spend accounting", () => {
  it("moves the budget down as spends are committed", () => {
    const store = makeStore()
    const { envelope } = issue(store)
    store.commitSpend(envelope.claims.id, 20_000)
    expect(store.get(envelope.claims.id)?.state.spendToDate).toEqual(EUR(20_000))
    expect(store.get(envelope.claims.id)?.state.transactionCount).toBe(1)
  })

  it("refuses the next payment once the budget is exhausted", () => {
    const store = makeStore()
    const { envelope } = issue(store)
    store.commitSpend(envelope.claims.id, 48_000)
    const decision = store.evaluate(envelope.claims.id, goodProposal())
    expect(decision.code).toBe("BUDGET_EXCEEDED")
  })

  it("refuses to commit spend against an unknown mandate", () => {
    expect(() => makeStore().commitSpend("nope", 100)).toThrow(/no mandate/i)
  })
})

describe("Store approvals", () => {
  function issuedForApproval() {
    const store = makeStore()
    const { envelope } = issue(store, { constraints: { requireApprovalAbove: EUR(1_000) } })
    return { store, mandateId: envelope.claims.id }
  }

  it("parks an escalated payment in the pending queue and the ledger", () => {
    const { store, mandateId } = issuedForApproval()
    const decision = store.evaluate(mandateId, goodProposal())
    expect(decision.requiresApproval).toBe(true)

    const pending = store.parkForApproval({
      mandateId,
      agentId: "agent-procurement-01",
      action: "create_order",
      proposal: goodProposal(),
      decision,
    })

    expect(store.listPending()).toHaveLength(1)
    expect(store.listPending()[0]?.id).toBe(pending.id)
    expect(store.ledger.list()).toHaveLength(1)
  })

  it("consumes an approved payment exactly once", () => {
    const { store, mandateId } = issuedForApproval()
    const decision = store.evaluate(mandateId, goodProposal())
    const pending = store.parkForApproval({
      mandateId,
      agentId: "agent-procurement-01",
      action: "create_order",
      proposal: goodProposal(),
      decision,
    })

    store.resolveApproval(pending.id, true)

    const expected = {
      mandateId,
      action: "create_order",
      amount: goodProposal().amount,
      merchant: goodProposal().merchant,
    }

    expect(store.consumeApproval(pending.id, expected)).toBe(true)
    expect(store.consumeApproval(pending.id, expected)).toBe(false)
  })

  it("refuses an approval for a different amount", () => {
    const { store, mandateId } = issuedForApproval()
    const pending = store.parkForApproval({
      mandateId,
      agentId: "agent-procurement-01",
      action: "create_order",
      proposal: goodProposal(),
      decision: store.evaluate(mandateId, goodProposal()),
    })
    store.resolveApproval(pending.id, true)
    expect(
      store.consumeApproval(pending.id, {
        mandateId,
        action: "create_order",
        amount: 999_999,
        merchant: goodProposal().merchant,
      }),
    ).toBe(false)
  })

  it("refuses an approval for a different merchant", () => {
    const { store, mandateId } = issuedForApproval()
    const pending = store.parkForApproval({
      mandateId,
      agentId: "agent-procurement-01",
      action: "create_order",
      proposal: goodProposal(),
      decision: store.evaluate(mandateId, goodProposal()),
    })
    store.resolveApproval(pending.id, true)
    expect(
      store.consumeApproval(pending.id, {
        mandateId,
        action: "create_order",
        amount: goodProposal().amount,
        merchant: "somewhere-else",
      }),
    ).toBe(false)
  })

  it("refuses to consume a rejected approval", () => {
    const { store, mandateId } = issuedForApproval()
    const pending = store.parkForApproval({
      mandateId,
      agentId: "agent-procurement-01",
      action: "create_order",
      proposal: goodProposal(),
      decision: store.evaluate(mandateId, goodProposal()),
    })
    store.resolveApproval(pending.id, false)
    expect(
      store.consumeApproval(pending.id, {
        mandateId,
        action: "create_order",
        amount: goodProposal().amount,
        merchant: goodProposal().merchant,
      }),
    ).toBe(false)
  })

  it("refuses to resolve the same approval twice", () => {
    const { store, mandateId } = issuedForApproval()
    const pending = store.parkForApproval({
      mandateId,
      agentId: "agent-procurement-01",
      action: "create_order",
      proposal: goodProposal(),
      decision: store.evaluate(mandateId, goodProposal()),
    })
    expect(store.resolveApproval(pending.id, true)).toBeDefined()
    expect(store.resolveApproval(pending.id, true)).toBeUndefined()
  })
})

describe("Store trust", () => {
  it("scores an agent as unknown with no history", () => {
    const store = makeStore()
    expect(store.trustFor("never-seen").tier).toBe("unknown")
  })

  it("counts a live mandate towards the agent's trust", () => {
    const store = makeStore()
    const { envelope } = issue(store)
    expect(store.hasLiveMandate("agent-procurement-01")).toBe(true)

    store.revoke(envelope.claims.id)
    expect(store.hasLiveMandate("agent-procurement-01")).toBe(false)
  })

  it("lets a merchant seed PayPal history for an agent", () => {
    const store = makeStore()
    store.setAgentSignals({
      agentId: "agent-procurement-01",
      transactionCount: 30,
      disputeCount: 0,
      refundCount: 0,
      totalVolume: 900_000,
      currency: "EUR",
      firstSeenAt: new Date(Date.now() - 500 * 86_400_000).toISOString(),
      mandateActive: false,
    })
    const score = store.trustFor("agent-procurement-01")
    expect(score.tier).toBe("reliable")
    expect(score.score).toBeGreaterThanOrEqual(70)
  })

  it("ranks trust scores across every known agent", () => {
    const store = makeStore()
    issue(store)
    store.setAgentSignals({
      agentId: "agent-bad",
      transactionCount: 10,
      disputeCount: 5,
      refundCount: 3,
      totalVolume: 100_000,
      currency: "EUR",
      firstSeenAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      mandateActive: false,
    })

    const ranked = store.listTrustScores()
    expect(ranked.length).toBe(2)
    expect(ranked[0]?.score).toBeGreaterThanOrEqual(ranked[1]?.score ?? 0)
  })
})
