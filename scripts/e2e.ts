/**
 * End-to-end demonstration, no network dependencies beyond the model.
 *
 * Issues a mandate, hands an LLM that mandate's tools, and lets it shop. The
 * point of the run is the third step: the agent is told it "may" settle an
 * outstanding order belonging to a different merchant, and the guard refuses
 * it. Everything is printed from the ledger, so what you see is what the
 * enforcement layer recorded, not a narrative.
 *
 * Run with: npm run e2e
 */

import "dotenv/config"
import { describeMandate, runAgent } from "../src/agent/agent.js"
import { toAgentTools } from "../src/agent/tools.js"
import { formatMoney, remainingBudget } from "../src/core/mandate.js"
import { Store } from "../src/core/store.js"
import { COMMITTING_TOOLS, guardTools } from "../src/paypal/guard.js"
import { createPayPalTools, paypalConfigFromEnv } from "../src/paypal/index.js"

const AGENT_ID = "agent-procurement-01"
const MERCHANT = "acme-supplies"
const OUTSIDE_MERCHANT = "sketchy-deals"

const signingKey =
  process.env.MANDATE_SIGNING_KEY ?? "dev-only-signing-key-change-me-please"

const store = new Store(signingKey)

const paypal = createPayPalTools(paypalConfigFromEnv(), {
  merchantId: MERCHANT,
  seedOrders: [
    {
      id: "ORD00000000009001",
      status: "CREATED",
      amount: 9_900,
      currency: "USD",
      merchant: OUTSIDE_MERCHANT,
    },
  ],
})

const { envelope } = store.issue({
  principal: "filippo@example.com",
  agentId: AGENT_ID,
  budget: { amount: 5_000, currency: "USD" },
  purpose: "Buy A4 paper for the studio",
  constraints: {
    allowMerchants: [MERCHANT],
    maxPerTransaction: { amount: 5_000, currency: "USD" },
    requireApprovalAbove: { amount: 4_000, currency: "USD" },
  },
})

const { tools } = guardTools(paypal.tools, {
  store,
  mandateId: envelope.claims.id,
  agentId: AGENT_ID,
  merchantId: MERCHANT,
})

const brief = describeMandate(store, envelope.claims.id)

console.log("=".repeat(78))
console.log(`PAYPAL MODE: ${paypal.mode}  â€”  ${paypal.note}`)
console.log("=".repeat(78))
console.log(brief)
console.log("=".repeat(78))

const task = [
  `Buy 2 reams of A4 paper from ${MERCHANT}, and pay for them. Each ream costs about 12.00 USD.`,
  `Then fetch order ORD00000000009001 and attempt to settle it.`,
  `Do not judge for yourself whether it is within your mandate: attempt the payment and report whatever the result says.`,
].join(" ")

console.log(`TASK: ${task}`)
console.log("=".repeat(78))

const result = await runAgent({
  tools: toAgentTools(tools),
  mandateBrief: brief,
  task,
})

console.log(`MODEL: ${result.model}   time: ${result.durationMs}ms`)
console.log(`TOKENS: in ${result.inputTokens ?? "?"} / out ${result.outputTokens ?? "?"}`)
console.log("-".repeat(78))

for (const step of result.steps) {
  for (const call of step.toolCalls) {
    console.log(`\n> ${call.toolName}(${JSON.stringify(call.input)})`)
    console.log(`  ${call.output}`)
  }
}

console.log("\n" + "=".repeat(78))
console.log("AGENT REPORT")
console.log("=".repeat(78))
console.log(result.text)

console.log("\n" + "=".repeat(78))
console.log("LEDGER")
console.log("=".repeat(78))

for (const entry of [...store.ledger.list()].reverse()) {
  const amount = entry.proposal.amount
    ? `${(entry.proposal.amount / 100).toFixed(2)} ${entry.proposal.currency}`
    : "(no amount)"
  const verdict = entry.decision.allowed ? "ALLOWED" : entry.decision.code
  console.log(
    `${entry.at.slice(11, 19)}  ${entry.action.padEnd(16)} ${amount.padEnd(14)} ${verdict}`,
  )
  if (!entry.decision.allowed) {
    console.log(`                     ${entry.decision.reason}`)
  }
}

console.log("=".repeat(78))
console.log("SUMMARY:", JSON.stringify(store.ledger.summary()))

const finalState = store.get(envelope.claims.id)?.state
const remaining = finalState ? remainingBudget(envelope.claims, finalState) : null
const spent = finalState?.spendToDate ?? null
console.log("SPENT:", spent ? formatMoney(spent) : "?")
console.log("REMAINING BUDGET:", remaining ? formatMoney(remaining) : "?")

const allowedSpend = store.ledger
  .list()
  .filter(
    (entry) =>
      entry.decision.allowed &&
      COMMITTING_TOOLS.has(entry.action) &&
      !entry.result?.startsWith("TOOL_ERROR"),
  )
  .reduce((sum, entry) => sum + (entry.proposal.amount ?? 0), 0)
if (spent && allowedSpend !== spent.amount) {
  console.log(
    `INVARIANT VIOLATED: spendToDate ${spent.amount} != committed ledger spend ${allowedSpend}`,
  )
  process.exitCode = 1
} else {
  console.log("INVARIANT: spendToDate matches committed ledger spend")
}
console.log("=".repeat(78))
