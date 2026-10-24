/**
 * The enforced tool layer.
 *
 * PayPal's toolkit hands an agent 47 tools, several of which move real money.
 * `guardTools` wraps every one of them so that no call reaches PayPal until it
 * has been evaluated against the mandate, and so that every outcome is written
 * to the audit ledger.
 *
 * Two details make this more than a wrapper:
 *
 * 1. The amount is resolved from the thing actually being paid, not trusted
 *    from the agent. `pay_order` carries only an order id, so the guard reads
 *    the order first and enforces the policy against the order's real total.
 *    An agent cannot quote one price and be charged another.
 *
 * 2. Escalated payments are parked, not executed. They come back to a human
 *    with an approval id that authorises exactly one payment of exactly that
 *    amount, and the approval is spent on use.
 */

import type { ToolExecOptions, ToolLike, ToolSet } from "./tool-types.js"
import type { PendingApproval, Store } from "../core/store.js"
import { toolClassOf } from "../core/policy.js"
import type { Decision, LedgerEntry, PaymentProposal } from "../core/types.js"

/** Tools that move money and therefore consume the mandate's budget. */
/** Tools whose success actually moves money, and therefore the budget. */
export const COMMITTING_TOOLS = new Set(["pay_order", "record_payment_for_invoice"])

export interface GuardOptions {
  store: Store
  mandateId: string
  agentId: string
  /**
   * The merchant this account sells as. Used to attribute `create_order`,
   * which has no merchant argument because the order is created by the
   * authenticated merchant.
   */
  merchantId?: string
  /**
   * Maps PayPal's own merchant identifiers (merchant id or email address) to
   * the names a mandate uses. A mandate says "acme-supplies"; PayPal says
   * "HM98ZL79EKJ6Q". Without this the live path cannot match the two.
   */
  merchantAliases?: Record<string, string>
  /** Whether to put read-only calls in the ledger. Off by default. */
  recordReads?: boolean
  onLedgerEntry?: (entry: LedgerEntry) => void
  onEscalation?: (pending: PendingApproval) => void
}

export interface GuardedTools {
  tools: Record<string, ToolLike>
}

export function guardTools(
  rawTools: Record<string, ToolLike>,
  options: GuardOptions,
): GuardedTools {
  const guarded: Record<string, ToolLike> = {}

  for (const [name, tool] of Object.entries(rawTools)) {
    guarded[name] = {
      ...tool,
      execute: async (args: unknown, execOptions: ToolExecOptions) =>
        executeGuarded(name, rawTools, tool, args, execOptions, options),
    }
  }

  return { tools: guarded }
}

async function executeGuarded(
  action: string,
  rawTools: Record<string, ToolLike>,
  tool: ToolLike,
  args: unknown,
  execOptions: ToolExecOptions,
  options: GuardOptions,
): Promise<unknown> {
  const { store, mandateId, agentId } = options
  const toolClass = toolClassOf(action)

  const proposal = await resolveProposal(action, args, rawTools, options)

  let decision = store.evaluate(mandateId, proposal)

  // --- a human may have already approved exactly this payment --------------
  // Escalation is not a dead end. When the same payment comes back after a
  // human approved it, the approval is consumed and the call proceeds. The
  // match is exact on action, amount and merchant, and the approval is deleted
  // on use, so it authorises one payment and cannot be replayed.
  if (!decision.allowed && decision.requiresApproval) {
    const expected = {
      mandateId,
      action,
      ...(proposal.amount !== undefined ? { amount: proposal.amount } : {}),
      ...(proposal.merchant !== undefined ? { merchant: proposal.merchant } : {}),
    }
    const approved = store.findApprovedApproval(expected)
    if (approved && store.consumeApproval(approved.id, expected)) {
      decision = {
        ...decision,
        allowed: true,
        requiresApproval: false,
        code: "ALLOWED",
        reason: `approved by a human (approval ${approved.id.slice(0, 8)})`,
        checks: [
          ...decision.checks,
          { rule: "human-approval", passed: true, detail: `approval ${approved.id}` },
        ],
      }
    }
  }

  // --- escalated: ask a human, do not call PayPal --------------------------
  if (decision.requiresApproval) {
    const pending = store.parkForApproval({
      mandateId,
      agentId,
      action,
      proposal,
      decision,
      ...(args !== undefined ? { args } : {}),
    })
    options.onEscalation?.(pending)
    return payload({
      ok: false,
      code: decision.code,
      reason: decision.reason,
      approvalId: pending.id,
    })
  }

  // --- refused: record why, tell the agent, do not call PayPal -------------
  if (!decision.allowed) {
    if (proposal.action !== action) {
      // resolveProposal may rewrite the action; report the tool actually called
      proposal.action = action
    }
    record(store, options, {
      mandateId,
      agentId,
      action,
      proposal,
      decision,
    })
    return payload({
      ok: false,
      code: decision.code,
      reason: decision.reason,
    })
  }

  // --- permitted: call PayPal ----------------------------------------------
  if (typeof tool.execute !== "function") {
    return payload({
      ok: false,
      code: "TOOL_ERROR",
      reason: `tool "${action}" has no execute function`,
    })
  }

  let result: unknown
  try {
    result = await tool.execute(args, execOptions)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    record(store, options, {
      mandateId,
      agentId,
      action,
      proposal,
      decision,
      result: `TOOL_ERROR: ${reason}`,
    })
    return payload({ ok: false, code: "TOOL_ERROR", reason })
  }

  // PayPal reports some failures in the payload rather than by throwing. A
  // failed call must never move the budget.
  const failure = errorFromResult(result)
  if (failure) {
    record(store, options, {
      mandateId,
      agentId,
      action,
      proposal,
      decision,
      result: `TOOL_ERROR: ${failure}`,
    })
    return payload({ ok: false, code: "TOOL_ERROR", reason: failure })
  }

  // Only now, after the call succeeded, does the budget move.
  if (toolClass === "spend" && COMMITTING_TOOLS.has(action) && typeof proposal.amount === "number") {
    store.commitSpend(mandateId, proposal.amount)
  }

  const externalRef = extractExternalRef(result)

  // Reads are noisy; only spend and mutate calls go in the ledger by default.
  if (toolClass !== "read" || options.recordReads) {
    record(store, options, {
      mandateId,
      agentId,
      action,
      proposal,
      decision,
      ...(externalRef ? { externalRef } : {}),
      result: preview(result),
    })
  }

  return payload({ ok: true, code: "ALLOWED", reason: decision.reason, result })
}

function record(store: Store, options: GuardOptions, input: Parameters<Store["record"]>[0]): void {
  const entry = store.record(input)
  options.onLedgerEntry?.(entry)
}

// ---------------------------------------------------------------------------
// Argument resolution
// ---------------------------------------------------------------------------

/**
 * Turn raw tool arguments into the proposal the policy engine judges.
 *
 * Where the amount is not in the arguments, it is read from PayPal. This is
 * the crucial step: policy is enforced against what will actually be charged.
 */
async function resolveProposal(
  action: string,
  args: unknown,
  rawTools: Record<string, ToolLike>,
  options: GuardOptions,
): Promise<PaymentProposal> {
  const input = asObject(args) ?? {}
  const proposal: PaymentProposal = {
    action,
    ...(typeof input.description === "string" ? { description: input.description } : {}),
  }

  if (action === "create_order") {
    const total = totalFromOrderInput(input)
    if (total) {
      proposal.amount = total.amount
      proposal.currency = total.currency
    }
    if (options.merchantId) {
      proposal.merchant = options.merchantId
    }
    return proposal
  }

  if (action === "pay_order") {
    // The agent supplies only an order id. Read the order to learn what it is
    // actually for, so the policy judges the real payment rather than the
    // agent's description of it.
    const orderId = typeof input.id === "string" ? input.id : undefined
    if (orderId) {
      const order = await readOrder(rawTools, orderId)
      const details = orderDetails(order)
      if (details) {
        proposal.amount = details.amount
        proposal.currency = details.currency
        if (details.merchant) {
          proposal.merchant = aliasMerchant(details.merchant, options.merchantAliases)
        }
      }
      proposal.description = proposal.description ?? `capture order ${orderId}`
    }
    return proposal
  }

  if (action === "create_refund") {
    const amount = asObject(input.amount)
    if (amount && typeof amount.value === "string" && typeof amount.currency_code === "string") {
      const parsed = Math.round(Number.parseFloat(amount.value) * 100)
      if (Number.isFinite(parsed)) {
        proposal.amount = parsed
        proposal.currency = amount.currency_code
      }
    }
    if (options.merchantId) {
      proposal.merchant = options.merchantId
    }
    return proposal
  }

  // Other tools carry no resolvable amount. If one is a spend tool the policy
  // engine will refuse it for lack of an amount, which is the safe outcome.
  const explicit = explicitAmount(input)
  if (explicit) {
    proposal.amount = explicit.amount
    proposal.currency = explicit.currency
  }
  if (options.merchantId) {
    proposal.merchant = options.merchantId
  }
  return proposal
}

/**
 * Replicates the toolkit's own total calculation, verified against
 * `@paypal/agent-toolkit/ai-sdk` — the toolkit charges
 * `sum(itemCost * qty) + sum(itemCost * taxPercent * qty / 100) + shipping - discount`,
 * formatted to two decimals. It does NOT use `itemTotal`, despite the field
 * existing on the schema.
 */
function totalFromOrderInput(input: Record<string, unknown>): { amount: number; currency: string } | null {
  const currency = typeof input.currencyCode === "string" ? input.currencyCode : null
  const items = Array.isArray(input.items) ? input.items : []
  if (!currency || items.length === 0) return null

  let subtotal = 0
  let tax = 0
  for (const raw of items) {
    const item = asObject(raw)
    if (!item) return null
    const cost = Number(item.itemCost)
    const quantity = Number(item.quantity ?? 1)
    const taxPercent = Number(item.taxPercent ?? 0)
    if (!Number.isFinite(cost) || !Number.isFinite(quantity) || !Number.isFinite(taxPercent)) {
      return null
    }
    subtotal += cost * quantity
    tax += (cost * taxPercent * quantity) / 100
  }

  const shipping = Number(input.shippingCost ?? 0)
  const discount = Number(input.discount ?? 0)
  if (!Number.isFinite(shipping) || !Number.isFinite(discount)) return null

  const total = subtotal + tax + shipping - discount
  if (!Number.isFinite(total) || total <= 0) return null

  return { amount: Math.round(total * 100), currency }
}

/** Salvage an explicit amount from tools that take one directly. */
function explicitAmount(input: Record<string, unknown>): { amount: number; currency: string } | null {
  const value = input.amount
  if (typeof value === "number" && typeof input.currency === "string") {
    return { amount: Math.round(value * 100), currency: input.currency }
  }
  if (typeof value === "string" && typeof input.currency === "string") {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed)) return { amount: Math.round(parsed * 100), currency: input.currency }
  }
  return null
}

async function readOrder(rawTools: Record<string, ToolLike>, orderId: string): Promise<unknown> {
  const getOrder = rawTools["get_order"]
  if (!getOrder || typeof getOrder.execute !== "function") return null
  try {
    return await getOrder.execute(
      { id: orderId },
      { toolCallId: `preflight-${orderId}`, messages: [] } as ToolExecOptions,
    )
  } catch {
    return null
  }
}

/**
 * Read the amount, currency and merchant out of a PayPal order, whichever of
 * the several shapes PayPal returns it in.
 */
export function orderDetails(
  order: unknown,
): { amount: number; currency: string; merchant?: string } | null {
  const root = asObject(order)
  if (!root) return null

  const units = Array.isArray(root.purchase_units) ? root.purchase_units : []
  if (units.length === 0) {
    const direct = asObject(root.amount)
    const amount = amountFromPayPalMoney(direct)
    if (amount) return amount
    return null
  }

  let total = 0
  let currency: string | null = null
  let merchant: string | undefined

  for (const rawUnit of units) {
    const unit = asObject(rawUnit)
    if (!unit) continue

    const direct = amountFromPayPalMoney(asObject(unit.amount))
    if (direct) {
      total += direct.amount
      currency = currency ?? direct.currency
    } else {
      const payments = asObject(unit.payments)
      const captures = payments && Array.isArray(payments.captures) ? payments.captures : []
      for (const rawCapture of captures) {
        const capture = asObject(rawCapture)
        const money = capture ? amountFromPayPalMoney(asObject(capture.amount)) : null
        if (money) {
          total += money.amount
          currency = currency ?? money.currency
        }
      }
    }

    const payee = asObject(unit.payee)
    if (payee) {
      const id = payee.merchant_id ?? payee.email_address
      if (typeof id === "string" && id.length > 0) merchant = id
    }
  }

  if (!currency || total <= 0) return null
  return merchant ? { amount: total, currency, merchant } : { amount: total, currency }
}

function amountFromPayPalMoney(value: Record<string, unknown> | null): { amount: number; currency: string } | null {
  if (!value) return null
  const currency = typeof value.currency_code === "string" ? value.currency_code : null
  const raw = value.value
  if (!currency || typeof raw !== "string") return null
  const parsed = Number.parseFloat(raw)
  if (!Number.isFinite(parsed)) return null
  return { amount: Math.round(parsed * 100), currency }
}

// ---------------------------------------------------------------------------
// Result shaping
// ---------------------------------------------------------------------------

export interface GuardPayload {
  ok: boolean
  code: string
  reason: string
  approvalId?: string
  result?: unknown
}

/**
 * Tool results are handed back to the model as JSON text. The model sees a
 * compact verdict it can reason about; the full rule trace stays in the
 * ledger for humans.
 */
function payload(input: GuardPayload): string {
  const body: Record<string, unknown> = {
    ok: input.ok,
    code: input.code,
    reason: input.reason,
  }
  if (input.approvalId) body.approvalId = input.approvalId
  if (input.result !== undefined) body.result = input.result
  return JSON.stringify(body)
}

/**
 * PayPal reports failures in two shapes: `{ error: { issue, description } }`
 * from some endpoints, and the toolkit's own
 * `{ ok: false, status, code, message }` envelope from others. Both are
 * failures, and a failed call must never move the budget.
 */
function errorFromResult(value: unknown): string | null {
  const object = asObject(value)
  if (!object) return null

  if (object.ok === false) {
    const description = object.message ?? object.description ?? object.code
    if (typeof description === "string" && description.length > 0) return description
    return "PayPal returned an error"
  }

  if (!("error" in object)) return null

  const error = asObject(object.error)
  if (error) {
    const description = error.description ?? error.message ?? error.issue
    if (typeof description === "string" && description.length > 0) return description
    return JSON.stringify(error)
  }

  if (typeof object.error === "string" && object.error.length > 0) return object.error
  return "PayPal returned an error"
}

function extractExternalRef(result: unknown): string | undefined {  const direct = asObject(result)
  if (direct) {
    const id = direct.id ?? direct.order_id ?? direct.capture_id ?? direct.invoice_id
    if (typeof id === "string") return id
  }
  if (typeof result === "string") {
    try {
      const parsed = asObject(JSON.parse(result))
      const id = parsed?.id ?? parsed?.order_id ?? parsed?.capture_id
      if (typeof id === "string") return id
    } catch {
      return undefined
    }
  }
  return undefined
}

function preview(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  if (text === undefined) return ""
  return text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text
}

/**
 * PayPal's toolkit returns JSON text from some tools and plain objects from
 * others, depending on the environment. Both are accepted here: a string that
 * parses to an object is treated as that object.
 */
function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function aliasMerchant(value: string, aliases: Record<string, string> | undefined): string {
  if (!aliases) return value
  const key = value.trim().toLowerCase()
  return aliases[key] ?? value
}

export type { Decision }
