/**
 * The snapshot shape every surface agrees on.
 *
 * The HTTP API, the recorder and the replay player all produce this same
 * object, so a recording is byte-for-byte what a live server would have sent.
 * That is what makes replay trustworthy: it is not a re-enactment, it is the
 * recorded state.
 */

import { remainingBudget } from "../core/mandate.js"
import type { PendingApproval, Store } from "../core/store.js"
import type {
  LedgerEntry,
  MandateClaims,
  MandateState,
  Money,
  TrustScore,
} from "../core/types.js"

export interface ReplayInfo {
  /** When the recording was made, ISO-8601. */
  recordedAt: string
  /** Model that actually answered during the recording. */
  model: string
  /** Task the recording agent was given. */
  task: string
  /** PayPal mode the recording was made in ("simulated" or "live"). */
  paypalMode: string
}

export interface LedgerSummary {
  total: number
  allowed: number
  denied: number
  pendingApproval: number
  denialReasons: Record<string, number>
}

export interface SnapshotMeta {
  mode: string
  note: string
  agentId: string
  merchantId: string
  model?: string
  running: boolean
  replay?: ReplayInfo
}

export interface ServerSnapshot {
  mode: string
  note: string
  agentId: string
  merchantId: string
  model: string | null
  running: boolean
  replay: ReplayInfo | null
  mandate: {
    claims: MandateClaims
    signature: string
    algorithm: string
    state: MandateState
    remaining: Money
  } | null
  ledger: LedgerEntry[]
  summary: LedgerSummary
  approvals: PendingApproval[]
  trust: TrustScore[]
}

export function buildSnapshot(
  store: Store,
  mandateId: string,
  meta: SnapshotMeta,
): ServerSnapshot {
  const stored = store.get(mandateId)
  return {
    mode: meta.mode,
    note: meta.note,
    agentId: meta.agentId,
    merchantId: meta.merchantId,
    model: meta.model ?? null,
    running: meta.running,
    replay: meta.replay ?? null,
    mandate: stored
      ? {
          claims: stored.envelope.claims,
          signature: stored.envelope.signature,
          algorithm: stored.envelope.algorithm,
          state: stored.state,
          remaining: remainingBudget(stored.envelope.claims, stored.state),
        }
      : null,
    ledger: store.ledger.list(),
    summary: store.ledger.summary(),
    approvals: store.listApprovals(),
    trust: store.listTrustScores(),
  }
}
