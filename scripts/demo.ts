/**
 * Zero-config demo.
 *
 * Serves the recorded run with no `.env`, no PayPal credentials, no Gemini key
 * and no network calls. `npm run demo` builds the console first, then this
 * script starts the server on http://localhost:3001.
 *
 * REPLAY_FILE is set before the server module is imported, so this overrides a
 * `.env` that would otherwise point at live mode. The point of the demo
 * command is that it cannot spend money.
 */

import { resolve } from "node:path"

process.env["REPLAY_FILE"] ??= resolve("replays/demo-run.json")

console.log("Starting the zero-config replay demo: no credentials, no API calls.")

await import("../src/server/index.js")
