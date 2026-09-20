import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarDays, Check, ChevronDown, ExternalLink, LoaderCircle, RefreshCw } from "lucide-react";
import "./partiful-connection.css";

type PartifulStatus = "connected" | "not_installed" | "not_authenticated" | "unavailable";
type HostedEvent = { id: string; name: string; date: string | null; url: string };
type StatusResponse = { status: PartifulStatus; message: string; events?: HostedEvent[]; hasMore?: boolean };
const statusLabels: Record<PartifulStatus, string> = {
  connected: "Credentials ready", not_installed: "Setup needed",
  not_authenticated: "Sign-in needed", unavailable: "Unavailable",
};

export function partifulEventUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return;
    if (url.hostname !== "partiful.com" && !url.hostname.endsWith(".partiful.com")) return;
    return url.href;
  } catch { return; }
}
function eventDate(value: string | null) {
  if (!value) return "Date not set";
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value);
  if (!Number.isFinite(parsed.getTime())) return "Date not set";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(parsed);
}

export default function PartifulConnection() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [busy, setBusy] = useState<"status" | "events" | null>("status");
  const [error, setError] = useState("");
  const [events, setEvents] = useState<HostedEvent[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const request = useRef<AbortController | null>(null);

  const load = useCallback(async (resource: "status" | "events") => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(resource);
    setError("");
    if (resource === "events") setEvents(null);
    try {
      const response = await fetch(`/api/partiful/${resource}`, { signal: controller.signal });
      const result = await response.json() as StatusResponse & { error?: string };
      if (!response.ok) throw new Error(result.error || result.message || "Couldn’t check Partiful.");
      if (controller.signal.aborted) return;
      if (!Object.hasOwn(statusLabels, result.status)) throw new Error("Partiful returned an unexpected status.");
      setStatus({ status: result.status, message: result.message });
      if (result.status !== "connected") {
        setEvents(null);
        setExpanded(false);
        setHasMore(false);
      } else if (resource === "events") {
        if (!Array.isArray(result.events)) throw new Error("Couldn’t read the upcoming events.");
        setEvents(result.events.filter(event => typeof event.id === "string" && typeof event.name === "string"));
        setHasMore(result.hasMore === true);
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        setError(cause instanceof Error ? cause.message : "Couldn’t check Partiful.");
        if (resource === "status") setStatus(null);
      }
    } finally {
      if (!controller.signal.aborted) setBusy(null);
    }
  }, []);

  useEffect(() => {
    void load("status");
    return () => request.current?.abort();
  }, [load]);

  const connected = status?.status === "connected";
  return <section className="partiful-connection" aria-label="Partiful connection">
    <header className="pc-heading">
      <span className="pc-icon"><CalendarDays size={20} strokeWidth={1.7} /></span>
      <div><h2>Partiful account</h2><p>Separate local sign-in for viewing your upcoming events.</p></div>
      <span className="pc-status" role="status">{busy === "status" ? <><LoaderCircle size={12} className="pc-spin" />Checking…</> : status ? <>{connected && <Check size={12} />}{statusLabels[status.status]}</> : "Not checked"}</span>
    </header>
    <div className="pc-body">
      {status?.message && <p className="pc-description">{status.message}</p>}
      {status?.status === "not_installed" && <p className="pc-setup">From the Ripple project folder, run <code>npm run partiful:setup</code>, then <code>npm run partiful:login</code>.</p>}
      {error && <p className="pc-error" role="alert">{error}</p>}
      <div className="pc-controls">
        {connected && <button type="button" disabled={!!busy} aria-expanded={expanded} onClick={() => {
          if (expanded) { setExpanded(false); return; }
          setExpanded(true);
          void load("events");
        }}>{busy === "events" ? <LoaderCircle size={13} className="pc-spin" /> : <CalendarDays size={13} />}{busy === "events" ? "Loading events…" : expanded ? "Hide events" : "View upcoming events"}<ChevronDown size={12} className={expanded ? "pc-expanded" : ""} /></button>}
        <button type="button" className="pc-check" disabled={!!busy} onClick={() => void load("status")}><RefreshCw size={12} />Check status</button>
        <a href="https://partiful.com/" target="_blank" rel="noreferrer">Open Partiful<ExternalLink size={12} /></a>
      </div>
      {expanded && connected && events && <div className="pc-events">
        {events.length ? <ul>{events.map(event => {
          const href = typeof event.url === "string" ? partifulEventUrl(event.url) : undefined;
          return <li key={event.id}><CalendarDays size={16} /><div><strong>{event.name || "Untitled event"}</strong><small>{eventDate(event.date)}</small></div>{href && <a href={href} target="_blank" rel="noreferrer" aria-label={`Open ${event.name || "event"} in Partiful`}>Open<ExternalLink size={12} /></a>}</li>;
        })}</ul> : <p>No upcoming events were returned by Partiful.</p>}
        <small className="pc-readonly">{hasMore ? `Showing the first ${events.length} events. Open Partiful to see more.` : "Read-only list. Event changes are made in Partiful."}</small>
      </div>}
    </div>
  </section>;
}
