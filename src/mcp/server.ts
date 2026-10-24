/**
 * The guarded PayPal tool set exposed over MCP.
 *
 * Every tool an MCP client sees is the same tool the in-process agent uses, so
 * the mandate policy applies identically no matter which client is driving.
 * The only extra tool is `get_mandate`, a read-only view of the authority the
 * session is bound to, which a remote agent needs in order to plan.
 */

import { randomUUID } from "node:crypto"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { z } from "zod"
import { remainingBudget } from "../core/mandate.js"
import type { Store } from "../core/store.js"
import type { ToolSet } from "../paypal/tool-types.js"

export interface McpServerOptions {
  store: Store
  mandateId: string
  tools: ToolSet
}

export interface GuardedMcpServer {
  server: McpServer
  toolNames: string[]
}

/** A guard refusal is still a successful MCP call, but mark it as an error. */
function isRefusal(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as { ok?: unknown }
    return parsed.ok === false
  } catch {
    return false
  }
}

export function createGuardedMcpServer(options: McpServerOptions): GuardedMcpServer {
  const { store, mandateId, tools } = options
  const server = new McpServer({ name: "agent-mandate", version: "0.1.0" })

  server.tool(
    "get_mandate",
    "Read the signed spending authority this session is bound to: budget, remaining amount, constraints and expiry.",
    {},
    async () => {
      const stored = store.get(mandateId)
      if (!stored) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ok: false, code: "MALFORMED_MANDATE", reason: "no current mandate" }),
            },
          ],
          isError: true,
        }
      }

      const { claims } = stored.envelope
      const { state } = stored
      const text = JSON.stringify(
        {
          ok: true,
          id: claims.id,
          principal: claims.principal,
          agentId: claims.agentId,
          purpose: claims.purpose,
          budget: claims.budget,
          spendToDate: state.spendToDate,
          remaining: remainingBudget(claims, state),
          constraints: claims.constraints,
          expiresAt: claims.expiresAt,
          revokedAt: state.revokedAt,
        },
        null,
        2,
      )
      return { content: [{ type: "text" as const, text }] }
    },
  )

  const toolNames: string[] = ["get_mandate"]

  for (const [name, tool] of Object.entries(tools)) {
    const shape = (tool.parameters as { shape?: z.ZodRawShape } | undefined)?.shape
    if (!shape) {
      throw new Error(`tool ${name} has no zod parameter shape; it cannot be exposed over MCP`)
    }

    server.tool(name, tool.description ?? `PayPal tool ${name}`, shape, async (args) => {
      if (!tool.execute) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ok: false, code: "TOOL_ERROR", reason: `tool ${name} is not executable` }),
            },
          ],
          isError: true,
        }
      }

      try {
        const raw = await tool.execute(args, {
          toolCallId: `mcp-${name}-${randomUUID()}`,
          messages: [],
        })
        const text = typeof raw === "string" ? raw : JSON.stringify(raw)
        return {
          content: [{ type: "text" as const, text }],
          ...(isRefusal(text) ? { isError: true } : {}),
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ ok: false, code: "TOOL_ERROR", reason }),
            },
          ],
          isError: true,
        }
      }
    })

    toolNames.push(name)
  }

  return { server, toolNames }
}
