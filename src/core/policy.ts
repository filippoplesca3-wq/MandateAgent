/**
 * Policy engine.
 *
 * This is the component that decides whether an agent's intended payment is
 * permitted by the mandate it holds. It is deliberately pure and
 * deterministic: no network, no LLM, no clock except what is passed in. That
 * makes every decision reproducible and testable.
 *
 * Every rule that runs is recorded in `Decision.checks`, so a decision can be
 * explained to a human, shown in the UI, and replayed from the audit ledger.
 *
 * Default posture is deny: a tool this module does not recognise is refused
 * outright rather than allowed through.
 */

import { verifySignature, validateClaims, remainingBudget, formatMoney } from "./mandate.js"
import type {
  Decision,
  DecisionCode,
  MandateEnvelope,
  MandateState,
  PaymentProposal,
  RuleCheck,
} from "./types.js"

/**
 * How the policy engine treats a PayPal toolkit tool.
 *
 * - `read`   — no side effects. Permitted whenever the mandate is valid.
 * - `spend`  — commits or moves money. Subject to every budget and constraint.
 * - `mutate` — changes merchant state without moving money. Needs a valid
 *              mandate, but no amount checks apply.
 *
 * Any tool not listed here is denied. New tools added to the PayPal toolkit do
 * not silently become available to agents.
 */
export type ToolClass = "read" | "spend" | "mutate"

export const TOOL_CLASSES: Readonly<Record<string, ToolClass>> = Object.freeze({
  // --- read -----------------------------------------------------------------
  get_order: "read",
  get_invoice: "read",
  list_invoices: "read",
  list_transactions: "read",
  list_disputes: "read",
  get_dispute: "read",
  get_refund: "read",
  get_shipment_tracking: "read",
  list_products: "read",
  show_product_details: "read",
  list_subscription_plans: "read",
  show_subscription_plan_details: "read",
  show_subscription_details: "read",
  get_merchant_insights: "read",
  search_invoicing: "read",
  get_recurring_series: "read",
  generate_invoice_number: "read",
  generate_invoice_qr_code: "read",

  // --- spend ----------------------------------------------------------------
  create_order: "spend",
  pay_order: "spend",
  create_refund: "spend",
  create_subscription: "spend",
  create_subscription_plan: "spend",
  create_recurring_series: "spend",
  activate_recurring_series: "spend",
  record_payment_for_invoice: "spend",
  record_refund_for_invoice: "spend",

  // --- mutate ---------------------------------------------------------------
  send_invoice: "mutate",
  create_conditional_rules_for_invoice: "mutate",
  setup_invoice_auto_reminders: "mutate",
  update_invoice_auto_reminder: "mutate",
  cancel_subscription: "mutate",
  update_subscription: "mutate",
  cancel_sent_invoice: "mutate",
  delete_invoice: "mutate",
  cancel_invoice_auto_reminder: "mutate",
  cancel_recurring_series: "mutate",
  delete_recurring_series: "mutate",
  update_invoicing: "mutate",
  create_product: "mutate",
  update_product: "mutate",
  update_plan: "mutate",
  accept_dispute_claim: "mutate",
  create_shipment_tracking: "mutate",
  update_shipment_tracking: "mutate",
  send_invoice_reminder: "mutate",
})

export function toolClassOf(action: string): ToolClass | null {
  return TOOL_CLASSES[action] ?? null
}

export interface EvaluateInput {
  envelope: MandateEnvelope
  state: MandateState
  proposal: PaymentProposal
  signingKey: string
  now?: Date
}

/**
 * Evaluate a proposal against a mandate.
 *
 * Rules run in a fixed order, cheapest and most fundamental first, so the
 * reason a payment was refused is the most specific true statement about it.
 */
export function evaluate(input: EvaluateInput): Decision {
  const { envelope, state, proposal, signingKey } = input
  const now = input.now ?? new Date()
  const checks: RuleCheck[] = []

  const pass = (rule: string, detail: string): void => {
    checks.push({ rule, passed: true, detail })
  }
  const deny = (rule: string, detail: string, code: DecisionCode): Decision => {
    checks.push({ rule, passed: false, detail })
    return { allowed: false, code, reason: detail, checks }
  }

  // --- 1. signature ---------------------------------------------------------
  const sig = verifySignature(envelope, signingKey)
  if (!sig.valid) {
    return deny("signature", sig.reason, "SIGNATURE_INVALID")
  }
  pass("signature", "HMAC-SHA256 over canonical claims matches")

  const claims = envelope.claims

  // --- 2. claims well-formed and unexpired ----------------------------------
  const claimsValidity = validateClaims(claims, now)
  if (!claimsValidity.valid) {
    const code: DecisionCode = claimsValidity.reason.includes("expired")
      ? "MANDATE_EXPIRED"
      : "MALFORMED_MANDATE"
    return deny("validity", claimsValidity.reason, code)
  }
  pass("validity", `mandate is well formed and expires ${claims.expiresAt}`)

  // --- 3. not revoked -------------------------------------------------------
  if (state.revokedAt !== null) {
    return deny(
      "revocation",
      `mandate was revoked at ${state.revokedAt}`,
      "MANDATE_REVOKED",
    )
  }
  pass("revocation", "mandate is live and has not been revoked")

  // --- 4. tool is known and classified --------------------------------------
  const toolClass = toolClassOf(proposal.action)
  if (toolClass === null) {
    return deny(
      "tool-allowlist",
      `tool "${proposal.action}" is not in the policy allowlist, so it is refused by default`,
      "ACTION_NOT_PERMITTED",
    )
  }
  pass("tool-allowlist", `tool "${proposal.action}" is a known ${toolClass} tool`)

  // Non-spending tools are permitted on a valid mandate and need no more checks.
  if (toolClass !== "spend") {
    pass("tool-class", `${toolClass} tools do not commit money, so no spend rules apply`)
    return {
      allowed: true,
      code: "ALLOWED",
      reason: `${toolClass} tool permitted under a valid mandate`,
      checks,
    }
  }

  const constraints = claims.constraints

  // --- 5. merchant ----------------------------------------------------------
  const merchant = normalizeKey(proposal.merchant)

  if (constraints.allowMerchants && constraints.allowMerchants.length > 0) {
    if (merchant === null) {
      return deny(
        "merchant-allowlist",
        "this mandate only permits specific merchants, but the proposal named none",
        "MERCHANT_REQUIRED",
      )
    }
    const allowed = constraints.allowMerchants.map(normalizeKey)
    if (!allowed.includes(merchant)) {
      return deny(
        "merchant-allowlist",
        `merchant "${proposal.merchant}" is not in the permitted set [${constraints.allowMerchants.join(", ")}]`,
        "MERCHANT_NOT_ALLOWED",
      )
    }
    pass("merchant-allowlist", `merchant "${merchant}" is permitted`)
  } else {
    pass("merchant-allowlist", "no merchant allowlist on this mandate")
  }

  if (constraints.denyMerchants && constraints.denyMerchants.length > 0 && merchant !== null) {
    const denied = constraints.denyMerchants.map(normalizeKey)
    if (denied.includes(merchant)) {
      return deny(
        "merchant-denylist",
        `merchant "${proposal.merchant}" is explicitly blocked by this mandate`,
        "MERCHANT_DENIED",
      )
    }
    pass("merchant-denylist", `merchant "${proposal.merchant}" is not on the deny list`)
  } else {
    pass("merchant-denylist", "no merchant denylist on this mandate")
  }

  // --- 6. category ----------------------------------------------------------
  if (constraints.allowCategories && constraints.allowCategories.length > 0) {
    const category = normalizeKey(proposal.category)
    const allowed = constraints.allowCategories.map(normalizeKey)
    if (category === null || !allowed.includes(category)) {
      return deny(
        "category-allowlist",
        `category "${proposal.category ?? "(none)"}" is not in the permitted set [${constraints.allowCategories.join(", ")}]`,
        "CATEGORY_NOT_ALLOWED",
      )
    }
    pass("category-allowlist", `category "${category}" is permitted`)
  } else {
    pass("category-allowlist", "no category restriction on this mandate")
  }

  // --- 7. amount present and positive ---------------------------------------
  if (typeof proposal.amount !== "number" || !Number.isInteger(proposal.amount)) {
    return deny(
      "amount-present",
      "spending proposals must carry an integer amount in minor units",
      "AMOUNT_REQUIRED",
    )
  }
  if (proposal.amount <= 0) {
    return deny("amount-positive", `amount ${proposal.amount} is not positive`, "AMOUNT_NOT_POSITIVE")
  }
  pass("amount-present", `amount ${proposal.amount} minor units is a positive integer`)

  // --- 8. currency ----------------------------------------------------------
  if (normalizeKey(proposal.currency) !== normalizeKey(claims.budget.currency)) {
    return deny(
      "currency",
      `proposal is in ${proposal.currency ?? "(none)"} but the mandate budget is in ${claims.budget.currency}`,
      "CURRENCY_MISMATCH",
    )
  }
  pass("currency", `currency matches the mandate budget (${claims.budget.currency})`)

  // --- 9. per-transaction ceiling -------------------------------------------
  const perTx = constraints.maxPerTransaction
  if (perTx) {
    if (proposal.amount > perTx.amount) {
      return deny(
        "max-per-transaction",
        `${proposal.amount} exceeds the per-transaction ceiling of ${perTx.amount}`,
        "MAX_PER_TRANSACTION_EXCEEDED",
      )
    }
    pass(
      "max-per-transaction",
      `${proposal.amount} is within the per-transaction ceiling of ${perTx.amount}`,
    )
  } else {
    pass("max-per-transaction", "no per-transaction ceiling on this mandate")
  }

  // --- 10. transaction count ------------------------------------------------
  if (typeof constraints.maxTransactions === "number") {
    if (state.transactionCount >= constraints.maxTransactions) {
      return deny(
        "max-transactions",
        `mandate permits ${constraints.maxTransactions} transactions and ${state.transactionCount} have already been made`,
        "MAX_TRANSACTIONS_EXCEEDED",
      )
    }
    pass(
      "max-transactions",
      `${state.transactionCount} of ${constraints.maxTransactions} permitted transactions used`,
    )
  } else {
    pass("max-transactions", "no transaction-count limit on this mandate")
  }

  // --- 11. cumulative budget ------------------------------------------------
  const remaining = remainingBudget(claims, state)
  if (proposal.amount > remaining.amount) {
    return deny(
      "budget",
      `${formatMoney({ amount: proposal.amount, currency: claims.budget.currency })} exceeds the ${formatMoney(remaining)} remaining of the ${formatMoney(claims.budget)} budget`,
      "BUDGET_EXCEEDED",
    )
  }
  pass("budget", `leaves ${formatMoney({ amount: remaining.amount - proposal.amount, currency: claims.budget.currency })} of budget`)

  // --- 12. escalation threshold ---------------------------------------------
  const escalateAbove = constraints.requireApprovalAbove
  if (escalateAbove && proposal.amount > escalateAbove.amount) {
    checks.push({
      rule: "approval-threshold",
      passed: false,
      detail: `${proposal.amount} exceeds the auto-approval threshold of ${escalateAbove.amount}, so a human must confirm`,
    })
    return {
      allowed: false,
      code: "REQUIRES_HUMAN_APPROVAL",
      reason: `a human must approve this payment: it exceeds the ${formatMoney(escalateAbove)} auto-approval threshold`,
      checks,
      requiresApproval: true,
    }
  }
  if (escalateAbove) {
    pass(
      "approval-threshold",
      `${proposal.amount} is at or below the ${escalateAbove.amount} auto-approval threshold`,
    )
  } else {
    pass("approval-threshold", "no auto-approval threshold on this mandate")
  }

  // --- 13. settle -----------------------------------------------------------
  checks.push({
    rule: "decision",
    passed: true,
    detail: `all ${checks.length + 1} rules passed`,
  })

  return {
    allowed: true,
    code: "ALLOWED",
    reason: `permitted: ${formatMoney({ amount: proposal.amount, currency: claims.budget.currency })} at ${proposal.merchant ?? "(unnamed merchant)"}`,
    checks,
  }
}

function normalizeKey(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim().toLowerCase()
  return trimmed.length === 0 ? null : trimmed
}
