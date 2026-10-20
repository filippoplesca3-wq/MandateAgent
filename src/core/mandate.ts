/**
 * Mandate issuance, signing and verification.
 *
 * A mandate is a signed capability: it says "agent X may spend up to N of
 * currency C, at these merchants, before time T, for this purpose". The
 * signature is a detached HMAC-SHA256 over the canonicalized claims, so the
 * claims cannot be widened after issuance without invalidating the mandate.
 *
 * Revocation is deliberately NOT part of the signed envelope. Revocation is
 * mutable server-side state, checked at evaluation time, so a mandate can be
 * killed instantly without re-issuing anything.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import { canonicalize } from "./canonical.js"
import type {
  MandateClaims,
  MandateConstraints,
  MandateEnvelope,
  MandateState,
  Money,
} from "./types.js"

export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

export interface IssueMandateSpec {
  principal: string
  agentId: string
  budget: Money
  purpose: string
  /** Lifetime in ms from `now`. Ignored when `expiresAt` is given. */
  ttlMs?: number
  expiresAt?: string
  constraints?: MandateConstraints
  now?: Date
}

export function signClaims(claims: MandateClaims, signingKey: string): string {
  return createHmac("sha256", signingKey).update(canonicalize(claims)).digest("hex")
}

export function issueMandate(spec: IssueMandateSpec, signingKey: string): MandateEnvelope {
  assertPositiveMoney(spec.budget, "budget")

  const now = spec.now ?? new Date()
  const expiresAt =
    spec.expiresAt ?? new Date(now.getTime() + (spec.ttlMs ?? DEFAULT_TTL_MS)).toISOString()

  if (Number.isNaN(Date.parse(expiresAt))) {
    throw new Error(`issueMandate: expiresAt is not a valid date: ${expiresAt}`)
  }
  if (Date.parse(expiresAt) <= now.getTime()) {
    throw new Error("issueMandate: expiresAt must be in the future")
  }

  const claims: MandateClaims = {
    id: randomUUID(),
    principal: spec.principal,
    agentId: spec.agentId,
    issuedAt: now.toISOString(),
    expiresAt,
    budget: { amount: spec.budget.amount, currency: spec.budget.currency },
    purpose: spec.purpose,
    constraints: spec.constraints ?? {},
    nonce: randomUUID(),
  }

  return {
    claims,
    signature: signClaims(claims, signingKey),
    algorithm: "HMAC-SHA256",
  }
}

export interface SignatureResult {
  valid: boolean
  reason: string
}

export function verifySignature(
  envelope: MandateEnvelope,
  signingKey: string,
): SignatureResult {
  if (!envelope || typeof envelope !== "object") {
    return { valid: false, reason: "envelope is not an object" }
  }
  if (!envelope.claims || typeof envelope.claims !== "object") {
    return { valid: false, reason: "envelope has no claims" }
  }
  if (typeof envelope.signature !== "string" || envelope.signature.length === 0) {
    return { valid: false, reason: "envelope has no signature" }
  }

  const expected = signClaims(envelope.claims, signingKey)
  const a = Buffer.from(expected, "utf8")
  const b = Buffer.from(envelope.signature, "utf8")

  // timingSafeEqual throws on length mismatch, so compare lengths first. The
  // length of a hex HMAC is not secret, so leaking it here is harmless.
  if (a.length !== b.length) {
    return { valid: false, reason: "signature does not match the claims" }
  }
  if (!timingSafeEqual(a, b)) {
    return { valid: false, reason: "signature does not match the claims" }
  }
  return { valid: true, reason: "signature verified" }
}

export interface ClaimsValidity {
  valid: boolean
  reason: string
}

export function validateClaims(claims: MandateClaims, now: Date = new Date()): ClaimsValidity {
  if (typeof claims.id !== "string" || claims.id.length === 0) {
    return { valid: false, reason: "mandate has no id" }
  }
  if (typeof claims.agentId !== "string" || claims.agentId.length === 0) {
    return { valid: false, reason: "mandate has no agentId" }
  }
  if (typeof claims.principal !== "string" || claims.principal.length === 0) {
    return { valid: false, reason: "mandate has no principal" }
  }
  if (!claims.budget || !Number.isInteger(claims.budget.amount) || claims.budget.amount <= 0) {
    return { valid: false, reason: "mandate budget must be a positive integer amount" }
  }
  if (typeof claims.budget.currency !== "string" || claims.budget.currency.length === 0) {
    return { valid: false, reason: "mandate budget must have a currency" }
  }

  const expiry = Date.parse(claims.expiresAt)
  if (Number.isNaN(expiry)) {
    return { valid: false, reason: `mandate expiry is not a valid date: ${claims.expiresAt}` }
  }
  if (expiry <= now.getTime()) {
    return { valid: false, reason: `mandate expired at ${claims.expiresAt}` }
  }

  return { valid: true, reason: "claims are well formed and unexpired" }
}

export function newMandateState(mandateId: string, currency: string): MandateState {
  return {
    mandateId,
    revokedAt: null,
    spendToDate: { amount: 0, currency },
    transactionCount: 0,
  }
}

export function revokeMandate(state: MandateState, now: Date = new Date()): MandateState {
  return { ...state, revokedAt: now.toISOString() }
}

export function remainingBudget(claims: MandateClaims, state: MandateState): Money {
  return {
    amount: Math.max(0, claims.budget.amount - state.spendToDate.amount),
    currency: claims.budget.currency,
  }
}

/** Human-readable money, for logs and UI. */
export function formatMoney(money: Money): string {
  const major = money.amount / 100
  return `${money.currency} ${major.toFixed(2)}`
}

function assertPositiveMoney(money: Money, label: string): void {
  if (!money || !Number.isInteger(money.amount) || money.amount <= 0) {
    throw new Error(`${label} must be a positive integer amount in minor units`)
  }
  if (typeof money.currency !== "string" || money.currency.length === 0) {
    throw new Error(`${label} must have a currency`)
  }
}
