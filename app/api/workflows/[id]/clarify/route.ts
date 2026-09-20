import { z } from "zod";
import { db, error, json, parseBody } from "@/lib/api/http";
import { answerClarification, getWorkflow } from "@/lib/workflows/service";

const Schema = z.object({ answers: z.record(z.string(), z.string().max(500)) });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = await parseBody(req, Schema);
  if (!parsed.ok) return parsed.response;
  const d = db();
  if (!getWorkflow(d, id)) return error("Workflow not found.", 404);
  try {
    return json({ workflow: answerClarification(d, id, parsed.value.answers) });
  } catch (e) {
    return error(e instanceof Error ? e.message : "Could not record the answer.", 409);
  }
}
