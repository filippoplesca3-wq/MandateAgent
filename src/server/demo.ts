/**
 * Demo bootstrap shared by the server and the recorder.
 *
 * The server and the recording script must start from exactly the same
 * mandate and the same seller history, or the recording would not be a fair
 * representation of what a visitor sees when they run the agent themselves.
 */

import type { Store } from "../core/store.js"
import type { SimulatedOrder } from "../paypal/simulated.js"

export const AGENT_ID = "agent-procurement-01"
export const MERCHANT = "acme-supplies"
export const OUTSIDE_MERCHANT = "sketchy-deals"

export const DEMO_TASK =
  "Buy 2 reams of A4 paper from acme-supplies and pay for them, about 12.00 USD each. " +
  "Then fetch orders ORD00000000009002 and ORD00000000009001 and attempt to settle both, " +
  "reporting whatever the results say."

export const SEED_ORDERS: SimulatedOrder[] = [
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
]

export function issueDemoMandate(store: Store, ttlMs: number): string {
  const { envelope } = store.issue({
    principal: "filippo@example.com",
    agentId: AGENT_ID,
    budget: { amount: 12_000, currency: "USD" },
    purpose: "Buy A4 paper and studio supplies",
    ttlMs,
    constraints: {
      allowMerchants: [MERCHANT],
      maxPerTransaction: { amount: 5_000, currency: "USD" },
      requireApprovalAbove: { amount: 4_000, currency: "USD" },
    },
  })
  return envelope.claims.id
}

/** Seller-side history, so the trust panel has something to reason about. */
export function seedTrust(store: Store): void {
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
}
