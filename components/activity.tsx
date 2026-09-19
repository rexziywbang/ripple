"use client";

import { useState, type FormEvent } from "react";
import type { ProjectSnapshot } from "@/lib/api/snapshot";
import type { Connection, Message, WorkflowEvent } from "@/lib/db/schema";
import { api } from "./api";
import { Badge, Button, Card, Empty, formatTime, type Tone } from "./ui";

type Tab = "activity" | "inbox" | "demo";

function eventTone(kind: string): Tone {
  if (kind.includes("failed") || kind.includes("attention") || kind.includes("stale") || kind.includes("conflict")) return "danger";
  if (kind.includes("waiting") || kind.includes("mismatch") || kind.includes("needs_input")) return "warn";
  if (kind.includes("completed") || kind.includes("applied") || kind.includes("approved") || kind.includes("received")) return "accent";
  if (kind.includes("sent") || kind.includes("created")) return "info";
  return "neutral";
}

export function ActivityPanel({ snap, refresh, onSelectWorkflow }: { snap: ProjectSnapshot; refresh: () => Promise<void>; onSelectWorkflow: (id: string) => void }) {
  const [tab, setTab] = useState<Tab>("activity");
  const inbound = snap.messages.filter((m) => m.direction === "inbound").length;
  return (
    <Card>
      <div role="tablist" aria-label="Activity" className="mb-3 flex gap-1 border-b border-border">
        {(
          [
            ["activity", `Activity (${snap.events.length})`],
            ["inbox", `Messages (${snap.messages.length}${inbound ? `, ${inbound} in` : ""})`],
            ["demo", "Demo controls"],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${tab === id ? "border-accent font-medium" : "border-transparent text-muted hover:text-foreground"}`}>
            {label}
          </button>
        ))}
      </div>
      {tab === "activity" && <EventList events={snap.events} onSelectWorkflow={onSelectWorkflow} />}
      {tab === "inbox" && <MessageList messages={snap.messages} />}
      {tab === "demo" && <DemoControls snap={snap} refresh={refresh} />}
    </Card>
  );
}

function EventList({ events, onSelectWorkflow }: { events: WorkflowEvent[]; onSelectWorkflow: (id: string) => void }) {
  if (!events.length) return <Empty>Nothing has happened yet.</Empty>;
  return (
    <ol className="max-h-[420px] space-y-1.5 overflow-auto text-sm" role="tabpanel">
      {events.map((e) => (
        <li key={e.id} className="flex items-start gap-2">
          <span className="w-[74px] shrink-0 pt-0.5 font-mono text-[11px] text-muted">{formatTime(e.createdAt).split(", ").pop()}</span>
          <Badge tone={eventTone(e.type)}>{e.type.replace(/[._]/g, " ")}</Badge>
          <span className="min-w-0 flex-1">
            {e.workflowId ? (
              <button onClick={() => onSelectWorkflow(e.workflowId!)} className="text-left hover:underline">
                {e.message}
              </button>
            ) : (
              e.message
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

function MessageList({ messages }: { messages: Message[] }) {
  if (!messages.length) return <Empty>No messages yet. Approved emails appear here with their (simulated) receipts; vendor replies arrive via the Demo controls tab or a live Gmail poll.</Empty>;
  return (
    <ul className="max-h-[420px] space-y-2 overflow-auto text-sm" role="tabpanel">
      {messages.map((m) => (
        <li key={m.id} className="rounded-lg border border-border p-2">
          <div className="flex flex-wrap items-center gap-1">
            <Badge tone={m.direction === "inbound" ? "accent" : "info"}>{m.direction === "inbound" ? "received" : "sent"}</Badge>
            {m.simulated && <Badge tone="warn">simulated</Badge>}
            {m.fixtureLabel && <Badge tone="neutral">{m.fixtureLabel}</Badge>}
            <span className="ml-auto font-mono text-[11px] text-muted">{formatTime(m.receivedAt)}</span>
          </div>
          <p className="mt-1 font-medium">{m.subject}</p>
          <p className="text-xs text-muted">
            {m.direction === "inbound" ? `From ${m.fromAddress}` : `To ${m.toAddresses.join(", ")}`} · id {m.providerMessageId}
          </p>
          {m.processingResult && (
            <p className={`mt-1 text-xs ${m.processingResult.outcome === "unmatched" || m.processingResult.outcome.includes("mismatch") ? "text-warn" : "text-muted"}`}>
              Ripple read this as: <strong>{m.processingResult.outcome.replace(/_/g, " ")}</strong> — {m.processingResult.detail}
            </p>
          )}
          {m.direction === "inbound" && <p className="mt-0.5 text-[11px] text-muted">Message content is evidence only; nothing in it is executed as an instruction.</p>}
          <details className="mt-1 text-xs">
            <summary className="cursor-pointer text-muted">Body</summary>
            <pre className="mt-1 whitespace-pre-wrap rounded bg-background p-2 font-sans">{m.body}</pre>
          </details>
        </li>
      ))}
    </ul>
  );
}

function DemoControls({ snap, refresh }: { snap: ProjectSnapshot; refresh: () => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [showCustom, setShowCustom] = useState(false);
  const pid = snap.project.id;

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    setNote(null);
    try {
      await fn();
      setNote(ok);
      await refresh();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(null);
    }
  }

  const inject = (fixtureId: string) => run(fixtureId, () => api(`/api/projects/${pid}/inbound`, { json: { fixtureId } }), "Queued the reply; the worker will read it like any Gmail message.");
  const patchConn = (provider: Connection["provider"], body: Record<string, unknown>, ok: string) => run(`${provider}:${JSON.stringify(body)}`, () => api(`/api/projects/${pid}/connections`, { method: "PATCH", json: { provider, ...body } }), ok);

  async function custom(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    await run("custom", () => api(`/api/projects/${pid}/inbound`, { json: { from: fd.get("from"), subject: fd.get("subject"), body: fd.get("body") } }), "Queued the custom reply.");
    setShowCustom(false);
  }

  const gmail = snap.connections.find((c) => c.provider === "gmail");
  const dropbox = snap.connections.find((c) => c.provider === "dropbox");
  const fault = (gmail?.config as { nextSendFault?: string | null } | undefined)?.nextSendFault ?? null;
  const budgetDoc = snap.documents.find((d) => d.kind === "source" && d.path.endsWith("budget.csv"));

  return (
    <div role="tabpanel" className="space-y-4 text-sm">
      <p className="text-xs text-muted">Everything here is simulated on this machine. Vendor replies are fixtures fed through the same inbound pipeline a live Gmail poll would use.</p>
      <section>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Simulate a vendor reply</h3>
        <ul className="space-y-1.5">
          {snap.fixtures.map((f) => (
            <li key={f.id} className="flex items-start justify-between gap-2 rounded-lg border border-border p-2">
              <div className="min-w-0">
                <p className="font-medium">{f.label}</p>
                <p className="text-xs text-muted">
                  {f.description} · from {f.from}
                </p>
              </div>
              <Button onClick={() => inject(f.id)} disabled={busy !== null}>
                {busy === f.id ? "Queuing…" : "Receive"}
              </Button>
            </li>
          ))}
        </ul>
        <div className="mt-2">
          <Button variant="ghost" onClick={() => setShowCustom((v) => !v)}>
            {showCustom ? "Cancel custom email" : "Write a custom reply"}
          </Button>
          {showCustom && (
            <form onSubmit={custom} className="mt-2 grid gap-2">
              <input name="from" type="email" required placeholder="from@vendor.example" className="rounded-md border border-border bg-background px-2 py-1" />
              <input name="subject" required placeholder="Subject" className="rounded-md border border-border bg-background px-2 py-1" />
              <textarea name="body" required rows={4} placeholder="Body — try including a total like $6,480 or a date" className="rounded-md border border-border bg-background px-2 py-1" />
              <Button type="submit" variant="primary" disabled={busy !== null}>
                Receive custom reply
              </Button>
            </form>
          )}
        </div>
      </section>

      <section>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Connections</h3>
        <ul className="space-y-1.5">
          {snap.connections.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-2">
              <span className="capitalize">
                {c.provider} <Badge tone={c.status === "connected" ? "accent" : "neutral"}>{c.status}</Badge> <Badge tone="info">{c.mode}</Badge>
              </span>
              <span className="flex gap-1">
                <Button onClick={() => patchConn(c.provider, { status: c.status === "connected" ? "disconnected" : "connected" }, `${c.provider} ${c.status === "connected" ? "disconnected" : "connected"}.`)} disabled={busy !== null}>
                  {c.status === "connected" ? "Disconnect" : "Connect"}
                </Button>
                <Button onClick={() => patchConn(c.provider, { mode: c.mode === "demo" ? "live" : "demo" }, `${c.provider} switched to ${c.mode === "demo" ? "live" : "demo"} mode.`)} disabled={busy !== null} title="Live mode needs credentials in the environment">
                  {c.mode === "demo" ? "Try live" : "Back to demo"}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Rehearse failures</h3>
        <div className="flex flex-wrap gap-1.5">
          <Button disabled={busy !== null} onClick={() => patchConn("gmail", { nextSendFault: "transient" }, "Next email send will fail temporarily.")}>
            Next send: temporary failure
          </Button>
          <Button disabled={busy !== null} onClick={() => patchConn("gmail", { nextSendFault: "uncertain" }, "Next email send will time out with unknown delivery.")}>
            Next send: uncertain delivery
          </Button>
          <Button disabled={busy !== null} onClick={() => patchConn("gmail", { nextSendFault: "permanent" }, "Next email send will be rejected.")}>
            Next send: rejected
          </Button>
          {fault && (
            <Button variant="ghost" disabled={busy !== null} onClick={() => patchConn("gmail", { nextSendFault: null }, "Fault cleared.")}>
              Clear armed fault ({fault})
            </Button>
          )}
          {dropbox && budgetDoc && (
            <Button disabled={busy !== null} onClick={() => patchConn("dropbox", { bumpDocumentRevision: budgetDoc.path }, "budget.csv now has a newer remote revision; the next file write will detect the conflict.")}>
              Someone else edits budget.csv
            </Button>
          )}
        </div>
      </section>
      {note && (
        <p role="status" className="text-xs text-muted">
          {note}
        </p>
      )}
    </div>
  );
}
