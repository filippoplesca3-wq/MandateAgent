import { describe, it, expect } from "vitest"
import { Store } from "../src/core/store.js"
import { guardTools } from "../src/paypal/guard.js"
import { createSimulatedTools, type SimulatedOrder } from "../src/paypal/simulated.js"
import type { ToolExecOptions, ToolSet } from "../src/paypal/tool-types.js"
import { TEST_KEY } from "./helpers.js"

const MERCHANT = "acme-supplies"
const EXEC: ToolExecOptions = { toolCallId: "test", messages: [] }

function setup(budget: number, seedOrders: SimulatedOrder[]) {
  const store = new Store(TEST_KEY)
  const { envelope } = store.issue({
    principal: "filippo@example.com",
    agentId: "agent-procurement-01",
    budget: { amount: budget, currency: "USD" },
    purpose: "Restock office supplies",
    now: new Date(),
  })

  const { tools } = guardTools(createSimulatedTools({ merchantId: MERCHANT, seedOrders }), {
    store,
    mandateId: envelope.claims.id,
    agentId: "agent-procurement-01",
    merchantId: MERCHANT,
  })

  return { store, mandateId: envelope.claims.id, tools }
}

async function call(tools: ToolSet, name: string, args: unknown): Promise<any> {
  const tool = tools[name]
  if (!tool || typeof tool.execute !== "function") throw new Error(`no tool ${name}`)
  const raw = await tool.execute(args, { ...EXEC, toolCallId: `t-${name}` })
  return typeof raw === "string" ? JSON.parse(raw) : raw
}

function order(id: string, amount: number, status: SimulatedOrder["status"] = "CREATED"): SimulatedOrder {
  return { id, status, amount, currency: "USD", merchant: MERCHANT }
}

describe("budget reservations", () => {
  it("lets only one of two concurrent payments through when both fit alone", async () => {
    const { store, mandateId, tools } = setup(6_000, [
      order("ORD00000000000001", 5_000),
      order("ORD00000000000002", 5_000),
    ])

    const [a, b] = await Promise.all([
      call(tools, "pay_order", { id: "ORD00000000000001" }),
      call(tools, "pay_order", { id: "ORD00000000000002" }),
    ])

    const results = [a, b]
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.filter((result) => result.code === "BUDGET_EXCEEDED")).toHaveLength(1)

    const state = store.get(mandateId)!.state
    expect(state.spendToDate.amount).toBe(5_000)
    expect(state.reservedToDate.amount).toBe(0)
    expect(store.effectiveRemaining(mandateId)?.amount).toBe(1_000)
  })

  it("releases the reservation when the payment fails", async () => {
    const { store, mandateId, tools } = setup(10_000, [
      order("ORD00000000000001", 2_500, "COMPLETED"),
    ])

    const result = await call(tools, "pay_order", { id: "ORD00000000000001" })
    expect(result.ok).toBe(false)
    expect(result.code).toBe("TOOL_ERROR")

    const state = store.get(mandateId)!.state
    expect(state.spendToDate.amount).toBe(0)
    expect(state.reservedToDate.amount).toBe(0)
    expect(store.effectiveRemaining(mandateId)?.amount).toBe(10_000)
  })

  it("does not reserve budget for a payment the policy refuses", async () => {
    const { store, mandateId, tools } = setup(1_000, [order("ORD00000000000001", 5_000)])

    const result = await call(tools, "pay_order", { id: "ORD00000000000001" })
    expect(result.code).toBe("BUDGET_EXCEEDED")
    expect(store.get(mandateId)!.state.reservedToDate.amount).toBe(0)
  })
})
