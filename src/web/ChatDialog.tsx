/**
 * The live purchasing chat.
 *
 * The visitor writes what they want; the model answers and may propose any
 * item with a price quote. The proposal card is the only thing that can start a
 * payment, and it starts it only when the visitor clicks. Every chat has its
 * own mandate, signing key and ledger on the server.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { api, ApiError } from "./api.js"
import type {
  ChatConfirmResponse,
  ChatProposal,
  ChatReceipt,
  ChatTurnResponse,
  Snapshot,
} from "./api.js"

interface ChatBubble {
  id: string
  role: "user" | "assistant"
  text: string
  proposal?: ChatProposal
  receipt?: ChatReceipt
}

const GREETING: ChatBubble = {
  id: "greeting",
  role: "assistant",
  text: "Tell me what you want to buy — anything. I'll check the mandate and propose it with a price. Nothing is paid until you approve the card.",
}

function money(amount: number, currency = "USD"): string {
  return `${currency} ${(amount / 100).toFixed(2)}`
}

export function ChatDialog(props: { onClose: () => void }) {
  const { onClose } = props
  const [messages, setMessages] = useState<ChatBubble[]>([GREETING])
  const [input, setInput] = useState("")
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [turns, setTurns] = useState<number | null>(null)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [model, setModel] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const startedAt = useRef(0)
  const endRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const busy = sending || confirming !== null

  useEffect(() => {
    if (!sending) return
    const timer = setInterval(() => setElapsed(Date.now() - startedAt.current), 100)
    return () => clearInterval(timer)
  }, [sending])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [messages, sending, confirming])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  const reset = useCallback(() => {
    setMessages([GREETING])
    setInput("")
    setSessionId(null)
    setTurns(null)
    setSnapshot(null)
    setModel(null)
    setError(null)
    setConfirming(null)
  }, [])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || busy) return

    setInput("")
    setError(null)
    setMessages((previous) => [
      ...previous,
      { id: `u-${Date.now()}`, role: "user", text },
    ])
    setSending(true)
    startedAt.current = Date.now()
    setElapsed(0)

    try {
      const response = await api<ChatTurnResponse>("/api/demo/chat", {
        method: "POST",
        body: JSON.stringify({
          ...(sessionId ? { sessionId } : {}),
          message: text,
        }),
      })

      setSessionId(response.sessionId)
      setTurns(response.turns)
      setSnapshot(response.snapshot)
      setModel(response.model)
      setMessages((previous) => [
        ...previous,
        {
          id: `a-${Date.now()}`,
          role: "assistant",
          text: response.text,
          ...(response.proposal ? { proposal: response.proposal } : {}),
        },
      ])
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSending(false)
      inputRef.current?.focus()
    }
  }, [busy, input, sessionId])

  const confirm = useCallback(
    async (proposal: ChatProposal) => {
      if (!sessionId || busy) return

      setConfirming(proposal.id)
      setError(null)

      try {
        const response = await api<ChatConfirmResponse>("/api/demo/chat/confirm", {
          method: "POST",
          body: JSON.stringify({ sessionId, proposalId: proposal.id }),
        })

        setSnapshot(response.snapshot)
        setMessages((previous) =>
          previous.map((message) =>
            message.proposal?.id === proposal.id
              ? {
                  ...message,
                  proposal: { ...message.proposal, status: "purchased" },
                  receipt: response.receipt,
                }
              : message,
          ),
        )
      } catch (caught) {
        const text = caught instanceof Error ? caught.message : String(caught)
        setError(text)
        if (caught instanceof ApiError && caught.status === 402) {
          setMessages((previous) =>
            previous.map((message) =>
              message.proposal?.id === proposal.id
                ? { ...message, proposal: { ...message.proposal, status: "failed" } }
                : message,
            ),
          )
        }
      } finally {
        setConfirming(null)
      }
    },
    [busy, sessionId],
  )

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        className="modal chat-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Live purchasing chat"
      >
        <header className="modal-head">
          <div>
            <h2>
              <span className="live-badge">
                <span className="pulse" /> LIVE
              </span>
              Chat with the purchasing agent
            </h2>
            <p className="panel-sub">
              Real Gemini, simulated PayPal. Say what you want in your own words: the model checks
              the mandate and proposes any item with a price. You approve the card before anything
              is paid. This chat gets its own mandate, signing key and ledger.
            </p>
          </div>
          <div className="chat-head-actions">
            <button className="btn ghost sm" onClick={reset} disabled={busy}>
              New chat
            </button>
            <button className="btn ghost sm" onClick={onClose}>
              Close
            </button>
          </div>
        </header>

        <div className="chat-log">
          {messages.map((message) => (
            <div key={message.id} className={`chat-row ${message.role}`}>
              <div className={`chat-bubble ${message.role}`}>
                <p>{message.text}</p>
                {message.proposal ? (
                  <ProposalCard
                    proposal={message.proposal}
                    busy={confirming !== null}
                    confirming={confirming === message.proposal.id}
                    onConfirm={() => void confirm(message.proposal!)}
                  />
                ) : null}
                {message.receipt ? <ReceiptCard receipt={message.receipt} /> : null}
              </div>
            </div>
          ))}

          {sending ? (
            <div className="chat-row assistant">
              <div className="chat-bubble assistant typing">
                <span className="live">
                  <span className="pulse" /> thinking · {(elapsed / 1_000).toFixed(1)}s
                </span>
                <span className="muted">
                  Gemini is working out what to propose and checking the mandate.
                </span>
              </div>
            </div>
          ) : null}

          <div ref={endRef} />
        </div>

        {snapshot ? (
          <>
            <div className="chat-stats">
              <ChatStat
                label="Remaining"
                value={snapshot.mandate ? money(snapshot.mandate.remaining.amount) : "—"}
              />
              <ChatStat label="Allowed" value={String(snapshot.summary.allowed)} tone="green" />
              <ChatStat label="Denied" value={String(snapshot.summary.denied)} tone="red" />
              <ChatStat
                label="Pending"
                value={String(
                  snapshot.approvals.filter((approval) => approval.status === "pending").length,
                )}
                tone="amber"
              />
              <ChatStat label="Turns" value={turns === null ? "—" : String(turns)} />
            </div>

            {snapshot.ledger.length > 0 ? (
              <ul className="chat-ledger">
                {snapshot.ledger.slice(-5).map((entry) => (
                  <li key={entry.id}>
                    <span
                      className={`chat-ledger-code ${
                        entry.decision.allowed ? "tone-green" : "tone-red"
                      }`}
                      title={entry.decision.code}
                    >
                      {entry.decision.allowed
                        ? "ALLOWED"
                        : entry.decision.code.startsWith("REQUIRES_HUMAN")
                          ? "ESCALATED"
                          : "DENIED"}
                    </span>
                    <code>{entry.action}</code>
                    <span className="chat-ledger-desc">
                      {entry.proposal.description ?? entry.proposal.merchant ?? "—"}
                    </span>
                    <span className="chat-ledger-amount">
                      {typeof entry.proposal.amount === "number"
                        ? money(entry.proposal.amount, entry.proposal.currency ?? "USD")
                        : "—"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : null}

        {error ? <div className="alert error">{error}</div> : null}

        <div className="chat-composer">
          <textarea
            ref={inputRef}
            className="task-input chat-input"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault()
                void send()
              }
            }}
            rows={2}
            maxLength={500}
            spellCheck={false}
            disabled={busy}
            placeholder="Tell the agent what you want to buy…"
          />
          <div className="chat-composer-actions">
            <span className="muted">
              {turns === null
                ? "Multi-turn chat · one proposal at a time"
                : `${turns} ${turns === 1 ? "turn" : "turns"} · one proposal at a time`}
              {model ? ` · ${model}` : ""}
            </span>
            <button
              className="btn primary"
              onClick={() => void send()}
              disabled={busy || input.trim().length === 0}
            >
              {sending ? "Thinking…" : "Send"}
            </button>
          </div>
        </div>

        <p className="chat-footnote">
          Simulated PayPal: no PayPal credentials are used and no money moves. The model, the guard
          and this chat's ledger are the same code paths as a real run.
        </p>
      </div>
    </div>
  )
}

function ProposalCard(props: {
  proposal: ChatProposal
  busy: boolean
  confirming: boolean
  onConfirm: () => void
}) {
  const { proposal } = props
  const canBuy =
    proposal.status === "proposed" && (proposal.allowed || proposal.requiresApproval)
  const tone = proposal.allowed
    ? "allowed"
    : proposal.requiresApproval
      ? "approval"
      : "denied"

  return (
    <div className={`chat-proposal ${tone}`}>
      <div className="chat-proposal-head">
        <div>
          <strong>{proposal.name}</strong>
          <span className="chat-proposal-desc">{proposal.description}</span>
        </div>
        <span className="chat-price">{money(proposal.amount, proposal.currency)}</span>
      </div>

      <div className="chat-proposal-meta">
        <span>{proposal.merchant}</span>
        <span className={`chat-verdict ${tone}`}>
          {proposal.allowed
            ? "Within mandate"
            : proposal.requiresApproval
              ? "Approval required"
              : "Refused by mandate"}
        </span>
      </div>

      <p className="chat-proposal-reason">{proposal.reason}</p>

      {proposal.status === "purchased" ? (
        <span className="chat-status tone-green">Paid</span>
      ) : proposal.status === "failed" ? (
        <span className="chat-status tone-red">Not completed</span>
      ) : proposal.status === "purchasing" ? (
        <span className="chat-status tone-amber">Processing…</span>
      ) : (
        <button
          className="btn primary sm"
          onClick={props.onConfirm}
          disabled={!canBuy || props.busy}
        >
          {props.confirming
            ? "Paying…"
            : proposal.requiresApproval
              ? `Approve & buy ${money(proposal.amount, proposal.currency)}`
              : `Buy ${money(proposal.amount, proposal.currency)}`}
        </button>
      )}
    </div>
  )
}

function ReceiptCard(props: { receipt: ChatReceipt }) {
  const { receipt } = props
  return (
    <div className="chat-receipt">
      <div className="chat-receipt-title">
        Payment complete <span className="tone-green">simulated</span>
      </div>
      <dl>
        <div>
          <dt>Item</dt>
          <dd>{receipt.name}</dd>
        </div>
        <div>
          <dt>Amount</dt>
          <dd>{money(receipt.amount, receipt.currency)}</dd>
        </div>
        <div>
          <dt>Order</dt>
          <dd>
            <code>{receipt.orderId}</code>
          </dd>
        </div>
        {receipt.captureId ? (
          <div>
            <dt>Capture</dt>
            <dd>
              <code>{receipt.captureId}</code>
            </dd>
          </div>
        ) : null}
        <div>
          <dt>Approvals</dt>
          <dd>{receipt.approvals} consumed</dd>
        </div>
      </dl>
    </div>
  )
}

function ChatStat(props: { label: string; value: string; tone?: "green" | "red" | "amber" }) {
  return (
    <div className="stat">
      <span className="stat-label">{props.label}</span>
      <span className={`stat-value ${props.tone ? `tone-${props.tone}` : ""}`}>{props.value}</span>
    </div>
  )
}
