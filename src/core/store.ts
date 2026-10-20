/**
 * Runtime state for Agent Mandate.
 *
 * The policy engine is pure: it takes a mandate, a proposal, and a clock, and
 * returns a decision. This module holds the mutable state that surrounds it —
 * issued mandates, how much of each budget has been spent, the audit ledger,
 * seller-side trust signals, and payments waiting on a human.
 *
 * Everything lives in memory. That is a deliberate choice for a demo: it makes
 * the whole system inspectable from a test or a REPL with no database to stand
 * up. Persistence would be a storage adapter behind the same methods.
 */

import { randomUUID } from "node:crypto"
import { Ledger } from "./ledger.js"
import {
  issueMandate,
  newMandateState,
  revokeMandate,
  type IssueMandateSpec,
} from "./mandate.js"
import { evaluate } from "./policy.js"
import { scoreAgentTrust } from "./trust.js"
import type {
  Decision,
  LedgerEntry,
  MandateEnvelope,
  MandateState,
  PaymentProposal,
  TrustScore,
  TrustSignals,
} from "./types.js"

export interface StoredMandate {
  envelope: MandateEnvelope
  state: MandateState
}

export interface PendingApproval {
  id: string
  at: string
  mandateId: string
  agentId: string
  action: string
  proposal: PaymentProposal
  decision: Decision
  status: "pending" | "approved" | "rejected"
  resolvedAt?: string
  /**
   * Raw tool arguments, kept so that an approved payment can be executed
   * exactly as it was proposed rather than reconstructed from the proposal.
   */
  args?: unknown
}

export interface ExecutionRecord {
  decision: Decision
  entry: LedgerEntry
  /** Present when the call was executed against PayPal. */
  externalRef?: string
}

export class Store {
  readonly ledger = new Ledger()

  private readonly mandates = new Map<string, StoredMandate>()
  private readonly approvals = new Map<string, PendingApproval>()
  private readonly agentSignals = new Map<string, TrustSignals>()

  constructor(private readonly signingKey: string) {
    if (!signingKey || signingKey.length < 16) {
      throw new Error(
        "Store requires a signing key of at least 16 characters; set MANDATE_SIGNING_KEY",
      )
    }
  }

  // -------------------------------------------------------------------------
  // Mandates
  // -------------------------------------------------------------------------

  issue(spec: IssueMandateSpec): StoredMandate {
    const envelope = issueMandate(spec, this.signingKey)
    const stored: StoredMandate = {
      envelope,
      state: newMandateState(envelope.claims.id, envelope.claims.budget.currency),
    }
    this.mandates.set(envelope.claims.id, stored)
    return stored
  }

  get(mandateId: string): StoredMandate | undefined {
    return this.mandates.get(mandateId)
  }

  getOrThrow(mandateId: string): StoredMandate {
    const found = this.mandates.get(mandateId)
    if (!found) throw new Error(`no mandate with id ${mandateId}`)
    return found
  }

  /** Newest first. */
  list(): StoredMandate[] {
    return [...this.mandates.values()].reverse()
  }

  revoke(mandateId: string): boolean {
    const found = this.mandates.get(mandateId)
    if (!found) return false
    if (found.state.revokedAt === null) {
      found.state = revokeMandate(found.state)
    }
    return true
  }

  // -------------------------------------------------------------------------
  // Evaluation and execution
  // -------------------------------------------------------------------------

  /**
   * Evaluate a proposal without executing anything. Used by the "dry run"
   * panel in the UI and by the executor before it touches PayPal.
   */
  evaluate(mandateId: string, proposal: PaymentProposal): Decision {
    const found = this.mandates.get(mandateId)
    if (!found) {
      const checks = [
        { rule: "mandate-lookup", passed: false, detail: `no mandate with id ${mandateId}` },
      ]
      return {
        allowed: false,
        code: "MALFORMED_MANDATE",
        reason: `no mandate with id ${mandateId}`,
        checks,
      }
    }

    return evaluate({
      envelope: found.envelope,
      state: found.state,
      proposal,
      signingKey: this.signingKey,
    })
  }

  /**
   * Record that an allowed payment actually went through. This is the only
   * place a mandate's spend counter moves, so the budget can never drift from
   * the ledger.
   */
  commitSpend(mandateId: string, amount: number): void {
    const found = this.getOrThrow(mandateId)
    found.state.spendToDate = {
      amount: found.state.spendToDate.amount + amount,
      currency: found.state.spendToDate.currency,
    }
    found.state.transactionCount += 1
  }

  /**
   * Record a refused or escalated proposal in the ledger.
   */
  record(entry: {
    mandateId: string
    agentId: string
    action: string
    proposal: PaymentProposal
    decision: Decision
    externalRef?: string
    result?: string
  }): LedgerEntry {
    return this.ledger.append(entry)
  }

  // -------------------------------------------------------------------------
  // Human approvals (the escalation path)
  // -------------------------------------------------------------------------

  /**
   * Park a payment that the policy engine escalated. The executor stops here
   * rather than calling PayPal: an escalated payment is not a failed payment,
   * it is one waiting on the human who set the threshold.
   */
  parkForApproval(input: {
    mandateId: string
    agentId: string
    action: string
    proposal: PaymentProposal
    decision: Decision
    args?: unknown
  }): PendingApproval {
    const pending: PendingApproval = {
      id: randomUUID(),
      at: new Date().toISOString(),
      mandateId: input.mandateId,
      agentId: input.agentId,
      action: input.action,
      proposal: input.proposal,
      decision: input.decision,
      status: "pending",
      ...(input.args !== undefined ? { args: input.args } : {}),
    }
    this.approvals.set(pending.id, pending)

    this.ledger.append({
      mandateId: input.mandateId,
      agentId: input.agentId,
      action: input.action,
      proposal: input.proposal,
      decision: input.decision,
    })

    return pending
  }

  listPending(): PendingApproval[] {
    return [...this.approvals.values()]
      .filter((item) => item.status === "pending")
      .sort((a, b) => b.at.localeCompare(a.at))
  }

  listApprovals(): PendingApproval[] {
    return [...this.approvals.values()].sort((a, b) => b.at.localeCompare(a.at))
  }

  resolveApproval(approvalId: string, approved: boolean): PendingApproval | undefined {
    const found = this.approvals.get(approvalId)
    if (!found || found.status !== "pending") return undefined
    found.status = approved ? "approved" : "rejected"
    found.resolvedAt = new Date().toISOString()
    return found
  }

  /**
   * Find an already-approved approval that authorises exactly this payment.
   *
   * Used by the guard when a payment it previously parked comes back. Matching
   * is exact on mandate, action, amount and merchant, so an approval can never
   * be stretched to cover a different payment.
   */
  findApprovedApproval(expected: {
    mandateId: string
    action: string
    amount?: number
    merchant?: string
  }): PendingApproval | undefined {
    for (const item of this.approvals.values()) {
      if (item.status !== "approved") continue
      if (item.mandateId !== expected.mandateId) continue
      if (item.action !== expected.action) continue
      if (item.proposal.amount !== expected.amount) continue
      if (normalize(item.proposal.merchant) !== normalize(expected.merchant)) continue
      return item
    }
    return undefined
  }

  /**
   * Consume a human approval for one specific payment.
   *
   * An approval authorises exactly one payment of exactly one amount at
   * exactly one merchant. It is spent on use, so an approved payment cannot be
   * replayed, and it cannot be stretched to cover a different amount.
   */
  consumeApproval(
    approvalId: string,
    expected: { mandateId: string; action: string; amount?: number; merchant?: string },
  ): boolean {
    const found = this.approvals.get(approvalId)
    if (!found || found.status !== "approved") return false
    if (found.mandateId !== expected.mandateId) return false
    if (found.action !== expected.action) return false
    if (found.proposal.amount !== expected.amount) return false
    if (normalize(found.proposal.merchant) !== normalize(expected.merchant)) return false

    this.approvals.delete(approvalId)
    return true
  }

  // -------------------------------------------------------------------------
  // Seller-side trust
  // -------------------------------------------------------------------------

  /**
   * Seed or replace the PayPal history a merchant holds for an agent. In
   * production this is populated from `list_transactions` and `list_disputes`;
   * tests and the demo call it directly.
   */
  setAgentSignals(signals: TrustSignals): void {
    this.agentSignals.set(signals.agentId, signals)
  }

  getAgentSignals(agentId: string): TrustSignals {
    return (
      this.agentSignals.get(agentId) ?? {
        agentId,
        transactionCount: 0,
        disputeCount: 0,
        refundCount: 0,
        totalVolume: 0,
        currency: "EUR",
        firstSeenAt: null,
        mandateActive: false,
      }
    )
  }

  /** Whether the agent currently holds any live mandate. */
  hasLiveMandate(agentId: string): boolean {
    const now = Date.now()
    for (const { envelope, state } of this.mandates.values()) {
      if (envelope.claims.agentId !== agentId) continue
      if (state.revokedAt !== null) continue
      if (Date.parse(envelope.claims.expiresAt) <= now) continue
      return true
    }
    return false
  }

  trustFor(agentId: string): TrustScore {
    const signals = this.getAgentSignals(agentId)
    return scoreAgentTrust({ ...signals, mandateActive: this.hasLiveMandate(agentId) })
  }

  listTrustScores(): TrustScore[] {
    const ids = new Set<string>([
      ...this.agentSignals.keys(),
      ...[...this.mandates.values()].map((m) => m.envelope.claims.agentId),
    ])
    return [...ids]
      .map((id) => this.trustFor(id))
      .sort((a, b) => b.score - a.score)
  }
}

function normalize(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim().toLowerCase()
  return trimmed.length === 0 ? null : trimmed
}

export type { MandateState }
