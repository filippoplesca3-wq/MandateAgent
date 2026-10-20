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
import { api, useLiveState } from "./api.js"
import type { AgentRunResponse, LedgerEntry, Money, PendingApproval, Snapshot, TrustScore } from "./api.js"

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
  headerFontSize: "11px",
  headerFontWeight: 600,
  spacing: 5,
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

  return (
    <Panel
      title="Mandate"
      subtitle={`${claims.principal} → ${claims.agentId}`}
      actions={
        <button
          className="btn ghost sm"
          onClick={props.onRevoke}
          disabled={props.busy || props.readOnly}
          title={props.readOnly ? "This is a recording, so it cannot be changed." : undefined}
        >
          Revoke
        </button>
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
          <dd>{state.revokedAt ? <Chip tone="red">revoked</Chip> : <Chip tone="green">active</Chip>}</dd>
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
      </div>
    </Panel>
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
        const bullet = /^\s*[*-]\s+/.test(line)
        const body = line.replace(/^\s*[*-]\s+/, "").replace(/^#+\s*/, "")
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
  verdict: "ALLOWED" | "DENIED" | "APPROVAL"
  code: string
  reason: string
  ref: string
}

function toRow(entry: LedgerEntry): LedgerRow {
  const verdict: LedgerRow["verdict"] = entry.decision.allowed
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
      api("/api/mandate", {
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
    act(() => api("/api/mandate/revoke", { method: "POST", body: JSON.stringify({}) }))

  const revokeTarget = state?.mandate?.claims.id

  const resolve = (id: string, approve: boolean) =>
    act(() =>
      api(`/api/approvals/${id}/resolve`, {
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
        <div className="banner info">
          <strong>Recorded run.</strong> This is a real Gemini run ({state.replay.model}) captured on{" "}
          {recordedOn(state.replay.recordedAt)} in {state.replay.paypalMode} PayPal mode. Timestamps,
          ids and decisions are exactly as recorded. Press <em>Play recording</em> — no key, no API
          calls.
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
