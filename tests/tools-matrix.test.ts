/**
 * Every tool in the PayPal toolkit goes through the guard.
 *
 * The point is coverage, not depth: the guard must have an opinion about all
 * 47 tools, and that opinion must match the policy table. A tool that is
 * neither classified nor denied is how an agent quietly gains authority.
 */

import { describe, expect, it } from "vitest"
import { TOOL_CLASSES, toolClassOf } from "../src/core/policy.js"
import { Store } from "../src/core/store.js"
import { guardTools } from "../src/paypal/guard.js"
import { createSimulatedTools } from "../src/paypal/simulated.js"
import { TEST_KEY } from "./helpers.js"

const MERCHANT = "acme-supplies"
const AGENT = "agent-procurement-01"
const exec = { toolCallId: "matrix", messages: [] }

function setup() {
  const store = new Store(TEST_KEY)
  const { envelope } = store.issue({
    principal: "filippo@example.com",
    agentId: AGENT,
    budget: { amount: 12_000, currency: "USD" },
    purpose: "Exercise every tool",
    constraints: {
      allowMerchants: [MERCHANT],
      maxPerTransaction: { amount: 5_000, currency: "USD" },
      requireApprovalAbove: { amount: 4_000, currency: "USD" },
    },
  })

  const raw = createSimulatedTools({ merchantId: MERCHANT })
  const { tools } = guardTools(raw, {
    store,
    mandateId: envelope.claims.id,
    agentId: AGENT,
    merchantId: MERCHANT,
    recordReads: true,
  })

  return { store, tools, raw }
}

describe("all 47 PayPal tools", () => {
  it("the toolkit and the policy table cover the same names", () => {
    const names = Object.keys(createSimulatedTools({ merchantId: MERCHANT })).sort()
    expect(names).toHaveLength(47)
    expect(names).toEqual(Object.keys(TOOL_CLASSES).sort())

    const counts = { read: 0, spend: 0, mutate: 0 }
    for (const name of names) {
      const clazz = toolClassOf(name)
      expect(clazz).not.toBeNull()
      if (clazz) counts[clazz] += 1
    }
    expect(counts).toEqual({ read: 18, spend: 9, mutate: 20 })
  })

  it("puts every tool through the guard and applies its class", async () => {
    const { store, tools } = setup()
    const names = Object.keys(tools).sort()

    for (const name of names) {
      const clazz = toolClassOf(name)
      const tool = tools[name]
      expect(tool?.execute).toBeTypeOf("function")
      await tool!.execute!({}, exec)

      const entry = store.ledger.list()[0]
      expect(entry, `${name} produced no ledger entry`).toBeDefined()
      expect(entry?.action).toBe(name)

      if (clazz === "spend") {
        // No amount was supplied, so nothing may reach PayPal.
        expect(entry?.decision.allowed, `${name} was executed without an amount`).toBe(false)
        // Whichever check fires first, a spend tool with no amount is denied.
        expect(["AMOUNT_REQUIRED", "MERCHANT_REQUIRED"]).toContain(entry?.decision.code)
        expect(entry?.decision.requiresApproval).not.toBe(true)
      } else {
        expect(entry?.decision.allowed, `${name} was refused on a valid mandate`).toBe(true)
      }
    }

    expect(store.ledger.list()).toHaveLength(47)
  })

  it("refuses a tool that is not on the allowlist, without calling it", async () => {
    const store = new Store(TEST_KEY)
    const { envelope } = store.issue({
      principal: "filippo@example.com",
      agentId: AGENT,
      budget: { amount: 1_000, currency: "USD" },
      purpose: "Allowlist test",
    })

    let called = false
    const raw = {
      delete_everything: {
        description: "not a PayPal tool",
        parameters: {},
        execute: async () => {
          called = true
          return { ok: true }
        },
      },
    }

    const { tools } = guardTools(raw, {
      store,
      mandateId: envelope.claims.id,
      agentId: AGENT,
      merchantId: MERCHANT,
    })

    const output = await tools["delete_everything"]!.execute!({}, exec)
    const result = JSON.parse(String(output)) as { ok: boolean; code: string }
    expect(result.ok).toBe(false)
    expect(result.code).toBe("ACTION_NOT_PERMITTED")
    expect(called).toBe(false)
    expect(store.ledger.list()[0]?.decision.code).toBe("ACTION_NOT_PERMITTED")
  })
})
