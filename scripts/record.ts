/**
 * Record one real agent run for the hosted replay.
 *
 * This runs the same agent, the same guard and the same store as the server,
 * in simulated PayPal mode, and saves every state transition. The output is
 * the evidence the demo plays back: genuine model tool calls and genuine
 * guard decisions, captured once so visitors do not spend anyone's quota.
 *
 * Usage: npm run record
 */

import "dotenv/config"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { describeMandate, runAgent } from "../src/agent/agent.js"
import { toAgentTools } from "../src/agent/tools.js"
import { Store } from "../src/core/store.js"
import { guardTools } from "../src/paypal/guard.js"
import { createPayPalTools } from "../src/paypal/index.js"
import {
  AGENT_ID,
  DEMO_TASK,
  MERCHANT,
  SEED_ORDERS,
  issueDemoMandate,
  seedTrust,
} from "../src/server/demo.js"
import type { RecordedFrame } from "../src/server/replay.js"
import { buildSnapshot, type ServerSnapshot } from "../src/server/snapshot.js"

const OUT = process.env["REPLAY_OUT"]?.trim() ?? "replays/demo-run.json"

const signingKey = process.env["MANDATE_SIGNING_KEY"]
if (!signingKey || signingKey.length < 16) {
  console.error("MANDATE_SIGNING_KEY is missing. Copy .env.example to .env and set it.")
  process.exit(1)
}
if (!process.env["GOOGLE_GENERATIVE_AI_API_KEY"]) {
  console.error("GOOGLE_GENERATIVE_AI_API_KEY is missing; the recording needs a real model run.")
  process.exit(1)
}

const store = new Store(signingKey)
const paypal = createPayPalTools(
  { sandbox: true },
  { merchantId: MERCHANT, seedOrders: SEED_ORDERS },
)
const mandateId = issueDemoMandate(store, 30 * 24 * 60 * 60 * 1_000)
seedTrust(store)

const { tools } = guardTools(paypal.tools, {
  store,
  mandateId,
  agentId: AGENT_ID,
  merchantId: MERCHANT,
})

let running = true
const started = Date.now()
const frames: RecordedFrame[] = []
let lastKey = ""

function keyOf(snapshot: ServerSnapshot): string {
  return [
    snapshot.ledger.length,
    snapshot.mandate?.state.spendToDate.amount ?? -1,
    snapshot.approvals.map((item) => `${item.id}:${item.status}`).join(","),
    snapshot.running,
  ].join("|")
}

function capture(): void {
  // Deep-copy: the store mutates mandate state and approval objects in place,
  // and a frame must show the world as it was at the moment it was captured.
  const snapshot = structuredClone(
    buildSnapshot(store, mandateId, {
      mode: "simulated",
      note: paypal.note,
      agentId: AGENT_ID,
      merchantId: MERCHANT,
      running,
    }),
  )
  const key = keyOf(snapshot)
  if (key === lastKey) return
  lastKey = key
  frames.push({ atMs: Date.now() - started, snapshot })
}

capture()

// Polling alone can merge decisions that land in the same tick. The ledger is
// the source of truth, so every append is captured as its own frame.
store.ledger.subscribe(() => capture())
const timer = setInterval(capture, 80)

const result = await runAgent({
  tools: toAgentTools(tools),
  mandateBrief: describeMandate(store, mandateId),
  task: DEMO_TASK,
})

// The recorded run includes the human half too: the payment the guard parked
// is approved and executed exactly as the server would do it.
const parked = store.listPending()[0]
if (parked?.args !== undefined) {
  store.resolveApproval(parked.id, true)
  const tool = tools[parked.action]
  if (tool?.execute) {
    await Promise.resolve(
      tool.execute(parked.args, { toolCallId: `approval-${parked.id}`, messages: [] }),
    )
  }
}

running = false
capture()
clearInterval(timer)

const recording = {
  kind: "agent-mandate-replay" as const,
  version: 1,
  recordedAt: new Date().toISOString(),
  paypalMode: "simulated",
  model: result.model,
  task: DEMO_TASK,
  text: result.text,
  durationMs: Date.now() - started,
  steps: result.steps,
  frames,
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, `${JSON.stringify(recording, null, 2)}\n`, "utf8")

const summary = store.ledger.summary()
console.log("=".repeat(70))
console.log(`Recorded ${result.model} run in ${(recording.durationMs / 1000).toFixed(1)}s`)
console.log(`Steps: ${result.steps.length} · frames: ${frames.length}`)
console.log(
  `Ledger: ${summary.total} decisions — ${summary.allowed} allowed, ${summary.denied} denied, ${summary.pendingApproval} escalated`,
)
console.log(`Saved to ${OUT}`)
console.log("=".repeat(70))
console.log(result.text)
