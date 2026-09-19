import { db, json } from "@/lib/api/http";
import { markManualDone } from "@/lib/workflows/service";

/** Marks a manual external action (e.g. live invitation update) as done by the organizer. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  markManualDone(db(), id);
  return json({ ok: true });
}
