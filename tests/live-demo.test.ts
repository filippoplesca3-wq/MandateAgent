import { afterEach, describe, expect, it } from "vitest"
import type { AddressInfo } from "node:net"
import type { Server } from "node:http"
import { Store } from "../src/core/store.js"
import { createSimulatedTools } from "../src/paypal/simulated.js"
import type { ToolExecOptions, ToolSet } from "../src/paypal/tool-types.js"
import { createApp, type LiveDemoConfig } from "../src/server/app.js"
import { AGENT_ID, MERCHANT } from "../src/server/demo.js"
import { createLiveRun, type LiveRunInput, type LiveRunOutput } from "../src/server/live-demo.js"
import { buildSnapshot } from "../src/server/snapshot.js"
import { TEST_KEY } from "./helpers.js"

const EXEC: ToolExecOptions = { toolCallId: "live-test", messages: [] }
const SECRET_KEY = "server-side-gemini-key-do-not-leak"

async function call(tools: ToolSet, name: string, args: unknown): Promise<any> {
  const tool = tools[name]
  if (!tool || typeof tool.execute !== "function") throw new Error(`no tool ${name}`)
  const raw = await tool.execute(args, { ...EXEC, toolCallId: `t-${name}` })
  return typeof raw === "string" ? JSON.parse(raw) : raw
}

/** A complete live-run payload without calling Gemini. */
function fakeOutput(model = "fake-model"): LiveRunOutput {
  const { store, mandateId } = createLiveRun()
  return {
    run: {
      model,
      task: "test",
      text: "The mandate refused the sketchy order.",
      steps: [
        {
          index: 0,
          text: "",
          toolCalls: [
            {
              toolName: "pay_order",
              input: { id: "ORD00000000009001" },
              output: JSON.stringify({
                ok: false,
                code: "MERCHANT_NOT_ALLOWED",
                reason: "sketchy-deals is not an allowed merchant",
              }),
            },
          ],
        },
      ],
      durationMs: 5,
    },
    snapshot: buildSnapshot(store, mandateId, {
      mode: "simulated",
      note: "live test",
      agentId: AGENT_ID,
      merchantId: MERCHANT,
      running: false,
      model,
    }),
    publicKey: store.publicKeyBase64,
    verification: { signatureValid: true, claimsValid: true },
  }
}

interface Harness {
  base: string
  close: () => void
}

async function start(liveDemo?: LiveDemoConfig): Promise<Harness> {
  const store = new Store(TEST_KEY)
  const { envelope } = store.issue({
    principal: "filippo@example.com",
    agentId: AGENT_ID,
    budget: { amount: 12_000, currency: "USD" },
    purpose: "Restock office supplies",
    now: new Date(),
  })

  const { app } = createApp({
    store,
    rawTools: createSimulatedTools({ merchantId: MERCHANT }),
    mandateId: envelope.claims.id,
    agentId: AGENT_ID,
    merchantId: MERCHANT,
    mode: "simulated",
    note: "test",
    ...(liveDemo ? { liveDemo } : {}),
  })

  const server: Server = app.listen(0)
  await new Promise<void>((resolve) => server.once("listening", resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { base, close: () => server.close() }
}

let harness: Harness | null = null

afterEach(() => {
  harness?.close()
  harness = null
})

const post = (base: string) =>
  fetch(`${base}/api/demo/live-run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  })

const postTask = (base: string, task: unknown) =>
  fetch(`${base}/api/demo/live-run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task }),
  })

describe("live run — isolation", () => {
  it("gives every run a fresh mandate, signing key and ledger", () => {
    const first = createLiveRun()
    const second = createLiveRun()

    expect(first.mandateId).not.toBe(second.mandateId)
    expect(first.store.publicKeyBase64).not.toBe(second.store.publicKeyBase64)
    expect(first.store.ledger.list()).toHaveLength(0)
    expect(second.store.ledger.list()).toHaveLength(0)
  })

  it("denies the sketchy order in its own store and leaves the other run untouched", async () => {
    const first = createLiveRun()
    const second = createLiveRun()

    const denied = await call(first.tools, "pay_order", { id: "ORD00000000009001" })
    expect(denied.ok).toBe(false)
    expect(denied.code).toBe("MERCHANT_NOT_ALLOWED")

    expect(first.store.ledger.list()).toHaveLength(1)
    expect(second.store.ledger.list()).toHaveLength(0)
  })

  it("escalates the 45.00 order instead of paying it automatically", async () => {
    const { store, mandateId, tools } = createLiveRun()

    const result = await call(tools, "pay_order", { id: "ORD00000000009002" })
    expect(result.code).toBe("REQUIRES_HUMAN_APPROVAL")
    expect(store.get(mandateId)!.state.spendToDate.amount).toBe(0)
  })
})

describe("live run — endpoint", () => {
  it("is off unless the deployment configures it", async () => {
    harness = await start()
    const response = await post(harness.base)
    const body = (await response.json()) as { ok: boolean; error: string }

    expect(response.status).toBe(503)
    expect(body.ok).toBe(false)
    expect(body.error).toContain("not enabled")
  })

  it("runs once and returns the run, snapshot and verification", async () => {
    harness = await start({ apiKey: SECRET_KEY, dailyCap: 5, run: async () => fakeOutput() })
    const response = await post(harness.base)
    const body = (await response.json()) as LiveRunOutput & { ok: boolean; live: boolean }

    expect(response.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.live).toBe(true)
    expect(body.run.model).toBe("fake-model")
    expect(body.verification.signatureValid).toBe(true)
    expect(body.verification.claimsValid).toBe(true)
    expect(body.publicKey.length).toBeGreaterThan(40)
    expect(body.snapshot.mandate?.claims.id).toBeTruthy()
    expect(body.snapshot.summary.denied).toBe(0)
  })

  it("passes the visitor's task to the run, trimmed", async () => {
    const seen: LiveRunInput[] = []
    harness = await start({
      apiKey: SECRET_KEY,
      dailyCap: 5,
      run: async (input) => {
        seen.push(input)
        return fakeOutput()
      },
    })

    const response = await postTask(harness.base, "  Buy a red stapler from acme-supplies.  ")
    expect(response.status).toBe(200)
    expect(seen[0]?.task).toBe("Buy a red stapler from acme-supplies.")
    expect(seen[0]?.apiKey).toBe(SECRET_KEY)
  })

  it("leaves the task unset when the visitor sends none or only spaces", async () => {
    const seen: LiveRunInput[] = []
    harness = await start({
      apiKey: SECRET_KEY,
      dailyCap: 5,
      run: async (input) => {
        seen.push(input)
        return fakeOutput()
      },
    })

    expect((await post(harness.base)).status).toBe(200)
    expect((await postTask(harness.base, "   ")).status).toBe(200)
    expect(seen[0]?.task).toBeUndefined()
    expect(seen[1]?.task).toBeUndefined()
  })

  it("rejects an overlong task without spending the daily budget", async () => {
    let calls = 0
    harness = await start({
      apiKey: SECRET_KEY,
      dailyCap: 5,
      run: async () => {
        calls += 1
        return fakeOutput()
      },
    })

    const response = await postTask(harness.base, "x".repeat(601))
    const body = (await response.json()) as { ok: boolean; error: string }
    expect(response.status).toBe(400)
    expect(body.error).toContain("task")
    expect(calls).toBe(0)

    const state = (await (await fetch(`${harness.base}/api/state`)).json()) as {
      live: { remaining: number }
    }
    expect(state.live.remaining).toBe(5)
  })

  it("never includes the server-side key in a response or the state snapshot", async () => {
    harness = await start({ apiKey: SECRET_KEY, dailyCap: 5, run: async () => fakeOutput() })

    const runBody = await (await post(harness.base)).text()
    const stateBody = await (await fetch(`${harness.base}/api/state`)).text()

    expect(runBody).not.toContain(SECRET_KEY)
    expect(stateBody).not.toContain(SECRET_KEY)
    expect(JSON.parse(stateBody).live).toEqual({ enabled: true, remaining: 4, cap: 5 })
  })

  it("refuses more runs once the daily cap is spent", async () => {
    harness = await start({ apiKey: SECRET_KEY, dailyCap: 1, run: async () => fakeOutput() })

    const first = await post(harness.base)
    expect(first.status).toBe(200)

    const second = await post(harness.base)
    const body = (await second.json()) as { ok: boolean; error: string }
    expect(second.status).toBe(429)
    expect(body.error).toContain("budget")
  })

  it("allows another run immediately, with no cooldown", async () => {
    harness = await start({
      apiKey: SECRET_KEY,
      dailyCap: 5,
      run: async () => fakeOutput(),
    })

    expect((await post(harness.base)).status).toBe(200)
    expect((await post(harness.base)).status).toBe(200)

    const state = (await (await fetch(`${harness.base}/api/state`)).json()) as {
      live: { remaining: number }
    }
    expect(state.live.remaining).toBe(3)
  })

  it("allows only one run in flight", async () => {
    let release: (value: LiveRunOutput) => void = () => {}
    let started: () => void = () => {}
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve
    })
    const gate = new Promise<LiveRunOutput>((resolve) => {
      release = resolve
    })

    harness = await start({
      apiKey: SECRET_KEY,
      dailyCap: 5,
      run: () => {
        started()
        return gate
      },
    })

    const first = post(harness.base)
    await startedPromise

    const second = await post(harness.base)
    const body = (await second.json()) as { ok: boolean; error: string }
    expect(second.status).toBe(429)
    expect(body.error).toContain("in progress")

    release(fakeOutput())
    expect((await first).status).toBe(200)
  })

  it("refuses a non-JSON POST so a cross-site form cannot burn the budget", async () => {
    harness = await start({ apiKey: SECRET_KEY, dailyCap: 5, run: async () => fakeOutput() })

    const response = await fetch(`${harness.base}/api/demo/live-run`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "go",
    })
    expect(response.status).toBe(415)
    expect((await response.json()).ok).toBe(false)
  })

  it("reports a failed run without leaking internals", async () => {
    harness = await start({
      apiKey: SECRET_KEY,
      dailyCap: 5,
      run: async () => {
        throw new Error("model quota exhausted")
      },
    })

    const response = await post(harness.base)
    const body = (await response.json()) as { ok: boolean; error: string }
    expect(response.status).toBe(502)
    expect(body.ok).toBe(false)
    expect(body.error).toContain("model quota exhausted")
    expect(JSON.stringify(body)).not.toContain(SECRET_KEY)
  })
})
