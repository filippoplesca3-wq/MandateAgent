/**
 * Live-mode smoke test.
 *
 * Proves the whole live path in one command:
 *   1. validate the environment,
 *   2. create a real PayPal sandbox order through the mandate guard,
 *   3. run the Gemini agent once against the demo mandate,
 *   4. print the ledger and the mandate's remaining budget.
 *
 * The order is not captured: PayPal requires a sandbox personal account to
 * approve it first. The script prints the payer-action link and stops there.
 */

import "dotenv/config"
import { Store } from "../src/core/store.js"
import { formatMoney, remainingBudget } from "../src/core/mandate.js"
import { describeMandate, runAgent } from "../src/agent/agent.js"
import { toAgentTools } from "../src/agent/tools.js"
import { guardTools } from "../src/paypal/guard.js"
import { createPayPalTools, paypalConfigFromEnv } from "../src/paypal/index.js"
import { parseMerchantAliases } from "../src/paypal/env.js"
import type { ToolExecOptions, ToolLike } from "../src/paypal/tool-types.js"
import { AGENT_ID, MERCHANT, issueDemoMandate } from "../src/server/demo.js"

const REQUIRED = [
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "MANDATE_SIGNING_KEY",
] as const

const missing = REQUIRED.filter((key) => !process.env[key]?.trim())
if (missing.length > 0) {
  console.error("check:live cannot run. Missing environment variables:\n")
  for (const key of missing) console.error(`  - ${key}`)
  console.error("\nCopy .env.example to .env and fill them in. See README, Live mode check.")
  process.exit(1)
}

const paypalConfig = paypalConfigFromEnv()
if (paypalConfig.sandbox !== true) {
  console.error(
    "check:live is sandbox-only. Set PAYPAL_ENVIRONMENT=SANDBOX; it refuses to move real money.",
  )
  process.exit(1)
}

const paypal = createPayPalTools(paypalConfig, { merchantId: MERCHANT })
if (paypal.mode !== "live") {
  console.error("PayPal credentials were not accepted, so the toolkit stayed simulated.")
  process.exit(1)
}

const store = new Store(process.env["MANDATE_SIGNING_KEY"]!)
const mandateId = issueDemoMandate(store, 15 * 60 * 1_000)
const aliases = parseMerchantAliases(process.env["PAYPAL_MERCHANT_ALIASES"])
const { tools } = guardTools(paypal.tools, {
  store,
  mandateId,
  agentId: AGENT_ID,
  merchantId: MERCHANT,
  ...(aliases ? { merchantAliases: aliases } : {}),
})

const messages: ToolExecOptions["messages"] = []
const exec = (name: string): ToolExecOptions => ({ toolCallId: `check-live-${name}`, messages })

function tool(name: string): NonNullable<ToolLike["execute"]> {
  const found = tools[name]?.execute
  if (!found) {
    console.error(`The live toolkit did not expose ${name}.`)
    process.exit(1)
  }
  return found
}

/** The guard returns JSON text; the live toolkit may nest another JSON string. */
function unwrap(raw: unknown): Record<string, any> {
  let parsed = typeof raw === "string" ? JSON.parse(raw) : raw
  if (parsed && typeof parsed.result === "string") {
    try {
      parsed = { ...parsed, result: JSON.parse(parsed.result) }
    } catch {
      // Leave a non-JSON result as text.
    }
  }
  return parsed as Record<string, any>
}

async function main(): Promise<void> {
  console.log("=".repeat(74))
  console.log(`PayPal mode: ${paypal.mode} - ${paypal.note}`)
  console.log(`Mandate: ${mandateId}`)
  console.log("=".repeat(74))

  const created = unwrap(
    await tool("create_order")(
      {
        currencyCode: "USD",
        items: [
          {
            name: "Agent Mandate live check",
            quantity: 1,
            itemCost: 12,
            taxPercent: 0,
            itemTotal: 12,
          },
        ],
        returnUrl: "https://example.com/paypal/return",
        cancelUrl: "https://example.com/paypal/cancel",
      },
      exec("create_order"),
    ),
  )

  if (created["ok"] !== true) {
    console.error("\ncreate_order was refused or failed:")
    console.error(created["reason"] ?? JSON.stringify(created, null, 2))
    process.exitCode = 1
    return
  }

  const orderId = String(created["result"]?.id ?? "")
  if (!orderId) {
    console.error("\ncreate_order returned no order id.")
    process.exitCode = 1
    return
  }

  console.log(`\nSandbox order created: ${orderId}`)
  const actionLink = (created["result"]?.links ?? []).find(
    (link: { rel?: string }) => link.rel === "payer-action",
  )
  if (actionLink?.href) {
    console.log("A sandbox personal account must approve it before capture:\n")
    console.log(`  ${actionLink.href}`)
  }

  console.log("\nRunning the Gemini agent once against this mandate...\n")
  const task = `Fetch PayPal order ${orderId} and report its status and amount. Do not pay or modify it.`
  try {
    const result = await runAgent({
      tools: toAgentTools(tools),
      mandateBrief: describeMandate(store, mandateId),
      task,
      maxSteps: 4,
    })
    console.log(result.text || "(the model returned no text)")
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`\nThe Gemini agent failed: ${message}`)
    console.error("Check GOOGLE_GENERATIVE_AI_API_KEY and the free-tier quota.")
    process.exitCode = 1
    return
  }

  const stored = store.get(mandateId)!
  console.log("\n" + "=".repeat(74))
  console.log("LEDGER")
  console.log("=".repeat(74))
  for (const entry of [...store.ledger.list()].reverse()) {
    const amount = entry.proposal.amount
      ? formatMoney({
          amount: entry.proposal.amount,
          currency: entry.proposal.currency ?? "USD",
        })
      : "(no amount)"
    console.log(
      `${entry.action.padEnd(16)} ${amount.padEnd(12)} ${entry.decision.code}  ${entry.externalRef ?? ""}`,
    )
  }
  console.log("SPENT:", formatMoney(stored.state.spendToDate))
  console.log("REMAINING:", formatMoney(remainingBudget(stored.envelope.claims, stored.state)))
  console.log("\nLIVE CHECK OK - env valid, sandbox order created, Gemini ran, ledger printed.")
}

await main()
