import { and, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import * as s from "@/lib/db/schema";
import { hashContent, newId, now } from "@/lib/domain/ids";
import { addMinutes } from "@/lib/domain/projections";
import { enqueueJob } from "@/lib/jobs/queue";
import { loadProjectContext, contextSummary, vocabulary, type ProjectContext } from "@/lib/planner/context";
import type { ChangeIntent } from "@/lib/planner/intent";
import { interpretRequest } from "@/lib/planner/interpret";
import { planConsequences, suppressionKeyFor } from "@/lib/planner/plan";
import type { ProposalDraft } from "@/lib/planner/types";
import { emailAdapterFor, isFixtureAddress } from "@/lib/integrations/email";
import { fileAdapterFor, invitationAdapterFor } from "@/lib/integrations/files";
import { appendEvent, bumpProjectRevision } from "./events";

const STAGES: { stage: s.WorkflowStage; title: string }[] = [
  { stage: "understand", title: "Understand change" },
  { stage: "check_sources", title: "Check sources" },
  { stage: "follow_consequences", title: "Follow consequences" },
  { stage: "prepare_updates", title: "Prepare updates" },
  { stage: "review", title: "Ready to review" },
];

// ---------------------------------------------------------------------------
// Creation & planning
// ---------------------------------------------------------------------------

export function createWorkflow(db: Db, input: { projectId: string; area: string; request: string; trigger?: s.Workflow["trigger"]; parentId?: string }): s.Workflow {
  const project = db.select().from(s.projects).where(eq(s.projects.id, input.projectId)).get();
  if (!project) throw new Error("project not found");
  const t = now();
  const wf: s.Workflow = {
    id: newId("wf"),
    projectId: input.projectId,
    area: input.area,
    request: input.request.trim(),
    intent: null,
    interpretationMode: "demo",
    projectRevision: project.revision,
    status: "planning",
    stage: "understand",
    trigger: input.trigger ?? { type: "user" },
    parentId: input.parentId ?? null,
    clarification: null,
    answers: {},
    summary: null,
    error: null,
    createdAt: t,
    updatedAt: t,
  };
  db.insert(s.workflows).values(wf).run();
  STAGES.forEach((st, i) => {
    db.insert(s.tasks).values({ id: newId("task"), workflowId: wf.id, kind: "stage", title: st.title, stage: st.stage, input: null, dependsOn: [], status: i === 0 ? "running" : "queued", attempts: 0, external: false, result: null, detail: null, sortOrder: i, updatedAt: t }).run();
  });
  appendEvent(db, wf.projectId, wf.id, "workflow.created", `Request captured from the ${input.area} area at project revision ${project.revision}.`, { stage: "understand", data: { request: wf.request } });
  enqueueJob(db, "workflow.plan", { workflowId: wf.id }, { idempotencyKey: `plan:${wf.id}:1` });
  return wf;
}

function setStageTask(db: Db, workflowId: string, stage: s.WorkflowStage, status: s.TaskStatus, detail?: string, result?: unknown) {
  db.update(s.tasks).set({ status, detail: detail ?? null, result: result ?? null, updatedAt: now() }).where(and(eq(s.tasks.workflowId, workflowId), eq(s.tasks.kind, "stage"), eq(s.tasks.stage, stage))).run();
}

function setWorkflow(db: Db, id: string, patch: Partial<s.Workflow>) {
  db.update(s.workflows).set({ ...patch, updatedAt: now() }).where(eq(s.workflows.id, id)).run();
}

export function getWorkflow(db: Db, id: string): s.Workflow | undefined {
  return db.select().from(s.workflows).where(eq(s.workflows.id, id)).get();
}

function applyAnswers(intent: ChangeIntent, answers: Record<string, string>): ChangeIntent {
  if (!Object.keys(answers).length) return intent;
  const changes = intent.requestedChanges.map((c) => {
    if (c.op === "cancel_vendor" && answers[`cancel_${c.vendorRef}`]) return { ...c, vendorRef: answers[`cancel_${c.vendorRef}`] };
    if (c.op === "request_quote" && answers[`quote_${c.vendorRef}`]) return { ...c, vendorRef: answers[`quote_${c.vendorRef}`] };
    if (c.op === "set_venue") return { ...c, venueRef: answers.venue ?? c.venueRef, roomRef: answers.venue_room ?? c.roomRef };
    if (c.op === "staff_unavailable" && answers.staff_name && !c.names?.length) return { ...c, names: [answers.staff_name], count: 1 };
    return c;
  });
  if (answers.staff_name && !changes.some((c) => c.op === "staff_unavailable")) {
    changes.push({ op: "staff_unavailable", count: 1, names: [answers.staff_name], certainty: "explicit" });
  }
  return { ...intent, requestedChanges: changes.filter((c) => c.op !== "unsupported" || changes.length === 1), questions: [] };
}

function intentFactKeys(intent: ChangeIntent): string[] {
  const keys: string[] = [];
  for (const c of intent.requestedChanges) {
    if (c.op === "set_attendance") keys.push("attendance.expected");
    else if (c.op === "set_budget_ceiling") keys.push("budget.ceiling_cents");
    else if (c.op === "set_date") keys.push("event.date");
    else if (c.op === "set_format") keys.push("event.format");
    else if (c.op === "set_time" || c.op === "shift_schedule") keys.push(c.item === "dinner" ? "schedule.dinner_start" : "event.time");
  }
  return keys;
}

/** Runs the planning pipeline for a workflow. Safe to re-run: existing pending proposals of this workflow are replaced. */
export async function planWorkflow(db: Db, workflowId: string): Promise<void> {
  const wf = getWorkflow(db, workflowId);
  if (!wf) throw new Error("workflow not found");
  if (!["planning", "needs_input"].includes(wf.status)) return;
  const ctx = loadProjectContext(db, wf.projectId);
  const t0 = now();

  // 1. understand
  setWorkflow(db, wf.id, { status: "planning", stage: "understand", error: null });
  setStageTask(db, wf.id, "understand", "running");
  const interpretation = await interpretRequest(wf.request, vocabulary(ctx), { summary: contextSummary(ctx) });
  const intent = applyAnswers(interpretation.intent, wf.answers);
  const supported = intent.requestedChanges.filter((c) => c.op !== "unsupported");
  const unsupported = intent.requestedChanges.filter((c) => c.op === "unsupported");
  setWorkflow(db, wf.id, { intent, interpretationMode: interpretation.mode });
  setStageTask(db, wf.id, "understand", "succeeded", `${interpretation.mode === "llm" ? "LLM" : "Demo"} reasoning: ${intent.summary}`, { mode: interpretation.mode, note: interpretation.note });
  appendEvent(db, wf.projectId, wf.id, "stage.understand", `${interpretation.mode === "llm" ? "Interpreted with the configured model" : "Interpreted with demo reasoning"}: ${intent.summary}`, { stage: "understand", data: { changes: intent.requestedChanges, note: interpretation.note } });

  if (!supported.length && intent.questions.length) {
    for (const st of ["follow_consequences", "prepare_updates", "review"] as s.WorkflowStage[]) setStageTask(db, wf.id, st, "skipped");
    setWorkflow(db, wf.id, { status: "needs_input", stage: "check_sources", clarification: intent.questions, summary: intent.questions.map((q) => q.question).join(" ") });
    appendEvent(db, wf.projectId, wf.id, "workflow.needs_input", intent.questions.map((q) => q.question).join(" "), { stage: "check_sources" });
    return;
  }
  if (!supported.length) {
    const reason = [...new Set(unsupported.map((u) => (u.op === "unsupported" ? u.reason : "")).filter(Boolean))].join(" ") || "No supported change was recognised.";
    for (const st of ["check_sources", "follow_consequences", "prepare_updates", "review"] as s.WorkflowStage[]) setStageTask(db, wf.id, st, "skipped");
    setWorkflow(db, wf.id, { status: "needs_input", stage: "understand", clarification: [{ id: "rephrase", question: `${reason} Try one of the example prompts, or rephrase in terms of attendance, budget, venue, vendors, schedule, staff or equipment.` }], summary: reason });
    appendEvent(db, wf.projectId, wf.id, "workflow.needs_input", reason, { stage: "understand" });
    return;
  }

  // 2. check sources
  setStageTask(db, wf.id, "check_sources", "running");
  const plan = planConsequences(ctx, intent);
  const docsRead = ctx.documents.filter((d) => d.kind === "source").length;
  const checks = plan.drafts.filter((d) => d.kind === "check");
  setStageTask(db, wf.id, "check_sources", "succeeded", `Read ${docsRead} source documents; ${checks.length} check${checks.length === 1 ? "" : "s"} recorded.`, { checks: checks.map((c) => ({ title: c.title, severity: c.severity })) });
  appendEvent(db, wf.projectId, wf.id, "stage.check_sources", `Checked ${docsRead} documents and ${ctx.recentMessages.length} messages. ${checks.map((c) => c.title).join("; ") || "No issues found."}`, { stage: "check_sources" });

  // clarification needed?
  if (plan.questions.length) {
    for (const st of ["follow_consequences", "prepare_updates", "review"] as s.WorkflowStage[]) setStageTask(db, wf.id, st, "queued");
    setWorkflow(db, wf.id, { status: "needs_input", stage: "check_sources", clarification: plan.questions, summary: plan.questions.map((q) => q.question).join(" ") });
    appendEvent(db, wf.projectId, wf.id, "workflow.needs_input", plan.questions.map((q) => q.question).join(" "), { stage: "check_sources" });
    return;
  }

  // 3. follow consequences
  setStageTask(db, wf.id, "follow_consequences", "running");
  const effect = plan.drafts.filter((d) => !d.informational);
  const areas = [...new Set(effect.map((d) => d.area))];
  setStageTask(db, wf.id, "follow_consequences", "succeeded", `${effect.length} consequence${effect.length === 1 ? "" : "s"} across ${areas.length} area${areas.length === 1 ? "" : "s"}: ${areas.join(", ")}.`);
  appendEvent(db, wf.projectId, wf.id, "stage.follow_consequences", `Followed consequences into ${areas.join(", ") || "no other areas"}.`, { stage: "follow_consequences", data: { changedFactKeys: plan.changedFactKeys } });

  // 4. prepare updates → persist proposals
  setStageTask(db, wf.id, "prepare_updates", "running");
  db.delete(s.proposals).where(and(eq(s.proposals.workflowId, wf.id), inArray(s.proposals.decision, ["pending", "approved", "applied", "withdrawn", "rejected", "stale"]))).run();
  db.delete(s.tasks).where(and(eq(s.tasks.workflowId, wf.id), eq(s.tasks.kind, "proposal"))).run();
  const persisted = persistProposals(db, ctx, wf, plan.drafts, intentFactKeys(intent));
  const external = persisted.filter((p) => p.external && p.decision === "pending").length;
  setStageTask(db, wf.id, "prepare_updates", "succeeded", `${persisted.filter((p) => p.decision === "pending").length} proposals prepared, ${external} needing send approval.`);

  // 5. review
  if (plan.noChange) {
    setStageTask(db, wf.id, "review", "succeeded", "No change needed.");
    setWorkflow(db, wf.id, { status: "completed", stage: "done", summary: `No consequential change: ${plan.notes.join(" ") || "the request matches the current plan."}` });
    appendEvent(db, wf.projectId, wf.id, "workflow.completed", `No change needed. ${plan.notes.join(" ")}`.trim(), { stage: "done" });
    return;
  }
  setStageTask(db, wf.id, "review", "waiting_approval", "Review the proposed updates below.");
  setWorkflow(db, wf.id, { status: "ready_for_review", stage: "review", clarification: null, summary: intent.summary });
  appendEvent(db, wf.projectId, wf.id, "workflow.ready_for_review", `Ready to review: ${persisted.filter((p) => p.decision === "pending").length} proposals (${now() - t0} ms).`, { stage: "review" });
}

export function persistProposals(db: Db, ctx: ProjectContext, wf: s.Workflow, drafts: ProposalDraft[], extraTargetKeys: string[] = []): s.Proposal[] {
  const t = now();
  const keyToId = new Map<string, string>();
  for (const d of drafts) keyToId.set(d.key, newId("prop"));
  const rows: s.Proposal[] = [];
  const otherPending = db.select().from(s.proposals).where(and(eq(s.proposals.projectId, wf.projectId), ne(s.proposals.workflowId, wf.id), inArray(s.proposals.decision, ["pending", "approved"]))).all();
  const rejected = ctx.rejectedProposals;
  let order = 0;
  for (const d of drafts) {
    const factDeps: Record<string, number> = {};
    for (const k of d.factDepKeys) factDeps[k] = ctx.facts[k]?.version ?? 0;
    const docDeps: Record<string, string> = {};
    for (const id of d.docDeps ?? []) {
      const doc = ctx.documents.find((x) => x.id === id);
      if (doc) docDeps[id] = doc.revision ?? String(doc.localRevision);
    }
    const suppressionKey = suppressionKeyFor(d);
    let decision: s.ProposalDecision = d.informational || d.kind === "wait" ? (d.kind === "wait" ? "approved" : "applied") : "pending";
    let decisionReason: string | null = null;
    if (decision === "pending") {
      const prior = rejected.find((r) => r.suppressionKey === suppressionKey && Object.entries(r.factDeps).every(([k, v]) => (ctx.facts[k]?.version ?? 0) === v));
      if (prior) {
        decision = "rejected";
        decisionReason = `Suppressed: you rejected this on ${new Date(prior.updatedAt).toLocaleDateString()} and the underlying facts have not changed.`;
      }
      const dup = otherPending.find((o) => o.suppressionKey === suppressionKey);
      if (dup && !prior) {
        decision = "withdrawn";
        decisionReason = `Already proposed by an earlier request (“${getWorkflow(db, dup.workflowId)?.request ?? dup.workflowId}”).`;
      }
    }
    const row: s.Proposal = {
      id: keyToId.get(d.key)!,
      workflowId: wf.id,
      projectId: wf.projectId,
      taskId: null,
      area: d.area,
      kind: d.kind,
      title: d.title,
      target: d.target,
      before: d.before ?? null,
      after: d.after ?? null,
      rationale: d.rationale,
      evidence: d.evidence,
      factDeps,
      docDeps,
      cost: d.cost,
      requires: d.requires.map((k) => keyToId.get(k)).filter((x): x is string => !!x),
      waitsFor: d.waitsFor ?? null,
      conditional: !!d.conditional,
      external: d.external,
      suppressionKey,
      decision,
      decisionReason,
      appliedAt: decision === "applied" ? t : null,
      sortOrder: order++,
      createdAt: t,
      updatedAt: t,
    };
    db.insert(s.proposals).values(row).run();
    rows.push(row);
    if (!d.informational) {
      const taskId = newId("task");
      db.insert(s.tasks).values({ id: taskId, workflowId: wf.id, kind: "proposal", title: d.title, stage: "apply", input: { proposalId: row.id }, dependsOn: row.requires, status: d.kind === "wait" ? "queued" : "waiting_approval", attempts: 0, external: d.external, result: null, detail: null, sortOrder: 100 + row.sortOrder, updatedAt: t }).run();
      db.update(s.proposals).set({ taskId }).where(eq(s.proposals.id, row.id)).run();
      row.taskId = taskId;
    }
  }
  // Withdraw pending proposals from earlier workflows that this request supersedes (same fact target, different value).
  const targetedFacts = new Set([...drafts.filter((d) => d.kind === "fact" && !d.conditional).map((d) => (d.target as { key: string }).key), ...extraTargetKeys]);
  // A workflow whose root fact change is superseded loses all of its still-pending consequences.
  const supersededWorkflows = new Set(otherPending.filter((o) => o.decision === "pending" && (Object.keys(o.factDeps).some((k) => targetedFacts.has(k)) || (o.target.type === "fact" && targetedFacts.has(o.target.key)))).map((o) => o.workflowId));
  for (const o of otherPending) {
    if (o.decision !== "pending" || !supersededWorkflows.has(o.workflowId)) continue;
    db.update(s.proposals).set({ decision: "withdrawn", decisionReason: `Superseded by the later request “${wf.request}”.`, updatedAt: t }).where(eq(s.proposals.id, o.id)).run();
    if (o.taskId) db.update(s.tasks).set({ status: "superseded", detail: "Withdrawn: a later request changed the same facts.", updatedAt: t }).where(eq(s.tasks.id, o.taskId)).run();
    appendEvent(db, wf.projectId, o.workflowId, "proposal.withdrawn", `Withdrew “${o.title}” — superseded by “${wf.request}”.`, { stage: "review" });
    refreshWorkflowStatus(db, o.workflowId);
  }
  return rows;
}

export function answerClarification(db: Db, workflowId: string, answers: Record<string, string>): s.Workflow {
  const wf = getWorkflow(db, workflowId);
  if (!wf) throw new Error("workflow not found");
  if (wf.status !== "needs_input") throw new Error("workflow is not waiting for input");
  const merged = { ...wf.answers, ...answers };
  setWorkflow(db, wf.id, { answers: merged, status: "planning", clarification: null });
  appendEvent(db, wf.projectId, wf.id, "workflow.answered", `Clarified: ${Object.values(answers).join("; ")}`, { stage: "understand" });
  enqueueJob(db, "workflow.plan", { workflowId: wf.id }, { idempotencyKey: `plan:${wf.id}:${Object.keys(merged).length + 1}:${now()}` });
  return getWorkflow(db, wf.id)!;
}

// ---------------------------------------------------------------------------
// Review decisions
// ---------------------------------------------------------------------------

export type Decision = { proposalId: string; decision: "approve" | "reject" };

export function submitReview(db: Db, workflowId: string, decisions: Decision[], approver = "organizer"): s.Workflow {
  const wf = getWorkflow(db, workflowId);
  if (!wf) throw new Error("workflow not found");
  if (!["ready_for_review", "waiting_external", "partially_complete", "executing"].includes(wf.status)) throw new Error(`workflow is ${wf.status}; nothing to review`);
  const t = now();
  const facts = db.select().from(s.projectFacts).where(eq(s.projectFacts.projectId, wf.projectId)).all();
  const versions = Object.fromEntries(facts.map((f) => [f.key, f.version]));
  for (const d of decisions) {
    const p = db.select().from(s.proposals).where(and(eq(s.proposals.id, d.proposalId), eq(s.proposals.workflowId, workflowId))).get();
    if (!p || p.decision !== "pending") continue;
    // stale check at decision time: facts moved since planning
    const stale = Object.entries(p.factDeps).find(([k, v]) => (versions[k] ?? 0) !== v);
    if (stale && d.decision === "approve") {
      db.update(s.proposals).set({ decision: "stale", decisionReason: `${stale[0]} changed (v${stale[1]} → v${versions[stale[0]]}) after this was proposed. Re-run the request to get a fresh proposal.`, updatedAt: t }).where(eq(s.proposals.id, p.id)).run();
      if (p.taskId) db.update(s.tasks).set({ status: "superseded", detail: "Stale: facts changed since planning.", updatedAt: t }).where(eq(s.tasks.id, p.taskId)).run();
      appendEvent(db, wf.projectId, wf.id, "proposal.stale", `“${p.title}” is stale: ${stale[0]} changed since it was proposed.`, { stage: "review" });
      continue;
    }
    if (d.decision === "approve") {
      const target = p.target;
      const recipients = target.type === "email" ? target.to.map((x) => x.email) : target.type === "staff_notice" ? target.recipients.map((x) => x.email) : [];
      db.insert(s.approvals).values({ id: newId("appr"), proposalId: p.id, approver, contentHash: hashContent(target), factVersions: Object.fromEntries(Object.keys(p.factDeps).map((k) => [k, versions[k] ?? 0])), scope: { projectId: wf.projectId, actionTypes: [target.type], recipients, costCeilingCents: p.cost?.deltaCents ?? null, conditional: p.conditional }, createdAt: t }).run();
      db.update(s.proposals).set({ decision: "approved", decisionReason: null, updatedAt: t }).where(eq(s.proposals.id, p.id)).run();
      if (p.taskId) db.update(s.tasks).set({ status: "queued", updatedAt: t }).where(eq(s.tasks.id, p.taskId)).run();
    } else {
      db.update(s.proposals).set({ decision: "rejected", decisionReason: "Skipped by organizer.", updatedAt: t }).where(eq(s.proposals.id, p.id)).run();
      if (p.taskId) db.update(s.tasks).set({ status: "skipped", detail: "Skipped by organizer.", updatedAt: t }).where(eq(s.tasks.id, p.taskId)).run();
    }
  }
  const approved = decisions.filter((d) => d.decision === "approve").length;
  appendEvent(db, wf.projectId, wf.id, "workflow.reviewed", `Review submitted: ${approved} approved, ${decisions.length - approved} skipped.`, { stage: "apply" });
  setStageTask(db, wf.id, "review", "succeeded", `${approved} approved, ${decisions.length - approved} skipped.`);
  setWorkflow(db, wf.id, { status: "executing", stage: "apply" });
  enqueueJob(db, "workflow.execute", { workflowId: wf.id }, { idempotencyKey: `exec:${wf.id}:${t}` });
  return getWorkflow(db, wf.id)!;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export function conditionSatisfied(db: Db, condition: string): boolean {
  const m = condition.match(/^engagement:([^:]+):([^:]+)(?::v(\d+))?$/);
  if (!m) return false;
  const e = db.select().from(s.vendorEngagements).where(eq(s.vendorEngagements.id, m[1])).get();
  if (!e) return false;
  switch (m[2]) {
    case "quote_received": {
      // ":vN" means a quote numbered N or later must have arrived (a revised quote, not one already on file).
      const minVersion = m[3] ? Number(m[3]) : 1;
      const usable = e.quotes.some((q) => q.version >= minVersion && q.status !== "mismatched");
      return usable && (e.quoteState === "received" || e.quoteState === "accepted");
    }
    case "confirmed":
      return e.confirmationState === "confirmed";
    case "cancellation_confirmed":
      return e.cancellationState === "confirmed";
    case "date_confirmed": {
      const date = db.select().from(s.projectFacts).where(and(eq(s.projectFacts.projectId, e.projectId), eq(s.projectFacts.key, "event.date"))).get()?.value;
      return db
        .select()
        .from(s.messages)
        .where(and(eq(s.messages.engagementId, e.id), eq(s.messages.direction, "inbound"), eq(s.messages.processed, true)))
        .all()
        .some((m) => m.processingResult?.outcome === "date_confirmed" && (m.processingResult.extracted as { date?: string } | undefined)?.date === date);
    }
    default:
      return false;
  }
}

export function describeCondition(db: Db, condition: string): string {
  const m = condition.match(/^engagement:([^:]+):([^:]+)(?::v(\d+))?$/);
  if (!m) return condition;
  const e = db.select().from(s.vendorEngagements).where(eq(s.vendorEngagements.id, m[1])).get();
  const who = e?.vendorName ?? "the vendor";
  return m[2] === "quote_received" ? (m[3] ? `${who} to send a revised quote` : `${who} to send a quote`) : m[2] === "confirmed" ? `${who} to confirm the booking` : m[2] === "cancellation_confirmed" ? `${who} to acknowledge the cancellation` : m[2] === "date_confirmed" ? `${who} to confirm the new date` : `${who}: ${m[2]}`;
}

type ExecOutcome = { status: s.TaskStatus; detail: string; result?: unknown };

/** Applies approved proposals in dependency order. Idempotent: re-running only touches tasks that are not terminal. */
export async function executeWorkflow(db: Db, workflowId: string): Promise<void> {
  const wf = getWorkflow(db, workflowId);
  if (!wf) throw new Error("workflow not found");
  if (["planning", "needs_input", "superseded"].includes(wf.status)) return;
  const taskRows = db.select().from(s.tasks).where(and(eq(s.tasks.workflowId, wf.id), eq(s.tasks.kind, "proposal"))).orderBy(s.tasks.sortOrder).all();
  const OPEN: s.TaskStatus[] = ["queued", "blocked", "waiting_external", "waiting_approval", "running"];
  let progressed = true;
  let guard = 0;
  while (progressed && guard++ < 50) {
    progressed = false;
    for (const t of taskRows) {
      const fresh = db.select().from(s.tasks).where(eq(s.tasks.id, t.id)).get()!;
      if (!OPEN.includes(fresh.status)) continue;
      const proposalId = (fresh.input as { proposalId: string }).proposalId;
      const p = db.select().from(s.proposals).where(eq(s.proposals.id, proposalId)).get();
      if (!p) continue;
      const outcome = await stepProposal(db, wf, p, fresh);
      if (outcome.status !== fresh.status || outcome.detail !== fresh.detail) {
        db.update(s.tasks).set({ status: outcome.status, detail: outcome.detail, result: outcome.result ?? fresh.result, updatedAt: now() }).where(eq(s.tasks.id, t.id)).run();
        if (outcome.status !== fresh.status) progressed = true;
      }
    }
  }
  refreshWorkflowStatus(db, wf.id);
}

async function stepProposal(db: Db, wf: s.Workflow, p: s.Proposal, task: s.Task): Promise<ExecOutcome> {
  if (p.decision === "rejected") return { status: "skipped", detail: p.decisionReason ?? "Skipped by organizer." };
  if (p.decision === "pending") return { status: "waiting_approval", detail: "Awaiting your decision." };
  if (p.decision === "stale" || p.decision === "withdrawn") return { status: "superseded", detail: p.decisionReason ?? "Superseded." };
  if (p.decision === "applied") return { status: "succeeded", detail: task.detail ?? "Applied." };

  // prerequisites
  for (const reqId of p.requires) {
    const req = db.select().from(s.proposals).where(eq(s.proposals.id, reqId)).get();
    if (!req) continue;
    if (req.decision === "applied") continue;
    if (req.decision === "rejected") return { status: "blocked", detail: `Skipped: depends on “${req.title}”, which was skipped.` };
    if (req.decision === "stale" || req.decision === "withdrawn") return { status: "blocked", detail: `Not applied: depends on “${req.title}”, which is no longer valid.` };
    if (req.decision === "pending") return { status: "waiting_approval", detail: `Waiting for a decision on “${req.title}”.` };
    const reqTask = req.taskId ? db.select().from(s.tasks).where(eq(s.tasks.id, req.taskId)).get() : undefined;
    if (reqTask?.status === "failed") return { status: "blocked", detail: `Held: “${req.title}” failed and needs attention first.` };
    return { status: "waiting_external", detail: `Waiting for “${req.title}” to complete.` };
  }
  if (p.waitsFor && !conditionSatisfied(db, p.waitsFor)) {
    return { status: "waiting_external", detail: `Waiting for ${describeCondition(db, p.waitsFor)}.` };
  }

  // revalidate facts (versions bumped by this very workflow are fine)
  const facts = db.select().from(s.projectFacts).where(eq(s.projectFacts.projectId, wf.projectId)).all();
  for (const [k, v] of Object.entries(p.factDeps)) {
    const f = facts.find((x) => x.key === k);
    const cur = f?.version ?? 0;
    const ownChange = f?.sourceRefs.some((r) => r.type === "workflow" && r.id === wf.id);
    if (cur !== v && !ownChange) {
      const t = now();
      db.update(s.proposals).set({ decision: "stale", decisionReason: `${k} changed (v${v} → v${cur}) after approval; not applied.`, updatedAt: t }).where(eq(s.proposals.id, p.id)).run();
      appendEvent(db, wf.projectId, wf.id, "proposal.stale", `Did not apply “${p.title}”: ${k} changed after approval. Re-run the request for a fresh proposal.`, { stage: "apply" });
      return { status: "superseded", detail: `Stale: ${k} changed after approval (v${v} → v${cur}).` };
    }
  }
  if (p.kind === "wait") {
    if (p.waitsFor && conditionSatisfied(db, p.waitsFor)) {
      markApplied(db, p);
      return { status: "succeeded", detail: "Condition met." };
    }
    return { status: "waiting_external", detail: `Waiting for ${p.waitsFor ? describeCondition(db, p.waitsFor) : "an external reply"}.` };
  }

  try {
    const outcome = await applyProposal(db, wf, p, task);
    if (outcome.status === "succeeded") {
      markApplied(db, p);
      appendEvent(db, wf.projectId, wf.id, "proposal.applied", `${p.title}: ${outcome.detail}`, { stage: "apply", data: { proposalId: p.id, area: p.area } });
    } else if (outcome.status === "failed") {
      appendEvent(db, wf.projectId, wf.id, "proposal.failed", `${p.title}: ${outcome.detail}`, { stage: "apply", data: { proposalId: p.id, area: p.area } });
    }
    return outcome;
  } catch (e) {
    const msg = (e as Error).message;
    appendEvent(db, wf.projectId, wf.id, "proposal.failed", `${p.title}: ${msg}`, { stage: "apply", data: { proposalId: p.id } });
    return { status: "failed", detail: msg };
  }
}

function markApplied(db: Db, p: s.Proposal) {
  db.update(s.proposals).set({ decision: "applied", appliedAt: now(), updatedAt: now() }).where(eq(s.proposals.id, p.id)).run();
}

export function setFact(db: Db, projectId: string, key: string, value: unknown, status: s.FactStatus, sourceRef: s.FactSourceRef): s.ProjectFact {
  const t = now();
  const existing = db.select().from(s.projectFacts).where(and(eq(s.projectFacts.projectId, projectId), eq(s.projectFacts.key, key))).get();
  if (existing) {
    db.update(s.projectFacts).set({ value, status, version: existing.version + 1, sourceRefs: [sourceRef, ...existing.sourceRefs].slice(0, 10), updatedAt: t }).where(eq(s.projectFacts.id, existing.id)).run();
  } else {
    db.insert(s.projectFacts).values({ id: newId("fact"), projectId, key, value, status, version: 1, sourceRefs: [sourceRef], updatedAt: t }).run();
  }
  bumpProjectRevision(db, projectId);
  return db.select().from(s.projectFacts).where(and(eq(s.projectFacts.projectId, projectId), eq(s.projectFacts.key, key))).get()!;
}

/** Marks pending/approved proposals in other workflows stale when a fact they depend on changes. */
export function invalidateDependents(db: Db, projectId: string, key: string, excludeWorkflowIds: string[], reason: string) {
  const rows = db.select().from(s.proposals).where(and(eq(s.proposals.projectId, projectId), inArray(s.proposals.decision, ["pending", "approved"]))).all();
  const t = now();
  const touched = new Set<string>();
  for (const p of rows) {
    if (excludeWorkflowIds.includes(p.workflowId)) continue;
    if (!(key in p.factDeps)) continue;
    db.update(s.proposals).set({ decision: "stale", decisionReason: reason, updatedAt: t }).where(eq(s.proposals.id, p.id)).run();
    if (p.taskId) db.update(s.tasks).set({ status: "superseded", detail: reason, updatedAt: t }).where(eq(s.tasks.id, p.taskId)).run();
    appendEvent(db, projectId, p.workflowId, "proposal.stale", `“${p.title}” is stale: ${reason}`, { stage: "review" });
    touched.add(p.workflowId);
  }
  for (const wid of touched) refreshWorkflowStatus(db, wid);
}

async function applyProposal(db: Db, wf: s.Workflow, p: s.Proposal, task: s.Task): Promise<ExecOutcome> {
  const target = p.target;
  const t = now();
  const src: s.FactSourceRef = { type: "workflow", id: wf.id, excerpt: p.title };
  switch (target.type) {
    case "fact": {
      const after = p.after as { value: unknown; status: s.FactStatus };
      setFact(db, wf.projectId, target.key, after.value, after.status ?? "confirmed", src);
      invalidateDependents(db, wf.projectId, target.key, [wf.id], `${target.key} was changed by “${wf.request}”.`);
      return { status: "succeeded", detail: `Recorded as ${after.status ?? "confirmed"}.` };
    }
    case "budget_line": {
      const after = p.after as { category: string; label: string; quantity: number; unitCents: number | null; subtotalCents: number | null; commitmentStatus: s.CommitmentStatus; engagementId: string | null; active: boolean };
      if (target.lineId) {
        const line = db.select().from(s.budgetLines).where(eq(s.budgetLines.id, target.lineId)).get();
        if (!line) return { status: "failed", detail: "Budget line no longer exists." };
        db.update(s.budgetLines).set({ label: after.label, quantity: after.quantity, unitCents: after.unitCents, subtotalCents: after.subtotalCents, commitmentStatus: after.commitmentStatus, active: after.active, engagementId: after.engagementId ?? line.engagementId, version: line.version + 1, provenance: [src, ...line.provenance].slice(0, 10), updatedAt: t }).where(eq(s.budgetLines.id, line.id)).run();
      } else {
        db.insert(s.budgetLines).values({ id: newId("line"), projectId: wf.projectId, category: after.category, label: after.label, quantity: after.quantity, unitCents: after.unitCents, subtotalCents: after.subtotalCents, taxCents: 0, currency: "USD", commitmentStatus: after.commitmentStatus, engagementId: after.engagementId, provenance: [src], active: after.active, version: 1, updatedAt: t }).run();
      }
      bumpProjectRevision(db, wf.projectId);
      return { status: "succeeded", detail: after.subtotalCents === null ? "Recorded with an unknown amount." : `Forecast line updated (${after.commitmentStatus}).` };
    }
    case "engagement": {
      const e = db.select().from(s.vendorEngagements).where(eq(s.vendorEngagements.id, target.engagementId)).get();
      if (!e) return { status: "failed", detail: "Vendor engagement not found." };
      const field = target.field as "quoteState" | "confirmationState" | "cancellationState";
      db.update(s.vendorEngagements).set({ [field]: p.after as string, version: e.version + 1, updatedAt: t }).where(eq(s.vendorEngagements.id, e.id)).run();
      return { status: "succeeded", detail: `${e.vendorName} marked ${String(p.after).replace(/_/g, " ")}.` };
    }
    case "schedule": {
      if (!target.itemId) return { status: "failed", detail: "Schedule item not found." };
      const item = db.select().from(s.scheduleItems).where(eq(s.scheduleItems.id, target.itemId)).get();
      if (!item) return { status: "failed", detail: "Schedule item not found." };
      const [bh, bm] = item.startLocal.split(":").map(Number);
      const [ah, am] = target.startLocal.split(":").map(Number);
      const delta = ah * 60 + am - (bh * 60 + bm);
      db.update(s.scheduleItems).set({ startLocal: target.startLocal, endLocal: item.endLocal ? addMinutes(item.endLocal, delta) : null, version: item.version + 1 }).where(eq(s.scheduleItems.id, item.id)).run();
      bumpProjectRevision(db, wf.projectId);
      return { status: "succeeded", detail: `${item.title} now ${target.startLocal}.` };
    }
    case "staff": {
      const m = db.select().from(s.staff).where(eq(s.staff.id, target.staffId)).get();
      if (!m) return { status: "failed", detail: "Staff member not found." };
      if (target.field === "available") db.update(s.staff).set({ available: !!p.after }).where(eq(s.staff.id, m.id)).run();
      bumpProjectRevision(db, wf.projectId);
      return { status: "succeeded", detail: `${m.name} marked ${p.after ? "available" : "unavailable"}.` };
    }
    case "file":
      return applyFile(db, wf, p, target);
    case "email":
    case "staff_notice":
      return applyEmail(db, wf, p, task, target);
    case "invitation":
      return applyInvitation(db, wf, p, target);
    case "check":
      return { status: "succeeded", detail: target.note };
  }
}

async function applyFile(db: Db, wf: s.Workflow, p: s.Proposal, target: Extract<s.ProposalTarget, { type: "file" }>): Promise<ExecOutcome> {
  const { adapter, connection } = fileAdapterFor(db, wf.projectId);
  if (connection && connection.status !== "connected") return { status: "failed", detail: `Dropbox is ${connection.status}; the file was not written. Reconnect and retry.` };
  const doc = db.select().from(s.sourceDocuments).where(and(eq(s.sourceDocuments.projectId, wf.projectId), eq(s.sourceDocuments.path, target.path))).get();
  const expected = doc ? (p.docDeps[doc.id] ?? doc.revision) : null;
  if (doc && expected && doc.revision !== expected) {
    return { status: "failed", detail: `Conflict: ${target.path} changed remotely (${doc.revision}) since this update was prepared from ${expected}. Re-run the request to rebase the change; nothing was overwritten.` };
  }
  const res = await adapter.write({ path: target.path, content: target.content, expectedRevision: doc?.revision ?? null });
  if (!res.ok) {
    if (res.kind === "conflict") return { status: "failed", detail: `Conflict: ${res.error} Nothing was overwritten; re-run the request to rebase.` };
    return { status: "failed", detail: `${res.kind === "transient" ? "Temporary" : "Permanent"} Dropbox error: ${res.error}` };
  }
  const t = now();
  const hash = hashContent(target.content);
  if (doc) {
    db.update(s.sourceDocuments).set({ content: target.content, contentHash: hash, revision: res.revision, localRevision: doc.localRevision + 1, syncedRevision: doc.localRevision + 1, syncedAt: t, updatedAt: t }).where(eq(s.sourceDocuments.id, doc.id)).run();
  } else {
    db.insert(s.sourceDocuments).values({ id: newId("doc"), projectId: wf.projectId, provider: adapter.provider, providerId: null, path: target.path, revision: res.revision, localRevision: 1, syncedRevision: 1, contentHash: hash, content: target.content, extractedFacts: {}, kind: "projection", supported: true, syncedAt: t, updatedAt: t }).run();
  }
  return { status: "succeeded", detail: `${res.simulated ? "Simulated write" : "Written"} to ${target.path} (rev ${res.revision}).`, result: { revision: res.revision, simulated: res.simulated } };
}

async function applyEmail(db: Db, wf: s.Workflow, p: s.Proposal, task: s.Task, target: Extract<s.ProposalTarget, { type: "email" | "staff_notice" }>): Promise<ExecOutcome> {
  const to = target.type === "email" ? target.to : target.recipients;
  const subject = target.type === "email" ? target.subject : `Staff update — ${getProjectName(db, wf.projectId)}`;
  const body = target.type === "email" ? target.body : target.text;
  const threadId = target.type === "email" ? target.threadId ?? null : null;
  const engagementId = target.type === "email" ? target.engagementId ?? null : null;
  const idempotencyKey = `email:${p.id}`;
  const { adapter, connection } = emailAdapterFor(db, wf.projectId);
  if (connection && connection.status !== "connected") return { status: "failed", detail: `Email is ${connection.status}; nothing was sent. Reconnect and retry.` };

  const approval = db.select().from(s.approvals).where(eq(s.approvals.proposalId, p.id)).get();
  if (!approval || approval.contentHash !== hashContent(p.target)) return { status: "failed", detail: "Approval does not match the message content; not sent." };
  const scopeBad = to.find((r) => !approval.scope.recipients.includes(r.email));
  if (scopeBad) return { status: "failed", detail: `Recipient ${scopeBad.email} is outside the approved scope; not sent.` };
  if (adapter.mode === "live") {
    const fixtureContacts = db.select().from(s.contacts).where(and(eq(s.contacts.projectId, wf.projectId), eq(s.contacts.isFixture, true))).all().map((c) => c.email);
    const blocked = to.find((r) => isFixtureAddress(r.email) || fixtureContacts.includes(r.email));
    if (blocked) return { status: "failed", detail: `Refused: ${blocked.email} is a sample contact and cannot receive live email.` };
  }

  let action = db.select().from(s.externalActions).where(eq(s.externalActions.idempotencyKey, idempotencyKey)).get();
  const t = now();
  if (!action) {
    action = { id: newId("act"), projectId: wf.projectId, workflowId: wf.id, proposalId: p.id, provider: "gmail", kind: target.type, payload: { to, subject, body, threadId }, idempotencyKey, approvalId: approval.id, state: "pending", simulated: adapter.mode === "demo", receipt: null, attempts: 0, error: null, createdAt: t, updatedAt: t };
    db.insert(s.externalActions).values(action).run();
  }
  if (action.state === "sent") return { status: "succeeded", detail: `Already ${action.simulated ? "simulated-sent" : "sent"} (${(action.receipt as { providerMessageId?: string } | null)?.providerMessageId ?? "receipt on file"}).`, result: action.receipt };
  if (action.state === "uncertain") {
    // reconcile before any resend
    const found = await adapter.findSent(idempotencyKey).catch(() => null);
    if (found) {
      recordSent(db, wf, p, action, { ...found, simulated: action.simulated, sentAt: now() }, to, subject, body, engagementId);
      return { status: "succeeded", detail: `Reconciled: the provider had delivered it (${found.providerMessageId}). No duplicate sent.`, result: found };
    }
    db.update(s.externalActions).set({ state: "pending", error: "Reconciled: provider has no record of the message; safe to retry.", updatedAt: now() }).where(eq(s.externalActions.id, action.id)).run();
  }
  if (action.attempts >= 3 && action.state === "failed") return { status: "failed", detail: `Gave up after ${action.attempts} attempts: ${action.error}` };

  // Mark dispatching outside any transaction, then call the provider.
  db.update(s.externalActions).set({ state: "dispatching", attempts: action.attempts + 1, updatedAt: now() }).where(eq(s.externalActions.id, action.id)).run();
  const res = await adapter.send({ idempotencyKey, to, subject, body, threadId });
  if (res.ok) {
    recordSent(db, wf, p, action, res, to, subject, body, engagementId);
    return { status: "succeeded", detail: `${res.simulated ? "Simulated send" : "Sent"} to ${to.map((r) => r.email).join(", ")} — receipt ${res.providerMessageId}.`, result: { providerMessageId: res.providerMessageId, simulated: res.simulated, sentAt: res.sentAt } };
  }
  db.update(s.externalActions).set({ state: res.kind === "uncertain" ? "uncertain" : "failed", error: res.error, updatedAt: now() }).where(eq(s.externalActions.id, action.id)).run();
  db.update(s.tasks).set({ attempts: task.attempts + 1 }).where(eq(s.tasks.id, task.id)).run();
  if (res.kind === "uncertain") return { status: "failed", detail: `Delivery uncertain: ${res.error} Use “Reconcile & retry” — Ripple checks the provider before sending again.` };
  if (res.kind === "transient") return { status: "failed", detail: `Send failed (temporary): ${res.error} Retry when ready; the same message will be sent once.` };
  return { status: "failed", detail: `Send failed: ${res.error}` };
}

function recordSent(db: Db, wf: s.Workflow, p: s.Proposal, action: s.ExternalAction, res: { providerMessageId: string; threadId: string; simulated: boolean; sentAt: number }, to: { name: string; email: string }[], subject: string, body: string, engagementId: string | null) {
  const t = now();
  db.update(s.externalActions).set({ state: "sent", receipt: { providerMessageId: res.providerMessageId, threadId: res.threadId, sentAt: res.sentAt, simulated: res.simulated }, error: null, updatedAt: t }).where(eq(s.externalActions.id, action.id)).run();
  const dedupeKey = `gmail:out:${res.providerMessageId}`;
  const exists = db.select().from(s.messages).where(eq(s.messages.dedupeKey, dedupeKey)).get();
  if (!exists) {
    db.insert(s.messages).values({ id: newId("msg"), projectId: wf.projectId, engagementId, threadId: res.threadId, provider: "gmail", providerMessageId: res.providerMessageId, direction: "outbound", fromAddress: process.env.GMAIL_FROM_ADDRESS ?? "organizer@ripple.demo", toAddresses: to.map((r) => r.email), subject, body, receivedAt: res.sentAt, dedupeKey, processed: true, processingResult: { outcome: "sent", detail: p.title }, simulated: res.simulated, fixtureLabel: null }).run();
  }
  if (engagementId) {
    const e = db.select().from(s.vendorEngagements).where(eq(s.vendorEngagements.id, engagementId)).get();
    if (e && !e.threadId) db.update(s.vendorEngagements).set({ threadId: res.threadId, updatedAt: t }).where(eq(s.vendorEngagements.id, e.id)).run();
  }
}

function getProjectName(db: Db, projectId: string): string {
  return db.select().from(s.projects).where(eq(s.projects.id, projectId)).get()?.name ?? "the event";
}

async function applyInvitation(db: Db, wf: s.Workflow, p: s.Proposal, target: Extract<s.ProposalTarget, { type: "invitation" }>): Promise<ExecOutcome> {
  const adapter = invitationAdapterFor(db, wf.projectId);
  const idempotencyKey = `invitation:${p.id}`;
  let action = db.select().from(s.externalActions).where(eq(s.externalActions.idempotencyKey, idempotencyKey)).get();
  const t = now();
  if (!action) {
    action = { id: newId("act"), projectId: wf.projectId, workflowId: wf.id, proposalId: p.id, provider: "invitations", kind: "invitation", payload: { text: target.text, recipientCount: target.recipientCount }, idempotencyKey, approvalId: null, state: "pending", simulated: adapter.mode === "demo", receipt: null, attempts: 0, error: null, createdAt: t, updatedAt: t };
    db.insert(s.externalActions).values(action).run();
  }
  if (action.state === "sent" || action.state === "manual_done") {
    setFact(db, wf.projectId, "invitation.text", target.text, "confirmed", { type: "workflow", id: wf.id, excerpt: p.title });
    return { status: "succeeded", detail: "Invitation already updated.", result: action.receipt };
  }
  if (action.state === "manual_pending") return { status: "waiting_external", detail: "Manual step: paste the approved invitation text into your invitation tool, then mark done." };
  const res = await adapter.update({ idempotencyKey, text: target.text, recipientCount: target.recipientCount });
  if (!res.ok) {
    db.update(s.externalActions).set({ state: "manual_pending", error: res.instructions, updatedAt: now() }).where(eq(s.externalActions.id, action.id)).run();
    return { status: "waiting_external", detail: "Manual step: paste the approved invitation text into your invitation tool, then mark done." };
  }
  db.update(s.externalActions).set({ state: "sent", receipt: { receiptId: res.receiptId, recipientCount: res.recipientCount, simulated: res.simulated }, updatedAt: now() }).where(eq(s.externalActions.id, action.id)).run();
  setFact(db, wf.projectId, "invitation.text", target.text, "confirmed", { type: "workflow", id: wf.id, excerpt: p.title });
  return { status: "succeeded", detail: `${res.simulated ? "Simulated update" : "Updated"} for ${res.recipientCount} recipients — receipt ${res.receiptId}.`, result: { receiptId: res.receiptId, simulated: res.simulated } };
}

export function markManualDone(db: Db, actionId: string) {
  const a = db.select().from(s.externalActions).where(eq(s.externalActions.id, actionId)).get();
  if (!a || a.state !== "manual_pending") return;
  db.update(s.externalActions).set({ state: "manual_done", receipt: { manual: true, doneAt: now() }, updatedAt: now() }).where(eq(s.externalActions.id, a.id)).run();
  enqueueJob(db, "workflow.execute", { workflowId: a.workflowId }, { idempotencyKey: `exec:${a.workflowId}:manual:${a.id}` });
}

/** Re-queues a failed proposal task (idempotent send path reconciles before resending). */
export function retryTask(db: Db, taskId: string): void {
  const task = db.select().from(s.tasks).where(eq(s.tasks.id, taskId)).get();
  if (!task || task.status !== "failed") return;
  const proposalId = (task.input as { proposalId?: string }).proposalId;
  if (proposalId) {
    const action = db.select().from(s.externalActions).where(eq(s.externalActions.proposalId, proposalId)).get();
    if (action && action.state === "failed") db.update(s.externalActions).set({ state: "pending", updatedAt: now() }).where(eq(s.externalActions.id, action.id)).run();
  }
  db.update(s.tasks).set({ status: "queued", detail: "Retry requested.", updatedAt: now() }).where(eq(s.tasks.id, taskId)).run();
  const wf = getWorkflow(db, task.workflowId);
  if (wf) {
    setWorkflow(db, wf.id, { status: "executing" });
    appendEvent(db, wf.projectId, wf.id, "task.retry", `Retrying “${task.title}”.`, { stage: "apply" });
  }
  enqueueJob(db, "workflow.execute", { workflowId: task.workflowId }, { idempotencyKey: `exec:${task.workflowId}:retry:${taskId}:${now()}` });
}

// ---------------------------------------------------------------------------
// Status derivation
// ---------------------------------------------------------------------------

export function refreshWorkflowStatus(db: Db, workflowId: string): s.Workflow | undefined {
  const wf = getWorkflow(db, workflowId);
  if (!wf) return;
  if (["planning", "needs_input"].includes(wf.status)) return wf;
  const props = db.select().from(s.proposals).where(and(eq(s.proposals.workflowId, workflowId), ne(s.proposals.kind, "check"))).all();
  const tasks = db.select().from(s.tasks).where(and(eq(s.tasks.workflowId, workflowId), eq(s.tasks.kind, "proposal"))).all();
  const byStatus = (st: s.TaskStatus) => tasks.filter((t) => t.status === st).length;
  const pending = props.filter((p) => p.decision === "pending").length;
  let status: s.WorkflowStatus;
  let stage: s.WorkflowStage;
  if (props.length && props.every((p) => p.decision === "stale" || p.decision === "withdrawn")) {
    status = "superseded";
    stage = "done";
  } else if (byStatus("failed") > 0) {
    status = "partially_complete";
    stage = "apply";
  } else if (pending > 0) {
    status = "ready_for_review";
    stage = "review";
  } else if (byStatus("waiting_external") > 0) {
    status = "waiting_external";
    stage = "waiting";
  } else if (byStatus("queued") + byStatus("running") + byStatus("waiting_approval") > 0) {
    status = "executing";
    stage = "apply";
  } else if (byStatus("blocked") > 0) {
    status = "partially_complete";
    stage = "done";
  } else {
    status = "completed";
    stage = "done";
  }
  if (status !== wf.status || stage !== wf.stage) {
    setWorkflow(db, workflowId, { status, stage, summary: summarize(db, tasks) });
    if (status === "completed") appendEvent(db, wf.projectId, wf.id, "workflow.completed", summarize(db, tasks), { stage: "done" });
    else if (status === "waiting_external") appendEvent(db, wf.projectId, wf.id, "workflow.waiting", summarize(db, tasks), { stage: "waiting" });
    else if (status === "partially_complete") appendEvent(db, wf.projectId, wf.id, "workflow.needs_attention", summarize(db, tasks), { stage: "apply" });
  } else {
    setWorkflow(db, workflowId, { summary: summarize(db, tasks) });
  }
  return getWorkflow(db, workflowId);
}

function summarize(db: Db, tasks: s.Task[]): string {
  const n = (st: s.TaskStatus[]) => tasks.filter((t) => st.includes(t.status)).length;
  const parts: string[] = [];
  const done = n(["succeeded"]);
  if (done) parts.push(`${done} completed`);
  const waiting = n(["waiting_external"]);
  if (waiting) parts.push(`${waiting} waiting`);
  const attention = n(["failed"]);
  if (attention) parts.push(`${attention} need attention`);
  const skipped = n(["skipped", "blocked", "superseded"]);
  if (skipped) parts.push(`${skipped} skipped`);
  const pending = n(["waiting_approval", "queued"]);
  if (pending) parts.push(`${pending} pending`);
  void db;
  return parts.join(", ") || "Nothing to apply.";
}

/** Called after external state changes (inbound replies) so waiting workflows re-evaluate. */
export function wakeWaitingWorkflows(db: Db, projectId: string) {
  const wfs = db.select().from(s.workflows).where(and(eq(s.workflows.projectId, projectId), inArray(s.workflows.status, ["waiting_external", "executing", "partially_complete", "ready_for_review"]))).all();
  for (const wf of wfs) enqueueJob(db, "workflow.execute", { workflowId: wf.id }, { idempotencyKey: `exec:${wf.id}:wake:${now()}` });
  return wfs;
}
