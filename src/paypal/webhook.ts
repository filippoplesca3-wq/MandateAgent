/**
 * Inbound PayPal webhooks.
 *
 * A webhook is only trusted after PayPal's own verification endpoint says the
 * signature matches, so a forged POST cannot claim that a payment settled.
 * The app records the verified event for display; the mandate ledger is the
 * source of truth for spend, and a webhook never moves budget.
 */

export interface PayPalApiConfig {
  clientId: string
  clientSecret: string
  sandbox: boolean
}

export interface WebhookHeaders {
  transmissionId: string
  transmissionTime: string
  transmissionSig: string
  certUrl: string
  authAlgo: string
}

/** The fields this app cares about, flattened from a PayPal event. */
export interface PayPalWebhookEvent {
  id: string
  type: string
  createTime?: string
  resourceType?: string
  resourceId?: string
  status?: string
  amount?: { value: string; currencyCode: string }
  orderId?: string
}

/** Read the transmission headers PayPal sends with every delivery. */
export function webhookHeadersFrom(headers: Record<string, string | undefined>): WebhookHeaders {
  return {
    transmissionId: headers["paypal-transmission-id"] ?? "",
    transmissionTime: headers["paypal-transmission-time"] ?? "",
    transmissionSig: headers["paypal-transmission-sig"] ?? "",
    certUrl: headers["paypal-cert-url"] ?? "",
    authAlgo: headers["paypal-auth-algo"] ?? "",
  }
}

export function hasAllWebhookHeaders(headers: WebhookHeaders): boolean {
  return (
    headers.transmissionId.length > 0 &&
    headers.transmissionTime.length > 0 &&
    headers.transmissionSig.length > 0 &&
    headers.certUrl.length > 0 &&
    headers.authAlgo.length > 0
  )
}

/**
 * Ask PayPal whether this delivery is authentic. Returns false on any error:
 * an unverifiable webhook is treated exactly like a forged one.
 */
export async function verifyWebhookSignature(
  config: PayPalApiConfig,
  webhookId: string,
  headers: WebhookHeaders,
  event: unknown,
): Promise<boolean> {
  const base = config.sandbox ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com"
  const authorization = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")

  const response = await fetch(`${base}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${authorization}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      auth_algo: headers.authAlgo,
      cert_url: headers.certUrl,
      transmission_id: headers.transmissionId,
      transmission_sig: headers.transmissionSig,
      transmission_time: headers.transmissionTime,
      webhook_id: webhookId,
      webhook_event: event,
    }),
  })

  if (!response.ok) return false
  const body = (await response.json()) as { verification_status?: string }
  return body.verification_status === "SUCCESS"
}

/** Flatten a PayPal event into the fields the demo records. */
export function readWebhookEvent(payload: unknown): PayPalWebhookEvent | null {
  const root = asRecord(payload)
  if (!root) return null

  const id = typeof root["id"] === "string" ? root["id"] : undefined
  const type = typeof root["event_type"] === "string" ? root["event_type"] : undefined
  if (!id || !type) return null

  const resource = asRecord(root["resource"]) ?? {}
  const amount = asRecord(resource["amount"])
  const supplementary = asRecord(resource["supplementary_data"])
  const related = asRecord(supplementary?.["related_ids"])

  const event: PayPalWebhookEvent = { id, type }
  if (typeof root["create_time"] === "string") event.createTime = root["create_time"]
  if (typeof root["resource_type"] === "string") event.resourceType = root["resource_type"]
  if (typeof resource["id"] === "string") event.resourceId = resource["id"]
  if (typeof resource["status"] === "string") event.status = resource["status"]
  if (amount && typeof amount["value"] === "string" && typeof amount["currency_code"] === "string") {
    event.amount = { value: amount["value"], currencyCode: amount["currency_code"] }
  }
  if (related && typeof related["order_id"] === "string") event.orderId = related["order_id"]
  return event
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}
