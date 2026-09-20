import { and, eq } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import * as s from "@/lib/db/schema";
import { now } from "@/lib/domain/ids";
import type { FileAdapter, InvitationAdapter } from "./types";

/**
 * Demo Dropbox: the "remote" file is the stored document revision. Writing requires the caller's expected revision to
 * match; the demo controls can bump the remote revision to rehearse a conflict.
 */
export function demoFileAdapter(db: Db, projectId: string): FileAdapter {
  return {
    provider: "dropbox",
    mode: "demo",
    async write({ path, expectedRevision }) {
      const doc = db.select().from(s.sourceDocuments).where(and(eq(s.sourceDocuments.projectId, projectId), eq(s.sourceDocuments.path, path))).get();
      const current = doc?.revision ?? null;
      if (doc && expectedRevision !== null && current !== expectedRevision) {
        return { ok: false, kind: "conflict", error: `Remote revision ${current} differs from the revision this update was based on (${expectedRevision}).`, currentRevision: current ?? undefined };
      }
      const n = (doc?.syncedRevision ?? 0) + 1;
      return { ok: true, revision: `rev-demo-${n}`, simulated: true };
    },
    async read(path) {
      const doc = db.select().from(s.sourceDocuments).where(and(eq(s.sourceDocuments.projectId, projectId), eq(s.sourceDocuments.path, path))).get();
      return doc ? { content: doc.content, revision: doc.revision ?? "rev-demo-1" } : null;
    },
  };
}

export function liveDropboxToken(): string | null {
  return process.env.DROPBOX_ACCESS_TOKEN ?? null;
}

/** Live Dropbox: files/upload in update mode so a changed remote rev is a conflict, never an overwrite. */
export function liveDropboxAdapter(token: string, root: string): FileAdapter {
  const full = (p: string) => (p.startsWith("/") ? p : `${root.replace(/\/$/, "")}/${p}`);
  return {
    provider: "dropbox",
    mode: "live",
    async write({ path, content, expectedRevision }) {
      const mode = expectedRevision ? { ".tag": "update", update: expectedRevision } : { ".tag": "add" };
      let res: Response;
      try {
        res = await fetch("https://content.dropboxapi.com/2/files/upload", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream", "Dropbox-API-Arg": JSON.stringify({ path: full(path), mode, autorename: false, mute: true }) },
          body: content,
        });
      } catch (e) {
        return { ok: false, kind: "transient", error: (e as Error).message };
      }
      if (res.status === 409) {
        const text = await res.text();
        return { ok: false, kind: "conflict", error: `Dropbox rejected the write: ${text.slice(0, 200)}` };
      }
      if (res.status >= 500 || res.status === 429) return { ok: false, kind: "transient", error: `Dropbox HTTP ${res.status}` };
      if (!res.ok) return { ok: false, kind: "permanent", error: `Dropbox HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
      const json = (await res.json()) as { rev: string };
      return { ok: true, revision: json.rev, simulated: false };
    },
    async read(path) {
      const res = await fetch("https://content.dropboxapi.com/2/files/download", { method: "POST", headers: { authorization: `Bearer ${token}`, "Dropbox-API-Arg": JSON.stringify({ path: full(path) }) } });
      if (!res.ok) return null;
      const meta = JSON.parse(res.headers.get("dropbox-api-result") ?? "{}") as { rev?: string };
      return { content: await res.text(), revision: meta.rev ?? "" };
    },
  };
}

export function fileAdapterFor(db: Db, projectId: string): { adapter: FileAdapter; connection: s.Connection | undefined } {
  const connection = db.select().from(s.connections).where(and(eq(s.connections.projectId, projectId), eq(s.connections.provider, "dropbox"))).get();
  const token = connection?.mode === "live" ? liveDropboxToken() : null;
  const root = (connection?.config.rootPath as string | undefined) ?? "";
  return { adapter: token ? liveDropboxAdapter(token, root) : demoFileAdapter(db, projectId), connection };
}

/** Invitations: demo mode records a simulated update; no live provider is bundled, so live mode yields manual instructions. */
export function invitationAdapterFor(db: Db, projectId: string): InvitationAdapter {
  const connection = db.select().from(s.connections).where(and(eq(s.connections.projectId, projectId), eq(s.connections.provider, "invitations"))).get();
  const live = connection?.mode === "live";
  return {
    provider: "invitations",
    mode: live ? "live" : "demo",
    async update({ idempotencyKey, recipientCount, text }) {
      if (live) return { ok: false, kind: "manual", instructions: `No live invitation provider is configured. Paste the approved text into your invitation tool for ${recipientCount} recipients, then mark this done.\n\n${text}` };
      return { ok: true, simulated: true, recipientCount, receiptId: `demo_inv_${idempotencyKey}_${now()}` };
    },
  };
}
