import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import * as s from "@/lib/db/schema";
import { now } from "@/lib/domain/ids";
import { claimJob, completeJob, failJob, type JobKind } from "./queue";
import { planWorkflow, executeWorkflow } from "@/lib/workflows/service";
import { processInboundMessage, type InboundInput } from "@/lib/workflows/inbound";

export const WORKER_STALE_MS = 15_000;

export async function runJob(db: Db, job: s.Job): Promise<void> {
  const kind = job.kind as JobKind;
  switch (kind) {
    case "workflow.plan":
      await planWorkflow(db, String(job.payload.workflowId));
      return;
    case "workflow.execute":
      await executeWorkflow(db, String(job.payload.workflowId));
      return;
    case "message.process":
      processInboundMessage(db, job.payload as unknown as InboundInput);
      return;
    default:
      throw new Error(`Unknown job kind ${job.kind}`);
  }
}

/** Claims and runs jobs until the queue is drained. Returns the number of jobs processed. */
export async function drainJobs(db: Db, owner: string, limit = 100): Promise<number> {
  let n = 0;
  while (n < limit) {
    const job = claimJob(db, owner);
    if (!job) break;
    n++;
    try {
      await runJob(db, job);
      completeJob(db, job);
    } catch (e) {
      failJob(db, job, (e as Error).stack ?? String(e));
    }
  }
  return n;
}

export function heartbeat(db: Db, workerId: string, startedAt: number) {
  const t = now();
  const row = db.select().from(s.workerHeartbeats).where(eq(s.workerHeartbeats.id, workerId)).get();
  if (row) db.update(s.workerHeartbeats).set({ lastSeen: t }).where(eq(s.workerHeartbeats.id, workerId)).run();
  else db.insert(s.workerHeartbeats).values({ id: workerId, lastSeen: t, startedAt }).run();
}

export function workerStatus(db: Db): { online: boolean; lastSeen: number | null; workers: number } {
  const rows = db.select().from(s.workerHeartbeats).all();
  const t = now();
  const live = rows.filter((r) => t - r.lastSeen < WORKER_STALE_MS);
  return { online: live.length > 0, lastSeen: rows.length ? Math.max(...rows.map((r) => r.lastSeen)) : null, workers: live.length };
}

/** Long-running loop for the worker process. */
export async function workerLoop(db: Db, workerId: string, opts: { pollMs?: number; signal?: AbortSignal } = {}) {
  const startedAt = now();
  const pollMs = opts.pollMs ?? 500;
  heartbeat(db, workerId, startedAt);
  let lastBeat = now();
  while (!opts.signal?.aborted) {
    const n = await drainJobs(db, workerId, 20);
    if (now() - lastBeat > 3000 || n > 0) {
      heartbeat(db, workerId, startedAt);
      lastBeat = now();
    }
    if (n === 0) await new Promise((r) => setTimeout(r, pollMs));
  }
}
