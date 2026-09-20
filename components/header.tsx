"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ProjectSnapshot } from "@/lib/api/snapshot";
import type { Connection } from "@/lib/db/schema";
import { api } from "./api";
import { ThemeToggle } from "./theme-toggle";
import { Badge, Button, relativeTime, type Tone } from "./ui";

const PROVIDER_LABEL: Record<Connection["provider"], string> = { dropbox: "Dropbox", gmail: "Gmail", invitations: "Invitations" };

function connectionTone(c: Connection): Tone {
  if (c.status === "connected") return c.mode === "live" ? "accent" : "info";
  if (c.status === "error") return "danger";
  return "neutral";
}

export function ConnectionPill({ c, withName = true }: { c: Connection; withName?: boolean }) {
  const label = c.status === "connected" ? (c.mode === "live" ? "live" : "demo") : c.status;
  return (
    <Badge tone={connectionTone(c)} title={c.status === "connected" ? (c.mode === "live" ? "Live provider credentials configured" : "Simulated: nothing leaves this machine") : "Disconnected: related actions produce manual instructions"}>
      {withName ? `${PROVIDER_LABEL[c.provider]} · ${label}` : label}
    </Badge>
  );
}

export function ProjectHeader({ snap, offline, refresh }: { snap: ProjectSnapshot; offline: boolean; refresh: () => Promise<void> }) {
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [menu, setMenu] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
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

  const demoCount = snap.connections.filter((c) => c.status === "connected" && c.mode === "demo").length;
  const broken = snap.connections.filter((c) => c.status !== "connected").length;
  const statusTone: Tone = offline ? "danger" : !snap.worker.online ? "warn" : broken ? "warn" : demoCount ? "info" : "accent";
  const statusLabel = offline
    ? "Server unreachable"
    : !snap.worker.online
      ? "Worker offline"
      : broken
        ? `${broken} disconnected`
        : demoCount === snap.connections.length
          ? "Demo mode"
          : "Connected";

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
          <span className="truncate text-sm text-muted" title={`${p.timezone} · revision ${p.revision}`}>
            {p.eventDate}
            {p.eventTime ? ` · ${p.eventTime}` : ""}
          </span>
          {p.status === "closed" && <Badge tone="neutral">closed</Badge>}
          {p.isSample && <Badge tone="info">sample</Badge>}
        </div>
        <div className="relative">
          <button
            type="button"
            aria-label="Integration status"
            aria-expanded={statusOpen}
            onClick={() => setStatusOpen((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs text-muted hover:text-foreground"
          >
            <span aria-hidden className={`size-2 rounded-full ${statusTone === "danger" ? "bg-danger" : statusTone === "warn" ? "bg-warn" : statusTone === "info" ? "bg-info" : "bg-accent"}`} />
            {statusLabel}
          </button>
          {statusOpen && (
            <div aria-label="Integration status" className="absolute right-0 z-20 mt-1 flex w-64 flex-col gap-2 rounded-lg border border-border bg-surface p-3 text-sm shadow-lg" onMouseLeave={() => setStatusOpen(false)}>
              {snap.connections.map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-2">
                  <span>{PROVIDER_LABEL[c.provider]}</span>
                  <ConnectionPill c={c} withName={false} />
                </div>
              ))}
              <div className="flex items-center justify-between gap-2 border-t border-border pt-2">
                <span>Worker</span>
                <Badge tone={offline ? "danger" : snap.worker.online ? "accent" : "warn"} title={snap.worker.online ? `Heartbeat ${relativeTime(snap.worker.lastSeen, snap.serverTime)}` : "No heartbeat in the last 15s. Start it with `npm run worker`."}>
                  {offline ? "unreachable" : snap.worker.online ? `online${snap.worker.queued ? ` · ${snap.worker.queued} queued` : ""}` : "offline"}
                </Badge>
              </div>
            </div>
          )}
        </div>
        <ThemeToggle />
        <div className="relative">
          <Button variant="ghost" aria-label="Project actions" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)} disabled={busy}>
            ⋯
          </Button>
          {menu && (
            <div role="menu" className="absolute right-0 z-20 mt-1 flex w-40 flex-col rounded-lg border border-border bg-surface p-1 shadow-lg" onMouseLeave={() => setMenu(false)}>
              <button role="menuitem" className="rounded-md px-3 py-1.5 text-left text-sm hover:bg-border/40" onClick={() => { setMenu(false); setRenaming(true); }}>
                Rename
              </button>
              <button role="menuitem" className="rounded-md px-3 py-1.5 text-left text-sm hover:bg-border/40" onClick={() => { setMenu(false); patch({ status: p.status === "closed" ? "active" : "closed" }); }}>
                {p.status === "closed" ? "Reopen" : "Close"}
              </button>
              {p.isSample && (
                <button role="menuitem" className="rounded-md px-3 py-1.5 text-left text-sm text-danger hover:bg-danger-soft" onClick={() => { setMenu(false); reset(); }}>
                  Reset demo
                </button>
              )}
            </div>
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
