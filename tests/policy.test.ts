import { describe, it, expect } from "vitest"
import { evaluate, toolClassOf, TOOL_CLASSES } from "../src/core/policy.js"
import { revokeMandate } from "../src/core/mandate.js"
import type { MandateState, PaymentProposal } from "../src/core/types.js"
import { EUR, TEST_KEY, goodProposal, makeMandate } from "./helpers.js"

const NOW = new Date("2026-01-01T12:00:00.000Z")

function run(proposal: PaymentProposal, stateOrFixture?: Partial<MandateState> | null) {
  const fixture = makeMandate()
  const state: MandateState = stateOrFixture
    ? { ...fixture.state, ...stateOrFixture }
    : fixture.state
  const decision = evaluate({
    envelope: fixture.envelope,
    state,
    proposal,
    signingKey: TEST_KEY,
    now: NOW,
  })
  return { decision, fixture }
}

describe("tool classification", () => {
  it("classifies spending tools as spend", () => {
    expect(toolClassOf("create_order")).toBe("spend")
    expect(toolClassOf("pay_order")).toBe("spend")
    expect(toolClassOf("create_refund")).toBe("spend")
  })

  it("classifies reads as read", () => {
    expect(toolClassOf("list_transactions")).toBe("read")
    expect(toolClassOf("get_order")).toBe("read")
  })

  it("classifies state changes without money movement as mutate", () => {
    expect(toolClassOf("cancel_subscription")).toBe("mutate")
  })

  it("returns null for tools it does not know", () => {
    expect(toolClassOf("drain_wallet")).toBeNull()
  })

  it("covers every tool with exactly one class", () => {
    const values = Object.values(TOOL_CLASSES)
    expect(values.length).toBe(Object.keys(TOOL_CLASSES).length)
    for (const value of values) {
      expect(["read", "spend", "mutate"]).toContain(value)
    }
  })
})

describe("evaluate — the happy path", () => {
  it("permits a payment that fits the mandate", () => {
    const { decision } = run(goodProposal())
    expect(decision.allowed).toBe(true)
    expect(decision.code).toBe("ALLOWED")
    expect(decision.reason).toMatch(/permitted/)
  })

  it("records every rule it evaluated", () => {
    const { decision } = run(goodProposal())
    const rules = decision.checks.map((check) => check.rule)
    expect(rules).toContain("signature")
    expect(rules).toContain("validity")
    expect(rules).toContain("revocation")
    expect(rules).toContain("tool-allowlist")
    expect(rules).toContain("merchant-allowlist")
    expect(rules).toContain("currency")
    expect(rules).toContain("budget")
    expect(rules).toContain("approval-threshold")
    expect(decision.checks.every((check) => check.passed)).toBe(true)
  })

  it("allows read tools on a valid mandate without amount checks", () => {
    const { decision } = run({ action: "list_transactions" })
    expect(decision.allowed).toBe(true)
    expect(decision.code).toBe("ALLOWED")
    expect(decision.reason).toMatch(/read tool/)
  })

  it("allows mutate tools on a valid mandate", () => {
    const { decision } = run({ action: "cancel_subscription" })
    expect(decision.allowed).toBe(true)
    expect(decision.reason).toMatch(/mutate tool/)
  })
})

describe("evaluate — mandate integrity", () => {
  it("refuses a forged mandate (SIGNATURE_INVALID)", () => {
    const { envelope } = makeMandate()
    const forged = {
      ...envelope,
      claims: { ...envelope.claims, budget: EUR(9_000_000) },
    }
    const decision = evaluate({
      envelope: forged,
      state: {
        mandateId: forged.claims.id,
        revokedAt: null,
        spendToDate: EUR(0),
        transactionCount: 0,
      },
      proposal: goodProposal(),
      signingKey: TEST_KEY,
      now: NOW,
    })
    expect(decision.allowed).toBe(false)
    expect(decision.code).toBe("SIGNATURE_INVALID")
  })

  it("refuses an expired mandate (MANDATE_EXPIRED)", () => {
    const fixture = makeMandate()
    const decision = evaluate({
      envelope: fixture.envelope,
      state: fixture.state,
      proposal: goodProposal(),
      signingKey: TEST_KEY,
      now: new Date("2026-01-05T00:00:00.000Z"),
    })
    expect(decision.allowed).toBe(false)
    expect(decision.code).toBe("MANDATE_EXPIRED")
  })

  it("refuses a revoked mandate (MANDATE_REVOKED)", () => {
    const { decision } = run(goodProposal(), revokeMandate(makeMandate().state))
    expect(decision.allowed).toBe(false)
    expect(decision.code).toBe("MANDATE_REVOKED")
  })

  it("refuses an unknown tool (ACTION_NOT_PERMITTED) rather than allowing it", () => {
    const { decision } = run({ action: "drain_wallet", amount: 1, currency: "EUR" })
    expect(decision.allowed).toBe(false)
    expect(decision.code).toBe("ACTION_NOT_PERMITTED")
    expect(decision.reason).toMatch(/refused by default/)
  })
})

describe("evaluate — merchant constraints", () => {
  it("requires a merchant when an allowlist exists (MERCHANT_REQUIRED)", () => {
    const fixture = makeMandate({ constraints: { allowMerchants: ["acme-supplies"] } })
    const decision = evaluate({
      envelope: fixture.envelope,
      state: fixture.state,
      proposal: { ...goodProposal(), merchant: undefined },
      signingKey: TEST_KEY,
      now: NOW,
    })
    expect(decision.code).toBe("MERCHANT_REQUIRED")
  })

  it("refuses a merchant outside the allowlist (MERCHANT_NOT_ALLOWED)", () => {
    const fixture = makeMandate({ constraints: { allowMerchants: ["acme-supplies"] } })
    const decision = evaluate({
      envelope: fixture.envelope,
      state: fixture.state,
      proposal: { ...goodProposal(), merchant: "sketchy-deals" },
      signingKey: TEST_KEY,
      now: NOW,
    })
    expect(decision.code).toBe("MERCHANT_NOT_ALLOWED")
  })

  it("matches merchants case-insensitively", () => {
    const fixture = makeMandate({ constraints: { allowMerchants: ["ACME-Supplies"] } })
    const decision = evaluate({
      envelope: fixture.envelope,
      state: fixture.state,
      proposal: { ...goodProposal(), merchant: "acme-supplies" },
      signingKey: TEST_KEY,
      now: NOW,
    })
    expect(decision.allowed).toBe(true)
  })

  it("refuses an explicitly denied merchant (MERCHANT_DENIED)", () => {
    const fixture = makeMandate({ constraints: { denyMerchants: ["acme-supplies"] } })
    const decision = evaluate({
      envelope: fixture.envelope,
      state: fixture.state,
      proposal: goodProposal(),
      signingKey: TEST_KEY,
      now: NOW,
    })
    expect(decision.code).toBe("MERCHANT_DENIED")
  })
})

describe("evaluate — category and amount rules", () => {
  it("refuses a category outside the allowlist (CATEGORY_NOT_ALLOWED)", () => {
    const fixture = makeMandate({ constraints: { allowCategories: ["hardware"] } })
    const decision = evaluate({
      envelope: fixture.envelope,
      state: fixture.state,
      proposal: goodProposal(),
      signingKey: TEST_KEY,
      now: NOW,
    })
    expect(decision.code).toBe("CATEGORY_NOT_ALLOWED")
  })

  it("requires an integer amount (AMOUNT_REQUIRED)", () => {
    const { decision } = run({ ...goodProposal(), amount: undefined })
    expect(decision.code).toBe("AMOUNT_REQUIRED")
  })

  it("refuses a non-integer amount (AMOUNT_REQUIRED)", () => {
    const { decision } = run({ ...goodProposal(), amount: 25.5 })
    expect(decision.code).toBe("AMOUNT_REQUIRED")
  })

  it("refuses a zero amount (AMOUNT_NOT_POSITIVE)", () => {
    const { decision } = run({ ...goodProposal(), amount: 0 })
    expect(decision.code).toBe("AMOUNT_NOT_POSITIVE")
  })

  it("refuses a negative amount (AMOUNT_NOT_POSITIVE)", () => {
    const { decision } = run({ ...goodProposal(), amount: -500 })
    expect(decision.code).toBe("AMOUNT_NOT_POSITIVE")
  })

  it("refuses a currency the mandate does not use (CURRENCY_MISMATCH)", () => {
    const { decision } = run({ ...goodProposal(), currency: "USD" })
    expect(decision.code).toBe("CURRENCY_MISMATCH")
  })
})

describe("evaluate — spending limits", () => {
  it("refuses a payment above the per-transaction ceiling", () => {
    const fixture = makeMandate({
      constraints: { maxPerTransaction: EUR(1_000) },
    })
    const decision = evaluate({
      envelope: fixture.envelope,
      state: fixture.state,
      proposal: goodProposal(),
      signingKey: TEST_KEY,
      now: NOW,
    })
    expect(decision.code).toBe("MAX_PER_TRANSACTION_EXCEEDED")
  })

  it("refuses once the transaction count is exhausted", () => {
    const fixture = makeMandate({ constraints: { maxTransactions: 2 } })
    const decision = evaluate({
      envelope: fixture.envelope,
      state: { ...fixture.state, transactionCount: 2 },
      proposal: goodProposal(),
      signingKey: TEST_KEY,
      now: NOW,
    })
    expect(decision.code).toBe("MAX_TRANSACTIONS_EXCEEDED")
  })

  it("refuses a payment that would exceed the remaining budget", () => {
    const fixture = makeMandate()
    const decision = evaluate({
      envelope: fixture.envelope,
      state: { ...fixture.state, spendToDate: EUR(49_000) },
      proposal: goodProposal(),
      signingKey: TEST_KEY,
      now: NOW,
    })
    expect(decision.code).toBe("BUDGET_EXCEEDED")
  })

  it("permits a payment that spends the budget exactly to zero", () => {
    const fixture = makeMandate()
    const decision = evaluate({
      envelope: fixture.envelope,
      state: { ...fixture.state, spendToDate: EUR(47_500) },
      proposal: goodProposal(),
      signingKey: TEST_KEY,
      now: NOW,
    })
    expect(decision.allowed).toBe(true)
  })
})

describe("evaluate — escalation", () => {
  it("escalates rather than denies above the approval threshold", () => {
    const fixture = makeMandate({
      constraints: { requireApprovalAbove: EUR(1_000) },
    })
    const decision = evaluate({
      envelope: fixture.envelope,
      state: fixture.state,
      proposal: goodProposal(),
      signingKey: TEST_KEY,
      now: NOW,
    })
    expect(decision.allowed).toBe(false)
    expect(decision.code).toBe("REQUIRES_HUMAN_APPROVAL")
    expect(decision.requiresApproval).toBe(true)
  })

  it("does not escalate at exactly the threshold", () => {
    const fixture = makeMandate({
      constraints: { requireApprovalAbove: EUR(2_500) },
    })
    const decision = evaluate({
      envelope: fixture.envelope,
      state: fixture.state,
      proposal: goodProposal(),
      signingKey: TEST_KEY,
      now: NOW,
    })
    expect(decision.allowed).toBe(true)
  })
})

describe("evaluate — determinism", () => {
  it("returns identical decisions for identical inputs", () => {
    const a = run(goodProposal()).decision
    const b = run(goodProposal()).decision
    expect(a).toEqual(b)
  })
})
