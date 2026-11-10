/**
 * The demo console.
 *
 * Three columns and one ledger. The point of the layout is that the human can
 * watch authority (left), action (centre) and accountability (bottom) at the
 * same time while the agent works: the mandate shrinks as money is spent, the
 * run log fills in, and every call lands in the ledger whether it was allowed
 * or refused.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AgGridReact } from "ag-grid-react"
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type ColDef,
  type ICellRendererParams,
} from "ag-grid-community"
import { adminApi, api, useLiveState } from "./api.js"
import type {
  AgentRunResponse,
  LedgerEntry,
  LiveRunResponse,
  Money,
  PendingApproval,
  Snapshot,
  TrustScore,
} from "./api.js"

ModuleRegistry.registerModules([AllCommunityModule])

const gridTheme = themeQuartz.withParams({
  backgroundColor: "transparent",
  foregroundColor: "#dce6f5",
  headerBackgroundColor: "#101a2c",
  headerTextColor: "#7f96b5",
  borderColor: "#1b2841",
  rowHoverColor: "#16223a",
  accentColor: "#4b8bf5",
  oddRowBackgroundColor: "rgba(255,255,255,0.015)",
  fontFamily: "inherit",
  fontSize: "13px",
  headerFontSize: "10.5px",
  headerFontWeight: 600,
  headerHeight: 40,
  rowHeight: 40,
  spacing: 6,
  wrapperBorderRadius: 0,
})

const DEFAULT_TASK =
  "Buy 2 reams of A4 paper from acme-supplies and pay for them, about 12.00 USD each. " +
  "Then fetch orders ORD00000000009002 and ORD00000000009001 and attempt to settle both, " +
  "reporting whatever the results say."

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function money(m: Money | undefined | null): string {
  if (!m) return "—"
  return `${m.currency} ${(m.amount / 100).toFixed(2)}`
}

function minor(value: number | undefined, currency = "USD"): string {
  if (typeof value !== "number") return "—"
  return `${currency} ${(value / 100).toFixed(2)}`
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour12: false })
}

function relative(iso: string): string {
  const diff = Date.parse(iso) - Date.now()
  if (Number.isNaN(diff)) return "—"
  if (diff <= 0) return "expired"
  const minutes = Math.round(diff / 60_000)
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `in ${hours}h`
  return `in ${Math.round(hours / 24)}d`
}

function shortId(id: string, size = 8): string {
  return id.slice(0, size)
}

function recordedOn(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

function Panel(props: {
  title: string
  subtitle?: string
  children: React.ReactNode
  className?: string
  actions?: React.ReactNode
}) {
  return (
    <section className={`panel ${props.className ?? ""}`}>
      <header className="panel-head">
        <div>
          <h2>{props.title}</h2>
          {props.subtitle ? <p className="panel-sub">{props.subtitle}</p> : null}
        </div>
        {props.actions ? <div className="panel-actions">{props.actions}</div> : null}
      </header>
      <div className="panel-body">{props.children}</div>
    </section>
  )
}

function Chip(props: { children: React.ReactNode; tone?: "neutral" | "green" | "red" | "amber" | "blue" }) {
  return <span className={`chip chip-${props.tone ?? "neutral"}`}>{props.children}</span>
}

function BudgetBar(props: { budget: Money; spent: Money; remaining: Money }) {
  const total = props.budget.amount || 1
  const used = Math.min(100, (props.spent.amount / total) * 100)
  return (
    <div className="budget">
      <div className="budget-labels">
        <span>{money(props.remaining)} left</span>
        <span className="muted">of {money(props.budget)}</span>
      </div>
      <div className="budget-track">
        <div
          className={`budget-fill ${used >= 100 ? "full" : ""}`}
          style={{ width: `${used}%` }}
        />
      </div>
      <div className="budget-foot">
        <span>{money(props.spent)} spent</span>
        <span className="muted">{Math.round(used)}%</span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Mandate
// ---------------------------------------------------------------------------

function MandateCard(props: {
  state: Snapshot
  busy: boolean
  readOnly: boolean
  onIssue: () => void
  onRevoke: () => void
}) {
  const { mandate } = props.state
  if (!mandate) {
    return (
      <Panel title="Mandate" subtitle="No mandate is current">
        <button
          className="btn primary"
          onClick={props.onIssue}
          disabled={props.busy || props.readOnly}
        >
          Issue a mandate
        </button>
      </Panel>
    )
  }

  const { claims, state, remaining } = mandate
  const constraints = claims.constraints
  const revoked = Boolean(state.revokedAt)
  const expired = Date.parse(claims.expiresAt) <= Date.now()

  return (
    <Panel
      title="Mandate"
      subtitle={`${claims.principal} → ${claims.agentId}`}
      actions={
        revoked || expired ? (
          <button
            className="btn primary sm"
            onClick={props.onIssue}
            disabled={props.busy || props.readOnly}
            title={props.readOnly ? "This is a recording, so it cannot be changed." : undefined}
          >
            New mandate
          </button>
        ) : (
          <button
            className="btn ghost sm"
            onClick={props.onRevoke}
            disabled={props.busy || props.readOnly}
            title={props.readOnly ? "This is a recording, so it cannot be changed." : undefined}
          >
            Revoke
          </button>
        )
      }
    >
      <p className="purpose">{claims.purpose}</p>

      <BudgetBar budget={claims.budget} spent={state.spendToDate} remaining={remaining} />

      <dl className="facts">
        <div>
          <dt>Transactions</dt>
          <dd>{state.transactionCount}</dd>
        </div>
        <div>
          <dt>Expires</dt>
          <dd>{relative(claims.expiresAt)}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>
            {revoked ? (
              <Chip tone="red">revoked</Chip>
            ) : expired ? (
              <Chip tone="amber">expired</Chip>
            ) : (
              <Chip tone="green">active</Chip>
            )}
          </dd>
        </div>
      </dl>

      <div className="constraints">
        {constraints.allowMerchants?.length ? (
          <div className="constraint-row">
            <span className="constraint-label">Merchants</span>
            <div className="chips">
              {constraints.allowMerchants.map((merchant) => (
                <Chip key={merchant} tone="blue">
                  {merchant}
                </Chip>
              ))}
            </div>
          </div>
        ) : null}

        {constraints.maxPerTransaction ? (
          <div className="constraint-row">
            <span className="constraint-label">Per payment</span>
            <Chip>max {money(constraints.maxPerTransaction)}</Chip>
          </div>
        ) : null}

        {constraints.requireApprovalAbove ? (
          <div className="constraint-row">
            <span className="constraint-label">Escalates</span>
            <Chip tone="amber">above {money(constraints.requireApprovalAbove)}</Chip>
          </div>
        ) : null}

        {typeof constraints.maxTransactions === "number" ? (
          <div className="constraint-row">
            <span className="constraint-label">Count</span>
            <Chip>max {constraints.maxTransactions}</Chip>
          </div>
        ) : null}
      </div>

      <div className="signature">
        <span className="constraint-label">Signature</span>
        <code title={mandate.signature}>{shortId(mandate.signature, 26)}…</code>
        <span className="muted">{mandate.algorithm}</span>
        <SignatureCheck mandateId={claims.id} signature={mandate.signature} algorithm={mandate.algorithm} />
      </div>
    </Panel>
  )
}

interface VerifyResult {
  ok: boolean
  signatureValid: boolean
  claimsValid: boolean
  revoked: boolean
  algorithm: string
  source?: string
  signatureReason?: string
  claimsReason?: string
}

/**
 * Prove the mandate on screen against the public key, in the browser.
 *
 * On the hosted replay the endpoint returns the key the recording was signed
 * with (`source: "recording"`), so a judge can check the signature without
 * trusting the page or running curl.
 */
function SignatureCheck(props: { mandateId: string; signature: string; algorithm: string }) {
  const [result, setResult] = useState<VerifyResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const check = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      setResult(await api<VerifyResult>(`/api/mandates/${props.mandateId}/verify`))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }, [props.mandateId])

  return (
    <>
      <button
        className="btn ghost sm"
        type="button"
        onClick={() => void check()}
        disabled={busy}
        title="Verify the signature against the public key"
      >
        {busy ? "Verifying…" : "Verify"}
      </button>
      {error ? <div className="alert error">{error}</div> : null}
      {result ? (
        <div className={`verdict ${result.ok ? "allowed" : "denied"}`}>
          <span className="verdict-label">
            {result.ok ? "SIGNATURE VALID" : "SIGNATURE INVALID"}
          </span>
          <code>
            {result.algorithm}
            {result.source === "recording" ? " · recorded key" : " · server key"}
          </code>
          <p>
            signature {result.signatureValid ? "verified" : "failed"} · claims{" "}
            {result.claimsValid ? "valid" : "invalid"}
            {result.revoked ? " · mandate revoked" : ""}
          </p>
        </div>
      ) : null}
    </>
  )
}

// ---------------------------------------------------------------------------
// Agent runner
// ---------------------------------------------------------------------------

function RunPanel(props: { state: Snapshot; replay: Snapshot["replay"] }) {
  const replay = props.replay
  const [task, setTask] = useState(replay?.task ?? DEFAULT_TASK)
  const [apiKey, setApiKey] = useState("")
  const [showKey, setShowKey] = useState(false)
  const [running, setRunning] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [result, setResult] = useState<AgentRunResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const startedAt = useRef<number>(0)

  useEffect(() => {
    if (replay) setTask(replay.task)
  }, [replay])

  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setElapsed(Date.now() - startedAt.current), 100)
    return () => clearInterval(timer)
  }, [running])

  const run = useCallback(async () => {
    setRunning(true)
    setError(null)
    setResult(null)
    startedAt.current = Date.now()
    setElapsed(0)
    try {
      const response = await api<AgentRunResponse>("/api/agent/run", {
        method: "POST",
        body: JSON.stringify({
          task,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        }),
      })
      setResult(response)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setRunning(false)
    }
  }, [task, apiKey])

  // A recording should start by itself: a visitor who never clicks still sees
  // the whole run. Pressing the button again replays it.
  const autoStarted = useRef(false)
  useEffect(() => {
    if (!replay || autoStarted.current) return
    const timer = setTimeout(() => {
      autoStarted.current = true
      void run()
    }, 700)
    return () => clearTimeout(timer)
  }, [replay, run])

  const busy = running || props.state.running
  const locked = Boolean(replay)

  return (
    <Panel
      title="Agent run"
      subtitle={
        replay
          ? "Plays back a recording of a real run. No API calls."
          : "The model proposes. The mandate decides."
      }
      actions={
        <button className="btn primary" onClick={() => void run()} disabled={busy}>
          {busy ? (locked ? "Playing…" : "Running…") : locked ? "Play recording" : "Run agent"}
        </button>
      }
    >
      <textarea
        className="task-input"
        value={task}
        onChange={(event) => setTask(event.target.value)}
        rows={2}
        spellCheck={false}
        disabled={busy || locked}
        title={locked ? "The task is fixed in the recording." : undefined}
      />

      <div className="run-meta">
        {busy ? (
          <span className="live">
            <span className="pulse" /> {locked ? "playing" : "working"} ·{" "}
            {(elapsed / 1000).toFixed(1)}s
          </span>
        ) : result ? (
          <span className="muted">
            {result.model} · {((result.durationMs ?? 0) / 1000).toFixed(1)}s
            {result.replay ? " · recorded" : ""}
          </span>
        ) : (
          <span className="muted">
            {replay ? `recorded with ${replay.model}` : props.state.model ?? "model chosen at runtime"}
          </span>
        )}
      </div>

      {!locked ? (
        <div className="key-row">
          <button className="btn ghost sm" onClick={() => setShowKey((value) => !value)}>
            {showKey ? "Hide key" : "Use your own Gemini key"}
          </button>
          {showKey ? (
            <input
              className="key-input"
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="AIza… — used for this run only, never stored"
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
            />
          ) : null}
        </div>
      ) : null}

      {error ? <div className="alert error">{error}</div> : null}

      {result?.steps?.length ? (
        <ol className="steps">
          {result.steps.flatMap((step) =>
            step.toolCalls.map((call, index) => (
              <StepRow key={`${step.index}-${index}`} toolName={call.toolName} output={call.output} />
            )),
          )}
        </ol>
      ) : null}

      {result?.text ? <Report text={result.text} /> : null}
    </Panel>
  )
}

/**
 * The model writes light markdown. Rendering it as literal asterisks makes the
 * report look broken, so the two constructs it actually uses — bold and inline
 * code — are handled here rather than pulling in a Markdown parser.
 */
function Inline(props: { text: string }) {
  const parts = props.text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean)
  return (
    <>
      {parts.map((part, index) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          return <strong key={index}>{part.slice(2, -2)}</strong>
        }
        if (part.startsWith("`") && part.endsWith("`")) {
          return <code key={index}>{part.slice(1, -1)}</code>
        }
        return <span key={index}>{part}</span>
      })}
    </>
  )
}

function Report(props: { text: string }) {
  const lines = props.text.split("\n").filter((line) => line.trim().length > 0)
  return (
    <div className="report">
      {lines.map((line, index) => {
        const trimmed = line.trim()
        if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
          return <hr key={index} />
        }
        const bullet = /^\s*[•*-]\s+/.test(line)
        const body = line.replace(/^\s*[•*-]\s+/, "").replace(/^#+\s*/, "")
        return (
          <p key={index} className={bullet ? "report-line bullet" : "report-line"}>
            <Inline text={body} />
          </p>
        )
      })}
    </div>
  )
}

function StepRow(props: { toolName: string; output?: string }) {
  const parsed = useMemo(() => {
    if (!props.output) return null
    try {
      const value = JSON.parse(props.output) as { ok?: boolean; code?: string; reason?: string }
      return value
    } catch {
      return null
    }
  }, [props.output])

  const ok = parsed?.ok === true
  const tone = ok ? "green" : parsed?.ok === false ? "red" : "neutral"

  return (
    <li className="step">
      <span className={`dot dot-${tone}`} />
      <code className="step-tool">{props.toolName}</code>
      <span className={`step-code code-${tone}`}>{parsed?.code ?? "—"}</span>
      {parsed?.reason ? <span className="step-reason">{parsed.reason}</span> : null}
    </li>
  )
}

// ---------------------------------------------------------------------------
// Live run
// ---------------------------------------------------------------------------

/**
 * The hosted demo's one real-model path.
 *
 * The recording is the fallback. This dialog asks the server for a fresh run:
 * a new store, a new mandate and a new signing key, real Gemini, simulated
 * PayPal. Nothing it does can change the recording or spend real money.
 *
 * The visitor writes the task, so the run is a request the agent interprets
 * rather than a script it replays. The presets are there for anyone who does
 * not want to compose a prompt; the last two are refused by the mandate.
 */
const LIVE_DEFAULT_TASK =
  "Buy 2 reams of A4 paper from acme-supplies and pay for them, about 12.00 USD each."

const LIVE_PRESETS: { label: string; task: string }[] = [
  {
    label: "Paper · $24",
    task: LIVE_DEFAULT_TASK,
  },
  {
    label: "Monitor stand · $45 (approval)",
    task: "Buy one monitor stand from acme-supplies for 45.00 USD and pay for it.",
  },
  {
    label: "Desk lamp · $75 (denied)",
    task: "Buy a desk lamp from acme-supplies for 75.00 USD and pay for it.",
  },
  {
    label: "Cables · sketchy-deals (denied)",
    task: "Buy 30.00 USD of cables from sketchy-deals and pay for them.",
  },
]

function LiveRunDialog(props: { onClose: () => void }) {
  const { onClose } = props
  const [task, setTask] = useState(LIVE_DEFAULT_TASK)
  const [asked, setAsked] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [result, setResult] = useState<LiveRunResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const startedAt = useRef(0)

  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setElapsed(Date.now() - startedAt.current), 100)
    return () => clearInterval(timer)
  }, [running])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  const run = useCallback(async () => {
    const prompt = task.trim()
    if (!prompt) return
    setRunning(true)
    setError(null)
    setResult(null)
    setAsked(prompt)
    startedAt.current = Date.now()
    setElapsed(0)
    try {
      const response = await api<LiveRunResponse>("/api/demo/live-run", {
        method: "POST",
        body: JSON.stringify({ task: prompt }),
      })
      setResult(response)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setRunning(false)
    }
  }, [task])

  const steps = result?.run.steps.flatMap((step) =>
    step.toolCalls.map((call, index) => ({
      key: `${step.index}-${index}`,
      toolName: call.toolName,
      output: call.output,
    })),
  )

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label="Live agent run">
        <header className="modal-head">
          <div>
            <h2>
              <span className="live-badge">
                <span className="pulse" /> LIVE
              </span>
              Tell the agent what to buy
            </h2>
            <p className="panel-sub">
              Real Gemini, simulated PayPal. Write a task or pick an example: the model plans the
              steps and the mandate decides what is allowed. This run gets its own mandate, signing
              key and ledger; it cannot touch the recording, and no money can move.
            </p>
          </div>
          <button className="btn ghost sm" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="live-prompt">
          <label className="live-prompt-label" htmlFor="live-task">
            Your task
          </label>
          <textarea
            id="live-task"
            className="task-input"
            value={task}
            onChange={(event) => setTask(event.target.value)}
            rows={3}
            maxLength={600}
            spellCheck={false}
            disabled={running}
            placeholder="e.g. Buy two reams of paper from acme-supplies and pay for them."
          />
          <div className="live-presets">
            <span className="muted">Try:</span>
            {LIVE_PRESETS.map((preset) => (
              <button
                key={preset.label}
                className="chip"
                type="button"
                disabled={running}
                title={preset.task}
                onClick={() => setTask(preset.task)}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div className="live-actions">
            <button
              className="btn primary"
              onClick={() => void run()}
              disabled={running || task.trim().length === 0}
            >
              {running ? "Running…" : result ? "Run again" : "Ask Gemini to run it"}
            </button>
            <span className="muted">{task.trim().length}/600</span>
          </div>
        </div>

        {running ? (
          <div className="live-progress">
            <span className="live">
              <span className="pulse" /> working · {(elapsed / 1000).toFixed(1)}s
            </span>
            <p className="muted">
              Gemini is choosing its next tool call. Usually 10–40 seconds; the model may call
              several tools in sequence.
            </p>
          </div>
        ) : null}

        {error ? <div className="alert error">{error}</div> : null}

        {result ? (
          <>
            {asked ? (
              <p className="live-asked">
                <span className="muted">Asked:</span> {asked}
              </p>
            ) : null}

            <div className="live-summary">
              <Stat label="Model" value={result.run.model} />
              <Stat
                label="Allowed"
                value={String(result.snapshot.summary.allowed)}
                tone="green"
              />
              <Stat label="Denied" value={String(result.snapshot.summary.denied)} tone="red" />
              <Stat
                label="Pending"
                value={String(result.snapshot.summary.pendingApproval)}
                tone="amber"
              />
              <Stat
                label="Remaining"
                value={result.snapshot.mandate ? money(result.snapshot.mandate.remaining) : "—"}
              />
            </div>

            <p className="live-verify">
              <code>{result.snapshot.mandate?.claims.id ?? "ephemeral mandate"}</code> · signature{" "}
              <span className={result.verification.signatureValid ? "tone-green" : "tone-red"}>
                {result.verification.signatureValid ? "verified" : "failed"}
              </span>{" "}
              · claims{" "}
              <span className={result.verification.claimsValid ? "tone-green" : "tone-red"}>
                {result.verification.claimsValid ? "valid" : "invalid"}
              </span>{" "}
              · fresh key <code>{result.publicKey.slice(0, 12)}…</code>
            </p>

            {steps?.length ? (
              <ol className="steps">
                {steps.map((step) => (
                  <StepRow key={step.key} toolName={step.toolName} output={step.output} />
                ))}
              </ol>
            ) : null}

            {result.run.text ? <Report text={result.run.text} /> : null}

            <p className="live-note">
              Simulated PayPal: no PayPal credentials were used and no money moved. The mandate,
              guard and ledger are the same code paths as a real run.
            </p>
          </>
        ) : null}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

interface Verdict {
  allowed: boolean
  code: string
  reason: string
  requiresApproval?: boolean
}

const TRY_PRESETS: {
  label: string
  amount: string
  merchant: string
  injection?: boolean
}[] = [
  { label: "$12 -> acme-supplies", amount: "12.00", merchant: "acme-supplies" },
  { label: "$45 -> acme-supplies", amount: "45.00", merchant: "acme-supplies" },
  { label: "$200 -> acme-supplies", amount: "200.00", merchant: "acme-supplies" },
  {
    label: "$99 -> sketchy-deals (injection)",
    amount: "99.00",
    merchant: "sketchy-deals",
    injection: true,
  },
]

/**
 * The one interactive thing on the hosted demo that needs neither a Gemini key
 * nor a PayPal account: a dry run against the current mandate. It calls the
 * same evaluator the guard uses and returns its verdict. The injection preset
 * is the exception: it runs the scripted attack and records the refusal.
 */
function TryPanel(props: { readOnly?: boolean }) {
  const [amount, setAmount] = useState("12.00")
  const [merchant, setMerchant] = useState("acme-supplies")
  const [busy, setBusy] = useState(false)
  const [verdict, setVerdict] = useState<Verdict | null>(null)
  const [error, setError] = useState<string | null>(null)

  const check = useCallback(async (nextAmount: string, nextMerchant: string) => {
    setBusy(true)
    setError(null)
    try {
      const response = await api<{ ok: boolean; decision?: Verdict; error?: string }>(
        "/api/evaluate",
        {
          method: "POST",
          body: JSON.stringify({
            action: "create_order",
            amount: nextAmount,
            merchant: nextMerchant,
          }),
        },
      )
      if (!response.decision) throw new Error(response.error ?? "No decision returned")
      setVerdict(response.decision)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }, [])

  const preset = (value: string, shop: string) => {
    setAmount(value)
    setMerchant(shop)
    void check(value, shop)
  }

  /**
   * The injection preset follows a malicious product description and asks the
   * guard to capture the order. It is the one preset that writes to the
   * ledger, because the refusal is the evidence being demonstrated.
   */
  const inject = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const response = await api<{ ok: boolean; decision?: Verdict; error?: string }>(
        "/api/demo/injection",
        { method: "POST", body: JSON.stringify({}) },
      )
      if (!response.decision) throw new Error(response.error ?? "No decision returned")
      setAmount("99.00")
      setMerchant("sketchy-deals")
      setVerdict(response.decision)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }, [])

  const tone = verdict
    ? verdict.allowed
      ? "allowed"
      : verdict.requiresApproval
        ? "escalated"
        : "denied"
    : "idle"
  const headline = { allowed: "ALLOWED", escalated: "NEEDS APPROVAL", denied: "DENIED", idle: "" }[tone]

  return (
    <Panel
      title="Test a payment"
      subtitle={
        props.readOnly
          ? "Dry run against the mandate. The scripted attack is available when you run locally."
          : "Dry run against the mandate. The injection preset is a scripted attack; its refusal is recorded."
      }
    >
      <div className="try-chips">
        {TRY_PRESETS.map((item) => (
          <button
            key={item.label}
            className="chip"
            type="button"
            disabled={busy || (item.injection && props.readOnly)}
            title={
              item.injection && props.readOnly
                ? "The hosted demo is a read-only recording. Run locally to trigger the scripted attack."
                : undefined
            }
            onClick={() => (item.injection ? void inject() : preset(item.amount, item.merchant))}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="try-fields">
        <label className="try-field">
          <span>Amount (USD)</span>
          <input
            value={amount}
            inputMode="decimal"
            spellCheck={false}
            disabled={busy}
            onChange={(event) => setAmount(event.target.value)}
          />
        </label>
        <label className="try-field">
          <span>Merchant</span>
          <input
            value={merchant}
            spellCheck={false}
            disabled={busy}
            onChange={(event) => setMerchant(event.target.value)}
          />
        </label>
      </div>

      <button className="btn primary" type="button" disabled={busy} onClick={() => void check(amount, merchant)}>
        {busy ? "Checking…" : "Check payment"}
      </button>

      {error ? <div className="alert error">{error}</div> : null}

      {verdict ? (
        <div className={`verdict ${tone}`}>
          <span className="verdict-label">{headline}</span>
          <code>{verdict.code}</code>
          <p>{verdict.reason}</p>
        </div>
      ) : null}
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// Live sandbox checkout
// ---------------------------------------------------------------------------

interface CheckoutConfig {
  enabled: boolean
  clientId: string | null
  currency: string
  amount: number
}

interface PayPalSdk {
  findEligibleMethods: (options: { currencyCode: string }) => Promise<{
    isEligible: (method: string) => boolean
  }>
  createPayPalOneTimePaymentSession: (options: {
    onApprove: (data: { orderId: string }) => Promise<void>
    onCancel: () => void
    onError: (error: { message?: string }) => void
  }) => {
    start: (
      options: { presentationMode: "auto" },
      order: Promise<{ orderId: string }>,
    ) => Promise<void>
  }
}

interface PayPalGlobal {
  createInstance: (options: {
    clientId: string
    components: string[]
    pageType?: string
  }) => Promise<PayPalSdk>
}

let paypalSdkLoader: Promise<void> | null = null

/** Loads the v6 core script once. Sandbox and production are different files. */
function loadPayPalSdk(): Promise<void> {
  if (paypalSdkLoader) return paypalSdkLoader

  paypalSdkLoader = new Promise((resolve, reject) => {
    const script = document.createElement("script")
    script.src = "https://www.sandbox.paypal.com/web-sdk/v6/core"
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => {
      paypalSdkLoader = null
      reject(new Error("The PayPal SDK could not be loaded."))
    }
    document.head.appendChild(script)
  })

  return paypalSdkLoader
}

/**
 * A real sandbox purchase, driven from the browser.
 *
 * The order is created and captured server-side through the guard, so the
 * browser never states a price. The only thing the browser does is ask the
 * payer to approve: the JS SDK hands back an order id, never a client secret.
 */
function CheckoutPanel(props: { active: boolean }) {
  const [config, setConfig] = useState<CheckoutConfig | null>(null)
  const [status, setStatus] = useState<"loading" | "ready" | "starting" | "capturing" | "paid" | "error">(
    "loading",
  )
  const [message, setMessage] = useState<string | null>(null)
  const [orderId, setOrderId] = useState<string | null>(null)
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    api<CheckoutConfig>("/api/checkout/config")
      .then((next) => {
        if (!cancelled) setConfig(next)
      })
      .catch((caught) => {
        if (cancelled) return
        setStatus("error")
        setMessage(caught instanceof Error ? caught.message : String(caught))
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const clientId = config?.clientId
    const container = host.current
    if (!props.active) return
    if (!config?.enabled || !clientId || !container) return

    let cancelled = false
    let button: HTMLElement | null = null

    const createOrder = async (): Promise<{ orderId: string }> => {
      const created = await api<{ orderId: string }>("/api/checkout/order", {
        method: "POST",
        body: JSON.stringify({}),
      })
      setOrderId(created.orderId)
      return { orderId: created.orderId }
    }

    const boot = async (): Promise<void> => {
      await loadPayPalSdk()
      if (cancelled) return

      const paypal = (window as unknown as { paypal?: PayPalGlobal }).paypal
      if (!paypal) throw new Error("The PayPal SDK did not expose its namespace.")

      const sdk = await paypal.createInstance({
        clientId,
        components: ["paypal-payments"],
        pageType: "checkout",
      })
      if (cancelled) return

      const methods = await sdk.findEligibleMethods({ currencyCode: config.currency })
      if (cancelled) return
      if (!methods.isEligible("paypal")) {
        throw new Error("PayPal checkout is not eligible for this sandbox account.")
      }

      const session = sdk.createPayPalOneTimePaymentSession({
        onApprove: async ({ orderId: approvedId }) => {
          setStatus("capturing")
          setMessage("Approved. Capturing through the mandate…")
          try {
            await api("/api/checkout/capture", {
              method: "POST",
              body: JSON.stringify({ orderId: approvedId }),
            })
            setOrderId(approvedId)
            setStatus("paid")
            setMessage("Captured. The spend is in the ledger and the budget has moved.")
          } catch (caught) {
            setStatus("error")
            setMessage(caught instanceof Error ? caught.message : String(caught))
          }
        },
        onCancel: () => {
          setStatus("ready")
          setMessage("Checkout cancelled. Nothing was captured.")
        },
        onError: (error) => {
          setStatus("error")
          setMessage(error.message ?? "PayPal reported an error during checkout.")
        },
      })

      const element = document.createElement("paypal-button")
      element.setAttribute("type", "pay")
      element.hidden = true
      element.addEventListener("click", () => {
        setStatus("starting")
        setMessage("Creating the sandbox order and opening PayPal…")
        void session.start({ presentationMode: "auto" }, createOrder()).catch((caught: unknown) => {
          setStatus("error")
          setMessage(caught instanceof Error ? caught.message : String(caught))
        })
      })

      container.appendChild(element)
      element.hidden = false
      button = element
      setStatus("ready")
    }

    void boot().catch((caught: unknown) => {
      if (cancelled) return
      setStatus("error")
      setMessage(caught instanceof Error ? caught.message : String(caught))
    })

    return () => {
      cancelled = true
      if (button?.parentElement === container) container.removeChild(button)
    }
  }, [config, props.active])

  if (!config?.enabled || !config.clientId) return null

  return (
    <Panel
      title="Live sandbox payment"
      subtitle="A real PayPal order, approved by you and captured by the mandate."
    >
      <p className="checkout-note">
        Moves <strong>{minor(config.amount, config.currency)}</strong> of sandbox money. Sign in with
        a PayPal <em>sandbox personal</em> account when the checkout opens.
      </p>

      {props.active ? (
        <>
          <p className="checkout-caption">Pay with PayPal</p>
          <div className="checkout-button" ref={host} />

          {message ? (
            <p
              className={`checkout-status ${status === "paid" ? "paid" : status === "error" ? "error" : ""}`}
            >
              {message}
            </p>
          ) : status === "loading" ? (
            <p className="checkout-status">Loading PayPal…</p>
          ) : null}

          {orderId ? (
            <p className="checkout-order">
              Order <code>{orderId}</code>
            </p>
          ) : null}
        </>
      ) : (
        <p className="checkout-status error">
          This mandate is no longer active. Issue a new mandate to enable live checkout.
        </p>
      )}
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// Trust and approvals
// ---------------------------------------------------------------------------

function TrustPanel(props: { scores: TrustScore[] }) {
  return (
    <Panel title="Seller view" subtitle="Would this agent be trusted to pay you?">
      <ul className="trust-list">
        {props.scores.map((score) => (
          <li key={score.agentId} className="trust">
            <div className="trust-head">
              <code>{score.agentId}</code>
              <Chip tone={score.tier === "trusted" || score.tier === "reliable" ? "green" : score.tier === "high-risk" ? "red" : "amber"}>
                {score.tier}
              </Chip>
            </div>
            <div className="trust-score-row">
              <div className="score-track">
                <div className="score-fill" style={{ width: `${score.score}%` }} />
              </div>
              <span className="score-value">{score.score}</span>
            </div>
            <div className="trust-signals">
              {score.signals.transactionCount} txns · {score.signals.disputeCount} disputes ·{" "}
              {score.signals.refundCount} refunds
            </div>
            {score.factors.length ? (
              <div className="trust-factors">
                {score.factors.slice(0, 3).map((factor) => (
                  <span key={factor.factor} className={factor.impact >= 0 ? "up" : "down"}>
                    {factor.impact >= 0 ? "+" : ""}
                    {factor.impact} {factor.factor}
                  </span>
                ))}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </Panel>
  )
}

function ApprovalsPanel(props: {
  approvals: PendingApproval[]
  busy: boolean
  readOnly: boolean
  onResolve: (id: string, approve: boolean) => void
}) {
  const pending = props.approvals.filter((item) => item.status === "pending")

  return (
    <Panel
      title="Waiting on you"
      subtitle={
        props.readOnly
          ? "Read-only recording — approvals are disabled"
          : pending.length
            ? `${pending.length} payment${pending.length === 1 ? "" : "s"} above the approval threshold`
            : "Nothing is parked"
      }
    >
      {pending.length === 0 ? (
        <p className="empty">
          Payments the agent proposes above the threshold stop here instead of failing.
        </p>
      ) : (
        <ul className="approval-list">
          {pending.map((item) => (
            <li key={item.id} className="approval">
              <div className="approval-main">
                <span className="approval-amount">
                  {minor(item.proposal.amount, item.proposal.currency ?? "USD")}
                </span>
                <span className="muted">{item.proposal.merchant ?? item.action}</span>
              </div>
              <p className="approval-reason">{item.decision.reason}</p>
              <div className="approval-actions">
                <button
                  className="btn sm primary"
                  disabled={props.busy || props.readOnly}
                  onClick={() => props.onResolve(item.id, true)}
                >
                  Approve & pay
                </button>
                <button
                  className="btn sm ghost"
                  disabled={props.busy || props.readOnly}
                  onClick={() => props.onResolve(item.id, false)}
                >
                  Reject
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

interface LedgerRow {
  id: string
  time: string
  action: string
  merchant: string
  amount: number | null
  currency: string
  verdict: "ALLOWED" | "DENIED" | "APPROVAL" | "FAILED"
  code: string
  reason: string
  ref: string
}

function toRow(entry: LedgerEntry): LedgerRow {
  // An allowed call can still fail at PayPal. The ledger must say so, rather
  // than reporting a capture that never happened as a success.
  const failed = (entry.result ?? "").startsWith("TOOL_ERROR")
  const verdict: LedgerRow["verdict"] = failed
    ? "FAILED"
    : entry.decision.allowed
      ? "ALLOWED"
      : entry.decision.requiresApproval
        ? "APPROVAL"
        : "DENIED"

  return {
    id: entry.id,
    time: clock(entry.at),
    action: entry.action,
    merchant: entry.proposal.merchant ?? "—",
    amount: entry.proposal.amount ?? null,
    currency: entry.proposal.currency ?? "USD",
    verdict,
    code: entry.decision.code,
    reason: entry.decision.reason,
    ref: entry.externalRef ?? "",
  }
}

function VerdictCell(params: ICellRendererParams<LedgerRow, LedgerRow["verdict"]>) {
  const value = params.value ?? "DENIED"
  return <span className={`badge badge-${value.toLowerCase()}`}>{value}</span>
}

const ledgerColumns: ColDef<LedgerRow>[] = [
  {
    field: "time",
    headerName: "Time",
    width: 92,
    cellClass: "mono dim",
  },
  {
    field: "action",
    headerName: "Action",
    width: 168,
    cellClass: "mono",
  },
  {
    field: "verdict",
    headerName: "Decision",
    width: 118,
    cellRenderer: VerdictCell,
    cellClass: "no-pad",
  },
  {
    field: "merchant",
    headerName: "Merchant",
    width: 156,
  },
  {
    field: "amount",
    headerName: "Amount",
    width: 116,
    type: "rightAligned",
    valueFormatter: (params) => (params.value == null ? "—" : minor(params.value, params.data?.currency)),
  },
  {
    field: "code",
    headerName: "Rule",
    width: 190,
    cellClass: "mono dim",
  },
  {
    field: "reason",
    headerName: "Why",
    flex: 1,
    minWidth: 220,
  },
  {
    field: "ref",
    headerName: "PayPal ref",
    width: 168,
    cellClass: "mono dim",
  },
]

function LedgerPanel(props: { rows: LedgerRow[]; summary: Snapshot["summary"] }) {
  const [query, setQuery] = useState("")

  return (
    <section className="panel ledger">
      <header className="panel-head">
        <div>
          <h2>Audit ledger</h2>
          <p className="panel-sub">
            {props.summary.total} decisions · {props.summary.allowed} allowed ·{" "}
            {props.summary.denied} denied · {props.summary.pendingApproval} escalated
          </p>
        </div>
        <input
          className="search"
          placeholder="Filter…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </header>
      <div className="grid-wrap">
        <AgGridReact<LedgerRow>
          theme={gridTheme}
          rowData={props.rows}
          columnDefs={ledgerColumns}
          getRowId={(params) => params.data.id}
          defaultColDef={{ sortable: true, resizable: true, filter: true }}
          quickFilterText={query}
          pagination
          paginationPageSize={6}
          paginationPageSizeSelector={[6, 12, 25]}
          animateRows
          rowHeight={38}
          headerHeight={36}
          overlayNoRowsTemplate='<span class="empty">Nothing has been attempted yet. Run the agent.</span>'
        />
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export function App() {
  const { state, connected, error: streamError } = useLiveState()
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [showLive, setShowLive] = useState(false)

  const rows = useMemo(() => (state?.ledger ?? []).map(toRow), [state?.ledger])

  const act = useCallback(async (work: () => Promise<unknown>) => {
    setBusy(true)
    setActionError(null)
    try {
      await work()
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }, [])

  const issue = () =>
    act(() =>
      adminApi("/api/mandate", {
        method: "POST",
        body: JSON.stringify({
          principal: "filippo@example.com",
          agentId: "agent-procurement-01",
          purpose: "Buy A4 paper and studio supplies",
          budget: 120,
          allowMerchants: ["acme-supplies"],
          maxPerTransaction: 50,
          requireApprovalAbove: 40,
          ttlMinutes: 1440,
        }),
      }),
    )

  const revoke = () =>
    act(() => adminApi("/api/mandate/revoke", { method: "POST", body: JSON.stringify({}) }))

  const revokeTarget = state?.mandate?.claims.id

  const resolve = (id: string, approve: boolean) =>
    act(() =>
      adminApi(`/api/approvals/${id}/resolve`, {
        method: "POST",
        body: JSON.stringify({ approve }),
      }),
    )

  if (!state) {
    return (
      <div className="boot">
        <span className="pulse" /> Connecting to the mandate service…
        {streamError ? <p className="muted">{streamError}</p> : null}
      </div>
    )
  }

  const mandate = state.mandate
  const revoked = Boolean(mandate?.state.revokedAt)
  const expired = Boolean(mandate && Date.parse(mandate.claims.expiresAt) <= Date.now())
  const waiting = state.approvals.filter((item) => item.status === "pending").length
  const readOnly = state.mode === "replay"

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="mark" />
          <div>
            <h1>Agent Mandate</h1>
            <p>Signed spending authority for AI agents</p>
          </div>
        </div>

        <div className="topbar-stats">
          <Stat label="Remaining" value={mandate ? money(mandate.remaining) : "—"} />
          <Stat label="Allowed" value={String(state.summary.allowed)} tone="green" />
          <Stat label="Denied" value={String(state.summary.denied)} tone="red" />
          <Stat label="Escalated" value={String(waiting)} tone="amber" />
        </div>

        <div className="topbar-mode">
          <span className={`mode ${state.mode}`}>{state.mode}</span>
          <span className={`conn ${connected ? "on" : "off"}`}>
            {connected ? "live" : "polling"}
          </span>
        </div>
      </header>

      {state.replay ? (
        <div className="banner info banner-row">
          <div>
            <strong>Recorded run.</strong> This is a real Gemini run ({state.replay.model}) captured
            on {recordedOn(state.replay.recordedAt)} in {state.replay.paypalMode} PayPal mode.
            Timestamps, ids and decisions are exactly as recorded. Press <em>Play recording</em> —
            no key, no API calls.
          </div>
          {state.live?.enabled ? (
            <div className="live-cta">
              <button
                className="btn primary sm"
                onClick={() => setShowLive(true)}
                disabled={state.live.remaining <= 0}
              >
                <span className="live-dot" />
                {state.live.remaining > 0
                  ? "Run live with Gemini"
                  : "Live budget exhausted today"}
              </button>
              <span className="live-cta-note">
                Real model, simulated PayPal · {state.live.remaining}/{state.live.cap} runs left
                today
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      {state.mode === "simulated" ? (
        <div className="banner">
          Simulated PayPal — no credentials configured. Every call is answered locally with the
          real toolkit schemas.
        </div>
      ) : null}

      {revoked ? (
        <div className="banner danger">
          This mandate has been revoked. Every call is refused, including reads.
        </div>
      ) : expired ? (
        <div className="banner">
          This mandate has expired. Issue a new one to keep going.
        </div>
      ) : null}

      {actionError ? <div className="alert error wide">{actionError}</div> : null}

      <main className="main">
        <MandateCard
          state={state}
          busy={busy}
          readOnly={readOnly}
          onIssue={() => void issue()}
          onRevoke={() => void (revokeTarget ? revoke() : issue())}
        />

        <RunPanel state={state} replay={state.replay} />

        <div className="side">
          <CheckoutPanel active={!revoked && !expired} />
          <TryPanel readOnly={readOnly} />

          <ApprovalsPanel
            approvals={state.approvals}
            busy={busy}
            readOnly={readOnly}
            onResolve={(id, approve) => void resolve(id, approve)}
          />
          <TrustPanel scores={state.trust} />
        </div>

        <LedgerPanel rows={rows} summary={state.summary} />
      </main>

      {showLive ? <LiveRunDialog onClose={() => setShowLive(false)} /> : null}
    </div>
  )
}

function Stat(props: { label: string; value: string; tone?: "green" | "red" | "amber" }) {
  return (
    <div className="stat">
      <span className="stat-label">{props.label}</span>
      <span className={`stat-value ${props.tone ? `tone-${props.tone}` : ""}`}>{props.value}</span>
    </div>
  )
}
