/**
 * PayPal wiring.
 *
 * Chooses between the real sandbox toolkit and the simulated one based on
 * whether credentials are present. Nothing else in the app knows the
 * difference: both return the same 47 tool names with the same schemas.
 */

import { ALL_TOOLS_ENABLED, PayPalAgentToolkit } from "@paypal/agent-toolkit/ai-sdk"
import { createSimulatedTools, type SimulatedOrder } from "./simulated.js"
import type { ToolSet } from "./tool-types.js"

export type PayPalMode = "live" | "simulated"

export interface PayPalConfig {
  clientId?: string
  clientSecret?: string
  sandbox: boolean
  merchantId?: string
}

export interface PayPalTools {
  mode: PayPalMode
  tools: ToolSet
  merchantId: string
  /** Why the mode was chosen, shown in the UI. */
  note: string
}

export function paypalConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PayPalConfig {
  const merchantId = env.PAYPAL_MERCHANT_ID?.trim()
  return {
    clientId: env.PAYPAL_CLIENT_ID?.trim() || undefined,
    clientSecret: env.PAYPAL_CLIENT_SECRET?.trim() || undefined,
    sandbox: (env.PAYPAL_ENVIRONMENT ?? "sandbox").toLowerCase() !== "live",
    ...(merchantId ? { merchantId } : {}),
  }
}

export function createPayPalTools(
  config: PayPalConfig,
  options: { seedOrders?: SimulatedOrder[]; merchantId?: string } = {},
): PayPalTools {
  const merchantId = options.merchantId ?? config.merchantId ?? "acme-supplies"

  if (config.clientId && config.clientSecret) {
    const toolkit = new PayPalAgentToolkit({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      configuration: {
        actions: ALL_TOOLS_ENABLED,
        context: { sandbox: config.sandbox, merchant_id: merchantId },
      },
    })

    return {
      // The toolkit's tools are typed against its own pinned AI SDK. They are
      // structurally the shape this app uses, so they are adopted here rather
      // than re-declared piece by piece.
      tools: toolkit.getTools() as unknown as ToolSet,
      mode: "live",
      merchantId,
      note: config.sandbox
        ? "Connected to the PayPal sandbox. Calls move sandbox money."
        : "Connected to PayPal live. Calls move real money.",
    }
  }

  return {
    mode: "simulated",
    tools: createSimulatedTools({
      merchantId,
      ...(options.seedOrders ? { seedOrders: options.seedOrders } : {}),
    }),
    merchantId,
    note: "No PayPal credentials found, so calls are simulated. Add sandbox credentials to go live.",
  }
}

export { createSimulatedTools }
export type { SimulatedOrder }
