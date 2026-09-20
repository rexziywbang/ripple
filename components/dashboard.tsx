"use client";

import type { ProjectSnapshot } from "@/lib/api/snapshot";
import { formatCents } from "@/lib/domain/money";
import { Badge, COST_LABEL, costTone } from "./ui";

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

const OPEN = ["completed", "failed", "superseded"];

/** One compact strip: the numbers that matter, plus anything that needs the organizer. */
export function Dashboard({ snap, onSelectWorkflow }: { snap: ProjectSnapshot; onSelectWorkflow: (id: string) => void }) {
  const attendance = fact<number>(snap, "attendance.expected");
  const venue = fact<string>(snap, "venue.name");
  const format = fact<string>(snap, "event.format") === "standing_reception" ? "Standing reception" : "Seated dinner";
  const b = budgetSummary(snap);
  const waiting = snap.workflows.filter((w) => w.status === "waiting_external" || (w.waits.length > 0 && !OPEN.includes(w.status)));
  const attention = snap.workflows.filter((w) => ["needs_input", "ready_for_review", "failed", "partially_complete"].includes(w.status));
  const inFlight = snap.workflows.filter((w) => w.status === "planning" || w.status === "executing");
  const variance = b.ceiling !== undefined ? b.ceiling - b.total : null;

  return (
    <section aria-label="Dashboard" className="min-w-0 space-y-2">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl border border-border bg-surface px-4 py-3 shadow-sm sm:grid-cols-4">
        <div className="min-w-0">
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted">Guests</dt>
          <dd className="text-xl font-semibold">{attendance ?? "—"}</dd>
          <dd className="truncate text-xs text-muted">{snap.guestsCount} on the list</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted">Where</dt>
          <dd className="truncate text-base font-semibold">{venue ?? "—"}</dd>
          <dd className="truncate text-xs text-muted">{format}</dd>
        </div>
        <div className="col-span-2 min-w-0">
          <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted">Budget forecast</dt>
          <dd className="text-xl font-semibold">
            {formatCents(b.total)}
            {b.ceiling !== undefined && <span className="text-sm font-normal text-muted"> / {formatCents(b.ceiling)}</span>}
          </dd>
          <dd className={`truncate text-xs ${variance !== null && variance < 0 ? "text-danger" : "text-muted"}`} title={Object.entries(b.byStatus).map(([st, amt]) => `${COST_LABEL[st] ?? st} ${formatCents(amt)}`).join(" · ")}>
            {variance === null ? "No ceiling set" : variance < 0 ? `Over ceiling by ${formatCents(-variance)}` : `${formatCents(variance)} headroom`}
            {b.unknown ? ` · ${b.unknown} unknown` : ""}
            {b.prospective ? ` · ${formatCents(Math.abs(b.prospective))} prospective saving pending confirmation` : ""}
          </dd>
          <dd className="mt-1 flex flex-wrap gap-1">
            {Object.entries(b.byStatus).map(([st, amt]) => (
              <Badge key={st} tone={costTone(st)}>
                {COST_LABEL[st] ?? st} {formatCents(amt)}
              </Badge>
            ))}
          </dd>
        </div>
      </dl>

      {(attention.length > 0 || waiting.length > 0 || inFlight.length > 0) && (
        <ul aria-label="Needs you" className="flex flex-wrap gap-2 text-xs">
          {attention.map((w) => (
            <li key={w.id}>
              <button onClick={() => onSelectWorkflow(w.id)} className="flex max-w-full items-center gap-1.5 rounded-full border border-accent/40 bg-accent-soft px-3 py-1 text-left hover:opacity-90">
                <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-accent" />
                <span className="truncate">
                  <strong>{w.status === "needs_input" ? "Question" : w.status === "ready_for_review" ? "Review" : "Attention"}</strong> · {w.summary ?? w.request}
                </span>
              </button>
            </li>
          ))}
          {waiting.map((w) => (
            <li key={w.id}>
              <button onClick={() => onSelectWorkflow(w.id)} className="flex max-w-full items-center gap-1.5 rounded-full border border-warn/40 bg-warn-soft px-3 py-1 text-left hover:opacity-90">
                <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warn ripple-active" />
                <span className="truncate">
                  <strong>Waiting</strong> · {w.waits.map((x) => x.description).join("; ") || w.summary || w.request}
                </span>
              </button>
            </li>
          ))}
          {inFlight.map((w) => (
            <li key={w.id}>
              <button onClick={() => onSelectWorkflow(w.id)} className="flex max-w-full items-center gap-1.5 rounded-full border border-info/40 bg-info-soft px-3 py-1 text-left hover:opacity-90">
                <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-info ripple-active" />
                <span className="truncate">
                  <strong>Working</strong> · {w.request}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
