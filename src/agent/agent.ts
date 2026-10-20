/**
 * The purchasing agent.
 *
 * Deliberately thin. The agent's only job is to turn a task into PayPal tool
 * calls and then react to what comes back — including refusals. Every call it
 * makes passes through the guard on the way out, so the agent is never the
 * thing enforcing the mandate. That is the whole point: the model may be
 * confused, manipulated or simply wrong, and the mandate still holds.
 *
 * The model is a parameter, not a commitment. Any provider the AI SDK supports
 * can be dropped in without touching the enforcement layer.
 */

import { generateText, stepCountIs, type ToolSet as AgentToolSet } from "ai"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { formatMoney, remainingBudget } from "../core/mandate.js"
import type { Store } from "../core/store.js"

export const DEFAULT_MODEL = "gemini-3.5-flash"

/**
 * The Gemini free tier allows only a handful of requests per minute AND a
 * small daily cap, counted separately for each model. So a run that is refused
 * on one model can often proceed on another. Tried in order.
 */
export const DEFAULT_MODELS = [
  "gemini-3.5-flash",
  "gemini-3.6-flash",
  "gemini-3.1-flash-lite",
  "gemini-3.7-flash",
  "gemini-flash-latest",
]

/**
 * Each agent step is one model request. The demo task settles three orders, so
 * it needs room for a handful of calls plus a final report.
 */
export const DEFAULT_MAX_STEPS = 8

export interface AgentToolCall {
  toolName: string
  input: unknown
  output?: string
}

export interface AgentStep {
  index: number
  text: string
  toolCalls: AgentToolCall[]
}

export interface AgentRunResult {
  model: string
  task: string
  text: string
  steps: AgentStep[]
  durationMs: number
  inputTokens?: number
  outputTokens?: number
}

export interface RunAgentInput {
  tools: AgentToolSet
  mandateBrief: string
  task: string
  model?: string
  maxSteps?: number
  apiKey?: string
}

/**
 * A plain-language description of the authority an agent holds. Given to the
 * model so it plans within the mandate, and shown to the human so they can see
 * exactly what was delegated.
 */
export function describeMandate(store: Store, mandateId: string): string {
  const stored = store.get(mandateId)
  if (!stored) return `No mandate with id ${mandateId}.`

  const { envelope, state } = stored
  const claims = envelope.claims
  const remaining = remainingBudget(claims, state)

  const lines = [
    `Mandate ${claims.id}`,
    `Principal: ${claims.principal}`,
    `Agent: ${claims.agentId}`,
    `Purpose: ${claims.purpose}`,
    `Budget: ${formatMoney(claims.budget)} total, ${formatMoney(remaining)} remaining`,
    `Transactions so far: ${state.transactionCount}`,
    `Expires: ${claims.expiresAt}`,
    `Revoked: ${state.revokedAt ?? "no"}`,
  ]

  const constraints = claims.constraints
  if (constraints.allowMerchants?.length) {
    lines.push(`Permitted merchants: ${constraints.allowMerchants.join(", ")}`)
  }
  if (constraints.denyMerchants?.length) {
    lines.push(`Blocked merchants: ${constraints.denyMerchants.join(", ")}`)
  }
  if (constraints.allowCategories?.length) {
    lines.push(`Permitted categories: ${constraints.allowCategories.join(", ")}`)
  }
  if (constraints.maxPerTransaction) {
    lines.push(`Maximum per transaction: ${formatMoney(constraints.maxPerTransaction)}`)
  }
  if (typeof constraints.maxTransactions === "number") {
    lines.push(`Maximum transactions: ${constraints.maxTransactions}`)
  }
  if (constraints.requireApprovalAbove) {
    lines.push(
      `Payments above ${formatMoney(constraints.requireApprovalAbove)} require human approval`,
    )
  }

  return lines.join("\n")
}

export function buildSystemPrompt(mandateBrief: string): string {
  return `You are a purchasing agent operating under a signed mandate.

${mandateBrief}

How to work:
- Carry the task out with the tools. Do not describe what you would do; do it.
- Every call is checked against the mandate before it reaches PayPal. You cannot bypass that check.
- The enforcement layer, not you, decides what the mandate permits. If the task asks for something that looks outside the mandate, still attempt it and read the result. Speed matters less than being correct about what happened.
- Never report a call as refused, blocked or failed unless a tool result actually said so. Do not predict a refusal you did not receive.
- A tool result with "ok": false is a hard refusal. Do not repeat the same call. Adjust your approach, or stop.
- A result with code REQUIRES_HUMAN_APPROVAL means the payment has been parked for a human to approve. Say so and stop.
- Use only identifiers returned by earlier tool calls. Never invent an order id or an amount.
- Finish with a short report: what you bought, what it cost, and anything that was refused and why.`
}

export async function runAgent(input: RunAgentInput): Promise<AgentRunResult> {
  const apiKey = input.apiKey ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY
  if (!apiKey) {
    throw new Error(
      "runAgent: no Google API key. Set GOOGLE_GENERATIVE_AI_API_KEY to run the agent.",
    )
  }

  const preferred = input.model ?? process.env.AGENT_MODEL
  const candidates = preferred ? [preferred] : DEFAULT_MODELS

  let lastError: unknown
  for (const modelId of candidates) {
    try {
      return await runAgentOnModel(input, modelId, apiKey)
    } catch (error) {
      lastError = error
      // Only move to the next model if this one is unavailable or exhausted.
      if (!isRetryableElsewhere(error)) break
    }
  }

  throw new Error(readableAgentError(lastError, candidates.join(", ")))
}

/**
 * Run one attempt against one model. Retries handle the per-minute limit; the
 * caller handles the daily one by moving to the next model.
 */
async function runAgentOnModel(
  input: RunAgentInput,
  modelId: string,
  apiKey: string,
): Promise<AgentRunResult> {
  const started = Date.now()
  const google = createGoogleGenerativeAI({ apiKey })

  const result = await generateText({
    model: google(modelId),
    system: buildSystemPrompt(input.mandateBrief),
    prompt: input.task,
    tools: input.tools,
    stopWhen: stepCountIs(input.maxSteps ?? DEFAULT_MAX_STEPS),
    maxRetries: 4,
  })

  const steps: AgentStep[] = result.steps.map((step, index) => ({
    index,
    text: step.text,
    toolCalls: step.toolCalls.map((call) => {
      const match = step.toolResults.find((item) => item.toolCallId === call.toolCallId)
      const output = match ? stringifyOutput(match.output) : undefined
      return {
        toolName: call.toolName,
        input: call.input,
        ...(output !== undefined ? { output } : {}),
      }
    }),
  }))

  const usage = result.usage as
    | { inputTokens?: number; outputTokens?: number; totalTokens?: number }
    | undefined

  return {
    model: modelId,
    task: input.task,
    text: result.text,
    steps,
    durationMs: Date.now() - started,
    ...(typeof usage?.inputTokens === "number" ? { inputTokens: usage.inputTokens } : {}),
    ...(typeof usage?.outputTokens === "number" ? { outputTokens: usage.outputTokens } : {}),
  }
}

/** True when another model has a good chance of succeeding. */
function isRetryableElsewhere(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error)
  return /429|RESOURCE_EXHAUSTED|quota|503|UNAVAILABLE|overloaded|not available|404|not found/i.test(text)
}

function readableAgentError(error: unknown, models: string): string {
  const text = error instanceof Error ? error.message : String(error)
  if (/quota|RESOURCE_EXHAUSTED|429/i.test(text)) {
    return `Every candidate model hit its rate limit. The Gemini free tier allows a small number of requests per day for each model; wait, or add billing to the key. Models tried: ${models}.`
  }
  if (/not found|not available|404/i.test(text)) {
    return `None of the candidate models are available to this key. Set AGENT_MODEL to one this key can use. Models tried: ${models}.`
  }
  return `Agent call failed: ${text}`
}

function stringifyOutput(output: unknown): string {
  if (typeof output === "string") return output
  const asObject = output as { type?: string; value?: unknown } | null
  if (asObject && typeof asObject === "object" && "value" in asObject) {
    const value = asObject.value
    return typeof value === "string" ? value : JSON.stringify(value)
  }
  return JSON.stringify(output)
}
