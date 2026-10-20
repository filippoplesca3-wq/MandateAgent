/**
 * Seller-side trust scoring.
 *
 * The novel half of Agent Mandate. Today a merchant has no way to assess an AI
 * agent that arrives wanting to buy something — they see a payment request and
 * nothing else. This module turns a merchant's own PayPal history for an agent
 * into a single explainable number, so the merchant can decide whether to
 * accept agent money at all.
 *
 * The score is deterministic arithmetic over PayPal signals. No model is
 * involved, so the same history always produces the same score, and every
 * point of it can be explained to the merchant who has to act on it.
 */

import type { TrustFactor, TrustScore, TrustSignals, TrustTier } from "./types.js"

/** Neutral starting point. Good and bad signals move it from here. */
const BASE_SCORE = 50

const DISPUTE_PENALTY_MAX = 40
const REFUND_PENALTY_MAX = 10

/** A dispute rate at or above this is treated as the worst case. */
const DISPUTE_RATE_SATURATION = 0.1

export function scoreAgentTrust(signals: TrustSignals): TrustScore {
  const factors: TrustFactor[] = []
  let score = BASE_SCORE

  const add = (factor: string, impact: number, detail: string): void => {
    score += impact
    factors.push({ factor, impact, detail })
  }

  const tx = Math.max(0, signals.transactionCount)

  // --- activity -------------------------------------------------------------
  if (tx === 0) {
    add(
      "activity",
      -10,
      "no prior transactions between this merchant and this agent; there is no history to reason from",
    )
  } else if (tx < 3) {
    add("activity", 0, `${tx} prior transaction${tx === 1 ? "" : "s"} — too little history to be informative`)
  } else if (tx < 10) {
    add("activity", 8, `${tx} prior transactions establish an emerging track record`)
  } else {
    add("activity", 15, `${tx} prior transactions establish a durable relationship`)
  }

  // --- disputes -------------------------------------------------------------
  const disputes = Math.max(0, signals.disputeCount)
  if (disputes > 0 && tx > 0) {
    const rate = disputes / tx
    const severity = Math.min(1, rate / DISPUTE_RATE_SATURATION)
    const impact = -Math.round(DISPUTE_PENALTY_MAX * severity)
    add(
      "disputes",
      impact,
      `${disputes} dispute${disputes === 1 ? "" : "s"} across ${tx} transactions (${(rate * 100).toFixed(1)}% dispute rate)`,
    )
  } else {
    add("disputes", 0, "no disputes on record")
  }

  // --- refunds --------------------------------------------------------------
  const refunds = Math.max(0, signals.refundCount)
  if (refunds > 0 && tx > 0) {
    const rate = Math.min(1, refunds / tx)
    const impact = -Math.round(REFUND_PENALTY_MAX * rate)
    add(
      "refunds",
      impact,
      `${refunds} refund${refunds === 1 ? "" : "s"} across ${tx} transactions (${(rate * 100).toFixed(1)}% refund rate)`,
    )
  } else {
    add("refunds", 0, "no refunds on record")
  }

  // --- tenure ---------------------------------------------------------------
  if (signals.firstSeenAt) {
    const first = Date.parse(signals.firstSeenAt)
    if (Number.isNaN(first)) {
      add("tenure", 0, "first-seen date is unreadable, so tenure is not scored")
    } else {
      const days = Math.floor((Date.now() - first) / 86_400_000)
      if (days < 7) {
        add("tenure", -10, `first seen ${days} day${days === 1 ? "" : "s"} ago — brand new counterparty`)
      } else if (days < 90) {
        add("tenure", 0, `known to this merchant for ${days} days`)
      } else if (days < 365) {
        add("tenure", 6, `known to this merchant for ${days} days`)
      } else {
        add("tenure", 10, `known to this merchant for over a year (${days} days)`)
      }
    }
  } else {
    add("tenure", -10, "no first-seen date, so this agent has no history with this merchant")
  }

  // --- live authority -------------------------------------------------------
  if (signals.mandateActive) {
    add("mandate", 5, "agent currently holds an unexpired, unrevoked mandate from a named principal")
  } else {
    add("mandate", 0, "agent holds no active mandate with this merchant")
  }

  const clamped = clamp(score, 0, 100)

  return {
    agentId: signals.agentId,
    score: clamped,
    tier: tierFor(clamped, tx),
    factors,
    signals,
  }
}

function tierFor(score: number, transactionCount: number): TrustTier {
  if (transactionCount === 0 && score <= BASE_SCORE) return "unknown"
  if (score < 30) return "high-risk"
  if (score < 60) return "emerging"
  if (score < 80) return "reliable"
  return "trusted"
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
