/**
 * Adapter from the framework-neutral tool shape to the AI SDK's tool shape.
 *
 * The guard produces plain `{ description, parameters, execute }` objects.
 * This is the only place that knows which SDK is driving the session, so
 * swapping the agent framework does not reach into the enforcement layer.
 */

import { tool, type ToolSet as AgentToolSet } from "ai"
import type { ToolSet } from "../paypal/tool-types.js"

export function toAgentTools(tools: ToolSet): AgentToolSet {
  const adapted: Record<string, unknown> = {}

  for (const [name, definition] of Object.entries(tools)) {
    adapted[name] = tool({
      description: definition.description ?? name,
      // The PayPal toolkit declares these schemas with zod. The AI SDK accepts
      // a zod schema here directly; the cast is only because this layer treats
      // schemas as opaque.
      inputSchema: definition.parameters as never,
      execute: definition.execute as never,
    })
  }

  return adapted as AgentToolSet
}
