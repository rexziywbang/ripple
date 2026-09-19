"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Project } from "@/lib/db/schema";
import { parseDollarsToCents } from "@/lib/domain/money";
import { api } from "./api";
import { Badge, Button, Card, Empty, SectionTitle, Spinner } from "./ui";

export function ProjectList() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api<{ projects: Project[] }>("/api/projects");
      setProjects(data.projects);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load projects");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => {
      if (!cancelled) load();
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const sample = projects?.find((p) => p.isSample);
  const others = projects?.filter((p) => !p.isSample) ?? [];

  async function resetSample() {
    if (!confirm("Reset the sample event? All of its workflow history, approvals and messages are discarded and the fixtures are re-imported.")) return;
    setBusy("reset");
    try {
      const { project } = await api<{ project: Project }>("/api/projects/sample", { json: {} });
      router.push(`/projects/${project.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reset failed");
    } finally {
      setBusy(null);
    }
  }

  async function onCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const budgetCents = parseDollarsToCents(String(fd.get("budget") ?? ""));
    if (budgetCents === null) {
      setError("Enter the budget as dollars, e.g. 18000 or 18k.");
      return;
    }
    setBusy("create");
    try {
      const { project } = await api<{ project: Project }>("/api/projects", {
        json: {
          name: String(fd.get("name")),
          eventDate: String(fd.get("eventDate")),
          eventTime: String(fd.get("eventTime") || "") || undefined,
          timezone: String(fd.get("timezone")),
          attendance: Number(fd.get("attendance")),
          budgetCents,
          folderPath: String(fd.get("folderPath") || "") || undefined,
        },
      });
      router.push(`/projects/${project.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the project");
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-10">
      <header className="mb-10">
        <p className="text-sm font-medium text-accent">Ripple</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Event planning that remembers consequences</h1>
        <p className="mt-2 max-w-2xl text-muted">
          Tell Ripple what changed — attendance, venue, caterer, budget, staff, timing — and it follows the change through every planning area, shows its evidence, and waits for your approval before anything leaves the building.
        </p>
      </header>

      {error && (
        <p role="alert" className="mb-4 rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <SectionTitle>Sample event</SectionTitle>
          {projects === null ? (
            <Spinner label="Loading projects" />
          ) : sample ? (
            <div className="space-y-3">
              <div>
                <h3 className="text-lg font-semibold">{sample.name}</h3>
                <p className="text-sm text-muted">
                  {sample.eventDate} · {sample.eventTime} {sample.timezone} · seeded from Dropbox-style fixtures with venue, caterer, AV, staff and budget documents.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link href={`/projects/${sample.id}`} className="inline-flex items-center rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90">
                  Explore sample event
                </Link>
                <Button onClick={resetSample} disabled={busy === "reset"}>
                  {busy === "reset" ? "Resetting…" : "Reset demo event"}
                </Button>
              </div>
              <p className="text-xs text-muted">All vendors, contacts and prices in the sample are fictional. Addresses end in .example and can never be delivered to.</p>
            </div>
          ) : (
            <Button onClick={resetSample}>Create the sample event</Button>
          )}
        </Card>

        <Card>
          <SectionTitle right={<Button variant="ghost" onClick={() => setShowCreate((v) => !v)}>{showCreate ? "Cancel" : "New project"}</Button>}>Your projects</SectionTitle>
          {showCreate ? (
            <form onSubmit={onCreate} className="grid gap-3 text-sm">
              <label className="grid gap-1">
                Event name
                <input name="name" required className="rounded-md border border-border bg-background px-2 py-1.5" placeholder="Spring offsite" />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="grid gap-1">
                  Date
                  <input name="eventDate" type="date" required className="rounded-md border border-border bg-background px-2 py-1.5" />
                </label>
                <label className="grid gap-1">
                  Start time
                  <input name="eventTime" type="time" className="rounded-md border border-border bg-background px-2 py-1.5" />
                </label>
              </div>
              <label className="grid gap-1">
                Timezone
                <input name="timezone" required defaultValue={Intl.DateTimeFormat().resolvedOptions().timeZone} className="rounded-md border border-border bg-background px-2 py-1.5" />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <label className="grid gap-1">
                  Expected attendance
                  <input name="attendance" type="number" min={1} required defaultValue={100} className="rounded-md border border-border bg-background px-2 py-1.5" />
                </label>
                <label className="grid gap-1">
                  Budget ceiling (USD)
                  <input name="budget" required defaultValue="10000" className="rounded-md border border-border bg-background px-2 py-1.5" />
                </label>
              </div>
              <label className="grid gap-1">
                Dropbox folder (optional)
                <input name="folderPath" className="rounded-md border border-border bg-background px-2 py-1.5" placeholder="/Events/Spring offsite" />
              </label>
              <Button type="submit" variant="primary" disabled={busy === "create"}>
                {busy === "create" ? "Creating…" : "Create project"}
              </Button>
            </form>
          ) : projects === null ? (
            <Spinner label="Loading projects" />
          ) : others.length === 0 ? (
            <Empty>No projects yet. Create one to plan an event from scratch, or explore the sample event first.</Empty>
          ) : (
            <ul className="divide-y divide-border">
              {others.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 py-2">
                  <div>
                    <Link href={`/projects/${p.id}`} className="font-medium hover:underline">
                      {p.name}
                    </Link>
                    <p className="text-xs text-muted">
                      {p.eventDate} · {p.timezone}
                    </p>
                  </div>
                  <Badge tone={p.status === "closed" ? "neutral" : "accent"}>{p.status}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </main>
  );
}
