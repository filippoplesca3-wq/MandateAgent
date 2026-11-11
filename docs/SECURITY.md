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
| 16 | A secret leaks through the repo or the hosted demo | `.env` is gitignored; `.env.example` has placeholders; the public replay has no PayPal or Gemini credentials; the hosted chat key is read from the server environment, never sent to the browser or included in a response; a visitor-supplied Gemini key is used for one request and never persisted or logged | `.gitignore`; `src/server/app.ts` — chat routes; `src/server/chat-demo.ts`; `tests/chat-demo.test.ts` — key is absent from responses; `DEPLOY.md` |
| 17 | A judge or attacker edits the hosted recording | Replay is read-only: issue, revoke, approve and the scripted attack return `409`; the UI disables those controls. The recording embeds its own public key, so the mandate on screen verifies against the published key instead of the serving process's ephemeral key | `src/server/app.ts` — `refuseInReplay`; `src/web/App.tsx`; `tests/replay-verify.test.ts` |
| 18 | A toolkit upgrade silently adds a money-moving tool | All 47 tools are classified; unknown tools fail closed; a matrix test covers every name | `tests/policy.test.ts` — "covers every tool with exactly one class"; `tests/tools-matrix.test.ts` |
| 19 | A failed capture still consumes budget | The reservation is released on exception or error result; only a successful call confirms it | `tests/guard.test.ts` — "does not commit budget twice when PayPal rejects a capture"; `tests/reservation.test.ts` — release |
| 20 | The ledger disagrees with the spend counter | The invariant `spendToDate == sum(committed ledger entries)` is asserted after every outcome | `tests/guard.test.ts` — budget accounting |
| 21 | A hostile page frames the console, sniffs response types or reads the referrer | `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` on every response; `x-powered-by` removed | `tests/http-hardening.test.ts` — hardening headers |
| 22 | A public live chat burns Gemini quota or mutates the recorded demo | Every chat gets a fresh in-memory store, signing key and mandate; PayPal is simulated; the message is capped at 500 characters; an optional daily cap (`DEMO_LIVE_DAILY_CAP`) is the only cost guard; there is no cooldown, idle expiry, turn cap or in-flight lock, so a judge is never cut off; the routes are off without a server-side key | `src/server/chat-demo.ts`; `src/server/app.ts` — chat limits; `tests/chat-demo.test.ts` — isolation, daily cap, no cooldown, no turn limit, key leak |
| 23 | A chat visitor buys a different item or price than the card, or someone else's proposal | The model may propose any item and quote a USD price, but the server validates the quote, converts it to minor units and previews the policy decision. The card shows the exact amount; the guard still enforces budget, ceiling and merchant allowlist. A proposal belongs to one session, is single-use, and a refused item never reaches PayPal. The click consumes the parked approval for that exact payment instead of bypassing the guard | `src/server/chat-demo.ts` — `confirmChatProposal`; `tests/chat-demo.test.ts` — arbitrary quote, double confirm, cross-session proposal, $75 denial, merchant denial |

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
- **The hosted demo serves a recording and an optional live chat.** The recording
  makes no Gemini or PayPal calls. The chat calls Gemini with a server-side key,
  always against simulated PayPal, with no cooldown, no per-visitor chat limit
  and no daily cap unless the operator sets `DEMO_LIVE_DAILY_CAP`. Neither path
  can move money, and the video is the proof of the real sandbox checkout.
- **Trust scores are partly seeded.** Only `mandateActive` is computed live in
  the demo; the transaction and dispute inputs are fixtures. The scoring
  function itself is deterministic and tested.
- **Transitive dependency advisories.** `npm audit` reports advisories in the
  PayPal toolkit dependency chain. The public demo carries no PayPal credentials;
  its optional Gemini key is server-side; request bodies are
  capped at 256 KB. Upgrading that chain is tracked separately.

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
npm test              # 231 tests, 20 files
npm run typecheck
npm run build
npm run check:live    # real PayPal sandbox + Gemini, sandbox only
```
