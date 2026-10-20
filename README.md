# Agent Mandate

**Signed spending authority for AI agents on PayPal.**

An agent should be able to buy things. It should not be able to buy *anything*.
Agent Mandate puts a signed, scoped, revocable mandate between the model and the
money — and a deterministic enforcement layer, not a prompt, decides what is
allowed.

The model can be confused, prompt-injected, or simply wrong. The mandate holds.

---

## The problem

Every "agentic commerce" demo has the same shape: give a language model access
to tools that move money, then ask it nicely not to overspend. That is not a
control. A prompt is a suggestion, and an injected instruction is still an
instruction.

Merchants have the mirror-image problem: an agent shows up wanting to pay, and
the seller has no idea whether this agent is an authorised buyer or a script
with a stolen API key.

Agent Mandate fixes both sides with one artefact: a **mandate** — a signed
statement of who delegated what to whom, for how much, to whom, until when.

## What it does

The human issues a mandate:

```
Mandate 1fef5e03-…          Agent: agent-procurement-01
Purpose: Buy A4 paper and studio supplies
Budget: USD 120.00          Max per payment: USD 50.00
Merchants: acme-supplies    Above USD 40.00: a human must approve
Expires: in 24h             Signature: HMAC-SHA256
```

The agent then operates freely inside those bounds. Every PayPal call passes
through the guard, and one of three things happens:

| Outcome | What the agent sees | What the ledger records |
| --- | --- | --- |
| **Allowed** | `ok: true` | action, amount, merchant, PayPal ref |
| **Denied** | `ok: false`, `MERCHANT_NOT_ALLOWED` | the refusal and the reason |
| **Escalated** | `ok: false`, `REQUIRES_HUMAN_APPROVAL`, `approvalId` | a parked payment |

An escalated payment is not a failed payment. It is waiting on the human who set
the threshold. Approving it executes **exactly** the payment that was proposed —
same amount, same merchant, same arguments — and consumes the approval, so it
can never be replayed or stretched to cover something else.

## Try it in 60 seconds

```bash
npm install
cp .env.example .env          # Windows: copy .env.example .env
# set MANDATE_SIGNING_KEY to any long random string
npm run dev
```

Open http://localhost:5173 and press **Run agent**.

No PayPal credentials and no LLM key are needed to see the full system work.
Without PayPal credentials the app runs a simulator built from the **real**
toolkit schemas, so arguments and PayPal-shaped ids are validated exactly as
they would be live. Without an LLM key you can still drive every panel by hand
through the API.

To go live, add sandbox credentials from
[developer.paypal.com](https://developer.paypal.com/dashboard/applications/sandbox)
and a
[Gemini key](https://aistudio.google.com/apikey). The mode badge in the header
switches from `simulated` to `live`.

## Replay: a real run, recorded once

The hosted demo serves a **recording of a real agent run** instead of spending
model quota:

```bash
REPLAY_FILE=replays/demo-run.json npm start
# Windows PowerShell: $env:REPLAY_FILE="replays/demo-run.json"; npm start
```

`replays/demo-run.json` was captured with `npm run record`: one genuine Gemini
run (`gemini-3.1-flash-lite`) driving the same agent, guard and store the server
uses, with PayPal in simulated mode. Each frame is the state at that moment —
tool calls, guard decisions, ledger rows, and the human approval that released
the parked $45. Timestamps, ids and decisions are the real ones; the UI labels
the session as a recording and refuses writes.

Replay needs no keys, no network calls and no quota, and starts playing on page
load. To capture a fresh run with your own key:

```bash
npm run record            # writes replays/demo-run.json
```

A visitor who wants to drive a live agent can paste their own Gemini key into the
run panel. It is used for that single request and never stored or logged.

## Deploy on Render (free)

`render.yaml` is included:

- build: `npm ci --include=dev && npm run build`
- start: `npm start`
- env: `REPLAY_FILE=replays/demo-run.json`

No secrets are required: replay mode generates an ephemeral signing key and never
calls PayPal or Gemini. Render's free web services sleep after inactivity, so the
first request can take 30–60 seconds to wake the instance. That is expected.

## The demo, in one run

The default mandate allows one merchant, caps a single payment at $50, and
escalates anything above $40. One agent run produces all three outcomes:

```
create_order   USD 24.00   ALLOWED     permitted: USD 24.00 at acme-supplies
pay_order      USD 24.00   ALLOWED     …
pay_order      USD 45.00   APPROVAL    exceeds the USD 40.00 auto-approval threshold
pay_order      USD 99.00   DENIED      merchant "sketchy-deals" is not in the permitted set
```

Click **Approve & pay** and the parked $45 payment executes, the budget drops,
and the ledger shows why it was allowed:

```
approval-threshold   passed: false   4500 exceeds the auto-approval threshold of 4000
human-approval       passed: true    approval 3f0e7095-…
```

That check trail is the whole point. A refusal is evidence, not an error.

## How enforcement actually works

Two details separate this from a wrapper around `if (amount > limit)`.

**The amount is resolved, not trusted.** `pay_order` takes only an order id. The
guard reads the order from PayPal first, and enforces the policy against the
order's *real* total. An agent cannot quote one price and be charged another.
For `create_order`, the guard recomputes the total using the toolkit's own
formula — subtotal, plus per-item tax, plus shipping, minus discount — rather
than trusting the `itemTotal` the model supplied.

**Unknown tools fail closed.** All 47 toolkit tools are classified as
`read`, `spend` or `mutate`. A tool that is not on the list is denied by
default, so a toolkit upgrade cannot silently widen an agent's authority.

Money is held in integer minor units throughout. The budget moves in exactly one
place — after a successful `pay_order` — and a test asserts that the spend
counter always equals the sum of committed ledger entries.

## Architecture

Two layers, with a hard boundary between them.

```
┌────────────────────────────── Layer 2: clients ──────────────────────────────┐
│  React console (AG Grid ledger)          LLM agent (AI SDK 7, swappable)     │
└───────────────────────────────────┬──────────────────────────────────────────┘
                                    │ tool calls
┌───────────────────────────────────▼──────────────────────────────────────────┐
│                          guard: 47 guarded tools                             │
│   resolve amount → evaluate policy → allow / deny / park → record → execute  │
└───────────────────────────────────┬──────────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼──────────────────────────────────────────┐
│                      Layer 1: core — no LLM, no network                      │
│  mandate signing · policy engine · ledger · store · trust scoring            │
└──────────────────────────────────────────────────────────────────────────────┘
```

Layer 1 is pure and deterministic. It is where every security property lives,
and it is fully testable without a model or a network. Layer 2 is disposable: the
agent can be swapped for another provider, and a broken model degrades the demo
without breaking the guarantee.

## Seller-side trust

A merchant receiving an agent's money gets a score, not a leap of faith. The
trust service scores an agent from PayPal history — transaction count, disputes,
refunds, tenure — and adds a bonus for holding a live mandate. Every point is
attributable to a factor:

```
agent-procurement-01   80  trusted      +15 activity  +0 disputes  +0 refunds
agent-guest-77         18  high-risk    +8 activity   -40 disputes +0 refunds
```

## Tests

```bash
npm test          # 130 tests, 8 files
npm run typecheck
npm run e2e       # full agent run, prints the ledger
```

The suite covers signature forgery and replay, every policy rule, ledger
immutability, approval binding and single-use semantics, guard behaviour on
tool errors, and a contract test that checks the simulator's returned ids
against the toolkit's real zod schemas.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `MANDATE_SIGNING_KEY` | yes | HMAC key for mandates. Rotating it invalidates every mandate. |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | no | Enables the live sandbox toolkit. |
| `PAYPAL_ENVIRONMENT` | no | `sandbox` (default) or `live`. |
| `GOOGLE_GENERATIVE_AI_API_KEY` | no | Enables the autonomous agent. |
| `AGENT_MODEL` | no | Pin one model instead of using the fallback list. |
| `REPLAY_FILE` | no | Serve a recorded run instead of calling any API. |
| `REPLAY_FRAME_MS` | no | Playback beat per frame, default `1200`. |
| `PORT` | no | API port, default `3001`. |

On the Gemini free tier the daily request cap is small and counted **per
model**, so the agent falls back across several models. Anything above casual
use needs billing enabled on the key.

## Repo layout

```
src/core/      types, canonical JSON, mandate signing, policy, ledger, store, trust
src/paypal/    guarded tools, simulator, live toolkit wiring
src/agent/     AI SDK adapter, system prompt, model fallback
src/server/    Express API, SSE stream, replay player
src/web/       React console, AG Grid ledger
replays/       recorded run served by the hosted demo
tests/         vitest suite
scripts/e2e.ts end-to-end run printed to the terminal
scripts/record.ts one real run, captured as replay frames
```

## Notes and limits

- State is in memory. Persistence would be a storage adapter behind `Store`.
- PayPal's toolkit currently accepts `USD` only, so the demo does.
- Mandate signatures are HMAC-SHA256 for a self-contained demo. In a real
  deployment the issuer would use an asymmetric key so merchants could verify
  without holding the signing secret.
- The simulator is a test double, not a PayPal emulator. It exists so the demo
  and the test suite can run deterministically offline.
- The hosted replay is a recording, not an animation written to look like one:
  every frame is a snapshot the store produced during a real Gemini run. The UI
  says so, keeps the original timestamps, and disables every write.

## License

MIT — see [LICENSE](./LICENSE).
