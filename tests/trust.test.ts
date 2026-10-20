import { describe, it, expect } from "vitest"
import { scoreAgentTrust } from "../src/core/trust.js"
import type { TrustSignals } from "../src/core/types.js"

const BASE = 50

function signals(overrides: Partial<TrustSignals> = {}): TrustSignals {
  return {
    agentId: "agent-procurement-01",
    transactionCount: 0,
    disputeCount: 0,
    refundCount: 0,
    totalVolume: 0,
    currency: "EUR",
    firstSeenAt: null,
    mandateActive: false,
    ...overrides,
  }
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString()
}

describe("scoreAgentTrust", () => {
  it("treats an agent with no history as unknown and below neutral", () => {
    const score = scoreAgentTrust(signals())
    expect(score.tier).toBe("unknown")
    expect(score.score).toBe(BASE - 10 - 10)
  })

  it("rewards a long, clean history", () => {
    const score = scoreAgentTrust(
      signals({
        transactionCount: 40,
        disputeCount: 0,
        refundCount: 0,
        firstSeenAt: daysAgo(400),
        mandateActive: true,
      }),
    )
    expect(score.tier).toBe("trusted")
    expect(score.score).toBeGreaterThanOrEqual(80)
  })

  it("punishes a high dispute rate", () => {
    const clean = scoreAgentTrust(
      signals({ transactionCount: 40, disputeCount: 0, firstSeenAt: daysAgo(400) }),
    )
    const messy = scoreAgentTrust(
      signals({ transactionCount: 40, disputeCount: 8, firstSeenAt: daysAgo(400) }),
    )
    expect(messy.score).toBeLessThan(clean.score)
    expect(messy.tier === "high-risk" || messy.tier === "emerging").toBe(true)
  })

  it("is monotonic: more disputes can never raise the score", () => {
    let previous = Number.POSITIVE_INFINITY
    for (let disputes = 0; disputes <= 10; disputes += 1) {
      const score = scoreAgentTrust(
        signals({ transactionCount: 20, disputeCount: disputes, firstSeenAt: daysAgo(200) }),
      ).score
      expect(score).toBeLessThanOrEqual(previous)
      previous = score
    }
  })

  it("penalises refunds less severely than disputes", () => {
    const refunds = scoreAgentTrust(
      signals({ transactionCount: 20, refundCount: 5, firstSeenAt: daysAgo(200) }),
    )
    const disputes = scoreAgentTrust(
      signals({ transactionCount: 20, disputeCount: 5, firstSeenAt: daysAgo(200) }),
    )
    expect(refunds.score).toBeGreaterThan(disputes.score)
  })

  it("gives a brand-new counterparty a tenure penalty", () => {
    const score = scoreAgentTrust(
      signals({ transactionCount: 5, firstSeenAt: daysAgo(1) }),
    )
    const tenure = score.factors.find((factor) => factor.factor === "tenure")
    expect(tenure?.impact).toBe(-10)
  })

  it("clamps the score into 0..100", () => {
    const floor = scoreAgentTrust(
      signals({ transactionCount: 1, disputeCount: 1, firstSeenAt: daysAgo(0) }),
    )
    expect(floor.score).toBeGreaterThanOrEqual(0)
    expect(floor.score).toBeLessThanOrEqual(100)
  })

  it("explains itself: factor impacts sum to the score delta", () => {
    const score = scoreAgentTrust(
      signals({ transactionCount: 15, disputeCount: 2, firstSeenAt: daysAgo(200) }),
    )
    const totalImpact = score.factors.reduce((sum, factor) => sum + factor.impact, 0)
    expect(score.score).toBe(BASE + totalImpact)
  })

  it("records a factor for every scoring dimension", () => {
    const names = scoreAgentTrust(signals()).factors.map((factor) => factor.factor)
    expect(names).toEqual(
      expect.arrayContaining(["activity", "disputes", "refunds", "tenure", "mandate"]),
    )
  })

  it("gives an active mandate a positive nudge", () => {
    const withoutMandate = scoreAgentTrust(
      signals({ transactionCount: 10, firstSeenAt: daysAgo(100), mandateActive: false }),
    )
    const withMandate = scoreAgentTrust(
      signals({ transactionCount: 10, firstSeenAt: daysAgo(100), mandateActive: true }),
    )
    expect(withMandate.score).toBe(withoutMandate.score + 5)
  })
})
