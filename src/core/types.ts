/**
 * Domain types for Agent Mandate.
 *
 * Money is always an integer in minor units (cents) plus a currency code.
 * Floats are never used for money anywhere in this codebase.
 */

/** ISO-4217 currency code, e.g. "EUR", "USD". */
export type Currency = string

/**
 * An amount of money in minor units (e.g. 620 EUR => 62000).
 * Kept as a plain integer so arithmetic is exact.
 */
export interface Money {
  amount: number
  currency: Currency
}

// ---------------------------------------------------------------------------
// Mandate
// ---------------------------------------------------------------------------

/**
 * The signed, immutable claims of a mandate. This is exactly the data an HMAC
 * covers — anything outside these claims is not protected by the signature.
 */
export interface MandateClaims {
  /** Stable id for this mandate. */
  id: string
  /** Human principal granting the authority (the account holder). */
  principal: string
  /** Agent receiving the authority. */
  agentId: string
  /** When the mandate was issued, ISO-8601. */
  issuedAt: string
  /** Hard expiry, ISO-8601. After this the mandate is dead. */
  expiresAt: string
  /** Maximum total spend across all transactions under this mandate. */
  budget: Money
  /** Natural-language statement of what the human intended. */
  purpose: string
  constraints: MandateConstraints
  /** Anti-replay value, unique per mandate. */
  nonce: string
}

export interface MandateConstraints {
  /** If set, only these merchant keys may be paid. */
  allowMerchants?: string[]
  /** If set, these merchant keys may never be paid. */
  denyMerchants?: string[]
  /** If set, only these spend categories may be used. */
  allowCategories?: string[]
  /** Ceiling for any single transaction. */
  maxPerTransaction?: Money
  /** Maximum number of spend transactions. */
  maxTransactions?: number
  /**
   * Above this amount, the policy engine refuses to auto-approve and asks a
   * human. This is the "escalate rather than deny" path.
   */
  requireApprovalAbove?: Money
}

/** A mandate plus its detached signature. */
export interface MandateEnvelope {
  claims: MandateClaims
  /** hex-encoded HMAC-SHA256 over the canonicalized claims. */
  signature: string
  /** Ed25519 public key of the issuer, informational. */
  algorithm: "HMAC-SHA256"
}

/** Runtime-only state that is deliberately NOT signed. */
export interface MandateState {
  mandateId: string
  revokedAt: string | null
  spendToDate: Money
  transactionCount: number
}

// ---------------------------------------------------------------------------
// Proposals and decisions
// ---------------------------------------------------------------------------

/**
 * What the agent is trying to do. The policy engine is the only thing allowed
 * to turn a proposal into a PayPal call.
 */
export interface PaymentProposal {
  /** PayPal toolkit tool name, e.g. "create_order", "pay_order". */
  action: string
  /** Merchant key the payment would go to, if known. */
  merchant?: string
  /** Amount being committed, in minor units. */
  amount?: number
  currency?: Currency
  /** Spend category, used by category constraints. */
  category?: string
  /** Human-readable description for the ledger. */
  description?: string
}

/** Outcome of evaluating a proposal against a mandate. */
export interface Decision {
  allowed: boolean
  code: DecisionCode
  /** One-line explanation, safe to show a user or an agent. */
  reason: string
  /** Every rule that ran, in order. Powers the UI and the audit trail. */
  checks: RuleCheck[]
  /** Populated when a human must approve before the call proceeds. */
  requiresApproval?: boolean
}

export interface RuleCheck {
  rule: string
  passed: boolean
  detail: string
}

export type DecisionCode =
  | "ALLOWED"
  | "MALFORMED_MANDATE"
  | "SIGNATURE_INVALID"
  | "MANDATE_EXPIRED"
  | "MANDATE_REVOKED"
  | "ACTION_NOT_PERMITTED"
  | "MERCHANT_REQUIRED"
  | "MERCHANT_NOT_ALLOWED"
  | "MERCHANT_DENIED"
  | "CATEGORY_NOT_ALLOWED"
  | "AMOUNT_REQUIRED"
  | "AMOUNT_NOT_POSITIVE"
  | "CURRENCY_MISMATCH"
  | "MAX_PER_TRANSACTION_EXCEEDED"
  | "MAX_TRANSACTIONS_EXCEEDED"
  | "BUDGET_EXCEEDED"
  | "REQUIRES_HUMAN_APPROVAL"

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export interface LedgerEntry {
  id: string
  at: string
  mandateId: string
  agentId: string
  action: string
  proposal: PaymentProposal
  decision: Decision
  /** PayPal order/invoice id once the call actually succeeded. */
  externalRef?: string
  /** Tool result payload, truncated for display. */
  result?: string
}

// ---------------------------------------------------------------------------
// Trust
// ---------------------------------------------------------------------------

/** Raw signals a seller can inspect before accepting an agent's money. */
export interface TrustSignals {
  agentId: string
  transactionCount: number
  disputeCount: number
  refundCount: number
  totalVolume: number
  currency: Currency
  firstSeenAt: string | null
  mandateActive: boolean
}

export type TrustTier = "unknown" | "high-risk" | "emerging" | "reliable" | "trusted"

export interface TrustScore {
  agentId: string
  score: number
  tier: TrustTier
  factors: TrustFactor[]
  signals: TrustSignals
}

export interface TrustFactor {
  factor: string
  /** Signed contribution to the score. */
  impact: number
  detail: string
}
