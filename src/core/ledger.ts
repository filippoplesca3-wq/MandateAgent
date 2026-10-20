/**
 * Append-only audit ledger.
 *
 * Every proposal an agent makes is recorded here, whether it was permitted or
 * refused. Refusals are the interesting half: they are the evidence that the
 * mandate was actually enforced rather than merely displayed.
 */

import { randomUUID } from "node:crypto"
import type { Decision, LedgerEntry, PaymentProposal } from "./types.js"

export interface AppendInput {
  mandateId: string
  agentId: string
  action: string
  proposal: PaymentProposal
  decision: Decision
  externalRef?: string
  result?: string
}

export type LedgerSubscriber = (entry: LedgerEntry) => void

/** Cap on stored entries so a long-running demo cannot exhaust memory. */
const MAX_ENTRIES = 5_000

export class Ledger {
  private entries: LedgerEntry[] = []
  private readonly subscribers = new Set<LedgerSubscriber>()

  append(input: AppendInput): LedgerEntry {
    const entry: LedgerEntry = {
      id: randomUUID(),
      at: new Date().toISOString(),
      mandateId: input.mandateId,
      agentId: input.agentId,
      action: input.action,
      proposal: input.proposal,
      decision: input.decision,
      ...(input.externalRef !== undefined ? { externalRef: input.externalRef } : {}),
      ...(input.result !== undefined ? { result: input.result } : {}),
    }

    this.entries.push(entry)
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES)
    }

    for (const subscriber of this.subscribers) {
      try {
        subscriber(entry)
      } catch {
        // A broken subscriber must never break the audit trail.
      }
    }

    return entry
  }

  /** Newest first. */
  list(): LedgerEntry[] {
    return [...this.entries].reverse()
  }

  subscribe(fn: LedgerSubscriber): () => void {
    this.subscribers.add(fn)
    return () => {
      this.subscribers.delete(fn)
    }
  }

  clear(): void {
    this.entries = []
  }

  /** Totals used by the dashboard header. */
  summary(): {
    total: number
    allowed: number
    denied: number
    pendingApproval: number
    denialReasons: Record<string, number>
  } {
    let allowed = 0
    let denied = 0
    let pendingApproval = 0
    const denialReasons: Record<string, number> = {}

    for (const entry of this.entries) {
      if (entry.decision.allowed) {
        allowed += 1
        continue
      }
      if (entry.decision.requiresApproval) {
        pendingApproval += 1
      } else {
        denied += 1
      }
      denialReasons[entry.decision.code] = (denialReasons[entry.decision.code] ?? 0) + 1
    }

    return { total: this.entries.length, allowed, denied, pendingApproval, denialReasons }
  }
}
