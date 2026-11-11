/**
 * A live, multi-turn purchasing chat.
 *
 * The visitor says what they want in their own words. The model may only call
 * `propose_purchase`, which picks an item from a server-side catalog; it never
 * sees a payment tool and never supplies a price. The proposal is a card in the
 * UI. Nothing is paid until the visitor clicks it, and only then does the
 * server run the guarded `create_order` / `pay_order` pair.
 *
 * Every session gets its own in-memory store, signing key and mandate, so one
 * visitor cannot spend another visitor's budget, leave approvals behind or
 * change the recording. PayPal is simulated: the model, guard and ledger are
 * real, the payment rail is a local double.
 */

import { randomBytes, randomUUID } from "node:crypto"
import { z } from "zod"
import type { ModelMessage } from "ai"
import {
  describeMandate,
  runChatTurn,
  type ChatTurnInput,
  type ChatTurnOutput,
  type ChatToolCall,
} from "../agent/agent.js"
import { toAgentTools } from "../agent/tools.js"
import { formatMoney, validateClaims, verifySignature } from "../core/mandate.js"
import { Store } from "../core/store.js"
import type { Decision } from "../core/types.js"
import { guardTools } from "../paypal/guard.js"
import { createSimulatedTools } from "../paypal/simulated.js"
import type { ToolSet } from "../paypal/tool-types.js"
import { AGENT_ID, MERCHANT, SEED_ORDERS, issueDemoMandate, seedTrust } from "./demo.js"
import { buildSnapshot, type ServerSnapshot } from "./snapshot.js"

/** The catalog is authoritative. The model can only choose from these ids. */
const CHAT_ITEM_IDS = [
  "headset",
  "paper",
  "keyboard",
  "monitor",
  "cables",
  "desk-lamp",
  "standing-desk",
] as const

export type ChatItemId = (typeof CHAT_ITEM_IDS)[number]

export interface ChatCatalogItem {
  id: ChatItemId
  name: string
  description: string
  /** Minor units. */
  amount: number
  currency: "USD"
  merchant: string
}

export const CHAT_CATALOG: ChatCatalogItem[] = [
  {
    id: "headset",
    name: "Studio headset",
    description: "Over-ear headset with a boom microphone",
    amount: 4_500,
    currency: "USD",
    merchant: MERCHANT,
  },
  {
    id: "paper",
    name: "A4 paper (2 reams)",
    description: "Two reams of 80 gsm A4 paper",
    amount: 2_400,
    currency: "USD",
    merchant: MERCHANT,
  },
  {
    id: "keyboard",
    name: "Mechanical keyboard",
    description: "Compact wired mechanical keyboard",
    amount: 3_000,
    currency: "USD",
    merchant: MERCHANT,
  },
  {
    id: "monitor",
    name: "27-inch monitor",
    description: "QHD monitor with USB-C input",
    amount: 7_500,
    currency: "USD",
    merchant: MERCHANT,
  },
  {
    id: "cables",
    name: "USB-C cable pack",
    description: "Three braided USB-C cables, 1 m",
    amount: 1_800,
    currency: "USD",
    merchant: MERCHANT,
  },
  {
    id: "desk-lamp",
    name: "Desk lamp",
    description: "Adjustable LED desk lamp",
    amount: 2_200,
    currency: "USD",
    merchant: MERCHANT,
  },
  {
    id: "standing-desk",
    name: "Standing desk",
    description: "Electric height-adjustable desk",
    amount: 18_000,
    currency: "USD",
    merchant: MERCHANT,
  },
]

const CHAT_ITEM_ID = z.enum(CHAT_ITEM_IDS)

/** How long a chat session lives. Long enough to talk, short enough to forget. */
const CHAT_MANDATE_TTL_MS = 60 * 60 * 1_000

export type ChatProposalStatus = "proposed" | "purchasing" | "purchased" | "failed"

export interface ChatProposal {
  id: string
  itemId: ChatItemId
  name: string
  description: string
  /** Minor units, from the catalog. Never from the model or the browser. */
  amount: number
  currency: string
  merchant: string
  /** Policy preview at proposal time. */
  allowed: boolean
  requiresApproval: boolean
  code: string
  reason: string
  status: ChatProposalStatus
}

export interface ChatReceipt {
  proposalId: string
  itemId: ChatItemId
  name: string
  amount: number
  currency: string
  merchant: string
  orderId: string
  captureId?: string
  /** Human approvals consumed by the two guarded calls. */
  approvals: number
}

export interface ChatSession {
  id: string
  createdAt: number
  updatedAt: number
  store: Store
  mandateId: string
  /** Guarded PayPal tools, bound to this session's mandate. */
  tools: ToolSet
  /** Conversation as the model sees it. Tool calls are not replayed. */
  messages: ModelMessage[]
  proposals: Map<string, ChatProposal>
  /** User turns spent. Counted before the model call, so failures still count. */
  turns: number
  /** Set by the proposal tool; reset at the start of each turn. */
  lastProposalId: string | null
  proposedThisTurn: number
  model: string | null
}

export type ChatRunner = (input: ChatTurnInput) => Promise<ChatTurnOutput>

export interface ChatTurnOptions {
  apiKey: string
  model?: string
  maxSteps?: number
  /** Injectable so tests can choose an item without calling Gemini. */
  runner?: ChatRunner
}

export interface ChatTurnResult {
  output: ChatTurnOutput
  text: string
  proposal: ChatProposal | null
}

/** A refusal the visitor can understand, with the policy code attached. */
export class ChatRefused extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = "ChatRefused"
  }
}

/** Build a fresh store, signing key, mandate and guarded toolset. */
export function createChatSession(): ChatSession {
  const now = Date.now()
  const store = new Store(randomBytes(32).toString("hex"))
  const mandateId = issueDemoMandate(store, CHAT_MANDATE_TTL_MS)
  seedTrust(store)

  const rawTools = createSimulatedTools({ merchantId: MERCHANT, seedOrders: SEED_ORDERS })
  const { tools } = guardTools(rawTools, {
    store,
    mandateId,
    agentId: AGENT_ID,
    merchantId: MERCHANT,
  })

  return {
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    store,
    mandateId,
    tools,
    messages: [],
    proposals: new Map(),
    turns: 0,
    lastProposalId: null,
    proposedThisTurn: 0,
    model: null,
  }
}

/** Drop sessions nobody came back to. Called before every chat request. */
export function pruneChatSessions(
  sessions: Map<string, ChatSession>,
  ttlMs: number,
  now = Date.now(),
): number {
  let removed = 0
  for (const [id, session] of sessions) {
    if (now - session.updatedAt > ttlMs) {
      sessions.delete(id)
      removed += 1
    }
  }
  return removed
}

export function chatSnapshot(session: ChatSession): ServerSnapshot {
  return buildSnapshot(session.store, session.mandateId, {
    mode: "simulated",
    note: "Live chat against simulated PayPal. This chat has its own mandate, signing key and ledger; no money can move.",
    agentId: AGENT_ID,
    merchantId: MERCHANT,
    running: false,
    ...(session.model ? { model: session.model } : {}),
  })
}

export function chatVerification(session: ChatSession): {
  signatureValid: boolean
  claimsValid: boolean
  reason?: string
} {
  const stored = session.store.get(session.mandateId)
  if (!stored) {
    return { signatureValid: false, claimsValid: false, reason: "the mandate disappeared" }
  }

  const signature = verifySignature(stored.envelope, session.store.verificationKey)
  const claims = validateClaims(stored.envelope.claims)
  return {
    signatureValid: signature.valid,
    claimsValid: claims.valid,
    ...(claims.valid ? {} : { reason: claims.reason }),
  }
}

/**
 * The prompt for one turn. The catalog and the mandate are rebuilt every time,
 * so the model always sees the current remaining budget rather than a stale
 * snapshot from session creation.
 */
export function chatSystemPrompt(session: ChatSession): string {
  const catalog = CHAT_CATALOG.map(
    (item) =>
      `- ${item.id}: ${item.name} — ${formatMoney({ amount: item.amount, currency: item.currency })} — ${item.merchant}`,
  ).join("\n")

  return `You are the purchasing agent in a live demo of Agent Mandate. You are chatting with a visitor who wants to buy something.

Your job:
- Understand what the visitor wants in their own words.
- Pick the closest item from the catalog and call propose_purchase with its exact id.
- The catalog price is authoritative. Never invent, negotiate or repeat a different price.
- The proposal tool does not buy anything. It creates a card the visitor must approve. Never say an item was bought; say it is ready for approval.
- If the visitor asks whether the budget is sufficient, answer from the mandate below, then propose.
- If no catalog item is close, say so and mention a couple of alternatives. Do not call the tool.
- Call propose_purchase at most once per reply.
- Reply in the language the visitor writes in. Keep replies to a few short sentences.

Catalog:
${catalog}

Mandate:
${describeMandate(session.store, session.mandateId)}

The enforcement layer decides what the mandate permits. The proposal tool returns its decision; read it and explain it honestly, including when an item needs human approval or is refused.`
}

/**
 * The only tool the chat model gets. It resolves the item and price on the
 * server, previews the policy decision and stores a proposal the UI can show.
 */
function createProposalTool(session: ChatSession) {
  const tools: ToolSet = {
    propose_purchase: {
      description:
        "Propose one catalog item to the visitor. This does not buy anything: it creates a proposal card the visitor must approve. Call it once per reply, only after the visitor says what they want.",
      parameters: z.object({
        itemId: CHAT_ITEM_ID.describe("Exact catalog id of the item to propose"),
      }),
      execute: async (args: unknown) => {
        const input = (args ?? {}) as { itemId?: unknown }
        const parsed = CHAT_ITEM_ID.safeParse(input.itemId)
        if (!parsed.success) {
          return JSON.stringify({
            ok: false,
            code: "UNKNOWN_ITEM",
            reason: `"${String(input.itemId)}" is not in the catalog. Use one of: ${CHAT_ITEM_IDS.join(", ")}.`,
          })
        }

        if (session.proposedThisTurn > 0) {
          return JSON.stringify({
            ok: false,
            code: "PROPOSAL_ALREADY_MADE",
            reason: "One proposal per reply. Let the visitor respond to the current one.",
          })
        }

        const item = CHAT_CATALOG.find((candidate) => candidate.id === parsed.data)
        if (!item) {
          return JSON.stringify({
            ok: false,
            code: "UNKNOWN_ITEM",
            reason: `No catalog item with id ${parsed.data}.`,
          })
        }

        const decision: Decision = session.store.evaluate(session.mandateId, {
          action: "create_order",
          merchant: item.merchant,
          amount: item.amount,
          currency: item.currency,
          description: item.name,
        })

        const proposal: ChatProposal = {
          id: randomUUID(),
          itemId: item.id,
          name: item.name,
          description: item.description,
          amount: item.amount,
          currency: item.currency,
          merchant: item.merchant,
          allowed: decision.allowed,
          requiresApproval: Boolean(decision.requiresApproval),
          code: decision.code,
          reason: decision.reason,
          status: "proposed",
        }

        session.proposals.set(proposal.id, proposal)
        session.lastProposalId = proposal.id
        session.proposedThisTurn += 1
        session.updatedAt = Date.now()

        return JSON.stringify({
          ok: true,
          proposalId: proposal.id,
          item: {
            id: item.id,
            name: item.name,
            description: item.description,
            price: formatMoney({ amount: item.amount, currency: item.currency }),
            merchant: item.merchant,
          },
          decision: {
            allowed: decision.allowed,
            requiresApproval: Boolean(decision.requiresApproval),
            code: decision.code,
            reason: decision.reason,
          },
          next: "The visitor must approve the card. Do not claim the purchase is complete.",
        })
      },
    },
  }

  return toAgentTools(tools)
}

/** Run one user turn. The turn is counted before the model call. */
export async function takeChatTurn(
  session: ChatSession,
  message: string,
  options: ChatTurnOptions,
): Promise<ChatTurnResult> {
  session.turns += 1
  session.proposedThisTurn = 0
  session.lastProposalId = null
  session.updatedAt = Date.now()

  const userMessage: ModelMessage = { role: "user", content: message }
  session.messages.push(userMessage)

  const runner = options.runner ?? runChatTurn
  let output: ChatTurnOutput
  try {
    output = await runner({
      apiKey: options.apiKey,
      ...(options.model ? { model: options.model } : {}),
      ...(options.maxSteps ? { maxSteps: options.maxSteps } : {}),
      system: chatSystemPrompt(session),
      messages: session.messages,
      tools: createProposalTool(session),
    })
  } catch (error) {
    // The model did not answer, so do not leave two user messages in a row for
    // the next attempt. The turn itself stays spent: it may already have cost
    // a request.
    session.messages.pop()
    throw error
  }

  const proposal = session.lastProposalId
    ? (session.proposals.get(session.lastProposalId) ?? null)
    : proposalFromToolCalls(output.toolCalls, session)

  const text = output.text.trim() || fallbackText(proposal)
  session.messages.push({ role: "assistant", content: text })
  session.model = output.model
  session.updatedAt = Date.now()

  return { output, text, proposal }
}

/** The click is the human decision. Execute the exact catalog purchase. */
export async function confirmChatProposal(
  session: ChatSession,
  proposalId: string,
): Promise<{ proposal: ChatProposal; receipt: ChatReceipt }> {
  const proposal = session.proposals.get(proposalId)
  if (!proposal) {
    throw new ChatRefused("This proposal does not belong to this chat.", "UNKNOWN_PROPOSAL")
  }
  if (proposal.status === "purchased") {
    throw new ChatRefused("This proposal has already been paid.", "ALREADY_PURCHASED")
  }
  if (proposal.status === "purchasing") {
    throw new ChatRefused("This proposal is already being processed.", "PURCHASE_IN_PROGRESS")
  }
  if (proposal.status === "failed") {
    throw new ChatRefused("This proposal already failed. Ask for another one.", "PROPOSAL_FAILED")
  }
  if (!proposal.allowed && !proposal.requiresApproval) {
    throw new ChatRefused(proposal.reason, proposal.code)
  }

  proposal.status = "purchasing"
  session.updatedAt = Date.now()

  try {
    const create = await runWithApproval(session, "create_order", {
      currencyCode: proposal.currency,
      items: [
        {
          name: proposal.name,
          quantity: 1,
          itemCost: proposal.amount / 100,
          taxPercent: 0,
          itemTotal: proposal.amount / 100,
        },
      ],
    })

    if (!create.outcome.ok) {
      throw new ChatRefused(create.outcome.reason, create.outcome.code)
    }

    const orderId = extractOrderId(create.outcome.result)
    if (!orderId) {
      throw new ChatRefused("PayPal created the order but returned no id.", "ORDER_ID_MISSING")
    }

    const pay = await runWithApproval(session, "pay_order", { id: orderId })
    if (!pay.outcome.ok) {
      throw new ChatRefused(pay.outcome.reason, pay.outcome.code)
    }

    proposal.status = "purchased"
    session.updatedAt = Date.now()

    const captureId = extractCaptureId(pay.outcome.result)
    return {
      proposal,
      receipt: {
        proposalId: proposal.id,
        itemId: proposal.itemId,
        name: proposal.name,
        amount: proposal.amount,
        currency: proposal.currency,
        merchant: proposal.merchant,
        orderId,
        ...(captureId ? { captureId } : {}),
        approvals: create.approvals + pay.approvals,
      },
    }
  } catch (error) {
    proposal.status = "failed"
    session.updatedAt = Date.now()
    throw error
  }
}

interface GuardOutcome {
  ok: boolean
  code: string
  reason: string
  approvalId?: string
  result?: unknown
}

async function runWithApproval(
  session: ChatSession,
  toolName: string,
  args: unknown,
): Promise<{ outcome: GuardOutcome; approvals: number }> {
  let approvals = 0
  let outcome = await executeGuarded(session, toolName, args)

  // The visitor's click authorises this exact payment. Consume the approval the
  // guard parked and retry once; the guard still re-checks everything.
  if (outcome.code === "REQUIRES_HUMAN_APPROVAL" && outcome.approvalId) {
    const resolved = session.store.resolveApproval(outcome.approvalId, true)
    if (resolved) {
      approvals += 1
      outcome = await executeGuarded(session, toolName, args)
    }
  }

  return { outcome, approvals }
}

async function executeGuarded(
  session: ChatSession,
  toolName: string,
  args: unknown,
): Promise<GuardOutcome> {
  const tool = session.tools[toolName]
  if (!tool || typeof tool.execute !== "function") {
    return { ok: false, code: "TOOL_UNAVAILABLE", reason: `${toolName} is not available.` }
  }

  const raw = await tool.execute(args, {
    toolCallId: `chat-${toolName}-${randomUUID()}`,
    messages: [],
  })
  return parseGuardOutcome(raw)
}

function parseGuardOutcome(raw: unknown): GuardOutcome {
  let value: unknown = raw
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw)
    } catch {
      return { ok: false, code: "TOOL_ERROR", reason: raw.slice(0, 500) }
    }
  }

  if (value === null || typeof value !== "object") {
    return { ok: false, code: "TOOL_ERROR", reason: "PayPal returned an unexpected result." }
  }

  const record = value as Record<string, unknown>
  return {
    ok: record["ok"] === true,
    code: typeof record["code"] === "string" ? record["code"] : "TOOL_ERROR",
    reason:
      typeof record["reason"] === "string" ? record["reason"] : "The tool did not explain the failure.",
    ...(typeof record["approvalId"] === "string" ? { approvalId: record["approvalId"] } : {}),
    ...("result" in record ? { result: record["result"] } : {}),
  }
}

function proposalFromToolCalls(
  calls: ChatToolCall[],
  session: ChatSession,
): ChatProposal | null {
  for (const call of calls) {
    if (call.toolName !== "propose_purchase" || !call.output) continue
    try {
      const parsed = JSON.parse(call.output) as { proposalId?: unknown }
      if (typeof parsed.proposalId !== "string") continue
      const proposal = session.proposals.get(parsed.proposalId)
      if (proposal) return proposal
    } catch {
      // A malformed tool result is not a proposal.
    }
  }
  return null
}

function fallbackText(proposal: ChatProposal | null): string {
  if (!proposal) {
    return "I couldn't match that to an item in the catalog. Tell me a little more about what you need."
  }
  return `I can get the ${proposal.name} for ${formatMoney({ amount: proposal.amount, currency: proposal.currency })}. Review the proposal and approve it if you want me to go ahead.`
}

function extractOrderId(result: unknown): string | null {
  const record = asRecord(result)
  return record && typeof record["id"] === "string" ? record["id"] : null
}

function extractCaptureId(result: unknown): string | undefined {
  const record = asRecord(result)
  const units = record && Array.isArray(record["purchase_units"]) ? record["purchase_units"] : []
  for (const rawUnit of units) {
    const unit = asRecord(rawUnit)
    const payments = unit ? asRecord(unit["payments"]) : null
    const captures = payments && Array.isArray(payments["captures"]) ? payments["captures"] : []
    for (const rawCapture of captures) {
      const capture = asRecord(rawCapture)
      if (capture && typeof capture["id"] === "string") return capture["id"]
    }
  }
  return undefined
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value))
    } catch {
      return null
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}
