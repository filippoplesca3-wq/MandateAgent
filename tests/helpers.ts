import { issueMandate, newMandateState, type IssueMandateSpec } from "../src/core/mandate.js"
import type { MandateEnvelope, MandateState, MandateConstraints, Money } from "../src/core/types.js"

export const TEST_KEY = "test-signing-key-long-enough-to-be-valid"

export const EUR = (amount: number): Money => ({ amount, currency: "EUR" })

export interface Fixture {
  envelope: MandateEnvelope
  state: MandateState
}

export function makeMandate(
  overrides: {
    spec?: Partial<IssueMandateSpec>
    constraints?: MandateConstraints
    now?: Date
  } = {},
): Fixture {
  const now = overrides.now ?? new Date("2026-01-01T00:00:00.000Z")

  const envelope = issueMandate(
    {
      principal: "filippo@example.com",
      agentId: "agent-procurement-01",
      budget: EUR(50_000),
      purpose: "Restock office supplies for the studio",
      now,
      ...overrides.spec,
      ...(overrides.constraints ? { constraints: overrides.constraints } : {}),
    },
    TEST_KEY,
  )

  return {
    envelope,
    state: newMandateState(envelope.claims.id, envelope.claims.budget.currency),
  }
}

/** A well-formed spending proposal that the default fixture mandate permits. */
export function goodProposal() {
  return {
    action: "create_order",
    merchant: "acme-supplies",
    amount: 2_500,
    currency: "EUR",
    category: "office-supplies",
    description: "200x A4 paper",
  }
}
