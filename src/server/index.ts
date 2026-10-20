/**
 * Server entry point.
 *
 * Builds one store, one PayPal tool set and one demo mandate, then hands them
 * to the HTTP layer. In development Vite serves the UI on 5173 and proxies
 * `/api` here; in a built deployment this process serves `dist/web` as well.
 */

import "dotenv/config"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import express from "express"
import { Store } from "../core/store.js"
import { createPayPalTools, paypalConfigFromEnv } from "../paypal/index.js"
import { createApp } from "./app.js"

const AGENT_ID = "agent-procurement-01"
const MERCHANT = "acme-supplies"
const OUTSIDE_MERCHANT = "sketchy-deals"

const signingKey = process.env["MANDATE_SIGNING_KEY"]
if (!signingKey || signingKey.length < 16) {
  console.error(
    "MANDATE_SIGNING_KEY is missing or shorter than 16 characters. Copy .env.example to .env and set it.",
  )
  process.exit(1)
}

const port = Number(process.env["PORT"] ?? 3001)

const store = new Store(signingKey)

const paypal = createPayPalTools(paypalConfigFromEnv(), {
  merchantId: MERCHANT,
  seedOrders: [
    {
      id: "ORD00000000009001",
      status: "CREATED",
      amount: 9_900,
      currency: "USD",
      merchant: OUTSIDE_MERCHANT,
    },
    {
      id: "ORD00000000009002",
      status: "CREATED",
      amount: 4_500,
      currency: "USD",
      merchant: MERCHANT,
    },
  ],
})

const { envelope } = store.issue({
  principal: "filippo@example.com",
  agentId: AGENT_ID,
  budget: { amount: 12_000, currency: "USD" },
  purpose: "Buy A4 paper and studio supplies",
  ttlMs: 24 * 60 * 60 * 1_000,
  constraints: {
    allowMerchants: [MERCHANT],
    maxPerTransaction: { amount: 5_000, currency: "USD" },
    requireApprovalAbove: { amount: 4_000, currency: "USD" },
  },
})

// Seller-side history, so the trust panel has something to reason about.
store.setAgentSignals({
  agentId: AGENT_ID,
  transactionCount: 42,
  disputeCount: 0,
  refundCount: 2,
  totalVolume: 128_000,
  currency: "USD",
  firstSeenAt: "2024-03-01T00:00:00.000Z",
  mandateActive: true,
})

store.setAgentSignals({
  agentId: "agent-guest-77",
  transactionCount: 3,
  disputeCount: 2,
  refundCount: 0,
  totalVolume: 4_200,
  currency: "USD",
  firstSeenAt: "2026-09-28T00:00:00.000Z",
  mandateActive: false,
})

const { app } = createApp({
  store,
  rawTools: paypal.tools,
  mandateId: envelope.claims.id,
  agentId: AGENT_ID,
  merchantId: MERCHANT,
  mode: paypal.mode,
  note: paypal.note,
  ...(process.env["AGENT_MODEL"] ? { model: process.env["AGENT_MODEL"] } : {}),
})

// Serve the built UI when it exists. In dev, Vite handles this.
const here = dirname(fileURLToPath(import.meta.url))
const webRoot = join(here, "..", "..", "dist", "web")
if (existsSync(join(webRoot, "index.html"))) {
  app.use(express.static(webRoot))
  app.get(/^(?!\/api\/).*/, (_req, res) => {
    res.sendFile(join(webRoot, "index.html"))
  })
}

app.listen(port, () => {
  console.log("=".repeat(70))
  console.log(`Agent Mandate API on http://localhost:${port}`)
  console.log(`PayPal mode: ${paypal.mode} - ${paypal.note}`)
  console.log(`Mandate: ${envelope.claims.id}`)
  console.log("=".repeat(70))
})
