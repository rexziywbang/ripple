import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, error, json, parseBody } from "@/lib/api/http";
import * as s from "@/lib/db/schema";
import { newId } from "@/lib/domain/ids";
import { enqueueJob } from "@/lib/jobs/queue";
import { inboundFixtureById } from "@/fixtures/inbound-messages";

const Schema = z.object({
  fixtureId: z.string().min(1).optional(),
  providerMessageId: z.string().min(1).optional(),
  from: z.string().email().optional(),
  subject: z.string().max(300).optional(),
  body: z.string().max(20000).optional(),
});

/** Files a simulated inbound email through the worker queue, exactly as a Gmail poll would. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = await parseBody(req, Schema);
  if (!parsed.ok) return parsed.response;
  const d = db();
  const project = d.select().from(s.projects).where(eq(s.projects.id, id)).get();
  if (!project) return error("Project not found.", 404);
  const v = parsed.value;
  let payload: Record<string, unknown>;
  if (v.fixtureId) {
    const f = inboundFixtureById(v.fixtureId);
    if (!f) return error("Unknown fixture.", 404);
    const eng = d.select().from(s.vendorEngagements).where(eq(s.vendorEngagements.id, f.engagementId)).get();
    payload = { projectId: id, provider: "gmail", providerMessageId: v.providerMessageId ?? newId("demo_msg"), threadId: eng?.threadId ?? null, from: f.from, subject: f.subject, body: f.body, simulated: true, fixtureLabel: f.label };
  } else {
    if (!v.from || !v.subject || !v.body) return error("Provide fixtureId, or from + subject + body.");
    payload = { projectId: id, provider: "gmail", providerMessageId: v.providerMessageId ?? newId("demo_msg"), threadId: null, from: v.from, subject: v.subject, body: v.body, simulated: true, fixtureLabel: "Custom demo email" };
  }
  const job = enqueueJob(d, "message.process", payload, { idempotencyKey: `inbound:${payload.providerMessageId}` });
  return json({ job: { id: job.id, status: job.status } }, 202);
}
