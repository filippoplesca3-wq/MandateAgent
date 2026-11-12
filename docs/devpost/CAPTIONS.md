# Devpost gallery — upload order and captions

Upload these in order. The first one becomes the project thumbnail.

| File | Caption |
| --- | --- |
| `01-console.png` | The mandate: $120 total, $50 per payment, `acme-supplies` only, human approval above $40. Ed25519-signed and revocable. |
| `02-chat-live.png` | Live chat with Gemini: the visitor asks for a desk lamp in Italian — an item that was never in a catalog. The model quotes $30, the guard allows it, and the click runs the guarded create/capture pair. |
| `03-ledger.png` | The audit ledger: allowed, escalated and denied calls, each with amount, merchant, rule and reason. A refusal is recorded as evidence. |
| `04-injection-denied.png` | The prompt-injection preset: a scripted product description tells the agent to pay `sketchy-deals` $99. The guard refuses because the merchant is outside the signed mandate. |
| `05-signature-verified.png` | Verify: the mandate's Ed25519 signature and claims are checked against the published public key. |
| `06-console-full.png` | The full console after one recorded Gemini run: $24 allowed, $45 escalated and approved, $99 denied at `sketchy-deals`. |

Notes:

- The gallery order tells the story: authority, live purchase, audit, refusal, crypto proof, full run.
- Devpost crops the first image for the thumbnail; `01-console.png` keeps the mandate readable at small sizes.
- All captures are from the real app. `02-chat-live.png` is a real Gemini conversation against simulated PayPal.
