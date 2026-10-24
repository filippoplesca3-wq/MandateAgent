/**
 * MCP entry point: the same guarded PayPal tools, served over stdio.
 *
 * Point any MCP client at `npm run mcp`. Nothing about the mandate changes:
 * the server issues one demo mandate at boot, and every tool call is checked
 * against it, so an MCP client has exactly the authority the mandate grants.
 *
 * stdout belongs to the protocol. All logging goes to stderr.
 */

import "dotenv/config"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { Store } from "../core/store.js"
import { guardTools } from "../paypal/guard.js"
import { parseMerchantAliases } from "../paypal/env.js"
import { createPayPalTools, paypalConfigFromEnv } from "../paypal/index.js"
import { AGENT_ID, MERCHANT, SEED_ORDERS, issueDemoMandate, seedTrust } from "../server/demo.js"
import { createGuardedMcpServer } from "./server.js"

const signingKey = process.env["MANDATE_SIGNING_KEY"]
if (!signingKey || signingKey.length < 16) {
  console.error(
    "MANDATE_SIGNING_KEY is missing or shorter than 16 characters. Copy .env.example to .env and set it.",
  )
  process.exit(1)
}

const forcedSimulated = process.env["PAYPAL_MODE"]?.toLowerCase() === "simulated"
const paypal = forcedSimulated
  ? createPayPalTools({ sandbox: true }, { merchantId: MERCHANT, seedOrders: SEED_ORDERS })
  : createPayPalTools(paypalConfigFromEnv(), { merchantId: MERCHANT, seedOrders: SEED_ORDERS })

const store = new Store(signingKey)
const mandateId = issueDemoMandate(store, 24 * 60 * 60 * 1_000)
seedTrust(store)

const merchantAliases = parseMerchantAliases(process.env["PAYPAL_MERCHANT_ALIASES"])
const { tools } = guardTools(paypal.tools, {
  store,
  mandateId,
  agentId: AGENT_ID,
  merchantId: MERCHANT,
  ...(merchantAliases ? { merchantAliases } : {}),
})

const { server, toolNames } = createGuardedMcpServer({ store, mandateId, tools })
await server.connect(new StdioServerTransport())

console.error("=".repeat(70))
console.error(`Agent Mandate MCP server on stdio · ${toolNames.length} tools`)
console.error(`Mandate: ${mandateId} (24h, USD 120.00 budget)`)
console.error(`PayPal: ${paypal.mode} - ${paypal.note}`)
console.error("Every call is evaluated against the mandate before it reaches PayPal.")
console.error("=".repeat(70))
