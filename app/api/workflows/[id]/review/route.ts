import { z } from "zod";
import { db, error, json, parseBody } from "@/lib/api/http";
import { getWorkflow, submitReview } from "@/lib/workflows/service";

const Schema = z.object({ decisions: z.array(z.object({ proposalId: z.string().min(1), decision: z.enum(["approve", "reject"]) })).min(1) });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = await parseBody(req, Schema);
  if (!parsed.ok) return parsed.response;
  const d = db();
  if (!getWorkflow(d, id)) return error("Workflow not found.", 404);
  try {
    return json({ workflow: submitReview(d, id, parsed.value.decisions) });
  } catch (e) {
    return error(e instanceof Error ? e.message : "Review failed.", 409);
  }
}
