import { afterEach, describe, expect, it } from "vitest"
import type { AddressInfo } from "node:net"
import type { Server } from "node:http"
import { Store } from "../src/core/store.js"
import { createSimulatedTools } from "../src/paypal/simulated.js"
import { createApp, type LiveDemoConfig } from "../src/server/app.js"
import {
  ChatRefused,
  chatSnapshot,
  confirmChatProposal,
  createChatSession,
  takeChatTurn,
  type ChatRunner,
} from "../src/server/chat-demo.js"
import { AGENT_ID, MERCHANT } from "../src/server/demo.js"
import type { ServerSnapshot } from "../src/server/snapshot.js"
import { TEST_KEY } from "./helpers.js"

const SECRET_KEY = "server-side-gemini-key-do-not-leak"

/** A runner that behaves like a model choosing one catalog item. */
function runnerFor(itemId: string, text = "Here is the item I can get."): ChatRunner {
  return async (input) => {
    const tools = input.tools as Record<
      string,
      { execute?: (args: unknown, options: unknown) => Promise<unknown> } | undefined
    >
    const propose = tools["propose_purchase"]
    if (!propose?.execute) throw new Error("propose_purchase is missing")

    const raw = await propose.execute(
      { itemId },
      { toolCallId: "test-proposal", messages: input.messages },
    )
    const output = typeof raw === "string" ? raw : JSON.stringify(raw)

    return {
      model: "fake-model",
      text,
      durationMs: 3,
      toolCalls: [{ toolName: "propose_purchase", input: { itemId }, output }],
    }
  }
}

interface ChatBody {
  ok: boolean
  live?: boolean
  sessionId: string
  model?: string
  text?: string
  proposal: {
    id: string
    itemId: string
    name: string
    amount: number
    allowed: boolean
    requiresApproval: boolean
    code: string
    reason: string
    status: string
  } | null
  turns: number
  turnsRemaining: number
  snapshot: ServerSnapshot
  verification: { signatureValid: boolean; claimsValid: boolean }
  receipt: {
    itemId: string
    amount: number
    orderId: string
    captureId?: string
    approvals: number
  }
  error?: string
  code?: string
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

async function chat(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/api/demo/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function confirm(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/api/demo/chat/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("chat demo — session isolation", () => {
  it("gives every chat a fresh mandate, signing key and ledger", () => {
    const first = createChatSession()
    const second = createChatSession()

    expect(first.id).not.toBe(second.id)
    expect(first.mandateId).not.toBe(second.mandateId)
    expect(first.store.publicKeyBase64).not.toBe(second.store.publicKeyBase64)
    expect(first.store.ledger.list()).toHaveLength(0)
    expect(second.store.ledger.list()).toHaveLength(0)
  })

  it("proposes the $45 headset and leaves the budget untouched until approval", async () => {
    const session = createChatSession()
    const turn = await takeChatTurn(session, "I want a new headset around $45", {
      apiKey: "test-key",
      runner: runnerFor("headset"),
    })

    expect(turn.proposal?.itemId).toBe("headset")
    expect(turn.proposal?.amount).toBe(4_500)
    expect(turn.proposal?.requiresApproval).toBe(true)
    expect(turn.proposal?.allowed).toBe(false)
    expect(turn.proposal?.code).toBe("REQUIRES_HUMAN_APPROVAL")
    expect(session.store.get(session.mandateId)?.state.spendToDate.amount).toBe(0)
    expect(session.messages).toHaveLength(2)
  })

  it("pays the proposed headset only when the visitor confirms", async () => {
    const session = createChatSession()
    const turn = await takeChatTurn(session, "I want a new headset around $45", {
      apiKey: "test-key",
      runner: runnerFor("headset"),
    })
    expect(turn.proposal).not.toBeNull()

    const result = await confirmChatProposal(session, turn.proposal!.id)

    expect(result.receipt.itemId).toBe("headset")
    expect(result.receipt.amount).toBe(4_500)
    expect(result.receipt.approvals).toBe(2)
    expect(result.receipt.orderId).toMatch(/^ORD/)
    expect(result.receipt.captureId).toMatch(/^CAP/)
    expect(result.proposal.status).toBe("purchased")

    const stored = session.store.get(session.mandateId)!
    expect(stored.state.spendToDate.amount).toBe(4_500)
    expect(session.store.effectiveRemaining(session.mandateId)?.amount).toBe(7_500)
    expect(session.store.ledger.list().filter((entry) => entry.committed)).toHaveLength(1)
    expect(session.store.listApprovals()).toHaveLength(0)
  })

  it("refuses a $75 monitor before it reaches PayPal", async () => {
    const session = createChatSession()
    const turn = await takeChatTurn(session, "I want the $75 monitor", {
      apiKey: "test-key",
      runner: runnerFor("monitor"),
    })

    expect(turn.proposal?.allowed).toBe(false)
    expect(turn.proposal?.requiresApproval).toBe(false)
    expect(turn.proposal?.code).toBe("MAX_PER_TRANSACTION_EXCEEDED")

    await expect(confirmChatProposal(session, turn.proposal!.id)).rejects.toMatchObject({
      name: "ChatRefused",
      code: "MAX_PER_TRANSACTION_EXCEEDED",
    })
    expect(session.store.get(session.mandateId)?.state.spendToDate.amount).toBe(0)
    expect(session.store.ledger.list()).toHaveLength(0)
  })

  it("spends a proposal once, even if the visitor clicks twice", async () => {
    const session = createChatSession()
    const turn = await takeChatTurn(session, "A headset please", {
      apiKey: "test-key",
      runner: runnerFor("headset"),
    })

    await confirmChatProposal(session, turn.proposal!.id)
    await expect(confirmChatProposal(session, turn.proposal!.id)).rejects.toBeInstanceOf(ChatRefused)
    await expect(confirmChatProposal(session, turn.proposal!.id)).rejects.toMatchObject({
      code: "ALREADY_PURCHASED",
    })
    expect(session.store.get(session.mandateId)?.state.spendToDate.amount).toBe(4_500)
  })

  it("does not let one chat spend another chat's mandate", async () => {
    const first = createChatSession()
    const second = createChatSession()
    const turn = await takeChatTurn(first, "A headset please", {
      apiKey: "test-key",
      runner: runnerFor("headset"),
    })

    await expect(confirmChatProposal(second, turn.proposal!.id)).rejects.toMatchObject({
      code: "UNKNOWN_PROPOSAL",
    })
    expect(second.store.ledger.list()).toHaveLength(0)
    expect(first.store.get(first.mandateId)?.state.spendToDate.amount).toBe(0)
  })
})

describe("chat demo — endpoint", () => {
  it("is off unless the deployment configures it", async () => {
    harness = await start()

    const turn = await chat(harness.base, { message: "hello" })
    expect(turn.status).toBe(503)
    expect(((await turn.json()) as ChatBody).error).toContain("not enabled")

    const buy = await confirm(harness.base, { sessionId: "1234567890", proposalId: "1234567890" })
    expect(buy.status).toBe(503)
  })

  it("runs the first turn, returns a proposal and keeps the key server-side", async () => {
    harness = await start({
      apiKey: SECRET_KEY,
      dailyCap: 5,
      cooldownMs: 0,
      chatMaxTurns: 4,
      chatRunner: runnerFor("headset"),
    })

    const response = await chat(harness.base, {
      message: "I want a new headset around $40-50. Is the budget enough?",
    })
    const body = (await response.json()) as ChatBody

    expect(response.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.sessionId).toBeTruthy()
    expect(body.proposal?.itemId).toBe("headset")
    expect(body.proposal?.requiresApproval).toBe(true)
    expect(body.turns).toBe(1)
    expect(body.turnsRemaining).toBe(3)
    expect(body.snapshot.mandate?.claims.id).toBeTruthy()
    expect(body.verification.signatureValid).toBe(true)
    expect(body.verification.claimsValid).toBe(true)
    expect(JSON.stringify(body)).not.toContain(SECRET_KEY)

    const stateBody = await (await fetch(`${harness.base}/api/state`)).text()
    expect(stateBody).not.toContain(SECRET_KEY)
    expect(JSON.parse(stateBody).live).toEqual({ enabled: true, remaining: 4, cap: 5 })
  })

  it("executes the approved proposal and returns a receipt", async () => {
    harness = await start({
      apiKey: SECRET_KEY,
      dailyCap: 5,
      cooldownMs: 0,
      chatRunner: runnerFor("headset"),
    })

    const turn = (await (
      await chat(harness.base, { message: "A headset around $45, please" })
    ).json()) as ChatBody

    const response = await confirm(harness.base, {
      sessionId: turn.sessionId,
      proposalId: turn.proposal!.id,
    })
    const body = (await response.json()) as ChatBody

    expect(response.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.receipt.amount).toBe(4_500)
    expect(body.receipt.approvals).toBe(2)
    expect(body.snapshot.mandate?.state.spendToDate.amount).toBe(4_500)
    expect(body.snapshot.mandate?.remaining.amount).toBe(7_500)
    expect(body.snapshot.summary.allowed).toBe(2)
    expect(body.snapshot.summary.denied).toBe(0)
    expect(body.snapshot.approvals).toHaveLength(0)
    expect(body.verification.signatureValid).toBe(true)

    const again = await confirm(harness.base, {
      sessionId: turn.sessionId,
      proposalId: turn.proposal!.id,
    })
    expect(again.status).toBe(402)
    expect(((await again.json()) as ChatBody).code).toBe("ALREADY_PURCHASED")
  })

  it("does not charge a new daily chat when a session continues", async () => {
    harness = await start({
      apiKey: SECRET_KEY,
      dailyCap: 5,
      cooldownMs: 60_000,
      chatMaxTurns: 4,
      chatRunner: runnerFor("headset"),
    })

    const first = (await (
      await chat(harness.base, { message: "I want a headset" })
    ).json()) as ChatBody
    expect(first.turnsRemaining).toBe(3)

    const second = await chat(harness.base, {
      sessionId: first.sessionId,
      message: "Is the budget enough?",
    })
    const secondBody = (await second.json()) as ChatBody

    expect(second.status).toBe(200)
    expect(secondBody.sessionId).toBe(first.sessionId)
    expect(secondBody.turns).toBe(2)

    const state = (await (await fetch(`${harness.base}/api/state`)).json()) as {
      live: { remaining: number }
    }
    expect(state.live.remaining).toBe(4)

    // A brand-new chat hits the per-address cooldown; continuing one does not.
    const third = await chat(harness.base, { message: "Another headset" })
    expect(third.status).toBe(429)
    expect(third.headers.get("retry-after")).toBeTruthy()
  })

  it("enforces the per-chat turn limit", async () => {
    harness = await start({
      apiKey: SECRET_KEY,
      dailyCap: 5,
      cooldownMs: 0,
      chatMaxTurns: 1,
      chatRunner: runnerFor("headset"),
    })

    const first = (await (
      await chat(harness.base, { message: "I want a headset" })
    ).json()) as ChatBody
    expect(first.turnsRemaining).toBe(0)

    const second = await chat(harness.base, {
      sessionId: first.sessionId,
      message: "And a keyboard too",
    })
    const body = (await second.json()) as ChatBody
    expect(second.status).toBe(429)
    expect(body.error).toContain("1 turns")
  })

  it("rejects an overlong message without spending the daily budget", async () => {
    harness = await start({
      apiKey: SECRET_KEY,
      dailyCap: 5,
      cooldownMs: 0,
      chatRunner: runnerFor("headset"),
    })

    const response = await chat(harness.base, { message: "x".repeat(501) })
    expect(response.status).toBe(400)

    const state = (await (await fetch(`${harness.base}/api/state`)).json()) as {
      live: { remaining: number }
    }
    expect(state.live.remaining).toBe(5)
  })

  it("refuses a non-JSON POST", async () => {
    harness = await start({
      apiKey: SECRET_KEY,
      dailyCap: 5,
      cooldownMs: 0,
      chatRunner: runnerFor("headset"),
    })

    const response = await fetch(`${harness.base}/api/demo/chat`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello",
    })
    expect(response.status).toBe(415)
  })

  it("reports an expired session instead of creating a mandate for it", async () => {
    harness = await start({
      apiKey: SECRET_KEY,
      dailyCap: 5,
      cooldownMs: 0,
      chatRunner: runnerFor("headset"),
    })

    const response = await chat(harness.base, {
      sessionId: "00000000-0000-4000-8000-000000000000",
      message: "hello",
    })
    expect(response.status).toBe(410)
  })

  it("refuses an unknown proposal without calling PayPal", async () => {
    harness = await start({
      apiKey: SECRET_KEY,
      dailyCap: 5,
      cooldownMs: 0,
      chatRunner: runnerFor("headset"),
    })

    const turn = (await (
      await chat(harness.base, { message: "A headset" })
    ).json()) as ChatBody

    const response = await confirm(harness.base, {
      sessionId: turn.sessionId,
      proposalId: "00000000-0000-4000-8000-000000000000",
    })
    const body = (await response.json()) as ChatBody
    expect(response.status).toBe(402)
    expect(body.code).toBe("UNKNOWN_PROPOSAL")
  })

  it("returns a model failure with the session id so the chat can continue", async () => {
    harness = await start({
      apiKey: SECRET_KEY,
      dailyCap: 5,
      cooldownMs: 0,
      chatRunner: async () => {
        throw new Error("model quota exhausted")
      },
    })

    const response = await chat(harness.base, { message: "A headset" })
    const body = (await response.json()) as ChatBody

    expect(response.status).toBe(502)
    expect(body.ok).toBe(false)
    expect(body.sessionId).toBeTruthy()
    expect(body.error).toContain("model quota exhausted")
    expect(JSON.stringify(body)).not.toContain(SECRET_KEY)
  })

  it("shares the daily budget with one-shot live runs", async () => {
    harness = await start({
      apiKey: SECRET_KEY,
      dailyCap: 1,
      cooldownMs: 0,
      chatRunner: runnerFor("headset"),
    })

    const first = await chat(harness.base, { message: "A headset" })
    expect(first.status).toBe(200)

    const second = await chat(harness.base, { message: "Another headset" })
    const body = (await second.json()) as ChatBody
    expect(second.status).toBe(429)
    expect(body.error).toContain("budget")
  })

  it("exposes the isolated chat ledger in the snapshot", async () => {
    const session = createChatSession()
    const turn = await takeChatTurn(session, "A headset", {
      apiKey: "test-key",
      runner: runnerFor("headset"),
    })
    await confirmChatProposal(session, turn.proposal!.id)

    const snapshot = chatSnapshot(session)
    // Each escalation is recorded when it is parked, then the approved retry is
    // recorded too. The approvals themselves are consumed, not left pending.
    expect(snapshot.ledger.map((entry) => entry.action)).toEqual([
      "pay_order",
      "pay_order",
      "create_order",
      "create_order",
    ])
    expect(snapshot.summary.allowed).toBe(2)
    expect(snapshot.summary.pendingApproval).toBe(2)
    expect(snapshot.approvals).toHaveLength(0)
    expect(snapshot.mandate?.remaining.amount).toBe(7_500)
  })
})
