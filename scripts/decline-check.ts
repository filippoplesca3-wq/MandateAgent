/**
 * Negative-path check: a declined instrument must never move money.
 *
 * PayPal sandboxes accept a `PayPal-Mock-Response` header that makes the next
 * capture fail with a chosen error. This script creates a real $1 sandbox
 * order through the mandate guard, then asks PayPal to decline the capture with
 * INSTRUMENT_DECLINED. The order is never approved, so nothing is charged.
 *
 * The guard's handling of exactly this failure is pinned by
 * `tests/guard.test.ts` ("a declined capture never moves budget"). This script
 * proves the same response comes back from PayPal itself, which is the part a
 * unit test cannot cover.
 *
 * Usage: npm run decline:check
 */

import "dotenv/config"
import { Store } from "../src/core/store.js"
import { formatMoney, remainingBudget } from "../src/core/mandate.js"
import { guardTools } from "../src/paypal/guard.js"
import { createPayPalTools, paypalConfigFromEnv } from "../src/paypal/index.js"
import type { ToolExecOptions, ToolLike } from "../src/paypal/tool-types.js"

const AGENT_ID = "agent-decline-check"
const KEY = process.env["MANDATE_SIGNING_KEY"] ?? "dev-only-signing-key-change-me-please"
const MOCK_DECLINE = JSON.stringify({ mock_application_codes: "INSTRUMENT_DECLINED" })

type Executable = { execute: NonNullable<ToolLike["execute"]> }

/** The guard returns a JSON string; its `result` may itself be a JSON string. */
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

const config = paypalConfigFromEnv()
const paypal = createPayPalTools(config)

console.log("=".repeat(74))
console.log(`PayPal mode: ${paypal.mode} - ${paypal.note}`)
console.log("=".repeat(74))

if (paypal.mode !== "live" || !config.sandbox) {
  console.error(
    "This check needs live sandbox credentials: set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env.",
  )
  process.exit(1)
}

if (!config.clientId || !config.clientSecret) {
  console.error("PayPal credentials are incomplete.")
  process.exit(1)
}

const store = new Store(KEY)
const { envelope } = store.issue({
  principal: "filippo@example.com",
  agentId: AGENT_ID,
  budget: { amount: 500, currency: "USD" },
  purpose: "Decline path smoke test",
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
const exec = (name: string): ToolExecOptions => ({ toolCallId: `decline-${name}`, messages })

async function accessToken(): Promise<string> {
  const base = config.sandbox ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com"
  const authorization = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")
  const response = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${authorization}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  })
  if (!response.ok) throw new Error(`PayPal token request failed: HTTP ${response.status}`)
  const body = (await response.json()) as { access_token?: string }
  if (!body.access_token) throw new Error("PayPal token response had no access_token")
  return body.access_token
}

async function main(): Promise<void> {
  const created = unwrap(
    await tool("create_order").execute(
      {
        currencyCode: "USD",
        items: [
          {
            name: "Decline path test item",
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

  if (created["ok"] !== true) {
    console.error("create_order failed; nothing was charged.")
    console.error(JSON.stringify(created, null, 2))
    process.exitCode = 1
    return
  }

  const orderId = String(created["result"]?.id ?? "")
  if (!orderId) {
    console.error("create_order returned no order id.")
    process.exitCode = 1
    return
  }
  console.log(`\nCreated sandbox order ${orderId} (1.00 USD, never approved).`)

  const token = await accessToken()
  const base = config.sandbox ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com"
  const response = await fetch(`${base}/v2/checkout/orders/${orderId}/capture`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "PayPal-Mock-Response": MOCK_DECLINE,
    },
    body: "{}",
  })

  const text = await response.text()
  let body: Record<string, any> = {}
  try {
    body = JSON.parse(text) as Record<string, any>
  } catch {
    // Keep the raw text below.
  }

  const issue = Array.isArray(body["details"])
    ? String(body["details"][0]?.issue ?? "")
    : ""
  const declined = response.status === 422 && issue === "INSTRUMENT_DECLINED"

  const stored = store.get(envelope.claims.id)!
  console.log("\nPayPal capture response")
  console.log("-".repeat(74))
  console.log(text.slice(0, 700))
  console.log("-".repeat(74))
  console.log(`HTTP ${response.status}${issue ? ` · ${issue}` : ""}`)
  console.log(`Spent:     ${formatMoney(stored.state.spendToDate)}`)
  console.log(`Remaining: ${formatMoney(remainingBudget(envelope.claims, stored.state))}`)

  if (!declined) {
    console.error("\nFAIL: expected HTTP 422 INSTRUMENT_DECLINED from PayPal.")
    process.exitCode = 1
    return
  }

  if (stored.state.spendToDate.amount !== 0) {
    console.error("\nFAIL: a declined capture moved the mandate's spend counter.")
    process.exitCode = 1
    return
  }

  console.log(
    "\nPASS: PayPal declined the instrument and no budget moved. The guard turns this",
  )
  console.log("response into TOOL_ERROR, so a failed capture is never counted as spend.")
}

await main()
