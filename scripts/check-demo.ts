/**
 * Audit a running demo, local or hosted.
 *
 * Usage:
 *   npm run check:demo
 *   npm run check:demo -- https://agent-mandate.onrender.com
 *
 * The script checks the claims a judge would otherwise have to take on trust:
 * the mandate is signed, the published key verifies it, a widened copy is
 * rejected, a replay refuses writes, and the live-run route is present and
 * refuses a non-JSON probe without spending a run. It exits non-zero on the
 * first failure, so it can run after a deploy or in CI.
 */

import { createPublicKey } from "node:crypto"
import type { MandateEnvelope } from "../src/core/types.js"
import type { ServerSnapshot } from "../src/server/snapshot.js"

const base = (process.argv[2] ?? "http://localhost:3001").replace(/\/+$/, "")

let passed = 0

function pass(label: string, detail: string): void {
  passed += 1
  console.log(`  PASS  ${label.padEnd(24)} ${detail}`)
}

function fail(label: string, detail: string): never {
  console.error(`  FAIL  ${label.padEnd(24)} ${detail}`)
  console.error(`\nDemo audit failed against ${base}`)
  process.exit(1)
}

interface Reply<T> {
  status: number
  body: T
}

interface VerifyReply {
  ok: boolean
  signatureValid: boolean
  claimsValid: boolean
  revoked: boolean
  algorithm?: string
  source?: string
  signatureReason?: string
  claimsReason?: string
  error?: string
}

interface PublicKeyReply {
  ok: boolean
  algorithm: string
  format: string
  source?: string
  publicKey: string
}

async function call<T>(
  path: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<Reply<T>> {
  let response: Response
  try {
    response = await fetch(`${base}${path}`, init)
  } catch (error) {
    fail(path, `could not reach the server: ${error instanceof Error ? error.message : String(error)}`)
  }

  const text = await response.text()
  let body: unknown
  try {
    body = text.length > 0 ? JSON.parse(text) : {}
  } catch {
    body = { raw: text.slice(0, 200) }
  }

  return { status: response.status, body: body as T }
}

console.log(`\nAuditing ${base}\n`)

const health = await call<{ ok?: boolean }>("/api/health")
if (health.status !== 200 || health.body.ok !== true) {
  fail("health", `expected 200 { ok: true }, got ${health.status}`)
}
pass("health", "200 ok")

const state = await call<ServerSnapshot>("/api/state")
if (state.status !== 200) fail("snapshot", `expected 200, got ${state.status}`)

const mandate = state.body.mandate
if (!mandate) fail("snapshot", "the snapshot has no mandate")

const envelope: MandateEnvelope = {
  claims: mandate.claims,
  signature: mandate.signature,
  algorithm: mandate.algorithm as MandateEnvelope["algorithm"],
}
pass("snapshot", `${state.body.mode} mode, mandate ${mandate.claims.id.slice(0, 8)}`)

const live = state.body.live
if (live) {
  if (!Number.isInteger(live.cap) || live.cap < 1) {
    fail("live config", `expected a positive daily cap, got ${live.cap}`)
  }
  if (!Number.isInteger(live.remaining) || live.remaining < 0 || live.remaining > live.cap) {
    fail("live config", `remaining ${live.remaining} is outside 0..${live.cap}`)
  }
  pass(
    "live config",
    `${live.enabled ? "enabled" : "disabled"}, ${live.remaining}/${live.cap} runs left today`,
  )
} else {
  console.log("  SKIP  live config             live runs are off")
}

const key = await call<PublicKeyReply>("/api/mandate/public-key")
if (key.status !== 200 || key.body.ok !== true) {
  fail("public key", `expected 200 { ok: true }, got ${key.status}`)
}
if (key.body.algorithm !== "Ed25519") {
  fail("public key", `expected Ed25519, got ${key.body.algorithm}`)
}
if (key.body.format !== "spki-der-base64") {
  fail("public key", `expected spki-der-base64, got ${key.body.format}`)
}
try {
  const parsed = createPublicKey({
    key: Buffer.from(key.body.publicKey, "base64"),
    format: "der",
    type: "spki",
  })
  if (parsed.type !== "public") fail("public key", `parsed as ${parsed.type}, expected public`)
} catch (error) {
  fail(
    "public key",
    `not a valid SPKI DER key: ${error instanceof Error ? error.message : String(error)}`,
  )
}
pass("public key", `Ed25519, ${key.body.source ?? "unspecified"} key`)

const stored = await call<VerifyReply>(`/api/mandates/${mandate.claims.id}/verify`)
if (stored.status !== 200) fail("stored verification", `expected 200, got ${stored.status}`)
if (stored.body.ok !== true) {
  fail(
    "stored verification",
    stored.body.signatureReason ?? stored.body.claimsReason ?? "ok was false",
  )
}
pass("stored verification", "signature valid, claims valid, not revoked")

const posted = await call<VerifyReply>("/api/verify-mandate", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ envelope }),
})
if (posted.status !== 200) fail("envelope verification", `expected 200, got ${posted.status}`)
if (posted.body.ok !== true || posted.body.signatureValid !== true) {
  fail("envelope verification", posted.body.signatureReason ?? "the envelope was rejected")
}
pass("envelope verification", "same envelope accepted")

const tampered = structuredClone(envelope)
tampered.claims.budget.amount += 1
const rejected = await call<VerifyReply>("/api/verify-mandate", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ envelope: tampered }),
})
if (rejected.status !== 200) {
  fail("tamper rejection", `expected 200 with signatureValid=false, got ${rejected.status}`)
}
if (rejected.body.signatureValid !== false || rejected.body.ok !== false) {
  fail("tamper rejection", "a widened budget was accepted")
}
pass("tamper rejection", "widened budget rejected")

if (state.body.replay) {
  for (const path of ["/api/mandate", "/api/mandate/revoke"]) {
    const write = await call<{ ok?: boolean; error?: string }>(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
    if (write.status !== 409) {
      fail("read-only replay", `${path} returned ${write.status}, expected 409`)
    }
  }
  pass("read-only replay", "writes return 409")
} else {
  console.log("  SKIP  read-only replay         not a replay")
}

// Zero-cost probe: the route must exist and refuse a non-JSON POST before it
// can spend a run. Never send JSON here; that would consume the daily budget.
const liveProbe = await call<{ ok?: boolean; error?: string }>("/api/demo/live-run", {
  method: "POST",
  headers: { "content-type": "text/plain" },
  body: "probe",
})
if (liveProbe.status !== 415) {
  fail("live route", `expected 415 for a non-JSON POST, got ${liveProbe.status}`)
}
pass("live route", "non-JSON POST refused with 415")

console.log(`\n${passed} checks passed. The demo proves what it claims.\n`)
