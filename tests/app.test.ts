import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { AddressInfo } from "node:net"
import type { Server } from "node:http"
import { Store } from "../src/core/store.js"
import { createSimulatedTools } from "../src/paypal/simulated.js"
import { createApp } from "../src/server/app.js"
import { TEST_KEY } from "./helpers.js"

const MERCHANT = "acme-supplies"
const ADMIN_TOKEN = "test-admin-token"

let server: Server
let base: string
let mandateId: string
let snapshotMandate: Record<string, unknown>

beforeAll(async () => {
  const store = new Store(TEST_KEY)
  const { envelope } = store.issue({
    principal: "filippo@example.com",
    agentId: "agent-procurement-01",
    budget: { amount: 12_000, currency: "USD" },
    purpose: "Restock office supplies",
    now: new Date(),
    constraints: { allowMerchants: [MERCHANT] },
  })
  mandateId = envelope.claims.id

  const { app } = createApp({
    store,
    rawTools: createSimulatedTools({ merchantId: MERCHANT }),
    mandateId,
    agentId: "agent-procurement-01",
    merchantId: MERCHANT,
    mode: "simulated",
    note: "test",
    adminToken: ADMIN_TOKEN,
  })

  server = app.listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const state = (await (await fetch(`${base}/api/state`)).json()) as {
    mandate: Record<string, unknown>
  }
  snapshotMandate = state.mandate
})

afterAll(() => {
  server.close()
})

describe("public mandate verification", () => {
  it("publishes an Ed25519 public key", async () => {
    const response = await fetch(`${base}/api/mandate/public-key`)
    const body = (await response.json()) as {
      algorithm: string
      format: string
      publicKey: string
    }
    expect(response.status).toBe(200)
    expect(body.algorithm).toBe("Ed25519")
    expect(body.format).toBe("spki-der-base64")
    expect(body.publicKey.length).toBeGreaterThan(40)
  })

  it("verifies the current mandate", async () => {
    const response = await fetch(`${base}/api/verify-mandate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(snapshotMandate),
    })
    const body = (await response.json()) as {
      ok: boolean
      signatureValid: boolean
      claimsValid: boolean
      mandateId: string
    }
    expect(response.status).toBe(200)
    expect(body.signatureValid).toBe(true)
    expect(body.claimsValid).toBe(true)
    expect(body.ok).toBe(true)
    expect(body.mandateId).toBe(mandateId)
  })

  it("rejects a mandate whose claims were widened", async () => {
    const claims = snapshotMandate["claims"] as Record<string, unknown>
    const tampered = {
      ...snapshotMandate,
      claims: {
        ...claims,
        budget: { amount: 999_999, currency: "USD" },
      },
    }

    const response = await fetch(`${base}/api/verify-mandate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(tampered),
    })
    const body = (await response.json()) as { ok: boolean; signatureValid: boolean }
    expect(body.signatureValid).toBe(false)
    expect(body.ok).toBe(false)
  })
})

describe("prompt injection", () => {
  it("denies a malicious order and records the reason", async () => {
    const response = await fetch(`${base}/api/demo/injection`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    })
    const body = (await response.json()) as {
      decision: { allowed: boolean; code: string; reason: string }
      entry: { proposal: { amount: number; merchant: string } }
    }

    expect(response.status).toBe(200)
    expect(body.decision.allowed).toBe(false)
    expect(body.decision.code).toBe("MERCHANT_NOT_ALLOWED")
    expect(body.decision.reason).toContain("sketchy-deals")
    expect(body.entry.proposal.amount).toBe(9_900)
    expect(body.entry.proposal.merchant).toBe("sketchy-deals")
  })
})

describe("admin authentication", () => {
  const post = (path: string, body: unknown, token?: string) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    })

  it("refuses to issue a mandate without a bearer token", async () => {
    const response = await post("/api/mandate", {})
    expect(response.status).toBe(401)
  })

  it("refuses a wrong bearer token", async () => {
    const response = await post("/api/mandate", {}, "not-the-token")
    expect(response.status).toBe(401)
  })

  it("refuses to resolve an approval without a bearer token", async () => {
    const response = await post("/api/approvals/does-not-exist/resolve", { approve: true })
    expect(response.status).toBe(401)
  })

  it("issues a mandate with the bearer token", async () => {
    const response = await post("/api/mandate", {}, ADMIN_TOKEN)
    const body = (await response.json()) as {
      mandate: { claims: { principal: string; agentId: string } }
    }
    expect(response.status).toBe(201)
    expect(body.mandate.claims.agentId).toBe("agent-procurement-01")
  })

  it("revokes with the bearer token", async () => {
    const response = await post("/api/mandate/revoke", {}, ADMIN_TOKEN)
    const body = (await response.json()) as { revokedAt: string | null }
    expect(response.status).toBe(200)
    expect(body.revokedAt).not.toBeNull()
  })

  it("fails closed when ADMIN_TOKEN is not configured", async () => {
    const store = new Store(TEST_KEY)
    const { envelope } = store.issue({
      principal: "filippo@example.com",
      agentId: "agent-procurement-01",
      budget: { amount: 12_000, currency: "USD" },
      purpose: "Restock office supplies",
      now: new Date(),
    })

    const { app } = createApp({
      store,
      rawTools: createSimulatedTools({ merchantId: MERCHANT }),
      mandateId: envelope.claims.id,
      agentId: "agent-procurement-01",
      merchantId: MERCHANT,
      mode: "simulated",
      note: "test",
    })

    const local = app.listen(0)
    await new Promise<void>((resolve) => local.once("listening", resolve))
    try {
      const address = local.address() as AddressInfo
      const response = await fetch(`http://127.0.0.1:${address.port}/api/mandate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
      expect(response.status).toBe(503)
    } finally {
      local.close()
    }
  })
})
