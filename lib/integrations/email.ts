import { eq, and } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import * as s from "@/lib/db/schema";
import { newId, now } from "@/lib/domain/ids";
import type { EmailAdapter, SendResult } from "./types";

export type SendFault = "transient" | "uncertain" | "permanent" | null;

export function isFixtureAddress(email: string): boolean {
  return /\.example$/i.test(email.trim()) || /@example\.(com|org|net)$/i.test(email.trim());
}

/** Demo adapter: records a simulated send. Honors a one-shot fault stored on the project's gmail connection so failures can be rehearsed. */
export function demoEmailAdapter(db: Db, projectId: string): EmailAdapter {
  return {
    provider: "gmail",
    mode: "demo",
    async send({ idempotencyKey, threadId }) {
      const conn = db.select().from(s.connections).where(and(eq(s.connections.projectId, projectId), eq(s.connections.provider, "gmail"))).get();
      const fault = (conn?.config.nextSendFault as SendFault | undefined) ?? null;
      if (fault) {
        db.update(s.connections).set({ config: { ...conn!.config, nextSendFault: null }, updatedAt: now() }).where(eq(s.connections.id, conn!.id)).run();
        if (fault === "transient") return { ok: false, kind: "transient", error: "Simulated provider outage (503). The message was not sent." };
        if (fault === "permanent") return { ok: false, kind: "permanent", error: "Simulated permanent rejection (invalid recipient)." };
        // uncertain: the provider accepted the message but the response was lost
        const id = `demo_${idempotencyKey}`;
        db.update(s.connections).set({ config: { ...conn!.config, nextSendFault: null, deliveredKeys: [...((conn!.config.deliveredKeys as string[] | undefined) ?? []), idempotencyKey] }, updatedAt: now() }).where(eq(s.connections.id, conn!.id)).run();
        void id;
        return { ok: false, kind: "uncertain", error: "Simulated network drop after the provider accepted the message. Delivery is uncertain; reconcile before retrying." };
      }
      const result: SendResult = { ok: true, providerMessageId: `demo_${idempotencyKey}`, threadId: threadId ?? `thread_demo_${newId("t")}`, simulated: true, sentAt: now() };
      return result;
    },
    async findSent(idempotencyKey) {
      const conn = db.select().from(s.connections).where(and(eq(s.connections.projectId, projectId), eq(s.connections.provider, "gmail"))).get();
      const delivered = (conn?.config.deliveredKeys as string[] | undefined) ?? [];
      if (delivered.includes(idempotencyKey)) return { providerMessageId: `demo_${idempotencyKey}`, threadId: `thread_demo_${idempotencyKey}` };
      return null;
    },
  };
}

export type LiveGmailConfig = { clientId: string; clientSecret: string; refreshToken: string; fromAddress: string };

export function liveGmailConfig(): LiveGmailConfig | null {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, GMAIL_FROM_ADDRESS } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN || !GMAIL_FROM_ADDRESS) return null;
  return { clientId: GMAIL_CLIENT_ID, clientSecret: GMAIL_CLIENT_SECRET, refreshToken: GMAIL_REFRESH_TOKEN, fromAddress: GMAIL_FROM_ADDRESS };
}

async function gmailAccessToken(cfg: LiveGmailConfig): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: cfg.refreshToken, grant_type: "refresh_token" }),
  });
  if (!res.ok) throw new Error(`Gmail token refresh failed: HTTP ${res.status}`);
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("Gmail token refresh returned no access token");
  return json.access_token;
}

function base64Url(input: string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Live adapter using the Gmail REST API (users.messages.send) with an OAuth refresh token. Fixture addresses are refused. */
export function liveGmailAdapter(cfg: LiveGmailConfig): EmailAdapter {
  return {
    provider: "gmail",
    mode: "live",
    async send({ idempotencyKey, to, subject, body, threadId }) {
      const fixture = to.find((t) => isFixtureAddress(t.email));
      if (fixture) return { ok: false, kind: "permanent", error: `Refused: ${fixture.email} is a sample fixture address and cannot be sent to live.` };
      let token: string;
      try {
        token = await gmailAccessToken(cfg);
      } catch (e) {
        return { ok: false, kind: "transient", error: (e as Error).message };
      }
      const raw = [`From: ${cfg.fromAddress}`, `To: ${to.map((t) => `${t.name} <${t.email}>`).join(", ")}`, `Subject: ${subject}`, `X-Ripple-Idempotency-Key: ${idempotencyKey}`, "Content-Type: text/plain; charset=utf-8", "", body].join("\r\n");
      let res: Response;
      try {
        res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ raw: base64Url(raw), threadId: threadId ?? undefined }),
        });
      } catch (e) {
        return { ok: false, kind: "uncertain", error: `Network error after submitting to Gmail: ${(e as Error).message}` };
      }
      if (res.status >= 500 || res.status === 429) return { ok: false, kind: "transient", error: `Gmail HTTP ${res.status}` };
      if (!res.ok) return { ok: false, kind: "permanent", error: `Gmail HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
      const json = (await res.json()) as { id: string; threadId: string };
      return { ok: true, providerMessageId: json.id, threadId: json.threadId, simulated: false, sentAt: now() };
    },
    async findSent(idempotencyKey) {
      const token = await gmailAccessToken(cfg);
      const q = encodeURIComponent(`rfc822msgid: OR "X-Ripple-Idempotency-Key: ${idempotencyKey}" in:sent`);
      const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=1`, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`Gmail search HTTP ${res.status}`);
      const json = (await res.json()) as { messages?: { id: string; threadId: string }[] };
      const m = json.messages?.[0];
      return m ? { providerMessageId: m.id, threadId: m.threadId } : null;
    },
  };
}

export function emailAdapterFor(db: Db, projectId: string): { adapter: EmailAdapter; connection: s.Connection | undefined } {
  const connection = db.select().from(s.connections).where(and(eq(s.connections.projectId, projectId), eq(s.connections.provider, "gmail"))).get();
  const live = connection?.mode === "live" ? liveGmailConfig() : null;
  return { adapter: live ? liveGmailAdapter(live) : demoEmailAdapter(db, projectId), connection };
}
