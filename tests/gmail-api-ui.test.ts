import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { beginGmailConnection, GmailApiConnectionCard, googleGmailAuthorizationUrl, type GmailApiStatus } from "../web/src/GmailApiConnection";
import EventConnections from "../web/src/EventConnections";

const base: GmailApiStatus = { configured: false, connected: false, busy: false, needsAttention: false };
const render = (status: GmailApiStatus | null, options: { loading?: boolean; connecting?: boolean; error?: string } = {}) => renderToStaticMarkup(createElement(GmailApiConnectionCard, { status, loading: options.loading ?? false, connecting: options.connecting ?? false, error: options.error ?? "", onConnect: () => {}, onRefresh: () => {} }));

describe("direct Gmail connection", () => {
  it("offers local setup when OAuth is not configured, never claiming a saved email is connected", () => {
    const html = render({ ...base, account: "saved@gmail.com" });
    expect(html).toContain("Gmail setup required");
    expect(html).toContain('href="/api/gmail/setup"');
    expect(html).not.toContain("Connected");
    expect(html).not.toContain("saved@gmail.com");
    expect(html).not.toContain("Connect Gmail");
  });

  it("requests one-time send-only Google permission for a configured but disconnected API", () => {
    const html = render({ ...base, configured: true, account: "old@gmail.com" });
    expect(html).toContain("Connect Gmail");
    expect(html).toContain("One-time Google permission to send email. No inbox access.");
    expect(html).not.toContain("Connected");
    expect(html).not.toContain("old@gmail.com");
  });

  it("shows the verified account and resolves uncertain sends through Sent Mail rather than reconnection", () => {
    const connected = render({ ...base, configured: true, connected: true, account: "organizer@gmail.com" });
    expect(connected).toContain("organizer@gmail.com");
    expect(connected).toContain("Connected");
    expect(connected).not.toContain("Connect Gmail");
    expect(connected).not.toContain("One-time Google permission");
    const attention = render({ ...base, configured: true, connected: true, needsAttention: true, error: "The send outcome is unknown. Check Sent Mail before retrying." });
    expect(attention).toContain("The send outcome is unknown. Check Sent Mail before retrying.");
    expect(attention).toContain('href="https://mail.google.com/mail/u/0/#sent"');
    expect(attention).toContain("View sent mail");
    expect(attention).toContain("Refresh");
    expect(attention).not.toContain("Reconnect");
    const connectionError = render({ ...base, configured: true, error: "Google permission expired. Reconnect Gmail." });
    expect(connectionError).toContain("Google permission expired. Reconnect Gmail.");
    expect(connectionError).toContain("Reconnect</button>");
    expect(connectionError).not.toContain("View sent mail");
  });

  it("disables repeated sign-in attempts and makes loading and failed reads explicit", () => {
    expect(render(null, { loading: true })).toContain("Checking connection");
    const connecting = render({ ...base, configured: true }, { connecting: true });
    expect(connecting).toContain("Opening Google");
    expect(connecting).toMatch(/<button[^>]*disabled=""/);
    const failed = render(null, { error: "Couldn’t check Gmail. Try again." });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Connection unavailable");
    expect(failed).not.toContain("Connected");
  });

  it("preserves the official callback cookie and validates Google before navigation", async () => {
    const url = "https://accounts.google.com/o/oauth2/v2/auth?client_id=public-client&scope=email";
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ url }), { status: 200, headers: { "Content-Type": "application/json" } }));
    expect(await beginGmailConnection(fetcher as typeof fetch)).toBe(url);
    expect(fetcher).toHaveBeenCalledWith("/api/gmail/connect", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}" });
    for (const unsafe of ["javascript:alert(1)", "https://accounts.google.com.evil.com/o/oauth2/v2/auth", "https://evil.com/o/oauth2/v2/auth", "http://accounts.google.com/o/oauth2/v2/auth", "https://accounts.google.com/logout", "https://user:secret@accounts.google.com/o/oauth2/v2/auth"]) expect(() => googleGmailAuthorizationUrl(unsafe)).toThrow();
    await expect(beginGmailConnection(vi.fn(async () => new Response("Provider detail", { status: 400 })) as typeof fetch)).rejects.toThrow("Couldn’t start Gmail sign-in");
  });

  it("replaces the saved Email row while leaving Dropbox and the other event destinations available", () => {
    const html = renderToStaticMarkup(createElement(EventConnections, { projectId: "event", gmailConnection: createElement("div", { "data-testid": "verified-gmail" }, "Official Gmail") }));
    expect(html).toContain("Official Gmail");
    expect(html).not.toContain("Vendor conversations");
    for (const provider of ["Dropbox", "Google Calendar", "Partiful", "Evite"]) expect(html).toContain(provider);
    expect(html).not.toContain("Email stays in Ripple");
  });
});
