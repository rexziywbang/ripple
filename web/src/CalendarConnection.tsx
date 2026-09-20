import { useEffect, useId, useRef, useState } from "react";
import { CalendarDays, Check, CircleAlert, Clock3, ExternalLink, LoaderCircle, RefreshCw } from "lucide-react";
import "./calendar-connection.css";

type CalendarJob = { projectId: string; provider: string; status: string };
type CalendarConfig = { calendarEventUrl?: string };
export function calendarEventLink(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.hostname !== "calendar.google.com" || url.username || url.password || (url.port && url.port !== "443")) return;
    return url.href;
  } catch { return; }
}
export function calendarQueueCounts(jobs: readonly CalendarJob[], projectId: string) {
  const relevant = jobs.filter(job => job.projectId === projectId && job.provider === "google_calendar");
  return { queued: relevant.filter(job => job.status === "queued").length, running: relevant.filter(job => job.status === "running").length };
}

export default function CalendarConnection({ projectId, onSaved }: { projectId: string; onSaved: () => void }) {
  const inputId = useId();
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState("");
  const [loadedProject, setLoadedProject] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [jobsError, setJobsError] = useState(false);
  const [queue, setQueue] = useState({ queued: 0, running: 0 });
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const mutation = useRef<AbortController | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    let queueController: AbortController | null = null;
    let polling = false;
    mutation.current?.abort(); busy.current = false;
    setDraft(""); setSaved(""); setLoadedProject(""); setLoading(true); setSaving(false); setError(""); setQueue({ queued: 0, running: 0 });
    const currentResponse = () => !controller.signal.aborted && generation.current === current;
    void (async () => {
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/integrations`, { signal: controller.signal });
        const result = await response.json() as CalendarConfig & { error?: string };
        if (!response.ok) throw new Error(result.error || "Couldn’t load the Calendar configuration.");
        if (!currentResponse()) return;
        const value = typeof result.calendarEventUrl === "string" ? result.calendarEventUrl : "";
        setDraft(value); setSaved(value); setLoadedProject(projectId);
      } catch (cause) { if (currentResponse()) setError(cause instanceof Error ? cause.message : "Couldn’t load the Calendar configuration."); }
      finally { if (currentResponse()) setLoading(false); }
    })();
    const readQueue = async () => {
      if (polling || !currentResponse()) return;
      polling = true;
      queueController = new AbortController();
      try {
        const response = await fetch(`/api/bridge/jobs?projectId=${encodeURIComponent(projectId)}`, { signal: queueController.signal });
        const jobs = await response.json();
        if (!response.ok || !Array.isArray(jobs)) throw new Error("Queue unavailable");
        if (!currentResponse()) return;
        setQueue(calendarQueueCounts(jobs, projectId)); setJobsError(false);
      } catch { if (currentResponse()) setJobsError(true); }
      finally { polling = false; }
    };
    void readQueue();
    const timer = window.setInterval(() => void readQueue(), 3000);
    return () => { controller.abort(); queueController?.abort(); mutation.current?.abort(); window.clearInterval(timer); generation.current++; };
  }, [projectId, reload]);

  async function save(remove = false) {
    if (busy.current || loading || loadedProject !== projectId) return;
    const next = remove ? "" : calendarEventLink(draft);
    if (next === undefined) { setError("Use an HTTPS event link from calendar.google.com."); return; }
    const current = generation.current;
    const controller = new AbortController(); mutation.current = controller;
    busy.current = true; setSaving(true); setError("");
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/integrations`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ calendarEventUrl: next }), signal: controller.signal,
      });
      const result = await response.json() as CalendarConfig & { error?: string };
      if (!response.ok) throw new Error(result.error || "Couldn’t save the Calendar link.");
      if (controller.signal.aborted || generation.current !== current) return;
      const value = typeof result.calendarEventUrl === "string" ? result.calendarEventUrl : "";
      setSaved(value); setDraft(value); onSaved();
    } catch (cause) { if (!controller.signal.aborted && generation.current === current) setError(cause instanceof Error ? cause.message : "Couldn’t save the Calendar link."); }
    finally { if (!controller.signal.aborted && generation.current === current) { busy.current = false; mutation.current = null; setSaving(false); } }
  }

  const linkedUrl = calendarEventLink(saved);
  const disabled = loading || saving || loadedProject !== projectId;
  const counts = [queue.queued ? `${queue.queued} ${queue.queued === 1 ? "update" : "updates"} queued` : "", queue.running ? `${queue.running} in progress` : ""].filter(Boolean).join(" · ");
  return <section className="calendar-connection" aria-labelledby={`${inputId}-heading`}>
    <header className="cc-heading"><span className="cc-icon"><CalendarDays size={20} strokeWidth={1.7} /></span><div><h2 id={`${inputId}-heading`}>Google Calendar</h2><p>Local browser sync. Updates wait in a queue until completed in Google Calendar on this computer.</p></div>{linkedUrl && <span className="cc-configured"><Check size={11} />Configured</span>}</header>
    {loading ? <p className="cc-loading" role="status"><LoaderCircle size={14} className="cc-spin" />Loading Calendar link…</p> : <form className="cc-form" onSubmit={event => { event.preventDefault(); void save(); }}>
      <label htmlFor={inputId}><span>Event link</span><input id={inputId} type="url" autoComplete="off" placeholder="https://calendar.google.com/calendar/…" value={draft} disabled={disabled} onChange={event => setDraft(event.target.value)} /></label>
      {error && <div className="cc-error" role="alert"><CircleAlert size={13} /><span>{error}</span>{loadedProject !== projectId && <button type="button" onClick={() => setReload(value => value + 1)}><RefreshCw size={12} />Retry</button>}</div>}
      <footer><div className="cc-controls"><button type="submit" className="cc-save" disabled={disabled || !draft.trim() || draft.trim() === saved}>{saving && <LoaderCircle size={12} className="cc-spin" />}{saving ? "Saving…" : saved ? "Save link" : "Link event"}</button>{saved && <button type="button" className="cc-remove" disabled={disabled} onClick={() => void save(true)}>Remove link</button>}</div>{linkedUrl && <a href={linkedUrl} target="_blank" rel="noreferrer">Open linked event<ExternalLink size={12} /></a>}</footer>
      {!jobsError && counts && <p className="cc-queue" role="status"><Clock3 size={13} />{counts}</p>}
      {jobsError && <p className="cc-queue">Sync status is temporarily unavailable.</p>}
    </form>}
  </section>;
}
