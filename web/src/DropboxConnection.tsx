import { useEffect, useId, useRef, useState } from "react";
import { Folder, FolderOpen, FilePlus2, FileText, Download, Check, CircleAlert, Clock3, ExternalLink, LoaderCircle, RefreshCw } from "lucide-react";
import "./dropbox-connection.css";

type SyncReceipt = { completedAt?: string; url?: string; detail?: string };
type DropboxJob = { projectId: string; provider: string; status: string; action?: string; revision?: number; createdAt?: string; updatedAt?: string; error?: string; receipt?: SyncReceipt };
type DropboxConfig = { dropboxFolderUrl?: string };
type ManifestFile = { id: string; path: string; source: string; downloadUrl: string; status: string };
type DropboxManifest = { projectId: string; projectName: string; files: ManifestFile[]; remoteVerifiedCount: number };
export function dropboxFolderName(value: string, fallback = "Event folder") {
  const link = dropboxFolderLink(value);
  if (!link) return fallback;
  try {
    const path = new URL(link).pathname;
    return path.startsWith("/home/") ? decodeURIComponent(path.split("/").filter(Boolean).at(-1) || fallback) : fallback;
  } catch { return fallback; }
}
export function manifestDownloadLink(file: ManifestFile, projectId: string) {
  const expected = `/api/projects/${encodeURIComponent(projectId)}/dropbox-files/${encodeURIComponent(file.id)}`;
  return file.downloadUrl === expected ? expected : undefined;
}
export function dropboxFolderLink(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || !["dropbox.com", "www.dropbox.com"].includes(url.hostname) || url.username || url.password || (url.port && url.port !== "443")) return;
    return url.href;
  } catch { return; }
}
export function dropboxQueueCounts(jobs: readonly DropboxJob[], projectId: string) {
  const relevant = jobs.filter(job => job.projectId === projectId && job.provider === "dropbox");
  return { queued: relevant.filter(job => job.status === "queued").length, running: relevant.filter(job => job.status === "running").length };
}


export function dropboxSyncFeedback(jobs: readonly DropboxJob[], projectId: string) {
  const timestamp = (value?: string) => Date.parse(value || "") || 0;
  const ordered = jobs.filter(job => job.projectId === projectId && job.provider === "dropbox" && job.action === "update_file")
    .slice().sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt) || (b.revision ?? 0) - (a.revision ?? 0) || timestamp(b.updatedAt) - timestamp(a.updatedAt));
  const latest = ordered[0];
  const message = latest?.status === "failed" ? latest.error?.replace(/\s+/g, " ").trim() || "Open the folder and check the pending upload." : undefined;
  const receipt = ordered.find(job => job.status === "completed" && job.receipt?.detail?.trim() && timestamp(job.receipt.completedAt))?.receipt;
  return { failure: message && (message.length > 180 ? `${message.slice(0, 177)}…` : message), receipt };
}

export type PlanningFileInput = Pick<File, "name" | "size" | "text" | "webkitRelativePath">;
export async function readPlanningFiles(selected: readonly PlanningFileInput[]) {
  const accepted = selected.filter(file => /\.(?:md|txt|csv|json)$/i.test(file.name));
  if (!accepted.length) throw new Error("Choose Markdown, text, CSV, or JSON files.");
  if (accepted.length > 30) throw new Error("Choose up to 30 planning files at a time.");
  if (accepted.some(file => file.size > 100_000)) throw new Error("Each planning file must be under 100 KB.");
  if (accepted.reduce((total, file) => total + file.size, 0) > 500_000) throw new Error("Choose a set of files under 500 KB.");
  const paths = new Set<string>();
  const files = await Promise.all(accepted.map(async file => {
    const path = file.webkitRelativePath || file.name;
    if (paths.has(path)) throw new Error("Two selected files have the same path. Import them separately.");
    paths.add(path);
    const content = await file.text();
    if (content.includes("\u0000")) throw new Error(`${file.name} is not a readable text file.`);
    return { path, content };
  }));
  return { files, skipped: selected.length - accepted.length };
}

export default function DropboxConnection({ projectId, onSaved }: { projectId: string; onSaved: () => void }) {
  const inputId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [saved, setSaved] = useState("");
  const [loadedProject, setLoadedProject] = useState("");
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [imported, setImported] = useState("");
  const [choosing, setChoosing] = useState(false);
  const [linking, setLinking] = useState(false);
  const [manifest, setManifest] = useState<DropboxManifest | null>(null);
  const [jobsError, setJobsError] = useState(false);
  const [queue, setQueue] = useState({ queued: 0, running: 0 });
  const [feedback, setFeedback] = useState<ReturnType<typeof dropboxSyncFeedback>>({ failure: undefined, receipt: undefined });
  const [reload, setReload] = useState(0);
  const generation = useRef(0);
  const mutation = useRef<AbortController | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    let queueController: AbortController | null = null;
    let manifestController: AbortController | null = null;
    let polling = false;
    mutation.current?.abort(); busy.current = false;
    setSaved(""); setLoadedProject(""); setLoading(true); setImporting(false); setLinking(false); setChoosing(false); setManifest(null); setError(""); setImported(""); setQueue({ queued: 0, running: 0 }); setFeedback({ failure: undefined, receipt: undefined });
    const currentResponse = () => !controller.signal.aborted && generation.current === current;
    void (async () => {
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/integrations`, { signal: controller.signal });
        const result = await response.json() as DropboxConfig & { error?: string };
        if (!response.ok) throw new Error(result.error || "Couldn’t load Dropbox.");
        if (!currentResponse()) return;
        setSaved(typeof result.dropboxFolderUrl === "string" ? result.dropboxFolderUrl : ""); setLoadedProject(projectId);
      } catch (cause) { if (currentResponse()) setError(cause instanceof Error ? cause.message : "Couldn’t load Dropbox."); }
      finally { if (currentResponse()) setLoading(false); }
    })();
    const readQueue = async () => {
      if (polling || !currentResponse()) return;
      polling = true;
      queueController = new AbortController();
      manifestController = new AbortController();
      const manifestRead = fetch(`/api/projects/${encodeURIComponent(projectId)}/dropbox-manifest`, { signal: manifestController.signal })
        .then(async response => response.ok ? await response.json() as DropboxManifest : null)
        .then(result => { if (currentResponse() && result?.projectId === projectId && Array.isArray(result.files)) setManifest(result); })
        .catch(() => { /* Folder access remains available if the export list cannot load. */ });
      try {
        const response = await fetch(`/api/bridge/jobs?projectId=${encodeURIComponent(projectId)}`, { signal: queueController.signal });
        const jobs = await response.json();
        if (!response.ok || !Array.isArray(jobs)) throw new Error("Queue unavailable");
        if (!currentResponse()) return;
        setQueue(dropboxQueueCounts(jobs, projectId)); setFeedback(dropboxSyncFeedback(jobs, projectId)); setJobsError(false);
      } catch { if (currentResponse()) setJobsError(true); }
      finally { await manifestRead; polling = false; }
    };
    void readQueue();
    const timer = window.setInterval(() => void readQueue(), 3000);
    return () => { controller.abort(); queueController?.abort(); manifestController?.abort(); mutation.current?.abort(); window.clearInterval(timer); generation.current++; };
  }, [projectId, reload]);

  async function importFiles(selected: FileList | null) {
    if (!selected?.length || busy.current || loading || loadedProject !== projectId) return;
    const current = generation.current;
    const controller = new AbortController(); mutation.current = controller;
    busy.current = true; setImporting(true); setError(""); setImported("");
    try {
      const { files, skipped } = await readPlanningFiles(Array.from(selected));
      if (controller.signal.aborted || generation.current !== current) return;
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/dropbox-materials`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files }), signal: controller.signal,
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "Couldn’t import these planning files.");
      if (controller.signal.aborted || generation.current !== current) return;
      setImported(`Imported ${files.length} ${files.length === 1 ? "file" : "files"}.${skipped ? ` ${skipped} unsupported ${skipped === 1 ? "file was" : "files were"} skipped.` : ""}`);
      onSaved();
    } catch (cause) { if (!controller.signal.aborted && generation.current === current) setError(cause instanceof Error ? cause.message : "Couldn’t import these planning files."); }
    finally { if (!controller.signal.aborted && generation.current === current) { busy.current = false; mutation.current = null; setImporting(false); } }
  }

  async function useFolder() {
    const url = dropboxFolderLink(saved);
    if (!url || busy.current || loading || loadedProject !== projectId) return;
    const current = generation.current;
    const controller = new AbortController(); mutation.current = controller;
    busy.current = true; setLinking(true); setError("");
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/integrations`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dropboxFolderUrl: url }), signal: controller.signal,
      });
      const result = await response.json() as DropboxConfig & { error?: string };
      if (!response.ok) throw new Error(result.error || "Couldn’t use this folder.");
      if (controller.signal.aborted || generation.current !== current) return;
      setSaved(result.dropboxFolderUrl || url); setChoosing(false); onSaved();
    } catch (cause) { if (!controller.signal.aborted && generation.current === current) setError(cause instanceof Error ? cause.message : "Couldn’t use this folder."); }
    finally { if (!controller.signal.aborted && generation.current === current) { busy.current = false; mutation.current = null; setLinking(false); } }
  }

  const linkedUrl = loadedProject === projectId ? dropboxFolderLink(saved) : undefined;
  const disabled = loading || importing || linking || loadedProject !== projectId;
  const folderName = dropboxFolderName(saved, manifest?.projectName || "Event folder");
  const files = manifest?.files.filter(file => manifestDownloadLink(file, projectId)) || [];
  const orderedFiles = files.slice().sort((a, b) => {
    const rank = (file: ManifestFile) => file.path === "Leadership brief.md" ? 0 : file.path === "Ripple event plan.md" ? 1 : file.source === "approved_plan" ? 2 : file.source === "current_plan" ? 3 : file.source === "invitation" ? 4 : 5;
    return rank(a) - rank(b);
  });
  const fileRow = (file: ManifestFile) => <a className="dc-file" key={file.id} href={manifestDownloadLink(file, projectId)} download title={`Download ${file.path}`}>
    <FileText size={14} /><span>{file.path.split("/").at(-1)?.replace(/\.(md|csv|json|txt)$/i, "").replace(file.source === "approved_plan" ? /-[a-f0-9]{8}$/ : /$^/, "")}</span>
    <small>{file.status === "completed" ? "Uploaded" : file.status === "running" ? "Uploading" : file.status === "queued" ? "Queued" : file.status === "failed" ? "Needs attention" : "Ready"}</small><Download size={13} />
  </a>;
  const counts = [queue.queued ? `${queue.queued} ${queue.queued === 1 ? "upload" : "uploads"} queued` : "", queue.running ? `${queue.running} in progress` : ""].filter(Boolean).join(" · ");
  return <section className="dropbox-connection" aria-labelledby={`${inputId}-heading`}>
    <header className="dc-heading"><span className="dc-icon"><Folder size={21} strokeWidth={1.6} /></span><div><h2 id={`${inputId}-heading`}>Dropbox</h2><p>{linkedUrl ? folderName : "Planning files for this event."}</p></div>{linkedUrl && <span className="dc-configured"><Check size={12} />Linked</span>}</header>
    {loading ? <p className="dc-loading" role="status"><LoaderCircle size={14} className="dc-spin" />Loading…</p> : <div className="dc-body">
      <div className="dc-controls">
        <button type="button" className="dc-primary" disabled={disabled} aria-expanded={choosing} onClick={() => setChoosing(value => !value)}><FolderOpen size={14} />Choose folder</button>
        <a className="dc-open" href={linkedUrl || "https://www.dropbox.com/home"} target="_blank" rel="noreferrer">{linkedUrl ? "Open folder" : "Open Dropbox"}<ExternalLink size={12} /></a>
      </div>
      {choosing && <div className="dc-folder-picker" aria-label="Choose a Dropbox folder">
        {linkedUrl ? <><div className="dc-folder-option"><Folder size={18} /><div><strong>{folderName}</strong><span>Saved Dropbox folder</span></div><Check size={14} /></div><button type="button" className="dc-use-folder" disabled={disabled} onClick={() => void useFolder()}>{linking ? <LoaderCircle size={13} className="dc-spin" /> : <Check size={13} />}Use this folder</button></>
          : <p>No saved Dropbox folder is available for this event. Open Dropbox or import local planning files below.</p>}
      </div>}
      <input ref={fileInput} type="file" multiple accept=".md,.txt,.csv,.json" aria-label="Choose planning files" hidden onChange={event => { void importFiles(event.target.files); event.target.value = ""; }} />
      <input ref={folderInput} type="file" multiple {...{ webkitdirectory: "" }} aria-label="Choose a planning folder" hidden onChange={event => { void importFiles(event.target.files); event.target.value = ""; }} />
      {orderedFiles.length > 0 && <div className="dc-files" aria-label="Event files"><div className="dc-files-label">Event files<span>{orderedFiles.length}</span></div>{orderedFiles.slice(0, 4).map(fileRow)}{orderedFiles.length > 4 && <details className="dc-more-files"><summary>{orderedFiles.length - 4} more files</summary>{orderedFiles.slice(4).map(fileRow)}</details>}</div>}
      {imported && <p className="dc-success" role="status"><Check size={13} />{imported}</p>}
      {error && <div className="dc-error" role="alert"><CircleAlert size={13} /><span>{error}</span>{loadedProject !== projectId && <button type="button" onClick={() => setReload(value => value + 1)}><RefreshCw size={12} />Retry</button>}</div>}
      {!jobsError && feedback.failure && <p className="dc-failure"><CircleAlert size={13} />Upload needs attention</p>}
      {!jobsError && counts && <p className="dc-queue" role="status"><Clock3 size={13} />{counts}</p>}
      <details className="dc-details"><summary>Details</summary><div>
        <div className="dc-controls dc-local-import"><button type="button" className="dc-secondary" disabled={disabled} onClick={() => folderInput.current?.click()}>{importing ? <LoaderCircle size={14} className="dc-spin" /> : <FolderOpen size={14} />}Import local folder</button><button type="button" className="dc-secondary" disabled={disabled} onClick={() => fileInput.current?.click()}><FilePlus2 size={14} />Add files</button></div>
        <p>Markdown, text, CSV, and JSON · up to 30 files. Imported files are saved in this event’s local records.</p>
        {linkedUrl && <p>Plan updates queue for upload through the signed-in Dropbox browser. A saved folder link is not an upload receipt.</p>}
        {!linkedUrl && <p>No Dropbox event folder is linked yet. Local files can still be imported.</p>}
        {!jobsError && feedback.failure && <p className="dc-failure-copy">{feedback.failure}</p>}
        {!jobsError && feedback.receipt && <p className="dc-verified"><Check size={12} /><span>Last upload verified · {new Date(feedback.receipt.completedAt!).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>{feedback.receipt.url && dropboxFolderLink(feedback.receipt.url) && <a href={dropboxFolderLink(feedback.receipt.url)} target="_blank" rel="noreferrer">View<ExternalLink size={11} /></a>}</p>}
        {jobsError && <p>Sync status is temporarily unavailable.</p>}
        <a className="dc-export" href={`/api/projects/${encodeURIComponent(projectId)}/dropbox-export`} download><Download size={13} />Download current plan</a>
      </div></details>
    </div>}
  </section>;
}
