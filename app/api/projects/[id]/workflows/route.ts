import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, error, json, parseBody } from "@/lib/api/http";
import * as s from "@/lib/db/schema";
import { AREAS } from "@/lib/domain/areas";
import { createWorkflow } from "@/lib/workflows/service";

const Schema = z.object({ area: z.enum(AREAS.map((a) => a.id) as [string, ...string[]]), request: z.string().trim().min(3).max(2000) });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await parseBody(req, Schema);
  if (!body.ok) return body.response;
  const d = db();
  const project = d.select().from(s.projects).where(eq(s.projects.id, id)).get();
  if (!project) return error("Project not found.", 404);
  if (project.status === "closed") return error("Project is closed. Reopen it to make changes.", 409);
  const workflow = createWorkflow(d, { projectId: id, area: body.value.area, request: body.value.request });
  return json({ workflow }, 201);
}
