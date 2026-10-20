/**
 * Contract tests between the simulator and the real toolkit.
 *
 * The simulator replaces `execute` but keeps the toolkit's own parameter
 * schemas. That is only useful if the values it returns also satisfy the
 * schemas of the tools that consume them — an order id handed back by
 * `create_order` must pass `pay_order`'s validation, or the agent is blocked
 * by schema validation before the guard ever sees the call.
 *
 * This was a real bug: simulated ids were readable but not PayPal-shaped, and
 * every capture was rejected before enforcement ran. These tests pin the
 * contract against the genuine schemas so it cannot regress silently.
 */

import { describe, it, expect } from "vitest"
import { ALL_TOOLS_ENABLED, PayPalAgentToolkit } from "@paypal/agent-toolkit/ai-sdk"
import { createSimulatedTools } from "../src/paypal/simulated.js"
import type { ToolExecOptions, ToolSet } from "../src/paypal/tool-types.js"

const toolkit = new PayPalAgentToolkit({
  clientId: "schema-probe",
  clientSecret: "schema-probe",
  configuration: { actions: ALL_TOOLS_ENABLED, context: { sandbox: true } },
})

const realSchemas = toolkit.getTools() as unknown as Record<
  string,
  { parameters: { parse: (value: unknown) => unknown } }
>

const EXEC: ToolExecOptions = { toolCallId: "contract", messages: [] }

async function run(tools: ToolSet, name: string, args: unknown): Promise<any> {
  const tool = tools[name]
  if (!tool?.execute) throw new Error(`no tool ${name}`)
  return tool.execute(args, EXEC)
}

const orderInput = {
  currencyCode: "USD",
  items: [{ name: "A4 paper", quantity: 2, itemCost: 12, taxPercent: 0, itemTotal: 24 }],
}

describe("simulated ids satisfy the real PayPal schemas", () => {
  it("passes create_order's id to pay_order's validator", async () => {
    const tools = createSimulatedTools()
    const created = await run(tools, "create_order", orderInput)
    expect(() => realSchemas["pay_order"]!.parameters.parse({ id: created.id })).not.toThrow()
  })

  it("passes create_order's id to get_order's validator", async () => {
    const tools = createSimulatedTools()
    const created = await run(tools, "create_order", orderInput)
    expect(() => realSchemas["get_order"]!.parameters.parse({ id: created.id })).not.toThrow()
  })

  it("passes the capture id to create_refund's validator", async () => {
    const tools = createSimulatedTools()
    const created = await run(tools, "create_order", orderInput)
    const paid = await run(tools, "pay_order", { id: created.id })
    const captureId = paid.purchase_units[0].payments.captures[0].id
    expect(() =>
      realSchemas["create_refund"]!.parameters.parse({ capture_id: captureId }),
    ).not.toThrow()
  })

  it("keeps every id it mints inside PayPal's id shape", async () => {
    const tools = createSimulatedTools()
    const created = await run(tools, "create_order", orderInput)
    expect(created.id).toMatch(/^[A-Z0-9]{17,32}$/)

    const paid = await run(tools, "pay_order", { id: created.id })
    const captureId = paid.purchase_units[0].payments.captures[0].id
    expect(captureId).toMatch(/^[A-Z0-9]{17,32}$/)
  })

  it("seeds orders whose ids the real schemas accept", async () => {
    const seedId = "ORD00000000009001"
    const tools = createSimulatedTools({
      seedOrders: [
        { id: seedId, status: "CREATED", amount: 9_900, currency: "USD", merchant: "sketchy-deals" },
      ],
    })
    expect(() => realSchemas["pay_order"]!.parameters.parse({ id: seedId })).not.toThrow()
    const fetched = await run(tools, "get_order", { id: seedId })
    expect(fetched.id).toBe(seedId)
  })
})

describe("simulated tools mirror the real argument schemas", () => {
  it("accepts the same create_order arguments the real schema does", () => {
    expect(() => realSchemas["create_order"]!.parameters.parse(orderInput)).not.toThrow()
  })

  it("computes the same total the toolkit would charge", async () => {
    const tools = createSimulatedTools()
    const created = await run(tools, "create_order", {
      currencyCode: "USD",
      items: [{ name: "Cable", quantity: 2, itemCost: 10, taxPercent: 10, itemTotal: 22 }],
      shippingCost: 5,
      discount: 1,
    })
    // 2 * 10 + 10% tax on 20 + 5 shipping - 1 discount = 26.00
    expect(created.purchase_units[0].amount.value).toBe("26.00")
  })
})
