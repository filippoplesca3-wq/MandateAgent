# Security model

Agent Mandate is a spending-control system, so the threat model is the product.
This page states what is protected, who the adversaries are, which control stops
them, and where the evidence lives.

## Assets

1. The principal's PayPal money and the mandate budget.
2. `MANDATE_SIGNING_KEY` — possession of it forges authority.
3. `ADMIN_TOKEN` — possession of it issues, revokes and approves.
4. PayPal client credentials.
5. Ledger integrity — refusals are evidence, not errors.

## Adversaries and controls

| # | Threat | Control | Evidence |
| --- | --- | --- | --- |
| 1 | A prompt-injected model pays an unapproved merchant | Merchant allowlist is enforced outside the prompt, against the order read back from PayPal | `tests/guard.test.ts` — "refuses an order belonging to a merchant outside the allowlist"; `tests/app.test.ts` — prompt injection |
| 2 | The model quotes a smaller amount than it is charged | `pay_order` carries only an order id; the guard reads the real total. `create_order` totals are recomputed from line items, tax, shipping and discount | `tests/guard.test.ts` — "enforces the order's real amount"; "computes tax and shipping into the enforced total" |
| 3 | The model widens the mandate's claims | Ed25519 signature over canonicalized claims is verified before every evaluation | `tests/mandate.test.ts` — "rejects the envelope after the budget is raised", expiry extended, agent swapped |
| 4 | A forged signature or unknown algorithm | Ed25519 verification; unknown algorithms are rejected. Legacy HMAC uses `crypto.timingSafeEqual` | `tests/mandate.test.ts` — signature coverage, unknown algorithm, legacy HMAC |
| 5 | An expired mandate is reused | `validateClaims` runs at evaluation time | `tests/mandate.test.ts`; `tests/policy.test.ts` — `MANDATE_EXPIRED` |
| 6 | A revoked mandate is reused | Revocation is server state checked on every call; it is deliberately not a signed claim | `tests/policy.test.ts` — `MANDATE_REVOKED`; `tests/guard.test.ts` — read and spend tools blocked |
| 7 | Two concurrent captures both pass the budget check | A synchronous reservation is taken before the PayPal call; confirm on success, release on failure | `tests/reservation.test.ts`; `tests/guard.test.ts` — concurrent captures |
| 8 | An approval is replayed or stretched to another order | Approval is bound to mandate, action, amount, merchant and order id; `consumeApproval` deletes it atomically | `tests/store.test.ts` — different amount, merchant, rejected, resolved twice; `tests/approval-concurrency.test.ts` |
| 9 | The agent approves its own payment | Admin routes require a bearer token; agent endpoints never receive it. Without `ADMIN_TOKEN` the routes fail closed with `503` | `tests/app.test.ts` — admin authentication, "fails closed when ADMIN_TOKEN is not configured" |
| 10 | An attacker brute-forces the admin token | Length check plus `timingSafeEqual`; no early-exit comparison | `src/server/app.ts` — `requireAdmin` |
| 11 | A hostile site calls the API from a browser | CORS only grants origins named in `ALLOWED_ORIGINS`; the default is no cross-origin access | `tests/http-hardening.test.ts` — CORS and preflight |
| 12 | Quota or money is burned by repeated calls | Per-IP rate limit on `/api/agent/run`, `/api/evaluate` and `/api/demo/injection`, with `Retry-After` | `tests/http-hardening.test.ts` — rate limiting |
| 13 | Oversized or malformed request bodies | 256 KB body limit, zod schemas, `400` on malformed JSON, `413` on oversize | `tests/http-hardening.test.ts` — request validation |
| 14 | An attacker captures an arbitrary PayPal order | The live checkout capture endpoint accepts only order ids the server created, bounded to 20 | `src/server/app.ts` — `checkoutOrders` |
| 15 | A forged PayPal webhook moves money | Delivery is verified with PayPal's `/v1/notifications/verify-webhook-signature`; unconfigured means `503`, unverified means `400`; webhooks never move budget | `tests/webhook.test.ts`; `src/server/app.ts` — webhook route |
| 16 | A secret leaks through the repo or the hosted demo | `.env` is gitignored; `.env.example` has placeholders; the public replay has no PayPal or Gemini credentials; a visitor-supplied Gemini key is used for one request and never persisted or logged | `.gitignore`; `src/server/app.ts` — agent run comment; `DEPLOY.md` |
| 17 | A judge or attacker edits the hosted recording | Replay is read-only: issue, revoke, approve and the scripted attack return `409`; the UI disables those controls. The recording embeds its own public key, so the mandate on screen verifies against the published key instead of the serving process's ephemeral key | `src/server/app.ts` — `refuseInReplay`; `src/web/App.tsx`; `tests/replay-verify.test.ts` |
| 18 | A toolkit upgrade silently adds a money-moving tool | All 47 tools are classified; unknown tools fail closed; a matrix test covers every name | `tests/policy.test.ts` — "covers every tool with exactly one class"; `tests/tools-matrix.test.ts` |
| 19 | A failed capture still consumes budget | The reservation is released on exception or error result; only a successful call confirms it | `tests/guard.test.ts` — "does not commit budget twice when PayPal rejects a capture"; `tests/reservation.test.ts` — release |
| 20 | The ledger disagrees with the spend counter | The invariant `spendToDate == sum(committed ledger entries)` is asserted after every outcome | `tests/guard.test.ts` — budget accounting |

## What is not protected

These are deliberate demo boundaries, not hidden assumptions:

- **In-memory state.** A restart loses mandates, approvals and the ledger. The
  hosted replay starts a fresh pre-seeded mandate by design. `STORE_BACKEND=sqlite`
  persists a single process, not a cluster.
- **Single tenant.** Read endpoints are unauthenticated so judges can inspect
  the demo. A production deployment needs user authentication and per-tenant
  isolation.
- **The admin token is a shared bearer secret.** Production should use SSO or
  short-lived credentials, and rotate the token.
- **The hosted demo is a recording.** It does not call Gemini or PayPal, and the
  UI says so. The live sandbox path is local-only because it needs credentials.
- **Trust scores are partly seeded.** Only `mandateActive` is computed live in
  the demo; the transaction and dispute inputs are fixtures. The scoring
  function itself is deterministic and tested.
- **Transitive dependency advisories.** `npm audit` reports advisories in the
  PayPal toolkit dependency chain. The public demo carries no PayPal or Gemini
  credentials and caps request bodies at 256 KB; upgrading that chain is tracked
  separately.

## Operational rules

- Never commit `.env`, PayPal secrets, a Gemini key or `ADMIN_TOKEN`.
- Set `MANDATE_SIGNING_KEY` in production. Rotating it invalidates every issued
  mandate; on Render the blueprint generates it once.
- Keep `PAYPAL_ENVIRONMENT=SANDBOX` for tests. `npm run check:live` refuses to
  run against live money.
- Warm the hosted URL before judging. A sleeping free instance is slow, not
  compromised.
- Treat a refusal as evidence: it should have a code, a reason and a ledger row.

## Reporting

Open a private security advisory on
[the repository](https://github.com/filippoplesca3-wq/MandateAgent/security/advisories)
rather than a public issue.

## Verify it yourself

```bash
npm ci
npm test              # 194 tests, 18 files
npm run typecheck
npm run build
npm run check:live    # real PayPal sandbox + Gemini, sandbox only
```
