/**
 * Typed access to the API, plus the live-state hook the UI runs on.
 *
 * The server sends whole snapshots rather than deltas. For a demo of this size
 * that is simpler and strictly more robust: there is no client-side state
 * machine to get out of sync, and a reconnect always recovers the truth.
 */

import { useEffect, useState } from "react"

export interface Money {
  amount: number
  currency: string
}

export interface MandateClaims {
  id: string
  principal: string
  agentId: string
  issuedAt: string
  expiresAt: string
  budget: Money
  purpose: string
  constraints: {
    allowMerchants?: string[]
    denyMerchants?: string[]
    allowCategories?: string[]
    maxPerTransaction?: Money
    maxTransactions?: number
    requireApprovalAbove?: Money
  }
  nonce: string
}

export interface MandateState {
  mandateId: string
  spendToDate: Money
  transactionCount: number
  revokedAt: string | null
}

export interface Decision {
  allowed: boolean
  code: string
  reason: string
  requiresApproval?: boolean
  checks: { rule: string; passed: boolean; detail: string }[]
}

export interface LedgerEntry {
  id: string
  at: string
  mandateId: string
  agentId: string
  action: string
  proposal: {
    action: string
    merchant?: string
    amount?: number
    currency?: string
    description?: string
  }
  decision: Decision
  externalRef?: string
  result?: string
}

export interface PendingApproval {
  id: string
  at: string
  mandateId: string
  agentId: string
  action: string
  proposal: { action: string; merchant?: string; amount?: number; currency?: string }
  decision: Decision
  status: "pending" | "approved" | "rejected"
  resolvedAt?: string
}

export interface TrustFactor {
  factor: string
  impact: number
  detail: string
}

export interface TrustScore {
  agentId: string
  score: number
  tier: string
  factors: TrustFactor[]
  signals: {
    transactionCount: number
    disputeCount: number
    refundCount: number
    totalVolume: number
    currency: string
    firstSeenAt: string | null
    mandateActive: boolean
  }
}

export interface Snapshot {
  mode: string
  note: string
  agentId: string
  merchantId: string
  model: string | null
  running: boolean
  mandate: {
    claims: MandateClaims
    signature: string
    algorithm: string
    state: MandateState
    remaining: Money
  } | null
  ledger: LedgerEntry[]
  summary: {
    total: number
    allowed: number
    denied: number
    pendingApproval: number
    denialReasons: Record<string, number>
  }
  approvals: PendingApproval[]
  trust: TrustScore[]
}

export interface AgentStep {
  index: number
  text: string
  toolCalls: { toolName: string; input: unknown; output?: string }[]
}

export interface AgentRunResponse {
  ok: boolean
  model?: string
  text?: string
  steps?: AgentStep[]
  durationMs?: number
  error?: string
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  })
  const body = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok) {
    throw new Error(body?.error ?? `Request failed with status ${response.status}`)
  }
  return body
}

/**
 * Subscribe to the server's snapshot stream, with polling as a fallback for
 * environments where SSE is buffered by a proxy.
 */
export function useLiveState(): {
  state: Snapshot | null
  connected: boolean
  error: string | null
} {
  const [state, setState] = useState<Snapshot | null>(null)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const source = new EventSource("/api/stream")

    source.onopen = () => {
      setConnected(true)
      setError(null)
    }

    source.onmessage = (event) => {
      try {
        setState(JSON.parse(event.data) as Snapshot)
        setConnected(true)
      } catch {
        // A truncated frame is not worth tearing the stream down; the next
        // snapshot will arrive whole.
      }
    }

    source.onerror = () => {
      setConnected(false)
      setError("Live connection lost. Reconnecting…")
    }

    return () => source.close()
  }, [])

  useEffect(() => {
    if (connected) return
    let cancelled = false

    const poll = async (): Promise<void> => {
      try {
        const next = await api<Snapshot>("/api/state")
        if (!cancelled) setState(next)
      } catch {
        // Keep the last good snapshot on screen.
      }
    }

    void poll()
    const timer = setInterval(() => void poll(), 2_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [connected])

  return { state, connected, error }
}
