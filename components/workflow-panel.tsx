"use client";

import { useMemo, useState } from "react";
import type { ProjectSnapshot, WorkflowView } from "@/lib/api/snapshot";
import type { EvidenceRef, Proposal, Task, WorkflowStage } from "@/lib/db/schema";
import { AREAS, AREA_BY_ID, type AreaId } from "@/lib/domain/areas";
import { formatFactValue, humanFactKey } from "@/lib/domain/facts";
import { formatCents, formatDelta } from "@/lib/domain/money";
import { api } from "./api";
import { Badge, Button, Card, CostBadge, Empty, SectionTitle, Spinner, formatTime, type Tone } from "./ui";

const PATH: { stage: WorkflowStage; title: string }[] = [
  { stage: "understand", title: "Understand change" },
  { stage: "check_sources", title: "Check sources" },
  { stage: "follow_consequences", title: "Follow consequences" },
  { stage: "prepare_updates", title: "Prepare updates" },
  { stage: "review", title: "Ready to review" },
];

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

const STATUS_LABEL: Record<string, string> = {
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

export function WorkflowPanel({ snap, workflow, refresh, onSelectWorkflow }: { snap: ProjectSnapshot; workflow: WorkflowView | null; refresh: () => Promise<void>; onSelectWorkflow: (id: string) => void }) {
  return (
    <Card aria-live="polite" aria-labelledby="wf-title">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 id="wf-title" className="text-sm font-semibold uppercase tracking-wide text-muted">
          Change in progress
        </h2>
        {snap.workflows.length > 0 && (
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

function stageState(wf: WorkflowView, stage: WorkflowStage): "done" | "active" | "todo" | "failed" {
  const t = wf.tasks.find((x) => x.kind === "stage" && x.stage === stage);
  if (!t) return "todo";
  if (t.status === "succeeded") return "done";
  if (t.status === "failed") return "failed";
  if (t.status === "running") return "active";
  return "todo";
}

function ProgressPath({ wf }: { wf: WorkflowView }) {
  const past = ["executing", "waiting_external", "partially_complete", "completed"].includes(wf.status);
  return (
    <ol aria-label="Progress" className="grid grid-cols-5 gap-1 text-[11px] sm:text-xs">
      {PATH.map((p, i) => {
        const st = stageState(wf, p.stage);
        const done = st === "done" || (past && p.stage === "review");
        const active = st === "active" || (wf.status === "ready_for_review" && p.stage === "review") || (wf.status === "needs_input" && p.stage === "understand");
        const task = wf.tasks.find((x) => x.kind === "stage" && x.stage === p.stage);
        return (
          <li key={p.stage} className="flex flex-col gap-1" aria-current={active ? "step" : undefined}>
            <div className="flex items-center gap-1">
              <span aria-hidden className={`inline-block size-2.5 rounded-full ${done ? "bg-accent" : active ? "bg-info ripple-active" : st === "failed" ? "bg-danger" : "bg-border"}`} />
              {i < PATH.length - 1 && <span aria-hidden className={`h-px flex-1 ${done ? "bg-accent" : "bg-border"}`} />}
            </div>
            <span className={`${done || active ? "font-medium" : "text-muted"}`}>{p.title}</span>
            {task?.detail && <span className="text-muted">{task.detail}</span>}
          </li>
        );
      })}
    </ol>
  );
}

function EvidenceList({ evidence, snap }: { evidence: EvidenceRef[]; snap: ProjectSnapshot }) {
  if (!evidence.length) return null;
  return (
    <ul className="mt-1 space-y-0.5">
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

function ProposalBody({ p }: { p: Proposal }) {
  const t = p.target;
  switch (t.type) {
    case "fact": {
      const unwrap = (v: unknown) => (v && typeof v === "object" && "value" in (v as Record<string, unknown>) ? (v as { value: unknown }).value : v);
      return (
        <p className="text-xs">
          {humanFactKey(t.key)}: <s className="text-muted">{formatFactValue(t.key, unwrap(p.before))}</s> → <strong>{formatFactValue(t.key, unwrap(p.after))}</strong>
        </p>
      );
    }
    case "email":
      return (
        <details className="text-xs">
          <summary className="cursor-pointer">
            To {t.to.map((r) => `${r.name} <${r.email}>`).join(", ")} · “{t.subject}”
          </summary>
          <pre className="mt-1 whitespace-pre-wrap rounded bg-background p-2 font-sans">{t.body}</pre>
        </details>
      );
    case "staff_notice":
      return (
        <details className="text-xs">
          <summary className="cursor-pointer">To {t.recipients.length} staff</summary>
          <pre className="mt-1 whitespace-pre-wrap rounded bg-background p-2 font-sans">{t.text}</pre>
        </details>
      );
    case "invitation":
      return (
        <details className="text-xs">
          <summary className="cursor-pointer">
            {t.audience} · {t.recipientCount} recipients
          </summary>
          <pre className="mt-1 whitespace-pre-wrap rounded bg-background p-2 font-sans">{t.text}</pre>
        </details>
      );
    case "file":
      return (
        <details className="text-xs">
          <summary className="cursor-pointer font-mono">{t.path}</summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-background p-2 font-mono text-[11px]">{t.content}</pre>
        </details>
      );
    case "budget_line": {
      const after = p.after as { label?: string; subtotalCents?: number | null; commitmentStatus?: string } | null;
      const before = p.before as { subtotalCents?: number | null } | null;
      return (
        <p className="text-xs">
          {after?.label ?? t.category}: {before ? formatCents(before.subtotalCents) : "—"} → {formatCents(after?.subtotalCents)}
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

const DECISION_TONE: Record<string, Tone> = { pending: "info", approved: "accent", applied: "accent", rejected: "neutral", stale: "danger", withdrawn: "neutral" };

function taskFor(wf: WorkflowView, p: Proposal): Task | undefined {
  return wf.tasks.find((t) => t.id === p.taskId);
}

function ProposalRow({ p, wf, snap, checked, onToggle, blockedBy, as: Tag = "li" }: { p: Proposal; wf: WorkflowView; snap: ProjectSnapshot; checked?: boolean; onToggle?: () => void; blockedBy: string[]; as?: "li" | "div" }) {
  const task = taskFor(wf, p);
  const isCheck = p.kind === "check";
  const severity = p.target.type === "check" ? p.target.severity : undefined;
  return (
    <Tag className={`rounded-lg border p-2 ${isCheck ? (severity === "warning" ? "border-warn/40 bg-warn-soft/40" : "border-border/60 bg-background/60") : "border-border"}`}>
      <div className="flex items-start gap-2">
        {onToggle && p.decision === "pending" && (
          <input type="checkbox" aria-label={`Include: ${p.title}`} checked={checked} onChange={onToggle} className="mt-1 size-4 accent-[var(--accent)]" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-sm font-medium">{p.title}</span>
            {isCheck ? <Badge tone={severity === "warning" ? "warn" : "neutral"}>{severity === "warning" ? "warning" : "checked"}</Badge> : p.kind === "wait" ? <Badge tone="warn">wait</Badge> : <Badge tone={DECISION_TONE[p.decision]}>{p.decision}</Badge>}
            {p.external && <Badge tone="info">leaves Ripple</Badge>}
            {p.conditional && <Badge tone="warn">conditional</Badge>}
            {p.cost && (
              <span className="inline-flex items-center gap-1">
                <CostBadge status={p.cost.status} />
                <span className="text-xs">{formatDelta(p.cost.deltaCents)}</span>
              </span>
            )}
            {task && task.status !== "waiting_approval" && task.status !== "queued" && <Badge tone={task.status === "succeeded" ? "accent" : task.status === "failed" ? "danger" : task.status === "waiting_external" ? "warn" : "neutral"}>{task.status.replace("_", " ")}</Badge>}
          </div>
          <ProposalBody p={p} />
          {!isCheck && <p className="mt-1 text-[11px] text-muted">{p.rationale}</p>}
          {blockedBy.length > 0 && <p className="text-[11px] text-warn">Runs only after: {blockedBy.join("; ")}</p>}
          {p.waitsFor && p.kind !== "wait" && task?.status !== "succeeded" && <p className="text-[11px] text-warn">Held until: {wf.waits.find((w) => w.condition === p.waitsFor)?.description ?? "the external condition is met"}.</p>}
          {p.decisionReason && <p className="text-[11px] text-muted">{p.decisionReason}</p>}
          {task?.detail && task.status !== "waiting_approval" && <p className={`text-[11px] ${task.status === "failed" ? "text-danger" : "text-muted"}`}>{task.detail}</p>}
          <EvidenceList evidence={p.evidence} snap={snap} />
        </div>
      </div>
    </Tag>
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
  const pending = useMemo(() => wf.proposals.filter((p) => p.decision === "pending"), [wf.proposals]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const included = useMemo(() => new Set(pending.filter((p) => !excluded.has(p.id)).map((p) => p.id)), [pending, excluded]);

  const byKey = new Map(wf.proposals.map((p) => [p.id, p]));
  const titleOf = (id: string) => byKey.get(id)?.title ?? id;

  async function review() {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/workflows/${wf.id}/review`, { json: { decisions: pending.map((p) => ({ proposalId: p.id, decision: included.has(p.id) ? "approve" : "reject" })) } });
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Review failed");
    } finally {
      setBusy(false);
    }
  }

  async function answer(id: string, value: string) {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/workflows/${wf.id}/clarify`, { json: { answers: { [id]: value } } });
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not send the answer");
    } finally {
      setBusy(false);
    }
  }

  async function retry(taskId: string) {
    setBusy(true);
    try {
      await api(`/api/workflows/${wf.id}/retry`, { json: { taskId } });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function manualDone(actionId: string) {
    setBusy(true);
    try {
      await api(`/api/actions/${actionId}`, { json: {} });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  const checks = wf.proposals.filter((p) => p.kind === "check");
  const effects = wf.proposals.filter((p) => p.kind !== "check" && p.kind !== "wait");
  const reviewing = wf.status === "ready_for_review";
  const outcomeStage = ["executing", "waiting_external", "partially_complete", "completed", "superseded"].includes(wf.status);
  const groups = groupByArea(reviewing ? wf.proposals.filter((p) => p.kind !== "wait") : checks);

  return (
    <div className="space-y-4">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={STATUS_TONE[wf.status]}>{STATUS_LABEL[wf.status]}</Badge>
          <Badge tone="neutral">from {AREA_BY_ID[wf.area as AreaId]?.short ?? wf.area}</Badge>
          <Badge tone={wf.interpretationMode === "llm" ? "accent" : "info"} title={wf.interpretationMode === "llm" ? "Interpreted by the configured language model; consequences computed deterministically." : "No model key configured: a deterministic, rule-based interpreter read this request."}>
            {wf.interpretationMode === "llm" ? "Model reasoning" : "Demo reasoning"}
          </Badge>
          <span className="text-xs text-muted">{formatTime(wf.createdAt)} · project rev {wf.projectRevision}</span>
        </div>
        <p className="mt-1 text-sm">“{wf.request}”</p>
        {wf.summary && <p className="text-xs text-muted">{wf.summary}</p>}
        {wf.error && (
          <p role="alert" className="mt-1 text-xs text-danger">
            {wf.error}
          </p>
        )}
      </div>

      <ProgressPath wf={wf} />

      {wf.status === "planning" && <Spinner label="Ripple is working through the consequences…" />}

      {wf.status === "needs_input" && wf.clarification && (
        <div className="space-y-3 rounded-lg border border-warn/40 bg-warn-soft/40 p-3">
          {wf.clarification.map((q) => (
            <ClarificationQuestion key={q.id} q={q} disabled={busy} onAnswer={(v) => answer(q.id, v)} />
          ))}
        </div>
      )}

      {(reviewing || wf.status === "needs_input" || wf.status === "planning") && groups.size > 0 && (
        <div>
          <SectionTitle
            right={
              reviewing && pending.length > 0 ? (
                <span className="flex gap-1">
                  <Button variant="ghost" onClick={() => setExcluded(new Set())}>
                    Include all
                  </Button>
                  <Button variant="ghost" onClick={() => setExcluded(new Set(pending.map((p) => p.id)))}>
                    Skip all
                  </Button>
                </span>
              ) : undefined
            }
          >
            {reviewing ? "Review report" : "Checks so far"}
          </SectionTitle>
          <div className="space-y-3">
            {[...groups.entries()].map(([area, list]) => (
              <div key={area}>
                <h3 className="mb-1 text-xs font-semibold text-muted">{AREA_BY_ID[area].title}</h3>
                <ul className="space-y-1.5">
                  {list.map((p) => (
                    <ProposalRow key={p.id} p={p} wf={wf} snap={snap} checked={included.has(p.id)} onToggle={() => setExcluded((s) => { const n = new Set(s); if (n.has(p.id)) n.delete(p.id); else n.add(p.id); return n; })} blockedBy={p.requires.filter((r) => byKey.get(r)?.kind !== "check").map(titleOf)} />
                  ))}
                </ul>
              </div>
            ))}
          </div>
          {reviewing && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button variant="primary" onClick={review} disabled={busy || pending.length === 0}>
                {busy ? "Submitting…" : `Apply ${included.size} of ${pending.length}${pending.length - included.size ? `, skip ${pending.length - included.size}` : ""}`}
              </Button>
              <span className="text-xs text-muted">Skipped items are not applied; anything that depends on them is blocked rather than sent. Approvals are re-checked against current facts before applying.</span>
            </div>
          )}
          {wf.waits.length > 0 && (
            <p className="mt-2 text-xs text-warn">
              After sending, Ripple will wait for {wf.waits.map((w) => w.description).join(" and ")} and resume this same change when the reply arrives.
            </p>
          )}
        </div>
      )}

      {outcomeStage && <OutcomeReport wf={wf} snap={snap} effects={effects} checks={checks} onRetry={retry} onManualDone={manualDone} busy={busy} />}

      {err && (
        <p role="alert" className="text-sm text-danger">
          {err}
        </p>
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
          <input aria-label="Rephrase your request" value={free} onChange={(e) => setFree(e.target.value)} className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm" placeholder="Rephrase the request" />
          <Button type="submit" disabled={disabled || !free.trim()}>
            Send
          </Button>
        </form>
      )}
    </div>
  );
}

function OutcomeReport({ wf, snap, effects, checks, onRetry, onManualDone, busy }: { wf: WorkflowView; snap: ProjectSnapshot; effects: Proposal[]; checks: Proposal[]; onRetry: (taskId: string) => void; onManualDone: (id: string) => void; busy: boolean }) {
  const groups: { title: string; tone: Tone; items: Proposal[] }[] = [
    { title: "Completed", tone: "accent", items: effects.filter((p) => taskFor(wf, p)?.status === "succeeded") },
    { title: "Waiting", tone: "warn", items: [...wf.proposals.filter((p) => p.kind === "wait" && taskFor(wf, p)?.status === "waiting_external"), ...effects.filter((p) => ["waiting_external", "queued", "running"].includes(taskFor(wf, p)?.status ?? "") && p.decision === "approved")] },
    { title: "Needs attention", tone: "danger", items: effects.filter((p) => taskFor(wf, p)?.status === "failed" || p.decision === "stale") },
    { title: "Skipped", tone: "neutral", items: effects.filter((p) => ["skipped", "blocked", "superseded"].includes(taskFor(wf, p)?.status ?? "") || ["rejected", "withdrawn"].includes(p.decision)) },
  ];
  const pending = effects.filter((p) => p.decision === "pending");
  return (
    <div>
      <SectionTitle>Outcome report</SectionTitle>
      <div className="space-y-3">
        {groups.map((g) =>
          g.items.length ? (
            <div key={g.title}>
              <h3 className="mb-1 flex items-center gap-2 text-xs font-semibold text-muted">
                <Badge tone={g.tone}>{g.items.length}</Badge> {g.title}
              </h3>
              <ul className="space-y-1.5">
                {g.items.map((p) => {
                  const task = taskFor(wf, p);
                  const action = wf.actions.find((a) => a.proposalId === p.id);
                  return (
                    <li key={p.id}>
                      <ProposalRow p={p} wf={wf} snap={snap} blockedBy={[]} as="div" />
                      {action && (
                        <p className="ml-2 mt-0.5 text-[11px] text-muted">
                          {action.simulated ? "Simulated send" : "Live send"} · {action.state}
                          {action.receipt && typeof action.receipt.providerMessageId === "string" ? ` · receipt ${action.receipt.providerMessageId}` : ""}
                          {action.attempts > 1 ? ` · ${action.attempts} attempts` : ""}
                          {action.error ? ` · ${action.error}` : ""}
                        </p>
                      )}
                      {task?.status === "failed" && (
                        <div className="ml-2 mt-1">
                          <Button disabled={busy} onClick={() => onRetry(task.id)}>
                            {action?.state === "uncertain" ? "Reconcile & retry" : "Retry"}
                          </Button>
                        </div>
                      )}
                      {action?.state === "manual_pending" && (
                        <div className="ml-2 mt-1">
                          <Button disabled={busy} onClick={() => onManualDone(action.id)}>
                            Mark done manually
                          </Button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null,
        )}
        {pending.length > 0 && <p className="text-xs text-muted">{pending.length} more item(s) became reviewable after a reply arrived — see the review report above.</p>}
        {checks.length > 0 && (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted">{checks.length} checks recorded during planning</summary>
            <ul className="mt-1 space-y-1">
              {checks.map((p) => (
                <ProposalRow key={p.id} p={p} wf={wf} snap={snap} blockedBy={[]} />
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}
