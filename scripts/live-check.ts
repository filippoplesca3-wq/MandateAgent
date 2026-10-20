/**
 * Live sandbox smoke test.
 *
 * Drives the real PayPal toolkit through the guard:
 *   1. create an order,
 *   2. (optionally) capture an order a sandbox buyer has approved,
 *   3. read it back.
 *
 * PayPal requires the buyer to approve an order before it can be captured, so
 * a fresh order comes back as PAYER_ACTION_REQUIRED with a sandbox checkout
 * link. Open that link as a sandbox personal account, approve, then run:
 *
 *   npm run live:check -- <orderId>
 *
 * to capture the approved order. Everything else in the suite runs against the
 * simulator; this is the one check that proves the live path.
 */

import "dotenv/config"
import { Store } from "../src/core/store.js"
import { formatMoney, remainingBudget } from "../src/core/mandate.js"
import { guardTools } from "../src/paypal/guard.js"
import { createPayPalTools, paypalConfigFromEnv } from "../src/paypal/index.js"
import type { ToolExecOptions, ToolLike, ToolSet } from "../src/paypal/tool-types.js"

const AGENT_ID = "agent-live-check"
const KEY = process.env["MANDATE_SIGNING_KEY"] ?? "dev-only-signing-key-change-me-please"

type Executable = { execute: NonNullable<ToolLike["execute"]> }

/** The guard returns a JSON string; its `result` is itself a JSON string. */
function unwrap(raw: unknown): Record<string, any> {
  let parsed = typeof raw === "string" ? JSON.parse(raw) : raw
  if (parsed && typeof parsed.result === "string") {
    try {
      parsed = { ...parsed, result: JSON.parse(parsed.result) }
    } catch {
      // Leave it as the raw string if it is not JSON.
    }
  }
  return parsed as Record<string, any>
}

const store = new Store(KEY)
const paypal = createPayPalTools(paypalConfigFromEnv())

console.log("=".repeat(74))
console.log(`PayPal mode: ${paypal.mode} - ${paypal.note}`)
console.log("=".repeat(74))

if (paypal.mode !== "live") {
  console.error("No credentials detected. Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to .env.")
  process.exit(1)
}

const { envelope } = store.issue({
  principal: "filippo@example.com",
  agentId: AGENT_ID,
  budget: { amount: 500, currency: "USD" },
  purpose: "Live sandbox smoke test",
  ttlMs: 15 * 60 * 1_000,
  constraints: { maxPerTransaction: { amount: 500, currency: "USD" } },
})

const { tools } = guardTools(paypal.tools, {
  store,
  mandateId: envelope.claims.id,
  agentId: AGENT_ID,
})

function tool(name: string): Executable {
  const found: ToolLike | undefined = tools[name]
  if (!found?.execute) throw new Error(`tool ${name} is unavailable`)
  return { execute: found.execute }
}

const messages: ToolExecOptions["messages"] = []
const exec = (name: string): ToolExecOptions => ({ toolCallId: `live-${name}`, messages })

async function main(): Promise<void> {
  const existing = process.argv[2]

  let orderId = existing
  if (!orderId) {
    const created = unwrap(
      await tool("create_order").execute(
        {
          currencyCode: "USD",
          items: [
            {
              name: "Live sandbox test item",
              quantity: 1,
              itemCost: 1,
              taxPercent: 0,
              itemTotal: 1,
            },
          ],
          returnUrl: "https://example.com/paypal/return",
          cancelUrl: "https://example.com/paypal/cancel",
        },
        exec("create_order"),
      ),
    )

    console.log("\ncreate_order ->", JSON.stringify(created, null, 2))
    if (created["ok"] !== true) {
      console.error("\ncreate_order failed. PayPal's own error is above; nothing was charged.")
      process.exitCode = 1
      return
    }

    orderId = String(created["result"]?.id ?? "")
    if (!orderId) {
      console.error("\ncreate_order returned no order id.")
      process.exitCode = 1
      return
    }

    const actionLink = (created["result"]?.links ?? []).find(
      (link: { rel?: string }) => link.rel === "payer-action",
    )
    if (actionLink?.href) {
      console.log("\nBuyer approval required. Open this sandbox checkout link, log in as a")
      console.log("sandbox PERSONAL account, and approve:\n")
      console.log(`  ${actionLink.href}\n`)
      console.log(`Then capture it with:  npm run live:check -- ${orderId}`)
      process.exitCode = 2
      return
    }
  }

  const paid = unwrap(await tool("pay_order").execute({ id: orderId }, exec("pay_order")))
  console.log("\npay_order ->", JSON.stringify(paid, null, 2))

  const fetched = unwrap(await tool("get_order").execute({ id: orderId }, exec("get_order")))
  const status = fetched["result"]?.status ?? fetched["status"]
  console.log("\nget_order status ->", status)

  const stored = store.get(envelope.claims.id)!
  console.log("\n" + "=".repeat(74))
  console.log("LEDGER")
  console.log("=".repeat(74))
  for (const entry of [...store.ledger.list()].reverse()) {
    const amount = entry.proposal.amount
      ? formatMoney({ amount: entry.proposal.amount, currency: entry.proposal.currency ?? "USD" })
      : "(no amount)"
    console.log(
      `${entry.action.padEnd(16)} ${amount.padEnd(12)} ${entry.decision.code}  ${entry.externalRef ?? ""}`,
    )
  }
  console.log("SPENT:", formatMoney(stored.state.spendToDate))
  console.log("REMAINING:", formatMoney(remainingBudget(envelope.claims, stored.state)))

  if (paid["ok"] !== true || status !== "COMPLETED") {
    console.error("\nLive path did not complete end to end.")
    process.exitCode = 1
  } else {
    console.log("\nLIVE PATH OK - a real sandbox order was created and captured.")
  }
}

await main()
