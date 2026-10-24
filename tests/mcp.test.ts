import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { Store } from "../src/core/store.js"
import { createGuardedMcpServer } from "../src/mcp/server.js"
import { guardTools } from "../src/paypal/guard.js"
import { createSimulatedTools } from "../src/paypal/simulated.js"
import { TEST_KEY } from "./helpers.js"

const BUDGET = 12_000

let client: Client
let server: McpServer
let store: Store
let mandateId: string

beforeAll(async () => {
  store = new Store(TEST_KEY)
  const { envelope } = store.issue({
    principal: "filippo@example.com",
    agentId: "agent-mcp-test",
    budget: { amount: BUDGET, currency: "USD" },
    purpose: "MCP integration test",
    ttlMs: 60 * 60 * 1_000,
    constraints: {
      allowMerchants: ["acme-supplies"],
      maxPerTransaction: { amount: 5_000, currency: "USD" },
      requireApprovalAbove: { amount: 4_000, currency: "USD" },
    },
  })
  mandateId = envelope.claims.id

  const raw = createSimulatedTools({
    merchantId: "acme-supplies",
    seedOrders: [
      { id: "ORD00000000009901", status: "CREATED", amount: 1_250, currency: "USD", merchant: "acme-supplies" },
      { id: "ORD00000000009902", status: "CREATED", amount: 1_000, currency: "USD", merchant: "sketchy-deals" },
    ],
  })

  const { tools } = guardTools(raw, {
    store,
    mandateId,
    agentId: "agent-mcp-test",
    merchantId: "acme-supplies",
  })

  const created = createGuardedMcpServer({ store, mandateId, tools })
  server = created.server
  expect(created.toolNames).toHaveLength(48)

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  client = new Client({ name: "agent-mandate-test", version: "0.0.0" })
  await client.connect(clientTransport)
})

afterAll(async () => {
  await client.close()
  await server.close()
})

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content
  if (!Array.isArray(content)) throw new Error("expected a content array")
  const block: unknown = content[0]
  if (
    block === null ||
    typeof block !== "object" ||
    (block as { type?: unknown }).type !== "text" ||
    typeof (block as { text?: unknown }).text !== "string"
  ) {
    throw new Error("expected a text content block")
  }
  return (block as { text: string }).text
}

describe("MCP server", () => {
  it("exposes the guarded PayPal tools plus the mandate description", async () => {
    const listed = await client.listTools()
    const names = listed.tools.map((tool) => tool.name)
    expect(names).toHaveLength(48)
    expect(names).toContain("pay_order")
    expect(names).toContain("get_mandate")
  })

  it("reports the mandate that bounds the session", async () => {
    const result = await client.callTool({ name: "get_mandate", arguments: {} })
    const mandate = JSON.parse(textOf(result)) as {
      ok: boolean
      remaining: { amount: number }
      constraints: { allowMerchants: string[] }
    }
    expect(mandate.ok).toBe(true)
    expect(mandate.remaining.amount).toBe(BUDGET)
    expect(mandate.constraints.allowMerchants).toContain("acme-supplies")
  })

  it("allows a read the mandate permits", async () => {
    const result = await client.callTool({
      name: "get_order",
      arguments: { id: "ORD00000000009901" },
    })
    expect(result.isError).toBeFalsy()
    expect(textOf(result)).toContain("ORD00000000009901")
  })

  it("refuses a payment the mandate forbids, without moving budget", async () => {
    const result = await client.callTool({
      name: "pay_order",
      arguments: { id: "ORD00000000009902" },
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain("MERCHANT_NOT_ALLOWED")
    expect(store.get(mandateId)?.state.spendToDate.amount).toBe(0)
  })
})
