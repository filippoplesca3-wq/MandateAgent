/**
 * Simulated PayPal.
 *
 * The suite is built from the real `@paypal/agent-toolkit` tool definitions, so
 * parameter schemas, names and argument shapes are identical to production.
 * Only `execute` is replaced.
 *
 * That matters for two reasons. Schema parity means the agent behaves the same
 * way in simulation and against a sandbox, and it means the policy guard is
 * exercised against the real argument shapes rather than a convenient fiction.
 *
 * Simulation is used when PayPal sandbox credentials are absent, so a judge (or
 * a developer) can run the whole product, including enforcement, without
 * signing up for anything. The UI marks the mode clearly.
 */

import type { ToolLike, ToolSet } from "./tool-types.js"
import { PayPalAgentToolkit, ALL_TOOLS_ENABLED } from "@paypal/agent-toolkit/ai-sdk"

export interface SimulatedOrder {
  id: string
  status: "CREATED" | "COMPLETED"
  /** Minor units. */
  amount: number
  currency: string
  merchant: string
  captureId?: string
}

export interface SimulatedOptions {
  /** Orders that already exist, e.g. one belonging to a different merchant. */
  seedOrders?: SimulatedOrder[]
  /** Merchant that `create_order` creates orders for. */
  merchantId?: string
}

const DEFAULT_MERCHANT = "acme-supplies"

export function createSimulatedTools(options: SimulatedOptions = {}): ToolSet {
  const merchantId = options.merchantId ?? DEFAULT_MERCHANT

  // Constructing the toolkit does no I/O; it is just a registry of actions.
  const toolkit = new PayPalAgentToolkit({
    clientId: "simulated-client",
    clientSecret: "simulated-secret",
    configuration: { actions: ALL_TOOLS_ENABLED, context: { sandbox: true } },
  })

  const real = toolkit.getTools()
  const orders = new Map<string, SimulatedOrder>()
  for (const order of options.seedOrders ?? []) orders.set(order.id, order)

  let sequence = 0
  /**
   * PayPal's own schemas validate ids as 17-32 uppercase alphanumerics
   * (`/^[A-Z0-9]{17,32}$/`). Simulated ids must satisfy the same rule, or the
   * agent's calls are rejected by schema validation before reaching the guard.
   */
  const nextId = (prefix: string): string => {
    sequence += 1
    const body = prefix.toUpperCase().replace(/[^A-Z0-9]/g, "")
    const digits = String(sequence).padStart(Math.max(1, 17 - body.length), "0")
    return `${body}${digits}`.slice(0, 32)
  }

  const fake: Record<string, (args: Record<string, unknown>) => unknown> = {
    create_order: (args) => {
      const total = computeOrderTotal(args)
      const id = nextId("ORD")
      const order: SimulatedOrder = {
        id,
        status: "CREATED",
        amount: total.amount,
        currency: total.currency,
        merchant: merchantId,
      }
      orders.set(id, order)
      return {
        id,
        status: "CREATED",
        purchase_units: [
          {
            amount: { currency_code: order.currency, value: toDecimal(order.amount) },
            payee: { merchant_id: order.merchant },
          },
        ],
      }
    },

    get_order: (args) => {
      const id = String(args.id ?? "")
      const order = orders.get(id)
      if (!order) return { error: { issue: "ORDER_NOT_FOUND", description: `no order ${id}` } }
      return {
        id: order.id,
        status: order.status,
        purchase_units: [
          {
            amount: { currency_code: order.currency, value: toDecimal(order.amount) },
            payee: { merchant_id: order.merchant },
          },
        ],
      }
    },

    pay_order: (args) => {
      const id = String(args.id ?? "")
      const order = orders.get(id)
      if (!order) return { error: { issue: "ORDER_NOT_FOUND", description: `no order ${id}` } }
      if (order.status === "COMPLETED") {
        return { error: { issue: "ORDER_ALREADY_CAPTURED", description: `order ${id} is captured` } }
      }
      order.status = "COMPLETED"
      order.captureId = nextId("CAP")
      return {
        id: order.id,
        status: "COMPLETED",
        purchase_units: [
          {
            payments: {
              captures: [
                {
                  id: order.captureId,
                  status: "COMPLETED",
                  amount: { currency_code: order.currency, value: toDecimal(order.amount) },
                },
              ],
            },
            payee: { merchant_id: order.merchant },
          },
        ],
      }
    },

    create_refund: (args) => {
      const amount = args.amount as { currency_code?: string; value?: string } | undefined
      return {
        id: nextId("RFD"),
        status: "COMPLETED",
        ...(amount?.value ? { amount: { currency_code: amount.currency_code, value: amount.value } } : {}),
      }
    },

    list_transactions: () => ({
      transactions: [
        {
          transaction_id: "SIM-TXN-1",
          status: "COMPLETED",
          amount: { currency_code: "USD", value: "42.00" },
          transaction_initiation_date: new Date(Date.now() - 5 * 86_400_000).toISOString(),
        },
        {
          transaction_id: "SIM-TXN-2",
          status: "COMPLETED",
          amount: { currency_code: "USD", value: "18.50" },
          transaction_initiation_date: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        },
      ],
      total_items: 2,
    }),

    list_disputes: () => ({ items: [], total_items: 0 }),
  }

  const tools: ToolSet = {}
  for (const [name, tool] of Object.entries(real)) {
    const handler = fake[name]
    tools[name] = {
      ...tool,
      execute: async (args: unknown) => {
        if (!handler) {
          return { simulated: true, tool: name, input: args }
        }
        return handler((args ?? {}) as Record<string, unknown>)
      },
    }
  }

  return tools
}

/** Mirrors the toolkit's own total calculation, in minor units. */
function computeOrderTotal(args: Record<string, unknown>): { amount: number; currency: string } {
  const currency = typeof args.currencyCode === "string" ? args.currencyCode : "USD"
  const items = Array.isArray(args.items) ? args.items : []

  let subtotal = 0
  let tax = 0
  for (const raw of items) {
    const item = (raw ?? {}) as Record<string, unknown>
    const cost = Number(item.itemCost ?? 0)
    const quantity = Number(item.quantity ?? 1)
    const taxPercent = Number(item.taxPercent ?? 0)
    if (!Number.isFinite(cost) || !Number.isFinite(quantity) || !Number.isFinite(taxPercent)) continue
    subtotal += cost * quantity
    tax += (cost * taxPercent * quantity) / 100
  }

  const shipping = Number(args.shippingCost ?? 0)
  const discount = Number(args.discount ?? 0)
  const total = subtotal + tax + shipping - discount

  return { amount: Math.round(Math.max(0, total) * 100), currency }
}

function toDecimal(minor: number): string {
  return (minor / 100).toFixed(2)
}
