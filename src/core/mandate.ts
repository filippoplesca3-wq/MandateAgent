/**
 * Mandate issuance, signing and verification.
 *
 * A mandate is a signed capability: it says "agent X may spend up to N of
 * currency C, at these merchants, before time T, for this purpose". The
 * signature is a detached Ed25519 signature over the canonicalized claims, so
 * the claims cannot be widened after issuance without invalidating the mandate.
 * Ed25519 is asymmetric: the server signs with a private key, while anyone can
 * verify with the published public key.
 *
 * Revocation is deliberately NOT part of the signed envelope. Revocation is
 * mutable server-side state, checked at evaluation time, so a mandate can be
 * killed instantly without re-issuing anything.
 */

import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  timingSafeEqual,
  type KeyObject,
  verify,
} from "node:crypto"
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

/** A signing key can be a long random string (derived to an Ed25519 seed) or a KeyObject. */
export type SigningKey = string | KeyObject

export function deriveKeyPair(secret: string): { privateKey: KeyObject; publicKey: KeyObject } {
  // Ed25519 needs a 32-byte seed. Derive it deterministically from the secret so
  // rotating MANDATE_SIGNING_KEY rotates the mandate keys, and the same secret
  // always yields the same pair. Node accepts the seed wrapped in a PKCS8 DER
  // envelope: the fixed Ed25519 prefix followed by the raw seed.
  const seed = createHash("sha256").update(secret).digest()
  const pkcs8 = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    seed,
  ])
  const privateKey = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })
  const publicKey = createPublicKey(privateKey)
  return { privateKey, publicKey }
}

function privateKeyFrom(key: SigningKey): KeyObject {
  if (typeof key === "string") return deriveKeyPair(key).privateKey
  if (key.type !== "private") throw new Error("signClaims: key must be a private KeyObject")
  return key
}

function publicKeyFrom(key: SigningKey): KeyObject {
  if (typeof key === "string") return deriveKeyPair(key).publicKey
  if (key.type === "public") return key
  return createPublicKey(key)
}

export function signClaims(claims: MandateClaims, key: SigningKey): string {
  const privateKey = privateKeyFrom(key)
  const signed = sign(null, Buffer.from(canonicalize(claims), "utf8"), privateKey)
  return Buffer.from(signed).toString("base64")
}

/**
 * Legacy HMAC-SHA256 signing. Kept so envelopes issued before the move to
 * Ed25519 can still be verified; new mandates are always Ed25519.
 */
export function signClaimsHmac(claims: MandateClaims, secret: string): string {
  return createHmac("sha256", secret).update(canonicalize(claims), "utf8").digest("hex")
}

function verifyHmac(envelope: MandateEnvelope, secret: string): SignatureResult {
  const expected = Buffer.from(signClaimsHmac(envelope.claims, secret), "hex")
  // Old envelopes used hex; accept base64 too so a re-encoded signature does
  // not fail for the wrong reason.
  const actual = /^[0-9a-f]{64}$/i.test(envelope.signature)
    ? Buffer.from(envelope.signature, "hex")
    : Buffer.from(envelope.signature, "base64")

  if (actual.length !== expected.length) {
    return { valid: false, reason: "signature does not match the claims" }
  }
  return timingSafeEqual(actual, expected)
    ? { valid: true, reason: "signature verified" }
    : { valid: false, reason: "signature does not match the claims" }
}

export function issueMandate(spec: IssueMandateSpec, signingKey: SigningKey): MandateEnvelope {
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
    algorithm: "Ed25519",
  }
}

export interface SignatureResult {
  valid: boolean
  reason: string
}

export function verifySignature(
  envelope: MandateEnvelope,
  key: SigningKey,
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

  if (envelope.algorithm === "HMAC-SHA256") {
    if (typeof key !== "string") {
      return { valid: false, reason: "HMAC mandate requires the shared secret to verify" }
    }
    return verifyHmac(envelope, key)
  }
  if (envelope.algorithm !== "Ed25519") {
    return { valid: false, reason: `unsupported signature algorithm: ${String(envelope.algorithm)}` }
  }

  let signature: Buffer
  try {
    signature = Buffer.from(envelope.signature, "base64")
  } catch {
    return { valid: false, reason: "signature is not valid base64" }
  }

  const publicKey = publicKeyFrom(key)
  let valid = false
  try {
    valid = verify(
      null,
      Buffer.from(canonicalize(envelope.claims), "utf8"),
      publicKey,
      signature,
    )
  } catch {
    valid = false
  }

  return valid
    ? { valid: true, reason: "signature verified" }
    : { valid: false, reason: "signature does not match the claims" }
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
    reservedToDate: { amount: 0, currency },
    transactionCount: 0,
  }
}

export function revokeMandate(state: MandateState, now: Date = new Date()): MandateState {
  return { ...state, revokedAt: now.toISOString() }
}

export function remainingBudget(claims: MandateClaims, state: MandateState): Money {
  const committed = state.spendToDate.amount + state.reservedToDate.amount
  return {
    amount: Math.max(0, claims.budget.amount - committed),
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
