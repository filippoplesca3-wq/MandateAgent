/**
 * A hosted replay boots with its own ephemeral signing key, but the mandate on
 * screen was signed by the key used at record time. These tests prove that the
 * public key the demo publishes is the one that verifies the recording.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { AddressInfo } from "node:net"
import type { Server } from "node:http"
import { Store } from "../src/core/store.js"
import type { MandateEnvelope } from "../src/core/types.js"
import { createSimulatedTools } from "../src/paypal/simulated.js"
import { createApp } from "../src/server/app.js"
import { ReplayPlayer, type RecordedRun } from "../src/server/replay.js"
import { buildSnapshot } from "../src/server/snapshot.js"

const RECORDING_KEY = "recording-key-for-replay-verification"
const SERVING_KEY = "different-serving-key-for-hosted-demo"
const MERCHANT = "acme-supplies"

let server: Server
let base: string
let recorded: MandateEnvelope
let recordingPublicKey: string

beforeAll(async () => {
  const recorder = new Store(RECORDING_KEY)
  recorded = recorder.issue({
    principal: "filippo@example.com",
    agentId: "agent-procurement-01",
    budget: { amount: 12_000, currency: "USD" },
    purpose: "Restock office supplies",
    now: new Date(),
    constraints: { allowMerchants: [MERCHANT] },
  }).envelope
  recordingPublicKey = recorder.publicKeyBase64

  const snapshot = structuredClone(
    buildSnapshot(recorder, recorded.claims.id, {
      mode: "simulated",
      note: "recorded",
      agentId: "agent-procurement-01",
      merchantId: MERCHANT,
      running: false,
    }),
  )

  const run: RecordedRun = {
    kind: "agent-mandate-replay",
    version: 1,
    recordedAt: new Date().toISOString(),
    paypalMode: "simulated",
    model: "gemini-test",
    task: "test task",
    text: "",
    durationMs: 0,
    steps: [],
    frames: [{ atMs: 0, snapshot }],
    publicKey: recordingPublicKey,
  }

  // The serving store deliberately uses a different key, exactly like Render's
  // generated MANDATE_SIGNING_KEY.
  const serving = new Store(SERVING_KEY)
  const servingMandate = serving.issue({
    principal: "filippo@example.com",
    agentId: "agent-procurement-01",
    budget: { amount: 12_000, currency: "USD" },
    purpose: "Hosted demo",
    now: new Date(),
    constraints: { allowMerchants: [MERCHANT] },
  }).envelope.claims.id

  const { app } = createApp({
    store: serving,
    rawTools: createSimulatedTools({ merchantId: MERCHANT }),
    mandateId: servingMandate,
    agentId: "agent-procurement-01",
    merchantId: MERCHANT,
    mode: "replay",
    note: "test replay",
    replay: new ReplayPlayer(run),
  })

  server = app.listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
})

describe("replay mandate verification", () => {
  it("publishes the recording key, not the serving key", async () => {
    const response = await fetch(`${base}/api/mandate/public-key`)
    const body = (await response.json()) as {
      ok: boolean
      source: string
      publicKey: string
      algorithm: string
    }

    expect(response.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.source).toBe("recording")
    expect(body.algorithm).toBe("Ed25519")
    expect(body.publicKey).toBe(recordingPublicKey)
  })

  it("verifies the recorded mandate by id with only the public key", async () => {
    const response = await fetch(`${base}/api/mandates/${recorded.claims.id}/verify`)
    const body = (await response.json()) as {
      ok: boolean
      source: string
      signatureValid: boolean
      claimsValid: boolean
      revoked: boolean
      claims: { id: string }
    }

    expect(response.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.source).toBe("recording")
    expect(body.signatureValid).toBe(true)
    expect(body.claimsValid).toBe(true)
    expect(body.revoked).toBe(false)
    expect(body.claims.id).toBe(recorded.claims.id)
  })

  it("verifies the recorded envelope through POST without a supplied key", async () => {
    const response = await fetch(`${base}/api/verify-mandate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ envelope: recorded }),
    })
    const body = (await response.json()) as { ok: boolean; signatureValid: boolean }

    expect(response.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.signatureValid).toBe(true)
  })

  it("still rejects a widened recording", async () => {
    const tampered = structuredClone(recorded)
    tampered.claims.budget.amount = 999_999

    const response = await fetch(`${base}/api/verify-mandate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ envelope: tampered }),
    })
    const body = (await response.json()) as { ok: boolean; signatureValid: boolean }

    expect(response.status).toBe(200)
    expect(body.ok).toBe(false)
    expect(body.signatureValid).toBe(false)
  })

  it("returns 404 for an id that is neither stored nor recorded", async () => {
    const response = await fetch(`${base}/api/mandates/does-not-exist/verify`)
    expect(response.status).toBe(404)
  })

  it("refuses every write with 409 even when no admin token is configured", async () => {
    const writes = [
      "/api/mandate",
      "/api/mandate/revoke",
      "/api/demo/injection",
      "/api/approvals/does-not-exist/resolve",
    ]

    for (const path of writes) {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
      const body = (await response.json()) as { ok: boolean; error: string }

      // A recording has no admin, so 401/503 would misdescribe it. The docs
      // promise 409, and the promise should not depend on server config.
      expect(response.status, path).toBe(409)
      expect(body.ok, path).toBe(false)
      expect(body.error, path).toContain("read-only")
    }
  })
})
