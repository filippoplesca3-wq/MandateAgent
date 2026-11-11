# Pre-submission checklist — Agent Mandate

Deadline: **12 November 2026, 12:00 PM PT = 21:00 CET**. Aim to submit by
**20:30 CET**; Devpost is slow near the cutoff.

Legend: ✅ verified, ⬜ to do, ⚠️ risk.

## 1. Video — the only hard blocker

- [ ] ⬜ Record with [DEMO_SCRIPT.md](DEMO_SCRIPT.md) (2:40, hard limit 3:00, 1080p).
- [ ] Must be visible: **LIVE** badge + sandbox client id, a real PayPal payer
      approval, the $45 human approval, the $99 injection denial, and the hosted
      **Chat live with Gemini** proposal → receipt.
- [ ] Upload **public** (unlisted does not count). Title:
      `Agent Mandate — signed spending authority for AI agents on PayPal`.
      Description: repo URL, demo URL, "PayPal sandbox only".
- [ ] Review captions (auto-captions mishear "Ed25519" and "sketchy-deals").
- [ ] Replace `https://youtu.be/...` in `README.md` and
      [SUBMISSION.md](SUBMISSION.md) with the real URL.
- [ ] Watch the final upload once, end to end, before submitting.

## 2. Repository and claims

- [ ] ✅ Typecheck, **231 tests / 20 files**, build and `npm run verify:recording`
      pass locally.
- [ ] ✅ Test count in README badge and docs updated to 231.
- [ ] ⬜ CI green on the submitted commit (Actions → CI).
- [ ] ✅ No placeholders left except the video URL.
- [ ] ✅ No secrets committed: `.env` is gitignored, `git log -p -- .env` is empty.
- [ ] Repo public, MIT `LICENSE` visible.
- [ ] README "Judge in 90 seconds" still opens the demo, not a wall of text.

## 3. Hosted demo

- [ ] ⬜ Render serves the latest `main` (`f09618c` + `0f35872`):
      **Manual Deploy → Deploy latest commit** (auto-deploy is off).
- [ ] ⬜ After the deploy, `/api/state` must show
      `"live":{"enabled":true,"remaining":null,"cap":null}`.
- [ ] ⬜ Repo variable `DEMO_URL` set (Settings → Actions → Variables) so
      `warm.yml` keeps the instance awake; otherwise warm it by hand 20 minutes
      before judging.
- [ ] ✅ `npm run check:demo -- https://agent-mandate-paypal.onrender.com`
      → **10/10 checks passed**.
- [ ] ✅ Live chat end to end: 5.3 s turn, $45 proposal → human approval →
      receipt `ORD00000000000001` / `CAP00000000000002`, spend 4500.
- [ ] ⚠️ Gemini free tier: quota resets at 00:00 UTC (01:00 CET). Do not burn it
      while rehearsing.

## 4. Honesty claims

- [ ] ✅ `npm run verify:recording` → Ed25519 valid, widened copy rejected.
- [ ] ✅ Say **"simulated attack"** on camera for the $99 preset; it is scripted,
      not a live model.
- [ ] ✅ The hosted page is labelled `replay`; the live chat is the real model
      against simulated PayPal.

## 5. Devpost form

- [ ] Project name, tagline and 200-character pitch copied from
      [SUBMISSION.md](SUBMISSION.md).
- [ ] Gallery: `console.png`, `ledger.png`, `injection-denied.png`,
      `signature-verified.png`, `chat.png` from `docs/screenshots/`.
- [ ] Built-with list, "Try it out" table and team section filled.
- [ ] Video URL, public repo URL and hosted demo URL inserted.
- [ ] Preview the saved submission: no broken markdown, no dead links.

## 6. Final ten minutes

- [ ] Open the demo in a private window: recording plays, chat answers, **Verify**
      says `SIGNATURE VALID`.
- [ ] Click every link in README and SUBMISSION (video, demo, docs, repo).
- [ ] Press **Submit**, then reopen the submission page to confirm it saved.

## Open items right now

1. ⬜ Video — the only real blocker.
2. ⬜ Render **Manual Deploy** — 2 minutes, unlocks the no-cap build.
3. ⬜ `DEMO_URL` repository variable — keeps the demo awake for judges.
