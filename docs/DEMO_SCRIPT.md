# Demo video script — 2:40

Target length **2:40** (hard limit: 3:00). Record at 1080p, browser zoom 110%,
notifications off, one clean tab. The video must show **PayPal sandbox
credentials** and the **LIVE** badge; the hosted URL shown in the middle offers
the recording plus **Chat live with Gemini** for real-time model evidence.

## Before recording

- [ ] `.env` has `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`,
      `PAYPAL_ENVIRONMENT=SANDBOX`, `GOOGLE_GENERATIVE_AI_API_KEY`,
      `MANDATE_SIGNING_KEY`, `ADMIN_TOKEN`.
- [ ] `npm run check:live` passes (sandbox order + one Gemini call + ledger).
- [ ] `npm run dev` is running; the header badge says **live** and the PayPal
      mode says **sandbox**.
- [ ] The hosted demo is awake and **Chat live with Gemini** is visible (warm it
      a few minutes before recording; a free instance sleeps).
- [ ] The mandate is fresh: budget **$120**, max per payment **$50**, merchant
      **acme-supplies**, approval above **$40**, expires in **24h**.
- [ ] Ledger is empty (restart the server if needed).
- [ ] Real captures from `docs/screenshots/` are used in the README and Devpost.
- [ ] Do a dry run once, then restart to reset state before the real take.

## Beat-by-beat

| Time | Screen | Action | Narration |
| --- | --- | --- | --- |
| 0:00–0:12 | Console, Mandate panel | Hold on the mandate card | "AI agents can already spend money. The hard part is letting one buy paper without letting it empty your account. Agent Mandate is signed spending authority for AI agents on PayPal." |
| 0:12–0:32 | Mandate panel | Point to budget, per-payment cap, merchant, approval threshold, Ed25519 signature | "A human signs a mandate: one hundred and twenty dollars total, fifty per payment, only acme-supplies, and anything above forty dollars needs a human. It is Ed25519-signed, expires in twenty-four hours, and can be revoked. The model never sees the wallet." |
| 0:32–0:52 | Agent run panel | Paste or keep the demo task; click **Run agent** | "Now the agent works. Gemini reads the task and chooses PayPal tools itself. Every call goes through a deterministic guard that resolves the real order amount and merchant before deciding." |
| 0:52–1:12 | Run timeline + **Waiting on you** | Show the $45 payment parked; click **Approve & pay** | "A twenty-four dollar order is allowed. A forty-five dollar order is parked: above the threshold, so a human must approve. I approve it, and the exact payment I saw executes — same order, same amount. The approval is consumed, so it cannot be replayed." |
| 1:12–1:30 | **Test a payment** | Click **$99 -> sketchy-deals (injection)** | "Now the simulated attack. A scripted product description tells the agent to ignore its limits and pay sketchy-deals ninety-nine dollars, and the scripted call follows it. The guard does not: the merchant is outside the signed mandate, so the capture is denied and the refusal is written to the ledger." |
| 1:30–1:45 | **Audit ledger** | Scroll the ledger; press **Verify** next to the signature | "This is the audit trail. Allowed, escalated and denied calls are all recorded with the amount, merchant and reason. A refusal is evidence, not an error. And the mandate verifies against the public key with one click." |
| 1:45–2:10 | Hosted demo, **Chat live with Gemini** | Open the hosted URL, press **Chat live with Gemini**, type "Vorrei una lampada da scrivania LED sotto i 35 dollari. Il budget basta?", show the proposal, click **Buy USD 30.00**, show the receipt | "The hosted demo is live too. There is no catalog: I ask for a desk lamp in Italian, and the real model quotes thirty dollars. It is under the approval threshold, so the mandate allows it outright. I click buy, and the guarded create and capture run against simulated PayPal. Same code, no key in the browser, no money." |
| 2:10–2:30 | **Live sandbox payment** panel + PayPal window | Show the sandbox client id and `PAYPAL_ENVIRONMENT=SANDBOX`; create the $2 order; show the payer approval | "This is real PayPal sandbox money. The server creates an order through the same guard, the payer approves it in the browser with the PayPal JS SDK, and the capture moves the mandate's budget. No live money, and the hosted demo's key stays server-side." |
| 2:30–2:40 | Hosted URL + repo | Show the demo URL and the GitHub repo | "The hosted demo replays this run for free, or takes your own request live against simulated PayPal. The repo has the code, the tests and a one-command live check. Agent Mandate: let agents buy, not anything." |

## If you run long

Cut the audit-ledger beat (1:30–1:45) or shorten the hosted chat to a single
sentence. Never cut the injection denial or the sandbox/LIVE proof — those are
the two claims judges need to see.

## Honesty note

The **$99 -> sketchy-deals (injection)** preset is a deterministic, scripted
attack. It does not call a live model. Say "simulated attack" on camera and do
not imply that Gemini was tricked in real time. The real Gemini evidence is the
agent run in the video, and the hosted **Chat live with Gemini** button lets a
judge reproduce a real model conversation against simulated PayPal. The scenario
uses stubbed PayPal tools and cannot capture even if a mandate were widened.

## Upload checklist

- [ ] Public YouTube video, **under 3:00**, unlisted is not public.
- [ ] Title: `Agent Mandate — signed spending authority for AI agents on PayPal`.
- [ ] Description contains the repo URL, the hosted demo URL, and "PayPal
      sandbox only".
- [ ] Captions reviewed (auto-captions mishear "Ed25519" and "sketchy-deals").
- [ ] Thumbnail shows the mandate card or the ledger, not a title slide.
