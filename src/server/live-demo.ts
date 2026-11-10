/**
 * A live, isolated demo run.
 *
 * The hosted recording is the zero-cost fallback: it needs no key and makes no
 * calls. This module is the other half — a real Gemini run against simulated
 * PayPal, started on demand and thrown away when it finishes.
 *
 * Isolation is the point. Every run gets its own in-memory store, its own
 * signing key and its own mandate, so one visitor cannot spend another
 * visitor's budget, leave approvals behind or change the recorded demo. The
 * store dies with the request; the response carries everything the UI needs.
 *
 * PayPal is simulated on purpose. A public server must not hold PayPal
 * credentials, and a live run must never move money. The model, the guard and
 * the ledger are real; the payment rail is a local double.
 */

import { randomBytes } from "node:crypto"
import { describeMandate, runAgent, type AgentRunResult } from "../agent/agent.js"
import { toAgentTools } from "../agent/tools.js"
import { validateClaims, verifySignature } from "../core/mandate.js"
import { Store } from "../core/store.js"
import { guardTools } from "../paypal/guard.js"
import { createSimulatedTools } from "../paypal/simulated.js"
import type { ToolSet } from "../paypal/tool-types.js"
import {
  AGENT_ID,
  DEMO_TASK,
  MERCHANT,
  SEED_ORDERS,
  issueDemoMandate,
  seedTrust,
} from "./demo.js"
import { buildSnapshot, type ServerSnapshot } from "./snapshot.js"

export interface LiveRunInput {
  apiKey: string
  model?: string
  maxSteps?: number
  /** What the visitor asked for. Falls back to the recorded demo task. */
  task?: string
}

export interface LiveRunOutput {
  run: AgentRunResult
  snapshot: ServerSnapshot
  /** The ephemeral key this run was signed with, SPKI base64. */
  publicKey: string
  verification: {
    signatureValid: boolean
    claimsValid: boolean
    reason?: string
  }
}

/** The isolated world one live run works in. Exported so tests can inspect it. */
export interface LiveRunContext {
  store: Store
  mandateId: string
  tools: ToolSet
}

/** How long a live-run mandate is valid. It only has to outlive the request. */
const LIVE_MANDATE_TTL_MS = 60 * 60 * 1_000

/**
 * Build a fresh store, signing key, mandate and guarded toolset.
 *
 * Nothing is shared between calls, which is what keeps a public live run from
 * becoming a way to mutate the demo or another visitor's budget.
 */
export function createLiveRun(): LiveRunContext {
  const store = new Store(randomBytes(32).toString("hex"))
  const mandateId = issueDemoMandate(store, LIVE_MANDATE_TTL_MS)
  seedTrust(store)

  const rawTools = createSimulatedTools({ merchantId: MERCHANT, seedOrders: SEED_ORDERS })
  const { tools } = guardTools(rawTools, {
    store,
    mandateId,
    agentId: AGENT_ID,
    merchantId: MERCHANT,
  })

  return { store, mandateId, tools }
}

export async function runLiveDemo(input: LiveRunInput): Promise<LiveRunOutput> {
  const { store, mandateId, tools } = createLiveRun()

  const run = await runAgent({
    tools: toAgentTools(tools),
    mandateBrief: describeMandate(store, mandateId),
    task: input.task?.trim() || DEMO_TASK,
    apiKey: input.apiKey,
    ...(input.model ? { model: input.model } : {}),
    ...(input.maxSteps ? { maxSteps: input.maxSteps } : {}),
  })

  const stored = store.get(mandateId)
  if (!stored) throw new Error("live run: the mandate disappeared before it could be read")

  const signature = verifySignature(stored.envelope, store.verificationKey)
  const claims = validateClaims(stored.envelope.claims)
  const snapshot = buildSnapshot(store, mandateId, {
    mode: "simulated",
    note: "Live Gemini run against simulated PayPal. No PayPal credentials were used and no money moved.",
    agentId: AGENT_ID,
    merchantId: MERCHANT,
    running: false,
    model: run.model,
  })

  return {
    run,
    snapshot,
    publicKey: store.publicKeyBase64,
    verification: {
      signatureValid: signature.valid,
      claimsValid: claims.valid,
      ...(claims.valid ? {} : { reason: claims.reason }),
    },
  }
}
