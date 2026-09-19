import { z } from "zod";
import { db, json, parseBody } from "@/lib/api/http";
import { projectList } from "@/lib/api/snapshot";
import { createBlankProject } from "@/lib/db/seed";

export async function GET() {
  return json({ projects: projectList(db()) });
}

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  eventTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  timezone: z.string().min(1).max(64),
  attendance: z.number().int().min(1).max(100000),
  budgetCents: z.number().int().min(0),
  folderPath: z.string().max(300).optional(),
});

export async function POST(req: Request) {
  const body = await parseBody(req, CreateSchema);
  if (!body.ok) return body.response;
  const project = createBlankProject(db(), body.value);
  return json({ project }, 201);
}
