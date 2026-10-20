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
import { createPayPalTools, paypalConfigFromEnv } from "../paypal/index.js"
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

const paypal = replay
  ? createPayPalTools({ sandbox: true }, { merchantId: MERCHANT, seedOrders: SEED_ORDERS })
  : createPayPalTools(paypalConfigFromEnv(), { merchantId: MERCHANT, seedOrders: SEED_ORDERS })

const mandateId = issueDemoMandate(store, 24 * 60 * 60 * 1_000)
seedTrust(store)

const { app } = createApp({
  store,
  rawTools: paypal.tools,
  mandateId,
  agentId: AGENT_ID,
  merchantId: MERCHANT,
  mode: replay ? "replay" : paypal.mode,
  note: replay ? "Serving a recorded run." : paypal.note,
  ...(process.env["AGENT_MODEL"] ? { model: process.env["AGENT_MODEL"] } : {}),
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
  }
  console.log(`Mandate: ${mandateId}`)
  console.log("=".repeat(70))
})
