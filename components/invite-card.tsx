"use client";

import type { ProjectSnapshot } from "@/lib/api/snapshot";
import { formatLongDate } from "@/lib/domain/projections";

function fact<T>(snap: ProjectSnapshot, key: string): T | undefined {
  return snap.facts.find((f) => f.key === key)?.value as T | undefined;
}

function to12h(hhmm: string | undefined): string {
  if (!hhmm) return "TBC";
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h)) return hhmm;
  const suffix = h >= 12 ? "PM" : "AM";
  const hour = ((h + 11) % 12) + 1;
  return `${hour}:${String(m ?? 0).padStart(2, "0")} ${suffix}`;
}

/**
 * Guest-facing preview of the invitation, styled like a modern event page
 * (cover art, date block, location, RSVP). Every field is read from project
 * facts so it always reflects the current plan; `text` overrides the body when
 * previewing a proposed update.
 */
export function InviteCard({ snap, text, compact = false }: { snap: ProjectSnapshot; text?: string; compact?: boolean }) {
  const name = fact<string>(snap, "event.name") ?? snap.project.name;
  const date = fact<string>(snap, "event.date") ?? snap.project.eventDate;
  const time = fact<string>(snap, "event.time") ?? snap.project.eventTime ?? undefined;
  const venue = fact<string>(snap, "venue.name") ?? "Venue to be confirmed";
  const address = fact<string>(snap, "venue.address");
  const format = fact<string>(snap, "event.format") === "standing_reception" ? "Standing reception" : "Seated dinner";
  const body = text ?? (fact<string>(snap, "invitation.text") ?? "");
  const invited = snap.guestsCount;
  const d = new Date(`${date}T12:00:00Z`);
  const valid = !Number.isNaN(d.getTime());
  const month = valid ? d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase() : "";
  const day = valid ? d.getUTCDate() : "";

  return (
    <article aria-label="Invitation preview" className="invite-card overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
      <div className={`invite-cover relative ${compact ? "h-24" : "h-36 sm:h-44"}`} aria-hidden>
        <div className="absolute inset-x-4 bottom-3 flex items-end justify-between">
          <span className="rounded-full bg-white/85 px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-[#0f3b34]">{format}</span>
          <span className="rounded-full bg-black/35 px-2.5 py-0.5 text-[11px] font-medium text-white">Hosted by {snap.project.name.split(" ")[0]}</span>
        </div>
      </div>
      <div className={`grid gap-3 ${compact ? "p-3" : "p-4 sm:p-5"}`}>
        <div className="flex items-start gap-3">
          <div className="flex w-12 shrink-0 flex-col items-center overflow-hidden rounded-lg border border-border text-center">
            <span className="w-full bg-accent py-0.5 text-[10px] font-bold text-white">{month}</span>
            <span className="py-1 text-lg font-semibold leading-none">{day}</span>
          </div>
          <div className="min-w-0">
            <h3 className={`font-semibold leading-tight ${compact ? "text-base" : "text-xl"}`}>{name}</h3>
            <p className="text-sm text-muted">
              {valid ? formatLongDate(date) : date} · {to12h(time)}
            </p>
          </div>
        </div>
        <div className="flex items-start gap-2 text-sm">
          <span aria-hidden className="mt-0.5 text-muted">
            ⌖
          </span>
          <div className="min-w-0">
            <p className="font-medium">{venue}</p>
            {address && <p className="text-muted">{address}</p>}
          </div>
        </div>
        {body && <p className={`whitespace-pre-wrap text-sm leading-relaxed ${compact ? "line-clamp-3" : ""}`}>{body}</p>}
        {!compact && (
          <>
            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
              <span className="text-xs font-medium text-muted">RSVP</span>
              {["Going", "Maybe", "Can't go"].map((r) => (
                <button key={r} type="button" disabled className="rounded-full border border-border px-3 py-1 text-xs font-medium opacity-80" title="Preview only">
                  {r}
                </button>
              ))}
              <span className="ml-auto flex items-center gap-1.5 text-xs text-muted">
                <span aria-hidden className="flex -space-x-1.5">
                  {[0, 1, 2].map((i) => (
                    <span key={i} className={`inline-block size-5 rounded-full border-2 border-surface ${["bg-accent", "bg-info", "bg-warn"][i]}`} />
                  ))}
                </span>
                {invited} invited
              </span>
            </div>
            <p className="text-[11px] text-muted">Preview of what guests receive. Changes are proposed by Ripple and go out only after you approve them.</p>
          </>
        )}
      </div>
    </article>
  );
}
