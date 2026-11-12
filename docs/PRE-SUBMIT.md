# Pre-submission checklist — Agent Mandate

Official deadline: **Thursday 12 November 2026, 12:00 PM PST = 20:00 UTC =
21:00 CET** ([Devpost](https://paypalaihackathon.devpost.com/)). Aim to submit by
**20:30 CET**; submissions lock at the deadline.

How judging works: a pass/fail fit check, then **five equally weighted**
criteria — Technological Implementation, Design, Potential Impact,
Innovation/Idea, Presentation. Each is one fifth, so the video is worth as much
as the whole codebase.

Legend: ✅ verified, ⬜ to do, ⚠️ risk.

## 1. Video — the only hard blocker

- [x] ✅ Recorded and uploaded: https://youtu.be/dxX1lxIP6u8 (1:32, public).
- [ ] Must show the project **working on its own device**: LIVE badge + PayPal
      sandbox payer approval, the $45 human approval, the $99 injection denial,
      and the hosted **Chat live with Gemini** proposal → receipt.
- [ ] No third-party trademarks or copyrighted music.
- [ ] Upload to YouTube **publicly visible** (do not rely on unlisted). Title:
      `Agent Mandate — signed spending authority for AI agents on PayPal`.
      Description: repo URL, demo URL, "PayPal sandbox only".
- [ ] Review captions (auto-captions mishear "Ed25519" and "sketchy-deals").
- [x] ✅ `https://youtu.be/dxX1lxIP6u8` is in `README.md` and
      [SUBMISSION.md](SUBMISSION.md).
- [ ] Watch the final upload once, end to end, before submitting.

## 2. Repository — pass/fail gate

- [ ] Repo **public**, with all source code, assets and run instructions.
- [ ] ⬜ `LICENSE` file **and** the license visible in the repo **About** panel
      (GitHub → About → ⚙ → License: MIT). Rules ask for it "in the About
      section".
- [ ] ✅ Typecheck, **231 tests / 20 files**, build and `npm run verify:recording`
      pass locally.
- [ ] ⬜ CI green on the submitted commit (Actions → CI).
- [ ] ✅ No secrets committed: `.env` is gitignored, `git log -p -- .env` is empty.
- [x] ✅ README video URL is the real one.
- [ ] If the project predates the hackathon (opened 1 Oct 2026), the text
      description must say what changed during the event.

## 3. Hosted demo — the functional demo

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
- [ ] ⚠️ Gemini free tier: quota resets at 00:00 UTC. Do not burn it rehearsing.

## 4. Devpost form fields

- [ ] Project name, tagline and 200-character pitch from
      [SUBMISSION.md](SUBMISSION.md).
- [ ] **Text description** explaining features and functionality.
- [ ] **Functional demo**: hosted demo URL (and/or repo run instructions).
- [ ] **Tools**: name the model/AI service and say how it is used — Gemini
      (planner), AI SDK 7 (tool calling), PayPal Agent Toolkit (47 tools),
      PayPal JS SDK v6 (checkout), AG Grid (ledger), React/Express.
- [ ] ⬜ **Sponsor tools selected on the form**: **Render** and **AG Grid**.
      Each has its own prize; a project can win at most one sponsor prize plus
      one grand/honorable prize.
- [ ] Gallery: `console.png`, `ledger.png`, `injection-denied.png`,
      `signature-verified.png`, `chat.png` from `docs/screenshots/`.
- [ ] Video URL, public repo URL, hosted demo URL, built-with list, team.
- [ ] Preview the saved submission: no broken markdown, no dead links.

## 5. After you press Submit

- [ ] ⬜ Nothing is edited after the deadline — submissions, repo and video are
      locked until winners are announced (**21 December 2026**).
- [ ] Keep the demo, the Gemini key and the PayPal sandbox account alive until
      then; judges may still open them.

## 6. Final ten minutes

- [ ] Open the demo in a private window: recording plays, chat answers, **Verify**
      says `SIGNATURE VALID`.
- [ ] Click every link in README and SUBMISSION (video, demo, docs, repo).
- [ ] Press **Submit**, then reopen the submission page to confirm it saved.

## Open items right now

1. ✅ Video — uploaded public: https://youtu.be/dxX1lxIP6u8.
2. ⬜ Render **Manual Deploy** — 2 minutes, unlocks the no-cap build.
3. ⬜ `DEMO_URL` repository variable — keeps the demo awake for judges.
4. ⬜ License in the repo About panel + sponsor tools on the Devpost form.
