"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ProjectSnapshot } from "@/lib/api/snapshot";
import type { Connection } from "@/lib/db/schema";
import { api } from "./api";
import { Badge, Button, relativeTime, type Tone } from "./ui";

const PROVIDER_LABEL: Record<Connection["provider"], string> = { dropbox: "Dropbox", gmail: "Gmail", invitations: "Invitations" };

function connectionTone(c: Connection): Tone {
  if (c.status === "connected") return c.mode === "live" ? "accent" : "info";
  if (c.status === "error") return "danger";
  return "neutral";
}

export function ConnectionPill({ c }: { c: Connection }) {
  const label = c.status === "connected" ? (c.mode === "live" ? "live" : "demo") : c.status;
  return (
    <Badge tone={connectionTone(c)} title={c.status === "connected" ? (c.mode === "live" ? "Live provider credentials configured" : "Simulated: nothing leaves this machine") : "Disconnected: related actions produce manual instructions"}>
      {PROVIDER_LABEL[c.provider]} · {label}
    </Badge>
  );
}

export function ProjectHeader({ snap, offline, refresh }: { snap: ProjectSnapshot; offline: boolean; refresh: () => Promise<void> }) {
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(snap.project.name);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const p = snap.project;

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/projects/${p.id}`, { method: "PATCH", json: body });
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (!confirm("Reset the sample event? All workflow history, approvals and messages are discarded.")) return;
    setBusy(true);
    try {
      await api("/api/projects/sample", { json: {} });
      router.replace(`/projects/${p.id}`);
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto flex w-full max-w-[1500px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <Link href="/" className="text-sm text-muted hover:underline">
          ← Projects
        </Link>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          {renaming ? (
            <form
              className="flex items-center gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                await patch({ name: name.trim() });
                setRenaming(false);
              }}
            >
              <input aria-label="Project name" value={name} onChange={(e) => setName(e.target.value)} className="rounded-md border border-border bg-background px-2 py-1 text-lg font-semibold" autoFocus />
              <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
                Save
              </Button>
              <Button type="button" variant="ghost" onClick={() => setRenaming(false)}>
                Cancel
              </Button>
            </form>
          ) : (
            <h1 className="truncate text-lg font-semibold">{p.name}</h1>
          )}
          <span className="text-sm text-muted">
            {p.eventDate}
            {p.eventTime ? ` · ${p.eventTime}` : ""} · {p.timezone} · rev {p.revision}
          </span>
          <Badge tone={p.status === "closed" ? "neutral" : "accent"}>{p.status}</Badge>
          {p.isSample && <Badge tone="info">sample data</Badge>}
        </div>
        <div className="flex flex-wrap items-center gap-2" aria-label="Integration status">
          {snap.connections.map((c) => (
            <ConnectionPill key={c.id} c={c} />
          ))}
          <Badge tone={offline ? "danger" : snap.worker.online ? "accent" : "warn"} title={snap.worker.online ? `Worker heartbeat ${relativeTime(snap.worker.lastSeen, snap.serverTime)}; ${snap.worker.queued} job(s) queued` : "No worker heartbeat in the last 15s. Start it with `npm run worker`; queued jobs will run when it appears."}>
            {offline ? "Server unreachable" : snap.worker.online ? `Worker online${snap.worker.queued ? ` · ${snap.worker.queued} queued` : ""}` : `Worker offline${snap.worker.queued ? ` · ${snap.worker.queued} queued` : ""}`}
          </Badge>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" onClick={() => setRenaming(true)} disabled={busy}>
            Rename
          </Button>
          <Button variant="ghost" onClick={() => patch({ status: p.status === "closed" ? "active" : "closed" })} disabled={busy}>
            {p.status === "closed" ? "Reopen" : "Close"}
          </Button>
          {p.isSample && (
            <Button variant="ghost" onClick={reset} disabled={busy}>
              Reset demo
            </Button>
          )}
        </div>
      </div>
      {err && (
        <p role="alert" className="mx-auto w-full max-w-[1500px] px-4 pb-2 text-sm text-danger">
          {err}
        </p>
      )}
      {!snap.worker.online && !offline && (
        <p className="border-t border-warn/30 bg-warn-soft px-4 py-1.5 text-center text-xs text-warn">
          The worker process is not running, so requests will queue but not progress. Start it with <code className="font-mono">npm run worker</code> (or <code className="font-mono">npm run dev</code> which starts both).
        </p>
      )}
    </header>
  );
}
