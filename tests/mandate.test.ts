import { describe, it, expect } from "vitest"
import {
  issueMandate,
  newMandateState,
  remainingBudget,
  revokeMandate,
  signClaims,
  validateClaims,
  verifySignature,
} from "../src/core/mandate.js"
import { EUR, TEST_KEY, makeMandate } from "./helpers.js"

describe("issueMandate", () => {
  it("produces an envelope signed with HMAC-SHA256", () => {
    const { envelope } = makeMandate()
    expect(envelope.algorithm).toBe("HMAC-SHA256")
    expect(envelope.signature).toMatch(/^[0-9a-f]{64}$/)
  })

  it("defaults expiry to 24 hours after issue", () => {
    const now = new Date("2026-01-01T00:00:00.000Z")
    const { envelope } = makeMandate({ now })
    expect(envelope.claims.expiresAt).toBe("2026-01-02T00:00:00.000Z")
  })

  it("rejects a non-integer budget", () => {
    expect(() =>
      issueMandate(
        {
          principal: "p",
          agentId: "a",
          budget: { amount: 10.5, currency: "EUR" },
          purpose: "x",
        },
        TEST_KEY,
      ),
    ).toThrow(/integer/i)
  })

  it("rejects a zero budget", () => {
    expect(() =>
      issueMandate({ principal: "p", agentId: "a", budget: EUR(0), purpose: "x" }, TEST_KEY),
    ).toThrow(/positive/i)
  })

  it("rejects an expiry in the past", () => {
    expect(() =>
      issueMandate(
        {
          principal: "p",
          agentId: "a",
          budget: EUR(100),
          purpose: "x",
          now: new Date("2026-01-01T00:00:00.000Z"),
          expiresAt: "2025-12-31T00:00:00.000Z",
        },
        TEST_KEY,
      ),
    ).toThrow(/future/i)
  })

  it("gives every mandate a unique id and nonce", () => {
    const a = makeMandate().envelope.claims
    const b = makeMandate().envelope.claims
    expect(a.id).not.toBe(b.id)
    expect(a.nonce).not.toBe(b.nonce)
  })
})

describe("verifySignature", () => {
  it("accepts an untampered envelope", () => {
    const { envelope } = makeMandate()
    expect(verifySignature(envelope, TEST_KEY)).toEqual({
      valid: true,
      reason: "signature verified",
    })
  })

  it("rejects the envelope after the budget is raised", () => {
    const { envelope } = makeMandate()
    const forged = {
      ...envelope,
      claims: { ...envelope.claims, budget: EUR(9_000_000) },
    }
    const result = verifySignature(forged, TEST_KEY)
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/does not match/)
  })

  it("rejects the envelope after the expiry is extended", () => {
    const { envelope } = makeMandate()
    const forged = {
      ...envelope,
      claims: { ...envelope.claims, expiresAt: "2099-01-01T00:00:00.000Z" },
    }
    expect(verifySignature(forged, TEST_KEY).valid).toBe(false)
  })

  it("rejects the envelope after the agent id is swapped", () => {
    const { envelope } = makeMandate()
    const forged = {
      ...envelope,
      claims: { ...envelope.claims, agentId: "agent-attacker" },
    }
    expect(verifySignature(forged, TEST_KEY).valid).toBe(false)
  })

  it("rejects an envelope signed with a different key", () => {
    const { envelope } = makeMandate()
    expect(verifySignature(envelope, "a-completely-different-key").valid).toBe(false)
  })

  it("is stable under a JSON round-trip of the envelope", () => {
    const { envelope } = makeMandate()
    const roundTripped = JSON.parse(JSON.stringify(envelope))
    expect(verifySignature(roundTripped, TEST_KEY).valid).toBe(true)
  })

  it("rejects a malformed envelope without throwing", () => {
    expect(verifySignature({} as never, TEST_KEY).valid).toBe(false)
    expect(verifySignature({ claims: {}, signature: "" } as never, TEST_KEY).valid).toBe(false)
  })
})

describe("signClaims", () => {
  it("produces the same digest for reordered but equal claims", () => {
    const { envelope } = makeMandate()
    const reordered = {
      nonce: envelope.claims.nonce,
      purpose: envelope.claims.purpose,
      constraints: envelope.claims.constraints,
      budget: envelope.claims.budget,
      expiresAt: envelope.claims.expiresAt,
      issuedAt: envelope.claims.issuedAt,
      agentId: envelope.claims.agentId,
      principal: envelope.claims.principal,
      id: envelope.claims.id,
    }
    expect(signClaims(reordered, TEST_KEY)).toBe(envelope.signature)
  })
})

describe("validateClaims", () => {
  it("accepts a fresh mandate", () => {
    const { envelope } = makeMandate()
    const now = new Date("2026-01-01T12:00:00.000Z")
    expect(validateClaims(envelope.claims, now).valid).toBe(true)
  })

  it("refuses a mandate once it has expired", () => {
    const { envelope } = makeMandate()
    const now = new Date("2026-01-02T00:00:00.001Z")
    const result = validateClaims(envelope.claims, now)
    expect(result.valid).toBe(false)
    expect(result.reason).toMatch(/expired/)
  })

  it("refuses an unparseable expiry", () => {
    const { envelope } = makeMandate()
    const broken = { ...envelope.claims, expiresAt: "not-a-date" }
    expect(validateClaims(broken).valid).toBe(false)
  })
})

describe("remainingBudget", () => {
  it("reports the full budget before any spend", () => {
    const { envelope, state } = makeMandate()
    expect(remainingBudget(envelope.claims, state)).toEqual(EUR(50_000))
  })

  it("subtracts committed spend", () => {
    const { envelope, state } = makeMandate()
    const spent = { ...state, spendToDate: EUR(12_000) }
    expect(remainingBudget(envelope.claims, spent)).toEqual(EUR(38_000))
  })

  it("never goes negative even if spend somehow exceeds the budget", () => {
    const { envelope, state } = makeMandate()
    const overspent = { ...state, spendToDate: EUR(900_000) }
    expect(remainingBudget(envelope.claims, overspent)).toEqual(EUR(0))
  })
})

describe("revokeMandate", () => {
  it("stamps a revocation time and leaves the rest of the state alone", () => {
    const { state } = makeMandate()
    const revoked = revokeMandate(state, new Date("2026-01-01T06:00:00.000Z"))
    expect(revoked.revokedAt).toBe("2026-01-01T06:00:00.000Z")
    expect(revoked.spendToDate).toEqual(state.spendToDate)
    expect(revoked.mandateId).toBe(state.mandateId)
  })

  it("does not mutate the original state", () => {
    const { state } = makeMandate()
    revokeMandate(state)
    expect(state.revokedAt).toBeNull()
  })
})

describe("newMandateState", () => {
  it("starts with zero spend and no revocation", () => {
    expect(newMandateState("m-1", "EUR")).toEqual({
      mandateId: "m-1",
      revokedAt: null,
      spendToDate: { amount: 0, currency: "EUR" },
      transactionCount: 0,
    })
  })
})
