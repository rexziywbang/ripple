import { and, eq } from "drizzle-orm";
import { openTestDatabase, type Db } from "@/lib/db/client";
import { seedSampleProject, SAMPLE_PROJECT_ID } from "@/lib/db/seed";
import * as s from "@/lib/db/schema";
import { drainJobs } from "@/lib/jobs/worker";
import { createWorkflow, submitReview, getWorkflow } from "@/lib/workflows/service";
import { processInboundMessage } from "@/lib/workflows/inbound";
import { inboundFixtureById } from "@/fixtures/inbound-messages";

export function freshDb(): Db {
  const db = openTestDatabase();
  seedSampleProject(db);
  return db;
}

export const PID = SAMPLE_PROJECT_ID;

export async function run(db: Db) {
  return drainJobs(db, "test-worker");
}

export async function request(db: Db, text: string, area = "brief") {
  const wf = createWorkflow(db, { projectId: PID, area, request: text });
  await run(db);
  return getWorkflow(db, wf.id)!;
}

export function proposalsOf(db: Db, workflowId: string) {
  return db.select().from(s.proposals).where(eq(s.proposals.workflowId, workflowId)).orderBy(s.proposals.sortOrder).all();
}

export function tasksOf(db: Db, workflowId: string) {
  return db.select().from(s.tasks).where(and(eq(s.tasks.workflowId, workflowId), eq(s.tasks.kind, "proposal"))).all();
}

export function fact(db: Db, key: string) {
  return db.select().from(s.projectFacts).where(and(eq(s.projectFacts.projectId, PID), eq(s.projectFacts.key, key))).get();
}

export function lines(db: Db) {
  return db.select().from(s.budgetLines).where(and(eq(s.budgetLines.projectId, PID), eq(s.budgetLines.active, true))).all();
}

export function forecast(db: Db) {
  return lines(db).reduce((a, l) => a + (l.subtotalCents ?? 0) + l.taxCents, 0);
}

export async function approveAll(db: Db, workflowId: string, except: (p: s.Proposal) => boolean = () => false) {
  const pending = proposalsOf(db, workflowId).filter((p) => p.decision === "pending");
  submitReview(db, workflowId, pending.map((p) => ({ proposalId: p.id, decision: except(p) ? "reject" : "approve" })));
  await run(db);
  return getWorkflow(db, workflowId)!;
}

export function inject(db: Db, fixtureId: string, opts: { providerMessageId?: string; receivedAt?: number } = {}) {
  const f = inboundFixtureById(fixtureId)!;
  const eng = f.engagementId ? db.select().from(s.vendorEngagements).where(eq(s.vendorEngagements.id, f.engagementId)).get() : undefined;
  return processInboundMessage(db, { projectId: PID, provider: "gmail", providerMessageId: opts.providerMessageId ?? `${fixtureId}-${Date.now()}-${Math.random()}`, threadId: eng?.threadId ?? null, from: f.from, subject: f.subject, body: f.body, receivedAt: opts.receivedAt, simulated: true, fixtureLabel: f.label });
}

export function engagement(db: Db, id: string) {
  return db.select().from(s.vendorEngagements).where(eq(s.vendorEngagements.id, id)).get()!;
}
