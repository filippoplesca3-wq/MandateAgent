/**
 * HTTP surface for the Agent Mandate demo.
 *
 * Kept separate from `index.ts` so the whole API can be exercised in a test or
 * a script without opening a port. The app holds exactly two pieces of mutable
 * state — which mandate is current, and whether an agent run is in flight — and
 * everything else is read straight out of the store.
 *
 * The guard is rebuilt whenever the mandate changes. That is deliberate: the
 * guarded tools are bound to one mandate, and silently reusing them across
 * mandates is precisely the class of bug this project exists to prevent.
 */

import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express"
import { describeMandate, runAgent } from "../agent/agent.js"
import { toAgentTools } from "../agent/tools.js"
import type { Store } from "../core/store.js"
import type { Currency, MandateConstraints, Money } from "../core/types.js"
import { guardTools } from "../paypal/guard.js"
import type { ToolSet } from "../paypal/tool-types.js"
import {
  hasAllWebhookHeaders,
  readWebhookEvent,
  webhookHeadersFrom,
  type PayPalWebhookEvent,
  type WebhookHeaders,
} from "../paypal/webhook.js"
import type { ReplayPlayer } from "./replay.js"
import { buildSnapshot, type ServerSnapshot } from "./snapshot.js"

/** PayPal's toolkit only accepts USD, so the demo does too. */
const CURRENCY: Currency = "USD"

/**
 * The live checkout moves sandbox money, so it is deliberately tiny. It also
 * sits below the demo mandate's approval threshold: a visitor clicking "pay"
 * is the human decision for this purchase.
 */
const CHECKOUT_AMOUNT = 200

export interface ServerConfig {
  store: Store
  rawTools: ToolSet
  mandateId: string
  agentId: string
  merchantId: string
  mode: string
  note: string
  model?: string
  /** Public client id used by the browser to approve a sandbox order. */
  paypalClientId?: string
  /** The live checkout is exposed only against the sandbox. */
  paypalSandbox?: boolean
  merchantAliases?: Record<string, string>
  /** Present when a webhook id and PayPal credentials are configured. */
  webhook?: {
    id: string
    verify: (headers: WebhookHeaders, event: unknown) => Promise<boolean>
  }
  /** When set, the server serves a recording instead of running the agent. */
  replay?: ReplayPlayer
}

export interface ServerHandle {
  app: Express
  /** Current mandate id, updated when a new mandate is issued. */
  currentMandateId(): string
  isRunning(): boolean
}

class BadRequest extends Error {}

/** A checkout the mandate or PayPal refused, reported as a payment error. */
class CheckoutRefused extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
  }
}

export function createApp(config: ServerConfig): ServerHandle {
  const { store, rawTools, agentId, merchantId } = config
  const app = express()

  let mandateId = config.mandateId
  let running = false

  const checkoutEnabled =
    config.mode === "live" && config.paypalSandbox === true && Boolean(config.paypalClientId)
  /** Orders this server created, so arbitrary order ids cannot be captured. */
  const checkoutOrders = new Set<string>()
  /** Verified webhook deliveries, newest last. Bounded for a long-lived demo. */
  const webhookEvents = new Map<string, PayPalWebhookEvent>()

  let guardCache: { mandateId: string; tools: ToolSet } | null = null

  function toolsForCurrentMandate(): ToolSet {
    if (guardCache?.mandateId === mandateId) return guardCache.tools
    const { tools } = guardTools(rawTools, {
      store,
      mandateId,
      agentId,
      merchantId,
      ...(config.merchantAliases ? { merchantAliases: config.merchantAliases } : {}),
    })
    guardCache = { mandateId, tools }
    return tools
  }

  // -------------------------------------------------------------------------
  // Serialization
  // -------------------------------------------------------------------------

  function snapshot(): ServerSnapshot {
    if (config.replay) return config.replay.snapshot()
    return buildSnapshot(store, mandateId, {
      mode: config.mode,
      note: config.note,
      agentId,
      merchantId,
      running,
      ...(config.model ? { model: config.model } : {}),
    })
  }

  /**
   * Cheap value that changes when anything visible changes. Used by the SSE
   * stream so a quiet demo does not re-send the whole snapshot twice a second.
   */
  function fingerprint(): string {
    if (config.replay) {
      return `replay|${config.replay.frameIndex}|${config.replay.isPlaying}`
    }

    const stored = store.get(mandateId)
    const approvals = store
      .listApprovals()
      .map((item) => `${item.id}:${item.status}`)
      .join(",")
    return [
      mandateId,
      running,
      stored?.state.spendToDate.amount ?? -1,
      stored?.state.transactionCount ?? -1,
      stored?.state.revokedAt ?? "",
      store.ledger.list().length,
      approvals,
    ].join("|")
  }

  /**
   * A recording is evidence, not a sandbox. Mutating it would let a visitor
   * produce a ledger that never happened, so every write is refused.
   */
  function refuseInReplay(res: Response): boolean {
    if (!config.replay) return false
    res.status(409).json({
      ok: false,
      error: "This is a recording, so it is read-only. Run the agent with your own key to interact.",
    })
    return true
  }

  // -------------------------------------------------------------------------
  // Middleware
  // -------------------------------------------------------------------------

  app.use(express.json({ limit: "256kb" }))

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, mode: config.mode, mandateId, running })
  })

  app.get("/api/state", (_req, res) => {
    res.json(snapshot())
  })

  // -------------------------------------------------------------------------
  // Mandate lifecycle
  // -------------------------------------------------------------------------

  app.post("/api/mandate", (req, res, next) => {
    if (refuseInReplay(res)) return
    try {
      const body = (req.body ?? {}) as Record<string, unknown>

      const budget = moneyFrom(body["budget"], "budget") ?? { amount: 5_000, currency: CURRENCY }
      const constraints: MandateConstraints = {}

      const allowMerchants = stringList(body["allowMerchants"])
      if (allowMerchants) constraints.allowMerchants = allowMerchants

      const denyMerchants = stringList(body["denyMerchants"])
      if (denyMerchants) constraints.denyMerchants = denyMerchants

      const maxPerTransaction = moneyFrom(body["maxPerTransaction"], "maxPerTransaction")
      if (maxPerTransaction) constraints.maxPerTransaction = maxPerTransaction

      const requireApprovalAbove = moneyFrom(body["requireApprovalAbove"], "requireApprovalAbove")
      if (requireApprovalAbove) constraints.requireApprovalAbove = requireApprovalAbove

      const maxTransactions = integerFrom(body["maxTransactions"], "maxTransactions")
      if (maxTransactions !== undefined) constraints.maxTransactions = maxTransactions

      const ttlMinutes = integerFrom(body["ttlMinutes"], "ttlMinutes")
      if (ttlMinutes !== undefined && (ttlMinutes < 1 || ttlMinutes > 60 * 24 * 30)) {
        throw new BadRequest("ttlMinutes must be between 1 and 43200")
      }

      const stored = store.issue({
        principal: stringFrom(body["principal"]) ?? "filippo@example.com",
        agentId: stringFrom(body["agentId"]) ?? agentId,
        purpose: stringFrom(body["purpose"]) ?? "Buy A4 paper for the studio",
        budget,
        constraints,
        ...(ttlMinutes !== undefined ? { ttlMs: ttlMinutes * 60_000 } : {}),
      })

      mandateId = stored.envelope.claims.id
      guardCache = null
      res.status(201).json(snapshot())
    } catch (error) {
      next(error)
    }
  })

  app.post("/api/mandate/revoke", (req, res, next) => {
    if (refuseInReplay(res)) return
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      const target = stringFrom(body["mandateId"]) ?? mandateId
      if (!store.revoke(target)) throw new BadRequest(`no mandate with id ${target}`)
      res.json(snapshot())
    } catch (error) {
      next(error)
    }
  })

  // -------------------------------------------------------------------------
  // Agent
  // -------------------------------------------------------------------------

  app.post("/api/agent/run", (req, res, next) => {
    if (running) {
      res.status(409).json({ ok: false, error: "An agent run is already in progress." })
      return
    }

    const body = (req.body ?? {}) as Record<string, unknown>
    const replay = config.replay

    // In replay the task is whatever was recorded; the client cannot alter it.
    if (replay) {
      running = true
      replay
        .play()
        .then(() => {
          const run = replay.run
          res.json({
            ok: true,
            replay: true,
            model: run.model,
            task: run.task,
            text: run.text,
            steps: run.steps,
            // The real length of the recorded run, not the playback length.
            durationMs: run.durationMs,
          })
        })
        .finally(() => {
          running = false
        })
      return
    }

    const task = stringFrom(body["task"])
    if (!task) {
      res.status(400).json({ ok: false, error: "task must be a non-empty string" })
      return
    }

    // A visitor may supply their own key for one run. It is handed straight to
    // the SDK for this call; it is never persisted, logged or put in a snapshot.
    const apiKey = stringFrom(body["apiKey"])
    if (apiKey !== undefined && (apiKey.length < 20 || apiKey.length > 300)) {
      res.status(400).json({ ok: false, error: "apiKey does not look like a Google API key" })
      return
    }

    if (!store.get(mandateId)) {
      res.status(400).json({ ok: false, error: "No current mandate. Issue one first." })
      return
    }

    running = true
    const started = Date.now()

    runAgent({
      tools: toAgentTools(toolsForCurrentMandate()),
      mandateBrief: describeMandate(store, mandateId),
      task,
      ...(config.model ? { model: config.model } : {}),
      ...(apiKey ? { apiKey } : {}),
    })
      .then((result) => {
        res.json({ ok: true, ...result, totalDurationMs: Date.now() - started })
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        res.status(502).json({ ok: false, error: message })
      })
      .finally(() => {
        running = false
      })

    // Errors above are already turned into a response; `next` is intentional
    // no-op here so lint does not flag the unused parameter.
    void next
  })

  // -------------------------------------------------------------------------
  // Dry run
  // -------------------------------------------------------------------------

  // A dry run is deliberately allowed in replay: it is pure — it records
  // nothing and calls nothing — and it is the one way a visitor can try the
  // policy on the hosted demo without a Gemini key.
  app.post("/api/evaluate", (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>
      const action = stringFrom(body["action"])
      if (!action) throw new BadRequest("action is required")

      const amount = moneyFrom(body["amount"], "amount")
      const merchant = stringFrom(body["merchant"])

      const decision = store.evaluate(mandateId, {
        action,
        ...(amount ? { amount: amount.amount, currency: amount.currency } : {}),
        ...(merchant ? { merchant } : {}),
      })

      res.json({ ok: true, decision })
    } catch (error) {
      next(error)
    }
  })

  // -------------------------------------------------------------------------
  // Approvals
  // -------------------------------------------------------------------------

  app.post("/api/approvals/:id/resolve", (req, res, next) => {
    if (refuseInReplay(res)) return

    const approve = (req.body as Record<string, unknown> | undefined)?.["approve"]
    if (typeof approve !== "boolean") {
      next(new BadRequest("approve must be a boolean"))
      return
    }

    const approvalId = req.params["id"] ?? ""
    const target = store.listApprovals().find((item) => item.id === approvalId)
    if (!target) {
      next(new BadRequest("approval not found"))
      return
    }
    if (target.status !== "pending") {
      next(new BadRequest("approval already resolved"))
      return
    }

    const resolved = store.resolveApproval(approvalId, approve)
    if (!resolved) {
      next(new BadRequest("approval not found, or already resolved"))
      return
    }

    // Rejecting ends the matter. Approving releases the payment that was
    // parked, executed exactly as it was proposed — the server does not ask
    // the model to try again, because a retry is not the same authorisation.
    if (!approve || resolved.args === undefined || resolved.mandateId !== mandateId) {
      res.json({ ok: true, approval: resolved, execution: null, state: snapshot() })
      return
    }

    const tool = toolsForCurrentMandate()[resolved.action]
    if (!tool?.execute) {
      res.status(502).json({ ok: false, error: `tool ${resolved.action} is not available` })
      return
    }

    Promise.resolve(
      tool.execute(resolved.args, { toolCallId: `approval-${resolved.id}`, messages: [] }),
    )
      .then((execution) => {
        res.json({ ok: true, approval: resolved, execution, state: snapshot() })
      })
      .catch(next)
  })

  // -------------------------------------------------------------------------
  // Live sandbox checkout
  // -------------------------------------------------------------------------

  // The PayPal JS SDK needs only the public client id. The secret stays here.
  app.get("/api/checkout/config", (_req, res) => {
    res.json({
      enabled: checkoutEnabled,
      clientId: config.paypalClientId ?? null,
      currency: CURRENCY,
      amount: CHECKOUT_AMOUNT,
      sandbox: config.paypalSandbox === true,
    })
  })

  // Create the order server-side, so the browser never states a price.
  app.post("/api/checkout/order", (_req, res, next) => {
    if (!checkoutEnabled) {
      res.status(409).json({
        ok: false,
        error:
          "Live checkout is only available when the server is connected to the PayPal sandbox.",
      })
      return
    }

    void (async () => {
      try {
        if (!store.get(mandateId)) throw new BadRequest("No current mandate. Issue one first.")

        const tool = toolsForCurrentMandate()["create_order"]
        if (!tool?.execute) throw new Error("create_order is not available")

        const outcome = toolOutcome(
          await tool.execute(
            {
              currencyCode: CURRENCY,
              items: [
                {
                  name: "Agent Mandate live sandbox test",
                  quantity: 1,
                  itemCost: CHECKOUT_AMOUNT / 100,
                  taxPercent: 0,
                  itemTotal: CHECKOUT_AMOUNT / 100,
                },
              ],
              returnUrl: "https://example.com/paypal/return",
              cancelUrl: "https://example.com/paypal/cancel",
            },
            { toolCallId: "checkout-create", messages: [] },
          ),
        )

        if (!outcome.ok) throw new CheckoutRefused(outcome.reason, outcome.code)

        const order = asRecord(outcome.result)
        const orderId = typeof order?.["id"] === "string" ? order["id"] : undefined
        if (!orderId) throw new Error("PayPal did not return an order id")

        checkoutOrders.add(orderId)
        // Bounded memory, and old abandoned orders stop being capturable.
        while (checkoutOrders.size > 20) {
          const oldest = checkoutOrders.values().next().value
          if (oldest === undefined) break
          checkoutOrders.delete(oldest)
        }

        res.json({ ok: true, orderId, amount: CHECKOUT_AMOUNT, currency: CURRENCY })
      } catch (error) {
        next(error)
      }
    })()
  })

  // The browser reports a payer approval; only then is the order captured.
  app.post("/api/checkout/capture", (req, res, next) => {
    if (!checkoutEnabled) {
      res.status(409).json({
        ok: false,
        error:
          "Live checkout is only available when the server is connected to the PayPal sandbox.",
      })
      return
    }

    const body = (req.body ?? {}) as Record<string, unknown>
    const orderId = stringFrom(body["orderId"])
    if (!orderId) {
      next(new BadRequest("orderId is required"))
      return
    }
    if (!checkoutOrders.has(orderId)) {
      next(new BadRequest("this order was not created by the live checkout"))
      return
    }

    const tool = toolsForCurrentMandate()["pay_order"]
    if (!tool?.execute) {
      res.status(502).json({ ok: false, error: "pay_order is not available" })
      return
    }

    Promise.resolve(
      tool.execute({ id: orderId }, { toolCallId: `checkout-capture-${orderId}`, messages: [] }),
    )
      .then((raw) => {
        const outcome = toolOutcome(raw)
        if (!outcome.ok) {
          res.status(402).json({
            ok: false,
            error: outcome.reason,
            code: outcome.code,
            state: snapshot(),
          })
          return
        }
        checkoutOrders.delete(orderId)
        res.json({ ok: true, code: outcome.code, order: outcome.result ?? null, state: snapshot() })
      })
      .catch(next)
  })

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------

  // PayPal signs every delivery. The event is only recorded after PayPal's own
  // verification endpoint confirms the signature.
  app.post("/api/webhooks/paypal", (req, res, next) => {
    if (!config.webhook) {
      res.status(503).json({
        ok: false,
        error:
          "Webhooks are not configured. Set PAYPAL_WEBHOOK_ID and subscribe the app to PAYMENT.CAPTURE.COMPLETED.",
      })
      return
    }

    const headers = webhookHeadersFrom({
      "paypal-transmission-id": req.header("paypal-transmission-id"),
      "paypal-transmission-time": req.header("paypal-transmission-time"),
      "paypal-transmission-sig": req.header("paypal-transmission-sig"),
      "paypal-cert-url": req.header("paypal-cert-url"),
      "paypal-auth-algo": req.header("paypal-auth-algo"),
    })

    if (!hasAllWebhookHeaders(headers)) {
      res.status(400).json({ ok: false, error: "Missing PayPal transmission headers." })
      return
    }

    Promise.resolve(config.webhook.verify(headers, req.body))
      .then((verified) => {
        if (!verified) {
          res.status(400).json({
            ok: false,
            error: "PayPal could not verify this webhook signature.",
          })
          return
        }

        const event = readWebhookEvent(req.body)
        if (event) {
          webhookEvents.set(event.id, event)
          while (webhookEvents.size > 50) {
            const oldest = webhookEvents.keys().next().value
            if (oldest === undefined) break
            webhookEvents.delete(oldest)
          }
        }

        res.json({ ok: true, verified: true, event })
      })
      .catch(next)
  })

  app.get("/api/webhooks/paypal/events", (_req, res) => {
    res.json({ ok: true, events: [...webhookEvents.values()] })
  })

  // -------------------------------------------------------------------------
  // Live updates
  // -------------------------------------------------------------------------

  app.get("/api/stream", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    })

    const send = (): void => {
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`)
    }

    let last = fingerprint()
    send()

    const timer = setInterval(() => {
      const next = fingerprint()
      if (next === last) {
        res.write(": keepalive\n\n")
        return
      }
      last = next
      send()
    }, 800)

    req.on("close", () => {
      clearInterval(timer)
    })
  })

  // -------------------------------------------------------------------------
  // Errors
  // -------------------------------------------------------------------------

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof CheckoutRefused) {
      res.status(402).json({ ok: false, error: error.message, code: error.code })
      return
    }
    if (error instanceof BadRequest) {
      res.status(400).json({ ok: false, error: error.message })
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    res.status(500).json({ ok: false, error: message })
  })

  return {
    app,
    currentMandateId: () => mandateId,
    isRunning: () => running,
  }
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function stringFrom(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0)
  return items.length > 0 ? items : undefined
}

/** Accepts major units (12.50) and returns minor units (1250). */
function moneyFrom(value: unknown, label: string): Money | undefined {
  if (value === undefined || value === null || value === "") return undefined
  const parsed = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new BadRequest(`${label} must be a positive number`)
  }
  return { amount: Math.round(parsed * 100), currency: CURRENCY }
}

function integerFrom(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined
  const parsed = typeof value === "number" ? value : Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new BadRequest(`${label} must be a positive integer`)
  }
  return parsed
}

// ---------------------------------------------------------------------------
// Tool response shape
// ---------------------------------------------------------------------------

interface ToolOutcome {
  ok: boolean
  code: string
  reason: string
  result: unknown
}

/**
 * The guard answers with JSON text, and the live toolkit nests its own JSON
 * text inside it. Both are unwrapped here so callers see one shape.
 */
function toolOutcome(raw: unknown): ToolOutcome {
  const outer = parseObject(raw)
  if (!outer) {
    return {
      ok: false,
      code: "TOOL_ERROR",
      reason: "PayPal returned an unreadable response",
      result: null,
    }
  }

  let result = outer["result"]
  if (typeof result === "string") {
    try {
      result = JSON.parse(result)
    } catch {
      // Keep the raw text; a caller can still inspect it.
    }
  }

  return {
    ok: outer["ok"] === true,
    code: typeof outer["code"] === "string" ? outer["code"] : "TOOL_ERROR",
    reason: typeof outer["reason"] === "string" ? outer["reason"] : "PayPal call failed",
    result,
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function parseObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  return asRecord(value)
}
