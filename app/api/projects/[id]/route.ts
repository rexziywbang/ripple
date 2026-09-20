import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, error, json, parseBody } from "@/lib/api/http";
import { projectSnapshot } from "@/lib/api/snapshot";
import * as s from "@/lib/db/schema";
import { now } from "@/lib/domain/ids";
import { appendEvent } from "@/lib/workflows/events";
import { setFact } from "@/lib/workflows/service";

type Params = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Params) {
  const { id } = await params;
  const after = new URL(req.url).searchParams.get("eventsAfter");
  const snap = projectSnapshot(db(), id, { eventsAfter: after ? Number(after) : undefined });
  if (!snap) return error("Project not found.", 404);
  return json(snap);
}

const PatchSchema = z.object({ name: z.string().trim().min(1).max(120).optional(), status: z.enum(["active", "closed"]).optional() });

export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  const body = await parseBody(req, PatchSchema);
  if (!body.ok) return body.response;
  const d = db();
  const project = d.select().from(s.projects).where(eq(s.projects.id, id)).get();
  if (!project) return error("Project not found.", 404);
  d.update(s.projects).set({ ...body.value, updatedAt: now() }).where(eq(s.projects.id, id)).run();
  if (body.value.name && body.value.name !== project.name) {
    setFact(d, id, "event.name", body.value.name, "confirmed", { type: "user" });
    appendEvent(d, id, null, "project.renamed", `Project renamed from “${project.name}” to “${body.value.name}”.`);
  }
  if (body.value.status && body.value.status !== project.status) appendEvent(d, id, null, body.value.status === "closed" ? "project.closed" : "project.reopened", body.value.status === "closed" ? "Project closed." : "Project reopened.");
  return json({ project: d.select().from(s.projects).where(eq(s.projects.id, id)).get() });
}
