"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { ProjectSnapshot } from "@/lib/api/snapshot";
import type { ProjectFact, SourceDocument, Workflow } from "@/lib/db/schema";
import { AREAS, AREA_BY_ID, type AreaId } from "@/lib/domain/areas";
import { formatFactValue, humanFactKey } from "@/lib/domain/facts";
import { formatCents } from "@/lib/domain/money";
import { api } from "./api";
import { InviteCard } from "./invite-card";
import { Badge, Button, Card, CostBadge, Empty, SectionTitle, type Tone } from "./ui";

const FACT_TONE: Record<ProjectFact["status"], Tone> = { confirmed: "accent", tentative: "warn", unknown: "danger" };

export function AreaTiles({ snap, selected, onSelect }: { snap: ProjectSnapshot; selected: AreaId; onSelect: (a: AreaId) => void }) {
  return (
    <nav aria-label="Planning areas" className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
      {AREAS.map((a) => {
        const facts = snap.facts.filter((f) => a.factKeys.includes(f.key));
        const unknown = facts.filter((f) => f.status === "unknown").length;
        const tentative = facts.filter((f) => f.status === "tentative").length;
        const active = snap.workflows.filter((w) => !["completed", "superseded", "failed"].includes(w.status) && (w.area === a.id || w.proposals.some((p) => p.area === a.id && p.decision === "pending")));
        const isSel = a.id === selected;
        const dot = active.length ? "bg-info ripple-active" : unknown ? "bg-danger" : tentative ? "bg-warn" : "bg-accent";
        const hint = active.length ? `${active.length} change${active.length === 1 ? "" : "s"} in progress` : unknown ? `${unknown} unknown` : tentative ? `${tentative} tentative` : "settled";
        return (
          <button
            key={a.id}
            onClick={() => onSelect(a.id)}
            aria-pressed={isSel}
            title={hint}
            className={`flex min-w-0 items-center gap-2 rounded-xl border px-3 py-2 text-left transition-colors ${isSel ? "border-accent bg-accent-soft" : "border-border bg-surface hover:bg-border/30"}`}
          >
            <span aria-hidden className={`size-2 shrink-0 rounded-full ${dot}`} />
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold">{a.short}</span>
              <span className="block truncate text-[11px] text-muted">{hint}</span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}

function SourceLinks({ refs, snap, onOpen }: { refs: ProjectFact["sourceRefs"]; snap: ProjectSnapshot; onOpen: (id: string) => void }) {
  if (!refs.length) return null;
  return (
    <span className="flex min-w-0 flex-wrap gap-1">
      {refs.slice(0, 3).map((r, i) => {
        if (r.type === "document" && r.id) {
          const doc = snap.documents.find((d) => d.id === r.id);
          return (
            <button key={i} onClick={() => onOpen(r.id!)} className="max-w-full truncate rounded bg-border/50 px-1.5 py-0.5 text-[11px] hover:bg-border" title={r.excerpt ?? doc?.path}>
              {doc?.path.split("/").pop() ?? "document"}
            </button>
          );
        }
        if (r.type === "message") {
          const m = snap.messages.find((x) => x.id === r.id);
          return (
            <span key={i} className="max-w-full truncate rounded bg-border/50 px-1.5 py-0.5 text-[11px]" title={r.excerpt}>
              email: {m?.subject ?? "message"}
            </span>
          );
        }
        return (
          <span key={i} className="rounded bg-border/50 px-1.5 py-0.5 text-[11px]" title={r.excerpt}>
            {r.type === "workflow" ? "applied change" : r.type}
          </span>
        );
      })}
      {refs.length > 3 && <span className="text-[11px] text-muted">+{refs.length - 3}</span>}
    </span>
  );
}

function DocumentViewer({ projectId, docId, onClose }: { projectId: string; docId: string; onClose: () => void }) {
  const [doc, setDoc] = useState<SourceDocument | null>(null);
  useEffect(() => {
    api<{ document: SourceDocument }>(`/api/projects/${projectId}/documents/${docId}`).then((d) => setDoc(d.document)).catch(() => setDoc(null));
  }, [projectId, docId]);
  return (
    <div role="dialog" aria-modal="true" aria-label={doc?.path ?? "Document"} className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-3xl overflow-auto rounded-xl border border-border bg-surface p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <div>
            <p className="font-mono text-sm">{doc?.path ?? "Loading…"}</p>
            {doc && (
              <p className="text-xs text-muted">
                {doc.kind === "projection" ? "Projection written by Ripple" : "Imported source"} · revision {doc.revision ?? "—"} · treated as untrusted evidence
              </p>
            )}
          </div>
          <Button variant="ghost" onClick={onClose} autoFocus>
            Close
          </Button>
        </div>
        <pre className="whitespace-pre-wrap rounded-lg bg-background p-3 font-mono text-xs leading-relaxed">{doc?.content ?? ""}</pre>
      </div>
    </div>
  );
}

export function AreaPanel({ snap, area, refresh, onWorkflowCreated }: { snap: ProjectSnapshot; area: AreaId; refresh: () => Promise<void>; onWorkflowCreated: (id: string) => void }) {
  const def = AREA_BY_ID[area];
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showSources, setShowSources] = useState(false);
  const [openDoc, setOpenDoc] = useState<string | null>(null);
  const facts = def.factKeys.map((k) => snap.facts.find((f) => f.key === k)).filter((f): f is ProjectFact => !!f);
  const docs = snap.documents.filter((d) => def.folder && d.path.includes(`/${def.folder}/`));
  const closed = snap.project.status === "closed";

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const { workflow } = await api<{ workflow: Workflow }>(`/api/projects/${snap.project.id}/workflows`, { json: { area, request: text.trim() } });
      setText("");
      onWorkflowCreated(workflow.id);
      await refresh();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : "Could not submit");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card aria-labelledby="area-title" className="min-w-0">
      <div className="mb-3">
        <h2 id="area-title" className="text-lg font-semibold">
          {def.title}
        </h2>
      </div>

      <form onSubmit={submit} className="mb-4 grid gap-2">
        <label htmlFor="request" className="text-sm font-medium">
          What changed?
        </label>
        <textarea
          id="request"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          disabled={closed}
          placeholder={closed ? "Reopen the project to make changes." : `e.g. “${def.examples[0]}”`}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e);
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" variant="primary" disabled={busy || closed || !text.trim()}>
            {busy ? "Capturing…" : "Follow the consequences"}
          </Button>
          <span className="text-xs text-muted">Nothing is applied or sent until you review it.</span>
        </div>
        <div className="flex flex-wrap gap-1.5" aria-label="Example prompts">
          {def.examples.map((ex) => (
            <button key={ex} type="button" onClick={() => setText(ex)} className="rounded-full border border-border px-2.5 py-1 text-xs hover:bg-border/40">
              {ex}
            </button>
          ))}
        </div>
        {err && (
          <p role="alert" className="text-sm text-danger">
            {err}
          </p>
        )}
      </form>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="min-w-0">
          <div className="flex items-baseline justify-between gap-2">
            <SectionTitle>Current plan</SectionTitle>
            {facts.some((f) => f.sourceRefs.length) && (
              <button type="button" aria-pressed={showSources} onClick={() => setShowSources((v) => !v)} className="text-xs text-muted hover:underline">
                {showSources ? "Hide sources" : "Sources"}
              </button>
            )}
          </div>
          {facts.length === 0 ? (
            <Empty>No facts recorded for this area yet.</Empty>
          ) : (
            <dl className="divide-y divide-border text-sm">
              {facts.map((f) => (
                <div key={f.key} className="grid min-w-0 gap-0.5 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <dt className="truncate text-muted">{humanFactKey(f.key)}</dt>
                    {f.status !== "confirmed" && <Badge tone={FACT_TONE[f.status]}>{f.status}</Badge>}
                  </div>
                  <dd className="break-words font-medium" title={`Version ${f.version}`}>
                    {formatFactValue(f.key, f.value)}
                  </dd>
                  {showSources && <SourceLinks refs={f.sourceRefs} snap={snap} onOpen={setOpenDoc} />}
                </div>
              ))}
            </dl>
          )}
        </div>
        <div className="min-w-0 space-y-4">
          <AreaDetails snap={snap} area={area} />
          {docs.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-muted">
                {docs.length} linked file{docs.length === 1 ? "" : "s"}
              </summary>
              <ul className="mt-2 space-y-1">
                {docs.map((d) => (
                  <li key={d.id} className="flex min-w-0 items-center justify-between gap-2">
                    <button onClick={() => setOpenDoc(d.id)} className="min-w-0 truncate text-left font-mono text-xs hover:underline" title={d.path}>
                      {d.path.split("/").pop()}
                    </button>
                    <span className="flex shrink-0 gap-1">
                      {d.kind === "projection" && <Badge tone="info">by Ripple</Badge>}
                      {!d.supported && <Badge tone="neutral">unsupported</Badge>}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>
      {openDoc && <DocumentViewer projectId={snap.project.id} docId={openDoc} onClose={() => setOpenDoc(null)} />}
    </Card>
  );
}

const ENGAGEMENT_TONE: Record<string, Tone> = { confirmed: "accent", awaiting: "warn", declined: "danger", none: "neutral" };

function AreaDetails({ snap, area }: { snap: ProjectSnapshot; area: AreaId }) {
  if (area === "catering" || area === "venue" || area === "equipment") {
    const service = area === "catering" ? "catering" : area;
    const engs = snap.engagements.filter((e) => e.service === service || (area === "catering" && e.service !== "venue" && e.service !== "equipment"));
    return (
      <div>
        <SectionTitle>Vendors</SectionTitle>
        {engs.length === 0 ? (
          <Empty>No vendor engagements.</Empty>
        ) : (
          <ul className="space-y-2 text-sm">
            {engs.map((e) => {
              const contact = snap.contacts.find((c) => c.id === e.contactId);
              const latestQuote = e.quotes[e.quotes.length - 1];
              return (
                <li key={e.id} className="rounded-lg border border-border p-2">
                  <div className="flex flex-wrap items-center justify-between gap-1">
                    <span className="font-medium">{e.vendorName}</span>
                    <span className="flex gap-1">
                      {e.cancellationState !== "none" && <Badge tone={e.cancellationState === "confirmed" ? "neutral" : "warn"}>cancellation {e.cancellationState}</Badge>}
                      {e.quoteState !== "none" && <Badge tone={e.quoteState === "accepted" ? "accent" : "info"}>quote {e.quoteState}</Badge>}
                      <Badge tone={ENGAGEMENT_TONE[e.confirmationState]}>{e.confirmationState === "none" ? "not booked" : e.confirmationState}</Badge>
                    </span>
                  </div>
                  <p className="text-xs text-muted">
                    {contact ? `${contact.name} · ${contact.email}${contact.emailVerified ? " (verified)" : " (unverified)"}${contact.isFixture ? " · fixture" : ""}` : "No contact on file"}
                  </p>
                  {(e.unitCents !== null || e.depositCents !== null) && (
                    <p className="text-xs text-muted">
                      {e.unitCents !== null && e.quantity !== null ? `${e.quantity} × ${formatCents(e.unitCents)}` : ""}
                      {e.feeCents ? ` + ${formatCents(e.feeCents)} fee` : ""}
                      {e.depositCents !== null ? ` · deposit ${formatCents(e.depositCents)} ${e.depositRefundable ? "refundable" : "non-refundable"}` : ""}
                    </p>
                  )}
                  {e.cancellationTerms && <p className="text-xs text-muted">Terms: {e.cancellationTerms}</p>}
                  {latestQuote && (
                    <p className="text-xs">
                      Latest quote v{latestQuote.version}: {formatCents(latestQuote.totalCents)} ({latestQuote.status}
                      {latestQuote.expiresAt ? `, valid until ${latestQuote.expiresAt}` : ""})
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  }
  if (area === "budget") {
    const lines = snap.budgetLines.filter((l) => l.active || l.commitmentStatus === "sunk");
    return (
      <div>
        <SectionTitle>Budget lines</SectionTitle>
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="py-1 font-medium">Item</th>
              <th className="py-1 font-medium">State</th>
              <th className="py-1 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id} className={`border-t border-border ${!l.active ? "opacity-70" : ""}`}>
                <td className="py-1 pr-2">
                  {l.label}
                  {l.quantity !== null && l.unitCents !== null && (
                    <span className="block text-xs text-muted">
                      {l.quantity} × {formatCents(l.unitCents)}
                    </span>
                  )}
                </td>
                <td className="py-1">
                  <CostBadge status={l.commitmentStatus} />
                </td>
                <td className="py-1 text-right font-mono">{l.subtotalCents === null ? "Unknown" : formatCents(l.subtotalCents + l.taxCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (area === "staff") {
    return (
      <div className="space-y-4">
        <div>
          <SectionTitle>Roster</SectionTitle>
          <ul className="text-sm">
            {snap.staff.map((m) => (
              <li key={m.id} className="flex items-center justify-between border-t border-border py-1 first:border-t-0">
                <span>
                  {m.name} <span className="text-muted">· {m.role}</span>
                </span>
                <Badge tone={m.available ? "accent" : "danger"}>{m.available ? "available" : "unavailable"}</Badge>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <SectionTitle>Run of show</SectionTitle>
          <ul className="text-sm">
            {snap.schedule.map((it) => (
              <li key={it.id} className="flex justify-between border-t border-border py-1 first:border-t-0">
                <span>{it.title}</span>
                <span className="font-mono text-xs">
                  {it.startLocal}
                  {it.endLocal ? `–${it.endLocal}` : ""} <span className="text-muted">v{it.version}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  }
  if (area === "guests") {
    return (
      <div>
        <SectionTitle>Invitation</SectionTitle>
        <InviteCard snap={snap} />
      </div>
    );
  }
  return null;
}
