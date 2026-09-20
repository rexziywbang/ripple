import { useEffect, useRef, useState } from "react";
import { Check, ExternalLink, LoaderCircle, Mail, RefreshCw } from "lucide-react";
import "./gmail-api-connection.css";

export type GmailApiStatus = {
  configured: boolean;
  connected: boolean;
  account?: string;
  busy: boolean;
  needsAttention: boolean;
  error?: string;
};

export function googleGmailAuthorizationUrl(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("Google sign-in is unavailable. Try again.");
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.hostname !== "accounts.google.com" || url.username || url.password || url.port
    || !["/o/oauth2/v2/auth", "/o/oauth2/auth"].includes(url.pathname)) throw new Error("Google sign-in is unavailable. Try again.");
  return url.href;
}

/** The same-origin request stores Google's callback cookie before navigation. */
export async function beginGmailConnection(fetcher: typeof fetch = fetch): Promise<string> {
  const response = await fetcher("/api/gmail/connect", {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  if (!response.ok) throw new Error("Couldn’t start Gmail sign-in. Try again.");
  const result = await response.json();
  return googleGmailAuthorizationUrl(result.url);
}

type CardProps = {
  status: GmailApiStatus | null;
  loading: boolean;
  connecting: boolean;
  error: string;
  onConnect: () => void;
  onRefresh: () => void;
};

export function GmailApiConnectionCard({ status, loading, connecting, error, onConnect, onRefresh }: CardProps) {
  const connected = status?.configured === true && status.connected === true;
  return <section className="gmail-api-connection" aria-label="Gmail connection" aria-busy={loading || connecting}>
    <div className="gac-main">
      <span className="gac-icon" aria-hidden="true"><Mail size={19} strokeWidth={1.6} /></span>
      <div className="gac-copy"><h3>Gmail</h3>
        <p>{loading ? "Checking connection…" : connected ? status?.account || "Google account connected" : status?.configured === false ? "Gmail setup required" : status ? "Send approved emails directly." : "Connection unavailable"}</p>
      </div>
      <div className="gac-action">
        {loading ? <LoaderCircle size={16} className="gac-spin" aria-label="Checking Gmail" /> : connected ? <span className="gac-connected"><Check size={12} />Connected</span>
          : status?.configured === false ? <a className="gac-setup" href="/api/gmail/setup" target="_blank" rel="noreferrer">Set up Gmail<ExternalLink size={12} /></a>
          : status?.configured ? <button type="button" className="primary compact" disabled={connecting} onClick={onConnect}>{connecting && <LoaderCircle size={13} className="gac-spin" />}{connecting ? "Opening Google…" : "Connect Gmail"}</button>
          : <button type="button" className="text-button" disabled={connecting} onClick={onRefresh}><RefreshCw size={12} />Try again</button>}
      </div>
    </div>
    {!loading && !connected && status && <p className="gac-permission">One-time Google permission to send email. No inbox access.</p>}
    {(error || status?.needsAttention || status?.error) && <div className="gac-error" role="alert">
      <span>{error || status?.error || (status?.needsAttention ? "A send needs checking. Check Sent Mail before trying again." : "Gmail needs attention. Reconnect your account.")}</span>
      {status?.needsAttention ? <span style={{ display: "inline-flex", alignItems: "center", gap: 10, flexShrink: 0 }}><a className="text-button" href="https://mail.google.com/mail/u/0/#sent" target="_blank" rel="noreferrer">View sent mail<ExternalLink size={12} /></a><button className="text-button" type="button" disabled={loading || connecting} onClick={onRefresh}><RefreshCw size={12} />Refresh</button></span>
        : !error && status?.configured && <button className="text-button" type="button" disabled={connecting} onClick={onConnect}>Reconnect</button>}
    </div>}
  </section>;
}

export default function GmailApiConnection() {
  const [status, setStatus] = useState<GmailApiStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const connectLock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    let reading = false;
    async function load() {
      if (reading) return;
      reading = true;
      try {
        const response = await fetch("/api/gmail/status", { credentials: "same-origin", signal: controller.signal });
        if (!response.ok) throw new Error("Couldn’t check Gmail. Try again.");
        const result = await response.json();
        if (typeof result.configured !== "boolean" || typeof result.connected !== "boolean") throw new Error("Couldn’t check Gmail. Try again.");
        if (controller.signal.aborted) return;
        setStatus(result); setError("");
      } catch {
        if (!controller.signal.aborted) { setStatus(null); setError("Couldn’t check Gmail. Try again."); }
      } finally {
        reading = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    setLoading(true);
    void load();
    const onFocus = () => { void load(); };
    window.addEventListener("focus", onFocus);
    return () => { controller.abort(); window.removeEventListener("focus", onFocus); };
  }, [attempt]);

  async function connect() {
    if (connectLock.current || !status?.configured) return;
    connectLock.current = true; setConnecting(true); setError("");
    try {
      const url = await beginGmailConnection();
      if (mounted.current) window.location.assign(url);
    } catch {
      if (mounted.current) setError("Couldn’t start Gmail sign-in. Try again.");
    } finally {
      connectLock.current = false;
      if (mounted.current) setConnecting(false);
    }
  }

  return <GmailApiConnectionCard status={status} loading={loading} connecting={connecting} error={error} onConnect={() => void connect()} onRefresh={() => setAttempt(value => value + 1)} />;
}
