import { z } from "zod";
import { db, error, json, parseBody } from "@/lib/api/http";
import { getWorkflow, retryTask } from "@/lib/workflows/service";

const Schema = z.object({ taskId: z.string().min(1) });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = await parseBody(req, Schema);
  if (!parsed.ok) return parsed.response;
  const d = db();
  if (!getWorkflow(d, id)) return error("Workflow not found.", 404);
  retryTask(d, parsed.value.taskId);
  return json({ ok: true });
}
