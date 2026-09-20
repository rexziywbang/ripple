import { useEffect, useId, useRef, useState } from "react";
import { Check, CircleAlert, Clock3, ExternalLink, Link2, LoaderCircle, RefreshCw } from "lucide-react";
import "./invitation-connections.css";

type Provider = "evite" | "partiful";
type LinkValues = { eviteEventUrl: string; partifulEventUrl: string };
type InviteReceipt = { completedAt?: string; url?: string; detail?: string };
type InviteJob = { projectId: string; provider: string; action: string; status: string; revision?: number; createdAt?: string; updatedAt?: string; error?: string; receipt?: InviteReceipt };
const providers = [
  { id: "evite", name: "Evite", field: "eviteEventUrl", placeholder: "https://www.evite.com/event/…" },
  { id: "partiful", name: "Partiful", field: "partifulEventUrl", placeholder: "https://partiful.com/e/…" },
] as const;
const emptyLinks: LinkValues = { eviteEventUrl: "", partifulEventUrl: "" };
const normalize = (config: Partial<LinkValues>): LinkValues => ({
  eviteEventUrl: typeof config.eviteEventUrl === "string" ? config.eviteEventUrl : "",
  partifulEventUrl: typeof config.partifulEventUrl === "string" ? config.partifulEventUrl : "",
});
export function invitationEventLink(provider: Provider, value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    const hosts = provider === "evite" ? ["evite.com", "www.evite.com", "evite.me", "www.evite.me"] : ["partiful.com", "www.partiful.com"];
    if (url.protocol !== "https:" || !hosts.includes(url.hostname) || url.username || url.password || (url.port && url.port !== "443")) return;
    return url.href;
  } catch { return; }
}
export function invitationQueueCounts(jobs: readonly InviteJob[], projectId: string, provider: Provider) {
  const relevant = jobs.filter(job => job.projectId === projectId && job.provider === provider && job.action === "update_event");
  return { queued: relevant.filter(job => job.status === "queued").length, running: relevant.filter(job => job.status === "running").length };
}


export function invitationSyncFeedback(jobs: readonly InviteJob[], projectId: string, provider: Provider) {
  const timestamp = (value?: string) => Date.parse(value || "") || 0;
  const ordered = jobs.filter(job => job.projectId === projectId && job.provider === provider && job.action === "update_event")
    .slice().sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt) || (b.revision ?? 0) - (a.revision ?? 0) || timestamp(b.updatedAt) - timestamp(a.updatedAt));
  const latest = ordered[0];
  const message = latest?.status === "failed" ? latest.error?.replace(/\s+/g, " ").trim() || "Open the linked event and check its guest details." : undefined;
  const receipt = ordered.find(job => job.status === "completed" && job.receipt?.detail?.trim() && timestamp(job.receipt.completedAt))?.receipt;
  return { failure: message && (message.length > 180 ? `${message.slice(0, 177)}…` : message), receipt };
}

export default function InvitationConnections({ projectId, onSaved }: { projectId: string; onSaved: () => void }) {
  const baseId = useId();
  const [draft, setDraft] = useState<LinkValues>(emptyLinks);
  const [saved, setSaved] = useState<LinkValues>(emptyLinks);
  const [loadedProject, setLoadedProject] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [jobs, setJobs] = useState<InviteJob[]>([]);
  const [jobsError, setJobsError] = useState(false);
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const busy = useRef(false);
  const mutation = useRef<AbortController | null>(null);

  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    let pollController: AbortController | null = null;
    let polling = false;
    mutation.current?.abort(); busy.current = false;
    setDraft(emptyLinks); setSaved(emptyLinks); setLoadedProject(""); setLoading(true); setSaving(false); setError(""); setJobs([]); setJobsError(false);
    const isCurrent = () => !controller.signal.aborted && generation.current === current;
    void (async () => {
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/integrations`, { signal: controller.signal });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Couldn’t load invitation links.");
        if (!isCurrent()) return;
        const links = normalize(result); setDraft(links); setSaved(links); setLoadedProject(projectId);
      } catch (cause) { if (isCurrent()) setError(cause instanceof Error ? cause.message : "Couldn’t load invitation links."); }
      finally { if (isCurrent()) setLoading(false); }
    })();
    const readJobs = async () => {
      if (polling || !isCurrent()) return;
      polling = true; pollController = new AbortController();
      try {
        const response = await fetch(`/api/bridge/jobs?projectId=${encodeURIComponent(projectId)}`, { signal: pollController.signal });
        const result = await response.json();
        if (!response.ok || !Array.isArray(result)) throw new Error("Queue unavailable");
        if (isCurrent()) { setJobs(result); setJobsError(false); }
      } catch { if (isCurrent()) setJobsError(true); }
      finally { polling = false; }
    };
    void readJobs();
    const timer = window.setInterval(() => void readJobs(), 4000);
    return () => { controller.abort(); pollController?.abort(); mutation.current?.abort(); window.clearInterval(timer); generation.current++; };
  }, [projectId, reload]);

  async function save() {
    if (busy.current || loading || loadedProject !== projectId) return;
    const patch: Partial<LinkValues> = {};
    for (const provider of providers) {
      const text = draft[provider.field].trim();
      if (text === saved[provider.field]) continue;
      const link = text ? invitationEventLink(provider.id, text) : "";
      if (link === undefined) { setError(`Use an HTTPS ${provider.name} event link.`); return; }
      patch[provider.field] = link;
    }
    if (!Object.keys(patch).length) return;
    const current = generation.current;
    const controller = new AbortController(); mutation.current = controller;
    busy.current = true; setSaving(true); setError("");
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/integrations`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch), signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Couldn’t save invitation links.");
      if (controller.signal.aborted || generation.current !== current) return;
      const links = normalize(result); setSaved(links); setDraft(links); onSaved();
    } catch (cause) { if (!controller.signal.aborted && generation.current === current) setError(cause instanceof Error ? cause.message : "Couldn’t save invitation links."); }
    finally { if (!controller.signal.aborted && generation.current === current) { busy.current = false; mutation.current = null; setSaving(false); } }
  }

  const disabled = loading || saving || loadedProject !== projectId;
  const changed = providers.some(provider => draft[provider.field].trim() !== saved[provider.field]);
  return <section className="invitation-connections" aria-labelledby={`${baseId}-heading`}>
    <header className="ic-heading"><span className="ic-icon"><Link2 size={19} /></span><div><h2 id={`${baseId}-heading`}>Invitation event links</h2><p>Only approved guest details are queued for local browser sync. Linking an event does not send invitations.</p></div></header>
    {loading ? <p className="ic-loading" role="status"><LoaderCircle size={14} className="ic-spin" />Loading event links…</p> : <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="ic-fields">{providers.map(provider => {
        const url = invitationEventLink(provider.id, saved[provider.field]);
        const counts = invitationQueueCounts(jobs, projectId, provider.id);
        const feedback = invitationSyncFeedback(jobs, projectId, provider.id);
        const receiptLink = feedback.receipt?.url && invitationEventLink(provider.id, feedback.receipt.url);
        return <div className="ic-provider" key={provider.id}>
          <div className="ic-label"><label htmlFor={`${baseId}-${provider.id}`}>{provider.name}</label>{url && <span><Check size={10} />Link configured</span>}</div>
          <input id={`${baseId}-${provider.id}`} type="url" value={draft[provider.field]} placeholder={provider.placeholder} autoComplete="off" disabled={disabled} onChange={event => setDraft(current => ({ ...current, [provider.field]: event.target.value }))} />
          {url && <a className="ic-open" href={url} target="_blank" rel="noreferrer">Open linked event<ExternalLink size={11} /></a>}
          {!jobsError && (counts.queued > 0 || counts.running > 0) && <p className="ic-queue" role="status"><Clock3 size={12} />{[counts.queued ? `${counts.queued} detail ${counts.queued === 1 ? "update" : "updates"} queued` : "", counts.running ? `${counts.running} in progress` : ""].filter(Boolean).join(" · ")}</p>}
          {!jobsError && feedback.failure && <div className="ic-sync-failure"><CircleAlert size={12} /><div><strong>Sync needs attention</strong><p>{feedback.failure}</p></div></div>}
          {!jobsError && feedback.receipt && <p className="ic-verified"><Check size={11} /><span>Last update verified · {new Date(feedback.receipt.completedAt!).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>{receiptLink && <a href={receiptLink} target="_blank" rel="noreferrer">View<ExternalLink size={10} /></a>}</p>}
        </div>;
      })}</div>
      {error && <p className="ic-error" role="alert">{error}{loadedProject !== projectId && <button type="button" onClick={() => setReload(value => value + 1)}><RefreshCw size={12} />Retry</button>}</p>}
      <footer><button type="submit" disabled={disabled || !changed}>{saving && <LoaderCircle size={12} className="ic-spin" />}{saving ? "Saving…" : "Save links"}</button><span>Clear a field to remove its link.</span></footer>
      {jobsError && <p className="ic-queue">Sync status is temporarily unavailable.</p>}
    </form>}
  </section>;
}
