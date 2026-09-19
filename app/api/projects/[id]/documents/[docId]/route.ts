import { db, error, json } from "@/lib/api/http";
import { documentContent } from "@/lib/api/snapshot";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; docId: string }> }) {
  const { id, docId } = await params;
  const doc = documentContent(db(), id, docId);
  if (!doc) return error("Document not found.", 404);
  return json({ document: doc });
}
