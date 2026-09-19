import { desc, eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import * as s from "@/lib/db/schema";
import { newId, now } from "@/lib/domain/ids";

export function appendEvent(db: Db, projectId: string, workflowId: string | null, type: string, message: string, opts: { stage?: s.WorkflowStage | null; data?: Record<string, unknown> } = {}): s.WorkflowEvent {
  const last = db.select({ seq: s.workflowEvents.seq }).from(s.workflowEvents).where(eq(s.workflowEvents.projectId, projectId)).orderBy(desc(s.workflowEvents.seq)).limit(1).get();
  const ev: s.WorkflowEvent = { id: newId("evt"), projectId, workflowId, seq: (last?.seq ?? 0) + 1, type, stage: opts.stage ?? null, message, data: opts.data ?? {}, createdAt: now() };
  db.insert(s.workflowEvents).values(ev).run();
  return ev;
}

export function bumpProjectRevision(db: Db, projectId: string): number {
  const p = db.select().from(s.projects).where(eq(s.projects.id, projectId)).get();
  if (!p) throw new Error(`project ${projectId} not found`);
  const revision = p.revision + 1;
  db.update(s.projects).set({ revision, updatedAt: now() }).where(eq(s.projects.id, projectId)).run();
  return revision;
}
