# Deploying Agent Mandate

The app is one Node process. Express serves both the API and the built React
console from `dist/web`, reads `PORT`, and keeps the agent-endpoint rate limit
enabled. The hosted demo needs **no PayPal or Gemini credentials**: it serves
`replays/demo-run.json`, a recording of a real Gemini run, and every write
endpoint is read-only.

## Build and run locally (production shape)

```bash
npm ci --include=dev
npm run build
REPLAY_FILE=replays/demo-run.json npm start
# Windows PowerShell:
# $env:REPLAY_FILE="replays/demo-run.json"; npm start
```

Open `http://localhost:3001`. The health check is `GET /api/health`.

## Render (free tier, blueprint)

`render.yaml` is already in the repo.

1. Push the repository to GitHub.
2. In [Render](https://render.com), choose **New → Blueprint**.
3. Connect the repository and apply the blueprint.
4. Wait for the build. Render gives you a URL such as
   `https://agent-mandate.onrender.com`.
5. Open the URL. Free web services sleep after inactivity; the first request
   can take 30–60 seconds to wake the instance. That is expected.

The blueprint sets:

| Setting | Value |
| --- | --- |
| Build | `npm ci --include=dev && npm run build` |
| Start | `npm start` |
| Health check | `/api/health` |
| `REPLAY_FILE` | `replays/demo-run.json` |
| `NODE_VERSION` | `22` |

No secrets are required, and none should be added to a public demo.

### Optional environment variables

| Variable | Effect |
| --- | --- |
| `REPLAY_FILE` | Serve a recording. Remove it to run simulated mode instead. |
| `ADMIN_TOKEN` | Enables issue / revoke / approve. Without it those routes fail closed. |
| `ALLOWED_ORIGINS` | Comma-separated exact origins allowed to call the API cross-origin. |
| `RATE_LIMIT_PER_MINUTE` | Per-IP limit on `/api/agent/run` and `/api/evaluate` (default 30). |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | Enables the live **sandbox** toolkit. |
| `PAYPAL_MERCHANT_ALIASES` | Maps a sandbox merchant id to the mandate's merchant name. |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Lets the server run Gemini. Do not put a key on a public demo. |

Live mode is used only when the PayPal credentials are present. Without them the
app stays simulated. Keep `PAYPAL_ENVIRONMENT=SANDBOX` on any public deployment;
`check:live` refuses to run against live money.

## Railway (free trial)

1. In [Railway](https://railway.app), choose **New Project → Deploy from GitHub**.
2. Select the repository.
3. Set the build command to `npm ci --include=dev && npm run build` and the start
   command to `npm start`.
4. Add `REPLAY_FILE=replays/demo-run.json` and `NODE_VERSION=22`.
5. Generate a public domain under **Settings → Networking**.

Railway injects `PORT`; the app already reads it.

## Docker (alternative)

Any container host works with the same two commands. A minimal image:

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --include=dev
COPY . .
RUN npm run build
ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001
CMD ["npm", "start"]
```

Set `REPLAY_FILE=replays/demo-run.json` at runtime for the credential-free demo.

## Troubleshooting

- **First load is slow** — Render free instances sleep. Wait for the wake-up.
- **`/api/health` fails** — check the build log; Node must be 22 or newer.
- **Issue / approve returns 503** — `ADMIN_TOKEN` is not set. That is the
  fail-closed default. Set it and enter the same token when the UI prompts.
- **Agent run returns 502** — no server Gemini key and no key supplied in the
  UI. The replay demo does not need one.
- **A live capture is refused with `MERCHANT_NOT_ALLOWED`** — set
  `PAYPAL_MERCHANT_ALIASES` so PayPal's merchant id maps to `acme-supplies`.
