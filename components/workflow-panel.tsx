"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import type { ProjectSnapshot, WorkflowView } from "@/lib/api/snapshot";
import type { EvidenceRef, Proposal, Task } from "@/lib/db/schema";
import { AREAS, AREA_BY_ID, type AreaId } from "@/lib/domain/areas";
import { formatFactValue, humanFactKey } from "@/lib/domain/facts";
import { formatCents, formatDelta } from "@/lib/domain/money";
import { api } from "./api";
import { FollowingPath, isFresh, pathSteps } from "./following-path";
import { InviteCard } from "./invite-card";
import { Badge, Button, Card, CostBadge, Empty, formatTime, type Tone } from "./ui";

const STATUS_TONE: Record<string, Tone> = {
  planning: "info",
  needs_input: "warn",
  ready_for_review: "accent",
  executing: "info",
  waiting_external: "warn",
  partially_complete: "danger",
  completed: "accent",
  failed: "danger",
  superseded: "neutral",
};

export const STATUS_LABEL: Record<string, string> = {
  planning: "Working",
  needs_input: "Needs your answer",
  ready_for_review: "Ready to review",
  executing: "Applying",
  waiting_external: "Waiting on others",
  partially_complete: "Needs attention",
  completed: "Completed",
  failed: "Failed",
  superseded: "Superseded",
};

const KIND_LABEL: Record<string, string> = {
  fact: "Plan",
  budget_line: "Budget",
  email: "Email",
  staff_notice: "Staff note",
  invitation: "Invitation",
  file: "File",
  schedule: "Schedule",
  engagement: "Vendor",
  staff: "Staff",
  check: "Check",
  wait: "Wait",
};

const SENDS = new Set(["email", "staff_notice", "invitation"]);

export function WorkflowPanel({ snap, workflow, refresh, onSelectWorkflow }: { snap: ProjectSnapshot; workflow: WorkflowView | null; refresh: () => Promise<void>; onSelectWorkflow: (id: string) => void }) {
  return (
    <Card aria-live="polite" aria-labelledby="wf-title" className="min-w-0">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 id="wf-title" className="text-sm font-semibold uppercase tracking-wide text-muted">
          Changes
        </h2>
        {snap.workflows.length > 1 && (
          <select aria-label="Select a change" value={workflow?.id ?? ""} onChange={(e) => onSelectWorkflow(e.target.value)} className="max-w-[60%] rounded-md border border-border bg-background px-2 py-1 text-xs">
            {snap.workflows.map((w) => (
              <option key={w.id} value={w.id}>
                {STATUS_LABEL[w.status]} · {w.request.slice(0, 60)}
              </option>
            ))}
          </select>
        )}
      </div>
      {!workflow ? <Empty>No changes yet. Describe what changed in any planning area and Ripple will follow the consequences here.</Empty> : <WorkflowDetail key={workflow.id} snap={snap} wf={workflow} refresh={refresh} />}
    </Card>
  );
}

function Chevron() {
  return (
    <svg aria-hidden className="chevron size-3.5 shrink-0 text-muted" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M6 3l5 5-5 5" />
    </svg>
  );
}

function ProgressPath({ wf }: { wf: WorkflowView }) {
  const [open, setOpen] = useState(false);
  const past = ["executing", "waiting_external", "partially_complete", "completed"].includes(wf.status);
  const states = pathSteps(wf);
  const current = states.find((s) => s.active) ?? states.find((s) => s.failed) ?? (past ? states[states.length - 1] : states.find((s) => !s.done));
  return (
    <div>
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 rounded-md py-1 text-left text-xs hover:bg-border/30">
        <Chevron />
        <ol aria-label="Progress" className="flex items-center gap-1">
          {states.map((s) => (
            <li key={s.stage} aria-current={s.active ? "step" : undefined} title={s.title} className={`inline-block size-2 rounded-full ${s.done ? "bg-accent" : s.active ? "bg-info ripple-active" : s.failed ? "bg-danger" : "bg-border"}`}>
              <span className="sr-only">{s.title}</span>
            </li>
          ))}
        </ol>
        <span className="text-muted">
          {past ? "All steps complete" : current ? current.title : ""}
          {!past && current?.task?.detail ? ` — ${current.task.detail}` : ""}
        </span>
      </button>
      {open && (
        <ol className="ml-6 mt-1 space-y-1 border-l border-border pl-3 text-xs">
          {states.map((s) => (
            <li key={s.stage} className={s.done || s.active ? "" : "text-muted"}>
              <span className="font-medium">{s.title}</span>
              {s.task?.detail && <span className="text-muted"> — {s.task.detail}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function EvidenceList({ evidence, snap }: { evidence: EvidenceRef[]; snap: ProjectSnapshot }) {
  if (!evidence.length) return null;
  return (
    <ul className="space-y-0.5">
      {evidence.map((e, i) => {
        const doc = e.sourceType === "document" ? snap.documents.find((d) => d.id === e.ref) : undefined;
        const msg = e.sourceType === "message" ? snap.messages.find((m) => m.id === e.ref) : undefined;
        return (
          <li key={i} className="text-[11px] text-muted">
            <span className="font-medium">{e.label ?? (doc ? doc.path.split("/").pop() : msg ? `email “${msg.subject}”` : e.sourceType)}</span>
            {e.excerpt && <span className="italic"> — “{e.excerpt.slice(0, 200)}”</span>}
          </li>
        );
      })}
    </ul>
  );
}

function unwrap(v: unknown) {
  return v && typeof v === "object" && "value" in (v as Record<string, unknown>) ? (v as { value: unknown }).value : v;
}

/** One-line summary shown while a row is collapsed. */
function summaryOf(p: Proposal): string | null {
  const t = p.target;
  switch (t.type) {
    case "fact":
      return `${formatFactValue(t.key, unwrap(p.before))} → ${formatFactValue(t.key, unwrap(p.after))}`;
    case "email":
      return `To ${t.to.map((r) => r.name).join(", ")}`;
    case "staff_notice":
      return `To ${t.recipients.length} staff`;
    case "invitation":
      return `${t.recipientCount} guests`;
    case "file":
      return t.path.split("/").pop() ?? t.path;
    case "budget_line": {
      const after = p.after as { subtotalCents?: number | null } | null;
      const before = p.before as { subtotalCents?: number | null } | null;
      return `${before ? formatCents(before.subtotalCents) : "—"} → ${formatCents(after?.subtotalCents)}`;
    }
    case "schedule":
      return `${String(p.before ?? "")} → ${t.startLocal}`;
    case "engagement":
      return `${String(p.before)} → ${String(p.after)}`;
    case "check":
      return t.note;
    default:
      return null;
  }
}

function ProposalBody({ p, snap }: { p: Proposal; snap: ProjectSnapshot }) {
  const t = p.target;
  const pre = "whitespace-pre-wrap break-words rounded-md bg-background p-2 text-xs";
  switch (t.type) {
    case "fact":
      return (
        <p className="text-xs">
          {humanFactKey(t.key)}: <s className="text-muted">{formatFactValue(t.key, unwrap(p.before))}</s> → <strong>{formatFactValue(t.key, unwrap(p.after))}</strong>
        </p>
      );
    case "email":
      return (
        <div className="space-y-1 text-xs">
          <p className="text-muted">
            To {t.to.map((r) => `${r.name} <${r.email}>`).join(", ")} · Subject: {t.subject}
          </p>
          <pre className={`${pre} font-sans`}>{t.body}</pre>
        </div>
      );
    case "staff_notice":
      return <pre className={`${pre} font-sans`}>{t.text}</pre>;
    case "invitation":
      return <InviteCard snap={snap} text={t.text} compact />;
    case "file":
      return (
        <div className="space-y-1 text-xs">
          <p className="font-mono text-muted">{t.path}</p>
          <pre className={`${pre} max-h-48 overflow-auto font-mono text-[11px]`}>{t.content}</pre>
        </div>
      );
    case "budget_line": {
      const after = p.after as { label?: string; subtotalCents?: number | null } | null;
      const before = p.before as { subtotalCents?: number | null } | null;
      return (
        <p className="text-xs">
          {after?.label ?? t.category}: {before ? formatCents(before.subtotalCents) : "—"} → <strong>{formatCents(after?.subtotalCents)}</strong>
        </p>
      );
    }
    case "schedule":
      return (
        <p className="text-xs">
          {t.title}: <s className="text-muted">{String(p.before ?? "")}</s> → <strong>{t.startLocal}</strong>
        </p>
      );
    case "engagement":
      return (
        <p className="text-xs">
          {t.field}: {String(p.before)} → <strong>{String(p.after)}</strong>
        </p>
      );
    case "check":
      return <p className="text-xs">{t.note}</p>;
    default:
      return null;
  }
}

function taskFor(wf: WorkflowView, p: Proposal): Task | undefined {
  return wf.tasks.find((t) => t.id === p.taskId);
}

function outcomeBadge(p: Proposal, task: Task | undefined, action: WorkflowView["actions"][number] | undefined): ReactNode {
  if (p.decision === "stale") return <Badge tone="danger">Stale</Badge>;
  if (p.decision === "rejected") return <Badge tone="neutral">Skipped</Badge>;
  if (!task) return null;
  switch (task.status) {
    case "succeeded":
      return action ? <Badge tone="accent">{action.simulated ? "Simulated send" : "Sent"}</Badge> : <Badge tone="accent">Updated</Badge>;
    case "failed":
      return <Badge tone="danger">Failed</Badge>;
    case "waiting_external":
      return <Badge tone="warn">Waiting</Badge>;
    case "blocked":
      return <Badge tone="neutral">Blocked</Badge>;
    case "skipped":
    case "superseded":
      return <Badge tone="neutral">Skipped</Badge>;
    case "queued":
    case "running":
      return <Badge tone="info">Applying</Badge>;
    default:
      return null;
  }
}

function ProposalRow({ p, wf, snap, checked, onToggle, blockedBy, showOutcome, children }: { p: Proposal; wf: WorkflowView; snap: ProjectSnapshot; checked?: boolean; onToggle?: () => void; blockedBy: string[]; showOutcome?: boolean; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const task = taskFor(wf, p);
  const action = wf.actions.find((a) => a.proposalId === p.id);
  const isCheck = p.kind === "check";
  const severity = p.target.type === "check" ? p.target.severity : undefined;
  const factsMoved = isCheck && Object.entries(p.factDeps).some(([k, v]) => (snap.facts.find((f) => f.key === k)?.version ?? 0) !== v);
  const summary = summaryOf(p);
  const rowId = `row-${p.id}`;

  if (isCheck) {
    return (
      <li className={`flex items-start gap-2 rounded-md px-2 py-1 text-xs ${severity === "warning" ? "bg-warn-soft/50 text-warn" : "text-muted"}`}>
        <span aria-hidden className="mt-0.5">
          {severity === "warning" ? "!" : "✓"}
        </span>
        <span className="min-w-0 flex-1 break-words">
          <span className="font-medium text-foreground">{p.title}.</span> {summary}
          {factsMoved && <span className="italic"> (at planning time)</span>}
        </span>
      </li>
    );
  }

  return (
    <li className="rounded-lg border border-border">
      <div className="flex items-center gap-2 px-2 py-1.5">
        {onToggle && p.decision === "pending" && <input type="checkbox" aria-label={`Include: ${p.title}`} checked={checked} onChange={onToggle} className="size-4 shrink-0 accent-[var(--accent)]" />}
        <button type="button" aria-expanded={open} aria-controls={rowId} onClick={() => setOpen((v) => !v)} className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 rounded-md text-left sm:flex-nowrap">
          <Chevron />
          <span className="min-w-[60%] flex-1 basis-0">
            <span className={`block text-sm font-medium ${open ? "" : "line-clamp-2 sm:truncate"}`}>{p.title}</span>
            {summary && <span className="block truncate text-xs text-muted">{summary}</span>}
          </span>
          <span className="flex shrink-0 flex-wrap items-center gap-1 pl-5 sm:pl-0">
            {p.cost && (
              <>
                <CostBadge status={p.cost.status} />
                <span className="text-xs tabular-nums">{formatDelta(p.cost.deltaCents)}</span>
              </>
            )}
            {showOutcome ? outcomeBadge(p, task, action) : SENDS.has(p.kind) ? <Badge tone="info">{KIND_LABEL[p.kind]}</Badge> : p.conditional ? <Badge tone="warn">Later</Badge> : null}
          </span>
        </button>
      </div>
      {open && (
        <div id={rowId} className="space-y-2 border-t border-border px-3 py-2">
          <ProposalBody p={p} snap={snap} />
          <p className="text-[11px] text-muted">{p.rationale}</p>
          {p.external && <p className="text-[11px] text-info">Leaves Ripple: sent to an outside party once approved.</p>}
          {blockedBy.length > 0 && <p className="text-[11px] text-warn">Runs only after: {blockedBy.join("; ")}</p>}
          {p.waitsFor && p.kind !== "wait" && task?.status !== "succeeded" && <p className="text-[11px] text-warn">Held until: {wf.waits.find((w) => w.condition === p.waitsFor)?.description ?? "the external condition is met"}.</p>}
          {p.decisionReason && <p className="text-[11px] text-muted">{p.decisionReason}</p>}
          {task?.detail && task.status !== "waiting_approval" && <p className={`text-[11px] ${task.status === "failed" ? "text-danger" : "text-muted"}`}>{task.detail}</p>}
          {action && (
            <p className="text-[11px] text-muted">
              {action.simulated ? "Simulated send" : "Live send"} · {action.state}
              {action.receipt && typeof action.receipt.providerMessageId === "string" ? ` · receipt ${action.receipt.providerMessageId}` : ""}
              {action.attempts > 1 ? ` · ${action.attempts} attempts` : ""}
              {action.error ? ` · ${action.error}` : ""}
            </p>
          )}
          <EvidenceList evidence={p.evidence} snap={snap} />
          {children}
        </div>
      )}
      {!open && children && <div className="border-t border-border px-3 py-1.5">{children}</div>}
    </li>
  );
}

function groupByArea(props: Proposal[]) {
  const groups = new Map<AreaId, Proposal[]>();
  for (const a of AREAS) {
    const list = props.filter((p) => p.area === a.id);
    if (list.length) groups.set(a.id, list);
  }
  return groups;
}

function WorkflowDetail({ snap, wf, refresh }: { snap: ProjectSnapshot; wf: WorkflowView; refresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showChecks, setShowChecks] = useState(false);
  const [showMeta, setShowMeta] = useState(false);
  const [walking, setWalking] = useState(() => isFresh(wf));
  const settle = useCallback(() => setWalking(false), []);
  const pending = useMemo(() => wf.proposals.filter((p) => p.decision === "pending"), [wf.proposals]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const included = useMemo(() => new Set(pending.filter((p) => !excluded.has(p.id)).map((p) => p.id)), [pending, excluded]);

  const byKey = new Map(wf.proposals.map((p) => [p.id, p]));
  const titleOf = (id: string) => byKey.get(id)?.title ?? id;

  async function call(fn: () => Promise<unknown>, fallback: string) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : fallback);
    } finally {
      setBusy(false);
    }
  }

  const review = () => call(() => api(`/api/workflows/${wf.id}/review`, { json: { decisions: pending.map((p) => ({ proposalId: p.id, decision: included.has(p.id) ? "approve" : "reject" })) } }), "Review failed");
  const answer = (id: string, value: string) => call(() => api(`/api/workflows/${wf.id}/clarify`, { json: { answers: { [id]: value } } }), "Could not send the answer");
  const retry = (taskId: string) => call(() => api(`/api/workflows/${wf.id}/retry`, { json: { taskId } }), "Retry failed");
  const manualDone = (actionId: string) => call(() => api(`/api/actions/${actionId}`, { json: {} }), "Could not mark done");

  const checks = wf.proposals.filter((p) => p.kind === "check");
  const effects = wf.proposals.filter((p) => p.kind !== "check" && p.kind !== "wait");
  const reviewing = wf.status === "ready_for_review";
  const outcomeStage = ["executing", "waiting_external", "partially_complete", "completed", "superseded"].includes(wf.status);
  const reviewGroups = groupByArea(pending.filter((p) => p.kind !== "wait" && p.kind !== "check"));
  const pendingChecks = checks.filter((p) => p.decision === "pending" || !outcomeStage);
  const sends = pending.filter((p) => included.has(p.id) && SENDS.has(p.kind)).length;
  const updates = included.size - sends;
  const skipped = pending.length - included.size;

  return (
    <div className="space-y-3">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={walking ? STATUS_TONE.planning : STATUS_TONE[wf.status]}>{walking ? STATUS_LABEL.planning : STATUS_LABEL[wf.status]}</Badge>
          <p className="min-w-0 flex-1 truncate text-sm" title={wf.request}>
            “{wf.request}”
          </p>
          <button type="button" aria-expanded={showMeta} onClick={() => setShowMeta((v) => !v)} className="text-xs text-muted hover:underline">
            {showMeta ? "Less" : "Details"}
          </button>
        </div>
        {showMeta && (
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
            <Badge tone="neutral">from {AREA_BY_ID[wf.area as AreaId]?.short ?? wf.area}</Badge>
            <Badge tone={wf.interpretationMode === "llm" ? "accent" : "info"} title={wf.interpretationMode === "llm" ? "Interpreted by the configured language model; consequences computed deterministically." : "No model key configured: a deterministic, rule-based interpreter read this request."}>
              {wf.interpretationMode === "llm" ? "Model reasoning" : "Demo reasoning"}
            </Badge>
            <span>
              {formatTime(wf.createdAt)} · project rev {wf.projectRevision}
            </span>
            {wf.summary && <p className="w-full">{wf.summary}</p>}
          </div>
        )}
        {wf.error && (
          <p role="alert" className="mt-1 text-xs text-danger">
            {wf.error}
          </p>
        )}
      </div>

      {walking || wf.status === "planning" ? (
        <FollowingPath wf={wf} onSettled={settle} />
      ) : (
        <>
          <ProgressPath wf={wf} />

      {wf.status === "needs_input" && wf.clarification && (
        <div className="space-y-3 rounded-lg border border-warn/40 bg-warn-soft/40 p-3">
          {wf.clarification.map((q) => (
            <ClarificationQuestion key={q.id} q={q} disabled={busy} onAnswer={(v) => answer(q.id, v)} />
          ))}
        </div>
      )}

      {pendingChecks.length > 0 && !outcomeStage && (
        <div>
          <button type="button" aria-expanded={showChecks} onClick={() => setShowChecks((v) => !v)} className="flex items-center gap-1 text-xs text-muted hover:underline">
            <Chevron />
            {pendingChecks.length} checks against your sources
            {pendingChecks.some((c) => c.target.type === "check" && c.target.severity === "warning") && <Badge tone="warn">{pendingChecks.filter((c) => c.target.type === "check" && c.target.severity === "warning").length} warning</Badge>}
          </button>
          {showChecks && (
            <ul className="mt-1 space-y-0.5">
              {pendingChecks.map((p) => (
                <ProposalRow key={p.id} p={p} wf={wf} snap={snap} blockedBy={[]} />
              ))}
            </ul>
          )}
        </div>
      )}

      {(reviewing || (outcomeStage && pending.length > 0)) && reviewGroups.size > 0 && (
        <div>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">{outcomeStage ? "New items to review" : "Here’s what follows"}</h3>
            <span className="flex gap-1 text-xs">
              <button type="button" className="text-muted hover:underline" onClick={() => setExcluded(new Set())}>
                Select all
              </button>
              <span className="text-muted">·</span>
              <button type="button" className="text-muted hover:underline" onClick={() => setExcluded(new Set(pending.map((p) => p.id)))}>
                None
              </button>
            </span>
          </div>
          <div className="space-y-3">
            {[...reviewGroups.entries()].map(([area, list]) => (
              <div key={area}>
                <h4 className="mb-1 text-xs font-semibold text-muted">{AREA_BY_ID[area].title}</h4>
                <ul className="space-y-1">
                  {list.map((p) => (
                    <ProposalRow
                      key={p.id}
                      p={p}
                      wf={wf}
                      snap={snap}
                      checked={included.has(p.id)}
                      onToggle={() =>
                        setExcluded((s) => {
                          const n = new Set(s);
                          if (n.has(p.id)) n.delete(p.id);
                          else n.add(p.id);
                          return n;
                        })
                      }
                      blockedBy={p.requires.filter((r) => byKey.get(r)?.kind !== "check").map(titleOf)}
                    />
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={review} disabled={busy || pending.length === 0}>
              {busy ? "Submitting…" : included.size === 0 ? "Skip everything" : `Apply ${updates} update${updates === 1 ? "" : "s"}${sends ? ` · send ${sends} message${sends === 1 ? "" : "s"}` : ""}`}
            </Button>
            <span className="text-xs text-muted">{skipped ? `${skipped} skipped. ` : ""}Anything depending on a skipped item is held, not sent.</span>
          </div>
          {wf.waits.length > 0 && !outcomeStage && <p className="mt-2 text-xs text-warn">Then Ripple waits for {wf.waits.map((w) => w.description).join(" and ")} and picks this up when the reply arrives.</p>}
        </div>
      )}

      {outcomeStage && <OutcomeReport wf={wf} snap={snap} effects={effects} checks={checks} onRetry={retry} onManualDone={manualDone} busy={busy} />}

      {err && (
        <p role="alert" className="text-sm text-danger">
          {err}
        </p>
      )}
        </>
      )}
    </div>
  );
}

function ClarificationQuestion({ q, disabled, onAnswer }: { q: { id: string; question: string; options?: string[] }; disabled: boolean; onAnswer: (v: string) => void }) {
  const [free, setFree] = useState("");
  return (
    <div>
      <p className="text-sm font-medium">{q.question}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {q.options?.map((o) => (
          <Button key={o} disabled={disabled} onClick={() => onAnswer(o)}>
            {o}
          </Button>
        ))}
      </div>
      {q.id === "rephrase" && (
        <form
          className="mt-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (free.trim()) onAnswer(free.trim());
          }}
        >
          <input aria-label="Rephrase your request" value={free} onChange={(e) => setFree(e.target.value)} className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm" placeholder="Rephrase the request" />
          <Button type="submit" disabled={disabled || !free.trim()}>
            Send
          </Button>
        </form>
      )}
    </div>
  );
}

function OutcomeReport({ wf, snap, effects, checks, onRetry, onManualDone, busy }: { wf: WorkflowView; snap: ProjectSnapshot; effects: Proposal[]; checks: Proposal[]; onRetry: (taskId: string) => void; onManualDone: (id: string) => void; busy: boolean }) {
  const [showChecks, setShowChecks] = useState(false);
  const groups: { title: string; tone: Tone; items: Proposal[] }[] = [
    { title: "Completed", tone: "accent", items: effects.filter((p) => taskFor(wf, p)?.status === "succeeded") },
    { title: "Waiting", tone: "warn", items: [...wf.proposals.filter((p) => p.kind === "wait" && taskFor(wf, p)?.status === "waiting_external"), ...effects.filter((p) => ["waiting_external", "queued", "running"].includes(taskFor(wf, p)?.status ?? "") && p.decision === "approved")] },
    { title: "Needs attention", tone: "danger", items: effects.filter((p) => taskFor(wf, p)?.status === "failed" || p.decision === "stale") },
    { title: "Skipped", tone: "neutral", items: effects.filter((p) => ["skipped", "blocked", "superseded"].includes(taskFor(wf, p)?.status ?? "") || ["rejected", "withdrawn"].includes(p.decision)) },
  ];
  return (
    <div className="space-y-3">
      {groups.map((g) =>
        g.items.length ? (
          <div key={g.title}>
            <h3 className="mb-1 flex items-center gap-2 text-xs font-semibold text-muted">
              <Badge tone={g.tone}>{g.items.length}</Badge> {g.title}
            </h3>
            <ul className="space-y-1">
              {g.items.map((p) => {
                const task = taskFor(wf, p);
                const action = wf.actions.find((a) => a.proposalId === p.id);
                if (p.kind === "wait") {
                  return (
                    <li key={p.id} className="flex items-center gap-2 rounded-lg border border-warn/40 bg-warn-soft/40 px-2 py-1.5 text-sm">
                      <span aria-hidden className="inline-block size-2 rounded-full bg-warn ripple-active" />
                      <span className="min-w-0 flex-1 truncate">{p.title}</span>
                      <Badge tone="warn">Waiting</Badge>
                    </li>
                  );
                }
                const needsAction = task?.status === "failed" || action?.state === "manual_pending";
                return (
                  <ProposalRow key={p.id} p={p} wf={wf} snap={snap} blockedBy={[]} showOutcome>
                    {needsAction && (
                      <div className="flex flex-wrap items-center gap-2">
                        {task?.status === "failed" && (
                          <Button disabled={busy} onClick={() => onRetry(task.id)}>
                            {action?.state === "uncertain" ? "Reconcile & retry" : "Retry"}
                          </Button>
                        )}
                        {action?.state === "manual_pending" && (
                          <Button disabled={busy} onClick={() => onManualDone(action.id)}>
                            Mark done manually
                          </Button>
                        )}
                        {task?.detail && <span className="text-[11px] text-danger">{task.detail}</span>}
                      </div>
                    )}
                  </ProposalRow>
                );
              })}
            </ul>
          </div>
        ) : null,
      )}
      {checks.length > 0 && (
        <div>
          <button type="button" aria-expanded={showChecks} onClick={() => setShowChecks((v) => !v)} className="flex items-center gap-1 text-xs text-muted hover:underline">
            <Chevron />
            {checks.length} checks recorded during planning
          </button>
          {showChecks && (
            <ul className="mt-1 space-y-0.5">
              {checks.map((p) => (
                <ProposalRow key={p.id} p={p} wf={wf} snap={snap} blockedBy={[]} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
