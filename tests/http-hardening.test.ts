import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { AddressInfo } from "node:net"
import type { Server } from "node:http"
import { Store } from "../src/core/store.js"
import { createSimulatedTools } from "../src/paypal/simulated.js"
import { createApp } from "../src/server/app.js"
import { TEST_KEY } from "./helpers.js"

const MERCHANT = "acme-supplies"
const ADMIN_TOKEN = "test-admin-token"
const ALLOWED_ORIGIN = "https://demo.example"

async function listen(rateLimitPerMinute: number): Promise<{ server: Server; base: string }> {
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
    adminToken: ADMIN_TOKEN,
    allowedOrigins: [ALLOWED_ORIGIN],
    rateLimitPerMinute,
  })

  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }
}

let server: Server
let base: string

beforeAll(async () => {
  const started = await listen(30)
  server = started.server
  base = started.base
})

afterAll(() => {
  server.close()
})

describe("CORS", () => {
  it("allows an origin on the allowlist", async () => {
    const response = await fetch(`${base}/api/state`, {
      headers: { origin: ALLOWED_ORIGIN },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN)
    expect(response.headers.get("vary")).toContain("Origin")
  })

  it("does not grant CORS to any other origin", async () => {
    const response = await fetch(`${base}/api/state`, {
      headers: { origin: "https://attacker.example" },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
  })

  it("answers a preflight for an allowed origin", async () => {
    const response = await fetch(`${base}/api/evaluate`, {
      method: "OPTIONS",
      headers: {
        origin: ALLOWED_ORIGIN,
        "access-control-request-method": "POST",
      },
    })
    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN)
    expect(response.headers.get("access-control-allow-methods")).toContain("POST")
  })
})

describe("hardening headers", () => {
  it("sets baseline headers and hides the framework", async () => {
    const response = await fetch(`${base}/api/health`)
    expect(response.status).toBe(200)
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN")
    expect(response.headers.get("referrer-policy")).toBe("no-referrer")
    expect(response.headers.get("x-powered-by")).toBeNull()
  })
})

describe("request validation", () => {
  it("rejects a body that fails the zod schema", async () => {
    const response = await fetch(`${base}/api/evaluate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: 42 }),
    })
    const body = (await response.json()) as { error: string }
    expect(response.status).toBe(400)
    expect(body.error).toMatch(/action/)
  })

  it("rejects malformed JSON with 400", async () => {
    const response = await fetch(`${base}/api/evaluate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    })
    expect(response.status).toBe(400)
  })

  it("rejects a body above the size limit with 413", async () => {
    const response = await fetch(`${base}/api/mandate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify({ purpose: "x".repeat(300_000) }),
    })
    expect(response.status).toBe(413)
  })
})

describe("rate limiting", () => {
  it("limits repeated calls to the agent endpoints", async () => {
    const limited = await listen(2)
    try {
      const evaluate = () =>
        fetch(`${limited.base}/api/evaluate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "list_transactions" }),
        })

      const first = await evaluate()
      const second = await evaluate()
      const third = await evaluate()

      expect(first.status).toBe(200)
      expect(second.status).toBe(200)
      expect(third.status).toBe(429)
      expect(third.headers.get("retry-after")).not.toBeNull()
    } finally {
      limited.server.close()
    }
  })
})
