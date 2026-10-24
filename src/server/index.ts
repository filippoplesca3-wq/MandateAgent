/**
 * Server entry point.
 *
 * Builds one store, one PayPal tool set and one demo mandate, then hands them
 * to the HTTP layer. In development Vite serves the UI on 5173 and proxies
 * `/api` here; in a built deployment this process serves `dist/web` as well.
 *
 * Setting REPLAY_FILE serves a recorded run instead of calling any API. That
 * is what makes the hosted demo useful with no credentials and no quota.
 */

import "dotenv/config"
import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import express from "express"
import { Store } from "../core/store.js"
import { parseMerchantAliases } from "../paypal/env.js"
import { createPayPalTools, paypalConfigFromEnv } from "../paypal/index.js"
import { verifyWebhookSignature, type WebhookHeaders } from "../paypal/webhook.js"
import { createApp } from "./app.js"
import { AGENT_ID, MERCHANT, SEED_ORDERS, issueDemoMandate, seedTrust } from "./demo.js"
import { ReplayPlayer, loadReplayFile } from "./replay.js"

const replayFile = process.env["REPLAY_FILE"]?.trim()

/**
 * A recording needs no signing key: nothing is being signed and no live
 * mandate exists. An ephemeral key lets a hosted demo boot with no secrets.
 */
const configuredKey = process.env["MANDATE_SIGNING_KEY"]
const signingKey = configuredKey ?? (replayFile ? randomBytes(32).toString("hex") : undefined)
if (!signingKey || signingKey.length < 16) {
  console.error(
    "MANDATE_SIGNING_KEY is missing or shorter than 16 characters. Copy .env.example to .env and set it, or set REPLAY_FILE for a read-only demo.",
  )
  process.exit(1)
}

const port = Number(process.env["PORT"] ?? 3001)
const frameMs = Number(process.env["REPLAY_FRAME_MS"] ?? 1_200)

const store = new Store(signingKey)

const replay = replayFile
  ? new ReplayPlayer(loadReplayFile(replayFile), Number.isFinite(frameMs) ? frameMs : 1_200)
  : undefined

// PAYPAL_MODE=simulated runs the real agent against local tool doubles even
// when credentials exist — useful for demos where no sandbox order should move.
const forcedSimulated = process.env["PAYPAL_MODE"]?.toLowerCase() === "simulated"
const simulated = replay !== undefined || forcedSimulated

const paypalConfig = paypalConfigFromEnv()
const merchantAliases = parseMerchantAliases(process.env["PAYPAL_MERCHANT_ALIASES"])

// Webhooks can only be verified when the app knows its own webhook id and can
// authenticate to PayPal. Without both, the endpoint reports 503 rather than
// accepting unverified deliveries.
const webhookId = process.env["PAYPAL_WEBHOOK_ID"]?.trim()
const paypalClientId = paypalConfig.clientId
const paypalClientSecret = paypalConfig.clientSecret
const webhook =
  !simulated && webhookId && paypalClientId && paypalClientSecret
    ? {
        id: webhookId,
        verify: (headers: WebhookHeaders, event: unknown) =>
          verifyWebhookSignature(
            {
              clientId: paypalClientId,
              clientSecret: paypalClientSecret,
              sandbox: paypalConfig.sandbox,
            },
            webhookId,
            headers,
            event,
          ),
      }
    : undefined

const paypal = simulated
  ? createPayPalTools({ sandbox: true }, { merchantId: MERCHANT, seedOrders: SEED_ORDERS })
  : createPayPalTools(paypalConfig, { merchantId: MERCHANT, seedOrders: SEED_ORDERS })

// A recorded mandate is already spent down. Issuing a fresh one and charging
// it with the same amount keeps a hosted dry run consistent with the numbers
// on screen. The longer TTL avoids a hosted demo expiring while it idles.
const mandateId = issueDemoMandate(store, replay ? 30 * 24 * 60 * 60 * 1_000 : 24 * 60 * 60 * 1_000)
seedTrust(store)

if (replay) {
  const final = replay.run.frames[replay.run.frames.length - 1]?.snapshot.mandate
  if (final && final.state.spendToDate.amount > 0) {
    store.commitSpend(mandateId, final.state.spendToDate.amount)
  }
}

const { app } = createApp({
  store,
  rawTools: paypal.tools,
  mandateId,
  agentId: AGENT_ID,
  merchantId: MERCHANT,
  mode: replay ? "replay" : paypal.mode,
  note: replay
    ? "Serving a recorded run."
    : forcedSimulated
      ? "Simulated PayPal: PAYPAL_MODE=simulated. Real Gemini, local tool calls."
      : paypal.note,
  ...(process.env["AGENT_MODEL"] ? { model: process.env["AGENT_MODEL"] } : {}),
  ...(!simulated && paypalConfig.clientId ? { paypalClientId: paypalConfig.clientId } : {}),
  ...(!simulated ? { paypalSandbox: paypalConfig.sandbox } : {}),
  ...(merchantAliases ? { merchantAliases } : {}),
  ...(webhook ? { webhook } : {}),
  ...(replay ? { replay } : {}),
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
  if (replay) {
    console.log(
      `Mode: replay of a run recorded ${replay.run.recordedAt} with ${replay.run.model} (PayPal ${replay.run.paypalMode}). No API calls will be made.`,
    )
  } else {
    console.log(`PayPal mode: ${paypal.mode} - ${paypal.note}`)
    if (process.env["GOOGLE_GENERATIVE_AI_API_KEY"]) {
      console.log("Gemini: server key configured")
    } else {
      console.log("Gemini: no server key; visitors must supply one to run the agent")
    }
    if (paypalConfig.sandbox && paypalConfig.clientId) {
      console.log("Live sandbox checkout: enabled (browser approval, 2.00 USD)")
      if (!merchantAliases) {
        console.log(
          "Hint: set PAYPAL_MERCHANT_ALIASES so a live capture matches the mandate's merchant name.",
        )
      }
    }
    console.log(
      webhook
        ? "Webhooks: signature verification enabled on POST /api/webhooks/paypal"
        : "Webhooks: disabled (set PAYPAL_WEBHOOK_ID and add the app's webhook in PayPal)",
    )
  }
  console.log(`Mandate: ${mandateId}`)
  console.log("=".repeat(70))
})
