import { describe, expect, it } from "vitest"
import {
  hasAllWebhookHeaders,
  readWebhookEvent,
  webhookHeadersFrom,
} from "../src/paypal/webhook.js"

const CAPTURE_COMPLETED = {
  id: "WH-2WR32451HC0233532-67976317FL4543714",
  event_version: "1.0",
  create_time: "2026-10-22T09:12:44.123Z",
  resource_type: "capture",
  event_type: "PAYMENT.CAPTURE.COMPLETED",
  resource: {
    id: "3C679366HH908993F",
    status: "COMPLETED",
    amount: { currency_code: "USD", value: "2.00" },
    supplementary_data: {
      related_ids: { order_id: "4Y715362NW1536928" },
    },
  },
}

describe("webhook event parsing", () => {
  it("flattens a capture event into the fields the demo records", () => {
    expect(readWebhookEvent(CAPTURE_COMPLETED)).toEqual({
      id: "WH-2WR32451HC0233532-67976317FL4543714",
      type: "PAYMENT.CAPTURE.COMPLETED",
      createTime: "2026-10-22T09:12:44.123Z",
      resourceType: "capture",
      resourceId: "3C679366HH908993F",
      status: "COMPLETED",
      amount: { value: "2.00", currencyCode: "USD" },
      orderId: "4Y715362NW1536928",
    })
  })

  it("rejects payloads without an id or event type", () => {
    expect(readWebhookEvent({})).toBeNull()
    expect(readWebhookEvent({ id: "WH-1" })).toBeNull()
    expect(readWebhookEvent("not an object")).toBeNull()
    expect(readWebhookEvent(null)).toBeNull()
  })

  it("tolerates events without a capture resource", () => {
    expect(
      readWebhookEvent({ id: "WH-2", event_type: "CUSTOMER.DISPUTE.CREATED", resource: {} }),
    ).toEqual({ id: "WH-2", type: "CUSTOMER.DISPUTE.CREATED" })
  })
})

describe("webhook headers", () => {
  it("reads the transmission headers PayPal sends", () => {
    const headers = webhookHeadersFrom({
      "paypal-transmission-id": "abc",
      "paypal-transmission-time": "2026-10-22T09:12:44Z",
      "paypal-transmission-sig": "sig",
      "paypal-cert-url": "https://api.paypal.com/cert.pem",
      "paypal-auth-algo": "SHA256withRSA",
    })
    expect(hasAllWebhookHeaders(headers)).toBe(true)
    expect(headers.transmissionId).toBe("abc")
  })

  it("treats a delivery with missing headers as unverifiable", () => {
    const headers = webhookHeadersFrom({ "paypal-transmission-id": "abc" })
    expect(hasAllWebhookHeaders(headers)).toBe(false)
  })
})
