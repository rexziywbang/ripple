import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, error, json, parseBody } from "@/lib/api/http";
import * as s from "@/lib/db/schema";
import { now } from "@/lib/domain/ids";
import { liveGmailConfig } from "@/lib/integrations/email";
import { liveDropboxToken } from "@/lib/integrations/files";
import { appendEvent } from "@/lib/workflows/events";

const Schema = z.object({
  provider: z.enum(["dropbox", "gmail", "invitations"]),
  mode: z.enum(["demo", "live"]).optional(),
  status: z.enum(["connected", "disconnected"]).optional(),
  nextSendFault: z.enum(["transient", "uncertain", "permanent"]).nullable().optional(),
  bumpDocumentRevision: z.string().optional(),
});

/** Demo controls for a connection: connect/disconnect, switch demo/live (live requires env credentials), rehearse faults. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = await parseBody(req, Schema);
  if (!parsed.ok) return parsed.response;
  const v = parsed.value;
  const d = db();
  const conn = d.select().from(s.connections).where(and(eq(s.connections.projectId, id), eq(s.connections.provider, v.provider))).get();
  if (!conn) return error("Connection not found.", 404);
  const patch: Partial<s.Connection> = { config: { ...conn.config } };
  if (v.mode === "live") {
    const available = v.provider === "gmail" ? !!liveGmailConfig() : v.provider === "dropbox" ? !!liveDropboxToken() : false;
    if (!available) return error(v.provider === "invitations" ? "No live invitation provider is bundled; live mode produces manual instructions only. Set mode to live anyway to rehearse that path." : `Live ${v.provider} credentials are not configured in the environment (see .env.example).`, 409);
    patch.mode = "live";
  } else if (v.mode === "demo") patch.mode = "demo";
  if (v.status) patch.status = v.status;
  if (v.nextSendFault !== undefined) patch.config = { ...patch.config, nextSendFault: v.nextSendFault };
  if (v.bumpDocumentRevision) {
    const doc = d.select().from(s.sourceDocuments).where(and(eq(s.sourceDocuments.projectId, id), eq(s.sourceDocuments.path, v.bumpDocumentRevision))).get();
    if (!doc) return error("Document not found.", 404);
    const rev = `rev-remote-${now()}`;
    d.update(s.sourceDocuments).set({ revision: rev, updatedAt: now() }).where(eq(s.sourceDocuments.id, doc.id)).run();
    appendEvent(d, id, null, "demo.remote_edit", `Simulated someone else editing ${doc.path} in Dropbox (remote revision is now ${rev}).`);
  }
  d.update(s.connections).set({ ...patch, updatedAt: now() }).where(eq(s.connections.id, conn.id)).run();
  appendEvent(d, id, null, "connection.updated", `${v.provider} connection updated: ${[v.mode && `mode ${v.mode}`, v.status, v.nextSendFault !== undefined && `next send fault: ${v.nextSendFault ?? "none"}`].filter(Boolean).join(", ") || "no change"}.`);
  return json({ connection: d.select().from(s.connections).where(eq(s.connections.id, conn.id)).get() });
}
