import { and, desc, eq, gt, inArray } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import * as s from "@/lib/db/schema";
import { workerStatus } from "@/lib/jobs/worker";
import { pendingJobCount } from "@/lib/jobs/queue";
import { describeCondition, refreshWorkflowStatus } from "@/lib/workflows/service";
import { INBOUND_FIXTURES } from "@/fixtures/inbound-messages";

export type WorkflowView = s.Workflow & {
  tasks: s.Task[];
  proposals: s.Proposal[];
  actions: s.ExternalAction[];
  waits: { taskId: string; condition: string; description: string; status: s.TaskStatus }[];
};

export type ProjectSnapshot = {
  project: s.Project;
  facts: s.ProjectFact[];
  connections: s.Connection[];
  documents: Omit<s.SourceDocument, "content">[];
  contacts: s.Contact[];
  engagements: s.VendorEngagement[];
  budgetLines: s.BudgetLine[];
  guestsCount: number;
  staff: s.StaffMember[];
  schedule: s.ScheduleItem[];
  workflows: WorkflowView[];
  messages: s.Message[];
  events: s.WorkflowEvent[];
  worker: { online: boolean; lastSeen: number | null; workers: number; queued: number };
  fixtures: { id: string; label: string; description: string; from: string; subject: string }[];
  serverTime: number;
};

export function projectList(db: Db) {
  return db.select().from(s.projects).orderBy(desc(s.projects.updatedAt)).all();
}

export function projectSnapshot(db: Db, projectId: string, opts: { eventsAfter?: number } = {}): ProjectSnapshot | null {
  const project = db.select().from(s.projects).where(eq(s.projects.id, projectId)).get();
  if (!project) return null;
  const workflowsRaw = db.select().from(s.workflows).where(eq(s.workflows.projectId, projectId)).orderBy(desc(s.workflows.createdAt)).all();
  for (const wf of workflowsRaw) if (wf.status === "executing" || wf.status === "waiting_external" || wf.status === "partially_complete") refreshWorkflowStatus(db, wf.id);
  const workflowsFresh = workflowsRaw.length ? db.select().from(s.workflows).where(inArray(s.workflows.id, workflowsRaw.map((w) => w.id))).orderBy(desc(s.workflows.createdAt)).all() : [];
  const ids = workflowsFresh.map((w) => w.id);
  const tasks = ids.length ? db.select().from(s.tasks).where(inArray(s.tasks.workflowId, ids)).orderBy(s.tasks.sortOrder).all() : [];
  const proposals = ids.length ? db.select().from(s.proposals).where(inArray(s.proposals.workflowId, ids)).orderBy(s.proposals.sortOrder).all() : [];
  const actions = db.select().from(s.externalActions).where(eq(s.externalActions.projectId, projectId)).all();
  const workflows: WorkflowView[] = workflowsFresh.map((wf) => {
    const wtasks = tasks.filter((t) => t.workflowId === wf.id);
    const wprops = proposals.filter((p) => p.workflowId === wf.id);
    return {
      ...wf,
      tasks: wtasks,
      proposals: wprops,
      actions: actions.filter((a) => a.workflowId === wf.id),
      waits: wprops
        .filter((p) => p.kind === "wait" && p.waitsFor && p.decision !== "applied" && p.decision !== "withdrawn" && p.decision !== "rejected")
        .map((p) => {
          const task = wtasks.find((t) => t.id === p.taskId);
          return { taskId: task?.id ?? p.id, condition: p.waitsFor!, description: describeCondition(db, p.waitsFor!), status: task?.status ?? "queued" };
        }),
    };
  });
  const status = workerStatus(db);
  const eventsQuery = opts.eventsAfter !== undefined ? and(eq(s.workflowEvents.projectId, projectId), gt(s.workflowEvents.seq, opts.eventsAfter)) : eq(s.workflowEvents.projectId, projectId);
  return {
    project,
    facts: db.select().from(s.projectFacts).where(eq(s.projectFacts.projectId, projectId)).all(),
    connections: db.select().from(s.connections).where(eq(s.connections.projectId, projectId)).all(),
    documents: db
      .select()
      .from(s.sourceDocuments)
      .where(eq(s.sourceDocuments.projectId, projectId))
      .all()
      .map((d) => { const { content, ...rest } = d; void content; return rest; }),
    contacts: db.select().from(s.contacts).where(eq(s.contacts.projectId, projectId)).all(),
    engagements: db.select().from(s.vendorEngagements).where(eq(s.vendorEngagements.projectId, projectId)).all(),
    budgetLines: db.select().from(s.budgetLines).where(eq(s.budgetLines.projectId, projectId)).all(),
    guestsCount: db.select().from(s.guests).where(eq(s.guests.projectId, projectId)).all().length,
    staff: db.select().from(s.staff).where(eq(s.staff.projectId, projectId)).all(),
    schedule: db.select().from(s.scheduleItems).where(eq(s.scheduleItems.projectId, projectId)).orderBy(s.scheduleItems.sortOrder).all(),
    workflows,
    messages: db.select().from(s.messages).where(eq(s.messages.projectId, projectId)).orderBy(desc(s.messages.receivedAt)).all(),
    events: db.select().from(s.workflowEvents).where(eventsQuery).orderBy(desc(s.workflowEvents.seq)).limit(200).all(),
    worker: { ...status, queued: pendingJobCount(db) },
    fixtures: project.isSample ? INBOUND_FIXTURES.map((f) => ({ id: f.id, label: f.label, description: f.description, from: f.from, subject: f.subject })) : [],
    serverTime: Date.now(),
  };
}

export function documentContent(db: Db, projectId: string, documentId: string) {
  return db.select().from(s.sourceDocuments).where(and(eq(s.sourceDocuments.projectId, projectId), eq(s.sourceDocuments.id, documentId))).get();
}
