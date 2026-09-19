"use client";

import type { ProjectSnapshot } from "@/lib/api/snapshot";
import { formatCents } from "@/lib/domain/money";
import { Badge, Card, COST_LABEL, costTone } from "./ui";

function fact<T>(snap: ProjectSnapshot, key: string): T | undefined {
  return snap.facts.find((f) => f.key === key)?.value as T | undefined;
}

export function budgetSummary(snap: ProjectSnapshot) {
  const active = snap.budgetLines.filter((l) => l.active);
  const byStatus: Record<string, number> = {};
  let total = 0;
  let unknown = 0;
  for (const l of active) {
    if (l.subtotalCents === null) {
      unknown++;
      continue;
    }
    const amt = l.subtotalCents + l.taxCents;
    total += amt;
    byStatus[l.commitmentStatus] = (byStatus[l.commitmentStatus] ?? 0) + amt;
  }
  const ceiling = fact<number>(snap, "budget.ceiling_cents");
  const prospective = snap.workflows
    .flatMap((w) => w.proposals)
    .filter((p) => p.conditional && p.cost?.status === "prospective" && (p.decision === "approved" || p.decision === "pending"))
    .reduce((a, p) => a + (p.cost?.deltaCents ?? 0), 0);
  return { total, unknown, byStatus, ceiling, prospective };
}

export function Dashboard({ snap, onSelectWorkflow }: { snap: ProjectSnapshot; onSelectWorkflow: (id: string) => void }) {
  const attendance = fact<number>(snap, "attendance.expected");
  const attendanceFact = snap.facts.find((f) => f.key === "attendance.expected");
  const b = budgetSummary(snap);
  const waiting = snap.workflows.filter((w) => w.status === "waiting_external");
  const attention = snap.workflows.filter((w) => w.status === "needs_input" || w.status === "ready_for_review" || w.status === "failed" || w.status === "partially_complete");
  const inFlight = snap.workflows.filter((w) => w.status === "planning" || w.status === "executing");
  const variance = b.ceiling !== undefined ? b.ceiling - b.total : null;

  return (
    <section aria-label="Dashboard" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Card className="flex flex-col gap-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">Attendance</p>
        <p className="text-2xl font-semibold">{attendance ?? "—"}</p>
        <p className="text-xs text-muted">
          {attendanceFact?.status ?? "unknown"} · {snap.guestsCount} on the guest list · v{attendanceFact?.version ?? 0}
        </p>
      </Card>
      <Card className="flex flex-col gap-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">Budget forecast</p>
        <p className="text-2xl font-semibold">
          {formatCents(b.total)}
          {b.ceiling !== undefined && <span className="text-sm font-normal text-muted"> / {formatCents(b.ceiling)}</span>}
        </p>
        <p className={`text-xs ${variance !== null && variance < 0 ? "text-danger" : "text-muted"}`}>
          {variance === null ? "No ceiling set" : variance < 0 ? `Over ceiling by ${formatCents(-variance)}` : `${formatCents(variance)} headroom`}
          {b.unknown ? ` · ${b.unknown} line${b.unknown === 1 ? "" : "s"} unknown (not counted as zero)` : ""}
          {b.prospective ? ` · ${formatCents(Math.abs(b.prospective))} prospective saving pending confirmation` : ""}
        </p>
        <div className="mt-1 flex flex-wrap gap-1">
          {Object.entries(b.byStatus).map(([st, amt]) => (
            <Badge key={st} tone={costTone(st)}>
              {COST_LABEL[st] ?? st} {formatCents(amt)}
            </Badge>
          ))}
          {b.unknown > 0 && <Badge tone="warn">Unknown ×{b.unknown}</Badge>}
        </div>
      </Card>
      <Card className="flex flex-col gap-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">Waiting on others</p>
        <p className="text-2xl font-semibold">{waiting.length}</p>
        {waiting.length === 0 ? (
          <p className="text-xs text-muted">Nothing is waiting on a vendor reply.</p>
        ) : (
          <ul className="text-xs text-muted">
            {waiting.slice(0, 3).map((w) => (
              <li key={w.id}>
                <button className="text-left hover:underline" onClick={() => onSelectWorkflow(w.id)}>
                  {w.waits.map((x) => x.description).join("; ") || w.summary || w.request}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card className="flex flex-col gap-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">Needs you</p>
        <p className="text-2xl font-semibold">{attention.length}</p>
        {inFlight.length > 0 && <p className="text-xs text-accent">{inFlight.length} in progress</p>}
        {attention.length === 0 ? (
          <p className="text-xs text-muted">No reviews or questions outstanding.</p>
        ) : (
          <ul className="text-xs text-muted">
            {attention.slice(0, 3).map((w) => (
              <li key={w.id}>
                <button className="text-left hover:underline" onClick={() => onSelectWorkflow(w.id)}>
                  {w.status === "needs_input" ? "Question: " : w.status === "ready_for_review" ? "Review: " : "Attention: "}
                  {w.summary ?? w.request}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}
