import { useRef, useState } from "react";
import { ArrowRight, CalendarDays, Check, ChevronLeft, Cloud, Folder, FolderUp, LoaderCircle, Plus, X } from "lucide-react";
import type { ProjectState } from "../../shared/types";
import "./event-workspace.css";

export type WorkspaceIndex = {
  projects: Array<{ id: string; name: string }>;
  connections: { dropboxFolderUrl?: string; [key: string]: unknown };
};
export type PlanningFile = { path: string; content: string };

export async function readPlanningFiles(files: FileList | readonly File[]): Promise<PlanningFile[]> {
  const supported = Array.from(files).filter(file => /\.(?:md|txt|csv|json)$/i.test(file.name) && !file.name.startsWith("."));
  if (!supported.length) throw new Error("Choose a folder with planning documents (.md, .txt, .csv or .json). You can also use the connected Dropbox folder.");
  if (supported.length > 30) throw new Error("Choose up to 30 planning documents for this event.");
  if (supported.reduce((total, file) => total + file.size, 0) > 500_000) throw new Error("Choose planning documents under 500 KB in total.");
  return Promise.all(supported.map(async file => {
    if (file.size > 100_000) throw new Error(`${file.name} is too large. Choose a document smaller than 100 KB.`);
    return { path: file.webkitRelativePath || file.name, content: await file.text() };
  }));
}

const folderName = (url?: string) => {
  if (!url) return "Event planning";
  try { return decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || "Event planning").replace(/^Ripple\s*[-–]\s*/i, ""); }
  catch { return "Event planning"; }
};

export default function WorkspaceHome({ workspace, demo, busy, error, onImport, onOpen, onNew, onRefresh }: {
  workspace: WorkspaceIndex | null;
  demo: boolean;
  busy: boolean;
  error?: string | null;
  onImport: (files: PlanningFile[]) => Promise<void>;
  onOpen: (id: string) => void;
  onNew: () => void;
  onRefresh: () => Promise<WorkspaceIndex>;
}) {
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [fileError, setFileError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const projects = demo ? [] : workspace?.projects || [];

  async function upload(files: FileList | null) {
    if (!files || !files.length) return;
    setFileError("");
    try { await onImport(await readPlanningFiles(files)); }
    catch (cause) { setFileError(cause instanceof Error ? cause.message : "These files couldn’t be opened."); }
    finally { if (input.current) input.current.value = ""; }
  }

  return <main className="workspace-home">
    <header className="wh-topbar"><a href="/" className="wh-brand"><span className="ripple-mark" aria-hidden="true"><i /><i /><i /></span><span>ripple<span className="brand-dot">.</span></span></a>{projects.length > 0 && <button className="secondary compact" onClick={onNew}><Plus size={15} />New event</button>}</header>
    <div className="wh-content">
      <div className="wh-heading"><span className="ew-eyebrow">Your workspace</span><h1>Your events</h1><p>{projects.length ? "Pick an event to keep things moving." : "Bring in your planning folder to get started."}</p></div>
      {projects.length > 0 && <div className="wh-events">{projects.map(project => <button key={project.id} className="wh-event" onClick={() => onOpen(project.id)} disabled={busy}><CalendarDays size={21} /><span>{project.name}</span><ArrowRight size={18} /></button>)}</div>}
      {!connected ? <section className="wh-import-card">
        <span className="wh-dropbox-icon"><DropboxIcon /></span><div><h2>Start with your planning files</h2><p>Briefs, budgets and guest lists, together in your event.</p></div><button className="primary" disabled={busy || connecting} onClick={async () => { setConnecting(true); setFileError(""); try { const latest = await onRefresh(); if (!latest.connections.dropboxFolderUrl) throw new Error("No Dropbox folder is linked yet. Upload your planning folder to continue."); setConnected(true); } catch (cause) { setFileError(cause instanceof Error ? cause.message : "Dropbox couldn’t be opened."); } finally { setConnecting(false); } }}>{connecting ? <LoaderCircle size={15} className="spin" /> : <Cloud size={16} />}Connect Dropbox</button>
      </section> : <section className="wh-folder-card" aria-label="Choose planning folder">
        <header><span className="wh-dropbox-icon"><DropboxIcon /></span><div><h2>Dropbox</h2><p><Check size={12} />Connected</p></div><button className="icon-button" onClick={() => setConnected(false)} aria-label="Back" disabled={busy}><X size={17} /></button></header>
        <button className="wh-folder-choice" disabled={busy} onClick={() => { setFileError(""); if (!demo) { input.current?.click(); return; } void onImport([]).catch(cause => setFileError(cause instanceof Error ? cause.message : "This folder couldn’t be opened.")); }}><span className="wh-folder-icon"><Folder size={25} /></span><span><span className="wh-folder-name">{folderName(workspace?.connections.dropboxFolderUrl)}</span><small>{demo ? "Planning documents and event details" : "Choose this folder from your computer"}</small></span>{busy ? <LoaderCircle className="spin" size={19} /> : <ArrowRight size={19} />}</button>
        <div className="wh-upload-row"><span>Or bring another planning folder</span><button className="text-button" disabled={busy} onClick={() => input.current?.click()}><FolderUp size={16} />Upload folder</button></div>
      </section>}
      <input className="wh-file-input" ref={input} type="file" multiple {...({ webkitdirectory: "", directory: "" } as Record<string, string>)} onChange={event => void upload(event.target.files)} aria-label="Upload planning folder" />
      {(fileError || error) && <p className="ew-error" role="alert">{fileError || error}</p>}
      {!connected && fileError && <button className="text-button" disabled={busy} onClick={() => input.current?.click()}><FolderUp size={16} />Upload planning folder</button>}
      {busy && <div className="wh-importing" role="status"><LoaderCircle size={17} className="spin" /><span>Reading your files and putting the event together…</span></div>}
    </div>
  </main>;
}

function DropboxIcon() {
  return <svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor" aria-hidden="true"><path d="m6 2 6 4-6 4-6-4 6-4Zm12 0 6 4-6 4-6-4 6-4ZM6 11l6 4-6 4-6-4 6-4Zm12 0 6 4-6 4-6-4 6-4Zm-6 5 6 4-6 4-6-4 6-4Z" /></svg>;
}
