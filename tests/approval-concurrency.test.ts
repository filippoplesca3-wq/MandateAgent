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
let store: Store
let mandateId: string
let approvalId: string

beforeAll(async () => {
  store = new Store(TEST_KEY)
  const { envelope } = store.issue({
    principal: "filippo@example.com",
    agentId: "agent-procurement-01",
    budget: { amount: 50_000, currency: "USD" },
    purpose: "Restock office supplies",
    now: new Date(),
    constraints: { requireApprovalAbove: { amount: 1_000, currency: "USD" } },
  })
  mandateId = envelope.claims.id

  const orderId = "ORD00000000000001"
  const { app } = createApp({
    store,
    rawTools: createSimulatedTools({
      merchantId: MERCHANT,
      seedOrders: [
        { id: orderId, status: "CREATED", amount: 5_000, currency: "USD", merchant: MERCHANT },
      ],
    }),
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

  // Park exactly the payment the guard would park when the threshold is hit.
  const pending = store.parkForApproval({
    mandateId,
    agentId: "agent-procurement-01",
    action: "pay_order",
    proposal: {
      action: "pay_order",
      merchant: MERCHANT,
      amount: 5_000,
      currency: "USD",
      orderId,
    },
    decision: {
      allowed: false,
      requiresApproval: true,
      code: "REQUIRES_HUMAN_APPROVAL",
      reason: "above the approval threshold",
      checks: [],
    },
    args: { id: orderId },
  })
  approvalId = pending.id
})

afterAll(() => {
  server.close()
})

describe("approval resolution", () => {
  it("executes a payment only once under two concurrent approve calls", async () => {
    const resolve = () =>
      fetch(`${base}/api/approvals/${approvalId}/resolve`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ADMIN_TOKEN}`,
        },
        body: JSON.stringify({ approve: true }),
      })

    const [first, second] = await Promise.all([resolve(), resolve()])
    const statuses = [first.status, second.status].sort()

    expect(statuses).toEqual([200, 400])

    const allowed = store.ledger
      .list()
      .filter((entry) => entry.action === "pay_order" && entry.decision.allowed)
    expect(allowed).toHaveLength(1)
    expect(store.get(mandateId)?.state.spendToDate.amount).toBe(5_000)
  })
})
