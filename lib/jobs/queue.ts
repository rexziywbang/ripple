import { and, eq, lt, lte, or, sql } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import * as s from "@/lib/db/schema";
import { newId, now } from "@/lib/domain/ids";

export type JobKind = "workflow.plan" | "workflow.execute" | "message.process";

export const LEASE_MS = 30_000;

export function enqueueJob(db: Db, kind: JobKind, payload: Record<string, unknown>, opts: { idempotencyKey?: string; runAt?: number; maxAttempts?: number } = {}): s.Job {
  const t = now();
  const idempotencyKey = opts.idempotencyKey ?? `${kind}:${newId("job")}`;
  const existing = db.select().from(s.jobs).where(eq(s.jobs.idempotencyKey, idempotencyKey)).get();
  if (existing) {
    if (existing.status === "succeeded" || existing.status === "failed" || existing.status === "dead") {
      db.update(s.jobs).set({ status: "queued", runAt: opts.runAt ?? t, attempts: 0, leaseUntil: null, leaseOwner: null, lastError: null, updatedAt: t, payload }).where(eq(s.jobs.id, existing.id)).run();
      return db.select().from(s.jobs).where(eq(s.jobs.id, existing.id)).get()!;
    }
    return existing;
  }
  const job: s.Job = { id: newId("job"), kind, payload, status: "queued", attempts: 0, maxAttempts: opts.maxAttempts ?? 5, runAt: opts.runAt ?? t, leaseUntil: null, leaseOwner: null, idempotencyKey, lastError: null, createdAt: t, updatedAt: t };
  db.insert(s.jobs).values(job).run();
  return job;
}

/** Claims one runnable job (queued and due, or running with an expired lease) using a single conditional update. */
export function claimJob(db: Db, owner: string): s.Job | null {
  const t = now();
  const candidate = db
    .select()
    .from(s.jobs)
    .where(or(and(eq(s.jobs.status, "queued"), lte(s.jobs.runAt, t)), and(eq(s.jobs.status, "running"), lt(s.jobs.leaseUntil, t))))
    .orderBy(s.jobs.runAt)
    .limit(1)
    .get();
  if (!candidate) return null;
  const res = db
    .update(s.jobs)
    .set({ status: "running", leaseOwner: owner, leaseUntil: t + LEASE_MS, attempts: sql`${s.jobs.attempts} + 1`, updatedAt: t })
    .where(and(eq(s.jobs.id, candidate.id), or(and(eq(s.jobs.status, "queued"), lte(s.jobs.runAt, t)), and(eq(s.jobs.status, "running"), lt(s.jobs.leaseUntil, t)))))
    .run();
  if (res.changes !== 1) return null;
  return db.select().from(s.jobs).where(eq(s.jobs.id, candidate.id)).get()!;
}

export function completeJob(db: Db, job: s.Job) {
  db.update(s.jobs).set({ status: "succeeded", leaseUntil: null, leaseOwner: null, updatedAt: now() }).where(eq(s.jobs.id, job.id)).run();
}

export function backoffMs(attempt: number): number {
  return Math.min(60_000, 1000 * 2 ** Math.max(0, attempt - 1));
}

export function failJob(db: Db, job: s.Job, error: string) {
  const t = now();
  const dead = job.attempts >= job.maxAttempts;
  db.update(s.jobs)
    .set({ status: dead ? "dead" : "queued", runAt: dead ? job.runAt : t + backoffMs(job.attempts), leaseUntil: null, leaseOwner: null, lastError: error.slice(0, 2000), updatedAt: t })
    .where(eq(s.jobs.id, job.id))
    .run();
}

export function pendingJobCount(db: Db): number {
  return db.select().from(s.jobs).where(or(eq(s.jobs.status, "queued"), eq(s.jobs.status, "running"))).all().length;
}
