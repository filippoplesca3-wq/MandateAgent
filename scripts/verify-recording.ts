/**
 * Verify the recorded run offline.
 *
 * Reads `replays/demo-run.json`, rebuilds the canonical claims bytes and checks
 * the Ed25519 signature against the public key embedded in the recording. No
 * server, no API call, no trust in the demo process.
 *
 * It also widens the budget by one cent and checks that the same signature no
 * longer verifies. That is the property the whole design rests on: the bytes
 * are signed, not the story around them.
 *
 * Usage:
 *   npm run verify:recording
 *   npm run verify:recording -- path/to/recording.json
 */

import { createPublicKey, verify } from "node:crypto"
import { canonicalize } from "../src/core/canonical.js"
import { validateClaims } from "../src/core/mandate.js"
import { loadReplayFile } from "../src/server/replay.js"

const path = process.argv[2] ?? "replays/demo-run.json"
const run = loadReplayFile(path)

if (!run.publicKey) {
  console.error(`${path}: no embedded public key, so it cannot be verified offline.`)
  process.exit(1)
}

const mandate = [...run.frames]
  .reverse()
  .find((frame) => frame.snapshot.mandate)?.snapshot.mandate
if (!mandate) {
  console.error(`${path}: no mandate in any frame.`)
  process.exit(1)
}
if (mandate.algorithm !== "Ed25519") {
  console.error(`${path}: algorithm is ${mandate.algorithm}; offline verification needs Ed25519.`)
  process.exit(1)
}

const key = createPublicKey({
  key: Buffer.from(run.publicKey, "base64"),
  format: "der",
  type: "spki",
})
const claims = validateClaims(mandate.claims)
const expired = !claims.valid && (claims.reason ?? "").startsWith("mandate expired")
const claimsOk = claims.valid || expired

const signatureValid = verify(
  null,
  Buffer.from(canonicalize(mandate.claims), "utf8"),
  key,
  Buffer.from(mandate.signature, "base64"),
)

const tampered = structuredClone(mandate.claims)
tampered.budget.amount += 1
const tamperedValid = verify(
  null,
  Buffer.from(canonicalize(tampered), "utf8"),
  key,
  Buffer.from(mandate.signature, "base64"),
)

const ok = signatureValid && claimsOk && !tamperedValid

console.log("")
console.log(`Recording:  ${path}`)
console.log(`Captured:   ${run.recordedAt} with ${run.model} (PayPal ${run.paypalMode})`)
console.log(`Mandate:    ${mandate.claims.id}`)
console.log(
  `Claims:     ${
    claims.valid
      ? "valid"
      : expired
        ? `${claims.reason} (expected; the signature is unaffected)`
        : `invalid (${claims.reason})`
  }`,
)
console.log(`Algorithm:  ${mandate.algorithm}`)
console.log(`Public key: ${run.publicKey.slice(0, 16)}... (embedded in the recording)`)
console.log(`Signature:  ${signatureValid ? "VALID" : "INVALID"}`)
console.log(`Tampered:   ${tamperedValid ? "ACCEPTED (bad)" : "rejected"}`)
console.log("")

if (!ok) {
  console.error("Offline verification failed.")
  process.exit(1)
}

console.log("Offline verification passed: the signature is real and a widened copy fails.")
