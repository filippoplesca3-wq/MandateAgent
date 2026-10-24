import { describe, it, expect } from "vitest"
import { z } from "zod"
import { Store } from "../src/core/store.js"
import { guardTools } from "../src/paypal/guard.js"
import { createSimulatedTools, type SimulatedOrder } from "../src/paypal/simulated.js"
import type { ToolExecOptions, ToolLike, ToolSet } from "../src/paypal/tool-types.js"
import type { MandateConstraints } from "../src/core/types.js"
import { TEST_KEY } from "./helpers.js"

const MERCHANT = "acme-supplies"
const OTHER_MERCHANT = "sketchy-deals"
const EXEC: ToolExecOptions = { toolCallId: "test", messages: [] }

interface SetupOptions {
  budget?: number
  constraints?: MandateConstraints
  seedOrders?: SimulatedOrder[]
  extraTools?: ToolSet
  merchantAliases?: Record<string, string>
}

function setup(options: SetupOptions = {}) {
  const store = new Store(TEST_KEY)
  const { envelope } = store.issue({
    principal: "filippo@example.com",
    agentId: "agent-procurement-01",
    budget: { amount: options.budget ?? 50_000, currency: "USD" },
    purpose: "Restock office supplies",
    now: new Date(),
    ...(options.constraints ? { constraints: options.constraints } : {}),
  })

  const raw = {
    ...createSimulatedTools({ merchantId: MERCHANT, ...(options.seedOrders ? { seedOrders: options.seedOrders } : {}) }),
    ...(options.extraTools ?? {}),
  }

  const { tools } = guardTools(raw, {
    store,
    mandateId: envelope.claims.id,
    agentId: "agent-procurement-01",
    merchantId: MERCHANT,
    ...(options.merchantAliases ? { merchantAliases: options.merchantAliases } : {}),
  })

  return { store, mandateId: envelope.claims.id, tools }
}

async function call(tools: ToolSet, name: string, args: unknown): Promise<any> {
  const tool = tools[name]
  if (!tool || typeof tool.execute !== "function") throw new Error(`no tool ${name}`)
  const raw = await tool.execute(args, { ...EXEC, toolCallId: `t-${name}` })
  return typeof raw === "string" ? JSON.parse(raw) : raw
}

function orderArgs(itemCost = 45, quantity = 1) {
  return {
    currencyCode: "USD",
    items: [
      {
        name: "A4 paper",
        quantity,
        itemCost,
        taxPercent: 0,
        itemTotal: itemCost * quantity,
      },
    ],
    shippingCost: 0,
    discount: 0,
  }
}

function remaining(store: Store, mandateId: string): number {
  return store.get(mandateId)!.state.spendToDate.amount
}

describe("guard â€” create_order", () => {
  it("executes an order the mandate permits", async () => {
    const { tools } = setup()
    const result = await call(tools, "create_order", orderArgs(45))
    expect(result.ok).toBe(true)
    expect(result.code).toBe("ALLOWED")
    expect(result.result.id).toMatch(/^ORD\d{14}$/)
  })

  it("does not consume budget for an order that has not been captured", async () => {
    const { store, mandateId, tools } = setup()
    await call(tools, "create_order", orderArgs(45))
    expect(remaining(store, mandateId)).toBe(0)
  })

  it("refuses an order above the budget without calling PayPal", async () => {
    const { store, mandateId, tools } = setup({ budget: 1_000 })
    const result = await call(tools, "create_order", orderArgs(45))
    expect(result.ok).toBe(false)
    expect(result.code).toBe("BUDGET_EXCEEDED")
    expect(result.result).toBeUndefined()
    expect(store.ledger.list()).toHaveLength(1)
    expect(store.ledger.list()[0]?.decision.code).toBe("BUDGET_EXCEEDED")
  })

  it("refuses an order above the per-transaction ceiling", async () => {
    const { tools } = setup({
      constraints: { maxPerTransaction: { amount: 2_000, currency: "USD" } },
    })
    const result = await call(tools, "create_order", orderArgs(45))
    expect(result.code).toBe("MAX_PER_TRANSACTION_EXCEEDED")
  })

  it("refuses a merchant on the deny list", async () => {
    const { tools } = setup({ constraints: { denyMerchants: [MERCHANT] } })
    const result = await call(tools, "create_order", orderArgs(45))
    expect(result.code).toBe("MERCHANT_DENIED")
  })

  it("computes tax and shipping into the enforced total", async () => {
    const { store, mandateId, tools } = setup({ budget: 10_000 })
    await call(tools, "create_order", {
      currencyCode: "USD",
      items: [{ name: "Cable", quantity: 2, itemCost: 10, taxPercent: 10, itemTotal: 22 }],
      shippingCost: 5,
      discount: 1,
    })
    const last = store.ledger.list()[0]
    expect(last?.proposal.amount).toBe(2_600)
    expect(remaining(store, mandateId)).toBe(0)
  })
})

describe("guard â€” pay_order", () => {
  const seed = (amount: number, merchant = MERCHANT): SimulatedOrder[] => [
    { id: "ORD00000000000001", status: "CREATED", amount, currency: "USD", merchant },
  ]

  it("captures an order and consumes the mandate budget", async () => {
    const { store, mandateId, tools } = setup({ seedOrders: seed(2_500) })
    const result = await call(tools, "pay_order", { id: "ORD00000000000001" })
    expect(result.ok).toBe(true)
    expect(result.result.status).toBe("COMPLETED")
    expect(remaining(store, mandateId)).toBe(2_500)
    expect(store.get(mandateId)?.state.transactionCount).toBe(1)
  })

  it("enforces the order's real amount, not anything the agent claims", async () => {
    const { store, mandateId, tools } = setup({ budget: 3_000, seedOrders: seed(4_000) })
    const result = await call(tools, "pay_order", { id: "ORD00000000000001", amount: 1 })
    expect(result.ok).toBe(false)
    expect(result.code).toBe("BUDGET_EXCEEDED")
    expect(remaining(store, mandateId)).toBe(0)
  })

  it("refuses an order belonging to a merchant outside the allowlist", async () => {
    const { tools } = setup({
      seedOrders: seed(1_000, OTHER_MERCHANT),
      constraints: { allowMerchants: [MERCHANT] },
    })
    const result = await call(tools, "pay_order", { id: "ORD00000000000001" })
    expect(result.ok).toBe(false)
    expect(result.code).toBe("MERCHANT_NOT_ALLOWED")
  })

  it("refuses an order once the budget is spent", async () => {
    const { store, mandateId, tools } = setup({
      budget: 4_000,
      seedOrders: [
        { id: "ORD00000000000001", status: "CREATED", amount: 2_500, currency: "USD", merchant: MERCHANT },
        { id: "ORD00000000000002", status: "CREATED", amount: 2_500, currency: "USD", merchant: MERCHANT },
      ],
    })

    const first = await call(tools, "pay_order", { id: "ORD00000000000001" })
    expect(first.ok).toBe(true)
    expect(remaining(store, mandateId)).toBe(2_500)

    const second = await call(tools, "pay_order", { id: "ORD00000000000002" })
    expect(second.ok).toBe(false)
    expect(second.code).toBe("BUDGET_EXCEEDED")
    expect(remaining(store, mandateId)).toBe(2_500)
  })

  it("does not commit budget twice when PayPal rejects a capture", async () => {
    const { store, mandateId, tools } = setup({ seedOrders: seed(4_000) })
    await call(tools, "pay_order", { id: "ORD00000000000001" })
    expect(remaining(store, mandateId)).toBe(4_000)

    const again = await call(tools, "pay_order", { id: "ORD00000000000001" })
    expect(again.ok).toBe(false)
    expect(again.code).toBe("TOOL_ERROR")
    expect(remaining(store, mandateId)).toBe(4_000)
  })
})

describe("guard — live toolkit responses", () => {
  const LIVE_ORDER = "ORDLIVE00000000001"
  const LIVE_MERCHANT_ID = "HM98ZL79EKJ6Q"

  function liveTools(capture: unknown): ToolSet {
    return {
      get_order: {
        parameters: z.object({ id: z.string() }),
        // The real toolkit returns JSON text from get_order, not an object.
        execute: async () =>
          JSON.stringify({
            id: LIVE_ORDER,
            status: "APPROVED",
            purchase_units: [
              {
                amount: { currency_code: "USD", value: "2.00" },
                payee: { merchant_id: LIVE_MERCHANT_ID },
              },
            ],
          }),
      },
      pay_order: {
        parameters: z.object({ id: z.string() }),
        execute: async () => capture,
      },
    }
  }

  it("reads a JSON-string order and maps PayPal's merchant id to the mandate's name", async () => {
    const { store, mandateId, tools } = setup({
      constraints: { allowMerchants: [MERCHANT] },
      extraTools: liveTools(JSON.stringify({ id: LIVE_ORDER, status: "COMPLETED" })),
      merchantAliases: { [LIVE_MERCHANT_ID.toLowerCase()]: MERCHANT },
    })

    const result = await call(tools, "pay_order", { id: LIVE_ORDER })
    expect(result.ok).toBe(true)
    expect(result.code).toBe("ALLOWED")
    expect(remaining(store, mandateId)).toBe(200)

    const entry = store.ledger.list()[0]
    expect(entry?.proposal.amount).toBe(200)
    expect(entry?.proposal.merchant).toBe(MERCHANT)
  })

  it("treats a PayPal error delivered as JSON text as a failed call, not a capture", async () => {
    const { store, mandateId, tools } = setup({
      seedOrders: [
        { id: LIVE_ORDER, status: "CREATED", amount: 4_000, currency: "USD", merchant: MERCHANT },
      ],
      extraTools: liveTools(
        JSON.stringify({
          error: { issue: "INSTRUMENT_DECLINED", description: "The instrument was declined." },
        }),
      ),
    })

    const result = await call(tools, "pay_order", { id: LIVE_ORDER })
    expect(result.ok).toBe(false)
    expect(result.code).toBe("TOOL_ERROR")
    expect(result.reason).toContain("declined")
    expect(remaining(store, mandateId)).toBe(0)
  })

  it("treats the live toolkit's own { ok: false } envelope as a failed call", async () => {
    const { store, mandateId, tools } = setup({
      seedOrders: [
        { id: LIVE_ORDER, status: "CREATED", amount: 4_000, currency: "USD", merchant: MERCHANT },
      ],
      extraTools: liveTools(
        JSON.stringify({
          ok: false,
          status: 422,
          code: "PAYPAL_API_HTTP_ERROR",
          message: "Payer has not yet approved the Order for payment.",
        }),
      ),
    })

    const result = await call(tools, "pay_order", { id: LIVE_ORDER })
    expect(result.ok).toBe(false)
    expect(result.code).toBe("TOOL_ERROR")
    expect(result.reason).toContain("not yet approved")
    expect(remaining(store, mandateId)).toBe(0)
  })
})

describe("guard — escalation", () => {
  it("parks a payment above the approval threshold instead of executing it", async () => {
    const { store, tools } = setup({
      constraints: { requireApprovalAbove: { amount: 1_000, currency: "USD" } },
    })
    const result = await call(tools, "create_order", orderArgs(45))
    expect(result.ok).toBe(false)
    expect(result.code).toBe("REQUIRES_HUMAN_APPROVAL")
    expect(result.approvalId).toMatch(/^[0-9a-f-]{36}$/)
    expect(store.listPending()).toHaveLength(1)
    expect(store.ledger.list().length).toBe(1)
  })

  it("releases the parked payment once a human approves it", async () => {
    const { store, mandateId, tools } = setup({
      constraints: { requireApprovalAbove: { amount: 1_000, currency: "USD" } },
      seedOrders: [
        { id: "ORD00000000000001", status: "CREATED", amount: 4_500, currency: "USD", merchant: MERCHANT },
      ],
    })

    const first = await call(tools, "pay_order", { id: "ORD00000000000001" })
    expect(first.code).toBe("REQUIRES_HUMAN_APPROVAL")
    expect(remaining(store, mandateId)).toBe(0)

    const pending = store.listPending()[0]
    expect(pending).toBeDefined()
    store.resolveApproval(pending!.id, true)

    const second = await call(tools, "pay_order", { id: "ORD00000000000001" })
    expect(second.ok).toBe(true)
    expect(second.code).toBe("ALLOWED")
    expect(remaining(store, mandateId)).toBe(4_500)
    expect(store.listPending()).toHaveLength(0)
    // Consumed, not merely marked: the approval is gone.
    expect(store.listApprovals().find((item) => item.id === pending!.id)).toBeUndefined()
  })

  it("spends an approval on exactly one payment", async () => {
    const { store, mandateId, tools } = setup({
      constraints: { requireApprovalAbove: { amount: 1_000, currency: "USD" } },
      seedOrders: [
        { id: "ORD00000000000001", status: "CREATED", amount: 4_500, currency: "USD", merchant: MERCHANT },
        { id: "ORD00000000000002", status: "CREATED", amount: 4_500, currency: "USD", merchant: MERCHANT },
      ],
    })

    const parked = await call(tools, "pay_order", { id: "ORD00000000000001" })
    store.resolveApproval(parked.approvalId, true)

    const approved = await call(tools, "pay_order", { id: "ORD00000000000001" })
    expect(approved.code).toBe("ALLOWED")

    // A second, identical payment is not covered by the approval that was
    // already spent, so it goes back to the human rather than through.
    const next = await call(tools, "pay_order", { id: "ORD00000000000002" })
    expect(next.code).toBe("REQUIRES_HUMAN_APPROVAL")
    expect(remaining(store, mandateId)).toBe(4_500)
  })

  it("does not release a payment the human never saw", async () => {
    const { store, tools } = setup({
      constraints: { requireApprovalAbove: { amount: 1_000, currency: "USD" } },
      seedOrders: [
        { id: "ORD00000000000001", status: "CREATED", amount: 4_500, currency: "USD", merchant: MERCHANT },
        { id: "ORD00000000000002", status: "CREATED", amount: 2_500, currency: "USD", merchant: MERCHANT },
      ],
    })

    const parked = await call(tools, "pay_order", { id: "ORD00000000000001" })
    store.resolveApproval(parked.approvalId, true)

    // Same action and merchant, different amount: the approval is bound to
    // the amount the human actually approved.
    const other = await call(tools, "pay_order", { id: "ORD00000000000002" })
    expect(other.code).toBe("REQUIRES_HUMAN_APPROVAL")
    expect(other.approvalId).not.toBe(parked.approvalId)
  })

  it("refuses to release a payment the human rejected", async () => {
    const { store, tools } = setup({
      constraints: { requireApprovalAbove: { amount: 1_000, currency: "USD" } },
      seedOrders: [
        { id: "ORD00000000000001", status: "CREATED", amount: 4_500, currency: "USD", merchant: MERCHANT },
      ],
    })

    const parked = await call(tools, "pay_order", { id: "ORD00000000000001" })
    store.resolveApproval(parked.approvalId, false)

    const retry = await call(tools, "pay_order", { id: "ORD00000000000001" })
    expect(retry.ok).toBe(false)
    expect(retry.code).toBe("REQUIRES_HUMAN_APPROVAL")
  })
})

describe("guard â€” mandate validity", () => {
  it("blocks even read tools once the mandate is revoked", async () => {
    const { store, mandateId, tools } = setup()
    store.revoke(mandateId)
    const result = await call(tools, "list_transactions", {})
    expect(result.ok).toBe(false)
    expect(result.code).toBe("MANDATE_REVOKED")
  })

  it("permits read tools without recording them by default", async () => {
    const { store, tools } = setup()
    const result = await call(tools, "list_transactions", {})
    expect(result.ok).toBe(true)
    expect(store.ledger.list()).toHaveLength(0)
  })

  it("refuses a tool that is not on the policy allowlist", async () => {
    const drain: ToolLike = {
      description: "not a PayPal tool",
      parameters: z.object({}),
      execute: async () => ({ drained: true }),
    }
    const { tools } = setup({ extraTools: { drain_wallet: drain } })
    const result = await call(tools, "drain_wallet", {})
    expect(result.ok).toBe(false)
    expect(result.code).toBe("ACTION_NOT_PERMITTED")
  })

  it("refuses a spend tool with no resolvable amount rather than guessing", async () => {
    const { tools } = setup()
    const result = await call(tools, "create_refund", { capture_id: "CAP-1" })
    expect(result.ok).toBe(false)
    expect(result.code).toBe("AMOUNT_REQUIRED")
  })
})

describe("guard â€” ledger integrity", () => {
  it("records the resolved amount on every spend decision", async () => {
    const { store, tools } = setup({
      seedOrders: [
        { id: "ORD00000000000001", status: "CREATED", amount: 2_500, currency: "USD", merchant: MERCHANT },
      ],
    })
    await call(tools, "pay_order", { id: "ORD00000000000001" })
    const entry = store.ledger.list()[0]
    expect(entry?.proposal.amount).toBe(2_500)
    expect(entry?.proposal.currency).toBe("USD")
    expect(entry?.externalRef).toBe("ORD00000000000001")
    expect(entry?.decision.allowed).toBe(true)
  })
})
