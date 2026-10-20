import { describe, it, expect, vi } from "vitest"
import { Ledger } from "../src/core/ledger.js"
import type { Decision } from "../src/core/types.js"

function allowed(): Decision {
  return {
    allowed: true,
    code: "ALLOWED",
    reason: "permitted",
    checks: [{ rule: "signature", passed: true, detail: "ok" }],
  }
}

function refused(code: Decision["code"], requiresApproval = false): Decision {
  return {
    allowed: false,
    code,
    reason: "refused",
    checks: [{ rule: "budget", passed: false, detail: "refused" }],
    ...(requiresApproval ? { requiresApproval: true } : {}),
  }
}

function append(ledger: Ledger, decision: Decision, action = "create_order") {
  return ledger.append({
    mandateId: "m-1",
    agentId: "agent-1",
    action,
    proposal: { action, amount: 100, currency: "EUR" },
    decision,
  })
}

describe("Ledger", () => {
  it("stamps every entry with an id and timestamp", () => {
    const ledger = new Ledger()
    const entry = append(ledger, allowed())
    expect(entry.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(Date.parse(entry.at)).not.toBeNaN()
  })

  it("returns entries newest first", () => {
    const ledger = new Ledger()
    const first = append(ledger, allowed(), "create_order")
    const second = append(ledger, allowed(), "pay_order")
    expect(ledger.list().map((entry) => entry.id)).toEqual([second.id, first.id])
  })

  it("omits optional fields that were not provided", () => {
    const ledger = new Ledger()
    const entry = append(ledger, allowed())
    expect("externalRef" in entry).toBe(false)
    expect("result" in entry).toBe(false)
  })

  it("keeps optional fields that were provided", () => {
    const ledger = new Ledger()
    const entry = ledger.append({
      mandateId: "m-1",
      agentId: "agent-1",
      action: "create_order",
      proposal: { action: "create_order", amount: 100, currency: "EUR" },
      decision: allowed(),
      externalRef: "ORDER-123",
      result: '{"status":"CREATED"}',
    })
    expect(entry.externalRef).toBe("ORDER-123")
    expect(entry.result).toBe('{"status":"CREATED"}')
  })

  it("records refusals, which are the evidence the mandate was enforced", () => {
    const ledger = new Ledger()
    append(ledger, refused("BUDGET_EXCEEDED"))
    expect(ledger.list()[0]?.decision.allowed).toBe(false)
  })

  it("summarises allowed, denied and escalated entries separately", () => {
    const ledger = new Ledger()
    append(ledger, allowed())
    append(ledger, allowed())
    append(ledger, refused("BUDGET_EXCEEDED"))
    append(ledger, refused("MERCHANT_DENIED"))
    append(ledger, refused("REQUIRES_HUMAN_APPROVAL", true))

    const summary = ledger.summary()
    expect(summary.total).toBe(5)
    expect(summary.allowed).toBe(2)
    expect(summary.denied).toBe(2)
    expect(summary.pendingApproval).toBe(1)
    expect(summary.denialReasons["BUDGET_EXCEEDED"]).toBe(1)
    expect(summary.denialReasons["MERCHANT_DENIED"]).toBe(1)
    expect(summary.denialReasons["REQUIRES_HUMAN_APPROVAL"]).toBe(1)
  })

  it("notifies subscribers of new entries", () => {
    const ledger = new Ledger()
    const seen = vi.fn()
    ledger.subscribe(seen)
    append(ledger, allowed())
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it("stops notifying after unsubscribe", () => {
    const ledger = new Ledger()
    const seen = vi.fn()
    const unsubscribe = ledger.subscribe(seen)
    append(ledger, allowed())
    unsubscribe()
    append(ledger, allowed())
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it("survives a subscriber that throws", () => {
    const ledger = new Ledger()
    ledger.subscribe(() => {
      throw new Error("broken subscriber")
    })
    const seen = vi.fn()
    ledger.subscribe(seen)
    expect(() => append(ledger, allowed())).not.toThrow()
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it("clears its entries", () => {
    const ledger = new Ledger()
    append(ledger, allowed())
    ledger.clear()
    expect(ledger.list()).toHaveLength(0)
  })
})
