/**
 * Replay of a recorded agent run.
 *
 * A recording is a list of snapshots captured while a real agent worked: the
 * agent's tool calls, the guard's decisions and the resulting ledger. Playing
 * it back costs nothing and needs no API key, which is what lets the hosted
 * demo show genuine agent behaviour on a free tier.
 *
 * The recording is not rewritten to look newer. Timestamps, ids and decisions
 * are exactly what happened; the UI labels it as a recording.
 */

import { readFileSync } from "node:fs"
import type { AgentStep } from "../agent/agent.js"
import type { ReplayInfo, ServerSnapshot } from "./snapshot.js"

export interface RecordedFrame {
  /** Milliseconds since the recording started. Kept for reference. */
  atMs: number
  snapshot: ServerSnapshot
}

export interface RecordedRun {
  kind: "agent-mandate-replay"
  version: number
  recordedAt: string
  paypalMode: string
  model: string
  task: string
  text: string
  durationMs: number
  steps: AgentStep[]
  frames: RecordedFrame[]
}

export function loadReplayFile(path: string): RecordedRun {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"))
  return parseReplay(raw, path)
}

export function parseReplay(raw: unknown, source = "recording"): RecordedRun {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`${source}: expected a JSON object`)
  }
  const value = raw as Partial<RecordedRun>

  if (value.kind !== "agent-mandate-replay") {
    throw new Error(`${source}: not an Agent Mandate recording`)
  }
  if (!Array.isArray(value.frames) || value.frames.length === 0) {
    throw new Error(`${source}: recording has no frames`)
  }
  for (const frame of value.frames) {
    if (typeof frame?.atMs !== "number" || typeof frame.snapshot !== "object") {
      throw new Error(`${source}: malformed frame`)
    }
  }
  if (typeof value.model !== "string" || typeof value.task !== "string") {
    throw new Error(`${source}: missing model or task`)
  }

  return {
    kind: "agent-mandate-replay",
    version: typeof value.version === "number" ? value.version : 1,
    recordedAt: typeof value.recordedAt === "string" ? value.recordedAt : new Date(0).toISOString(),
    paypalMode: typeof value.paypalMode === "string" ? value.paypalMode : "simulated",
    model: value.model,
    task: value.task,
    text: typeof value.text === "string" ? value.text : "",
    durationMs: typeof value.durationMs === "number" ? value.durationMs : 0,
    steps: Array.isArray(value.steps) ? (value.steps as AgentStep[]) : [],
    frames: value.frames,
  }
}

/**
 * Steps through a recording on a fixed beat.
 *
 * The recorded gaps contain model latency, which makes for dead air in a
 * demo; a steady frame rate reads better and keeps the whole run under a
 * minute.
 */
export class ReplayPlayer {
  private index = 0
  private playing: Promise<void> | null = null
  private timer: NodeJS.Timeout | null = null

  constructor(
    readonly run: RecordedRun,
    private readonly frameMs = 1_200,
  ) {
    if (run.frames.length === 0) throw new Error("replay: recording has no frames")
  }

  get info(): ReplayInfo {
    return {
      recordedAt: this.run.recordedAt,
      model: this.run.model,
      task: this.run.task,
      paypalMode: this.run.paypalMode,
    }
  }

  get frameIndex(): number {
    return this.index
  }

  get isPlaying(): boolean {
    return this.playing !== null
  }

  /** The frame currently on screen, relabelled as a replay. */
  snapshot(): ServerSnapshot {
    const frame = this.run.frames[Math.min(this.index, this.run.frames.length - 1)]
    if (!frame) throw new Error("replay: no frame at current index")
    return {
      ...frame.snapshot,
      mode: "replay",
      note:
        `Recording of a real agent run from ${this.run.recordedAt}. ` +
        `PayPal was in ${this.run.paypalMode} mode. No API calls are made.`,
      replay: this.info,
      running: this.isPlaying && this.index < this.run.frames.length - 1,
    }
  }

  /** Play from the beginning. Concurrent callers share one playback. */
  play(): Promise<void> {
    if (this.playing) return this.playing

    this.index = 0
    this.playing = new Promise<void>((resolve) => {
      this.timer = setInterval(() => {
        if (this.index < this.run.frames.length - 1) {
          this.index += 1
          return
        }
        this.finish()
        resolve()
      }, this.frameMs)
    })
    return this.playing
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.playing = null
  }

  private finish(): void {
    this.stop()
  }
}
