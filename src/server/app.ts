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
import { remainingBudget } from "../core/mandate.js"
import type { Store } from "../core/store.js"
import type { Currency, MandateConstraints, Money } from "../core/types.js"
import { guardTools } from "../paypal/guard.js"
import type { ToolSet } from "../paypal/tool-types.js"

/** PayPal's toolkit only accepts USD, so the demo does too. */
const CURRENCY: Currency = "USD"

export interface ServerConfig {
  store: Store
  rawTools: ToolSet
  mandateId: string
  agentId: string
  merchantId: string
  mode: string
  note: string
  model?: string
}

export interface ServerHandle {
  app: Express
  /** Current mandate id, updated when a new mandate is issued. */
  currentMandateId(): string
  isRunning(): boolean
}

class BadRequest extends Error {}

export function createApp(config: ServerConfig): ServerHandle {
  const { store, rawTools, agentId, merchantId } = config
  const app = express()

  let mandateId = config.mandateId
  let running = false

  let guardCache: { mandateId: string; tools: ToolSet } | null = null

  function toolsForCurrentMandate(): ToolSet {
    if (guardCache?.mandateId === mandateId) return guardCache.tools
    const { tools } = guardTools(rawTools, { store, mandateId, agentId, merchantId })
    guardCache = { mandateId, tools }
    return tools
  }

  // -------------------------------------------------------------------------
  // Serialization
  // -------------------------------------------------------------------------

  function snapshot(): Record<string, unknown> {
    const stored = store.get(mandateId)
    return {
      mode: config.mode,
      note: config.note,
      agentId,
      merchantId,
      model: config.model ?? null,
      running,
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

  /**
   * Cheap value that changes when anything visible changes. Used by the SSE
   * stream so a quiet demo does not re-send the whole snapshot twice a second.
   */
  function fingerprint(): string {
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

    const task = stringFrom((req.body as Record<string, unknown> | undefined)?.["task"])
    if (!task) {
      res.status(400).json({ ok: false, error: "task must be a non-empty string" })
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
