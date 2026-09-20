import { CalendarDays, Check, Clock3, Mail, MapPin, Utensils } from "lucide-react";
import type { ProjectState, Proposal } from "../../shared/types";
import { guestDietaryCopy } from "../../shared/invitation-copy";
import "./invitation-preview.css";

type InvitationSnapshot = NonNullable<Proposal["invitationSnapshot"]>;
const newestFirst = (a: Proposal, b: Proposal) =>
  b.version - a.version || b.createdAt.localeCompare(a.createdAt);

/** Approved content always comes from its own snapshot, never from today's mutable plan. */
export function selectInvitationPreview(state: Pick<ProjectState, "project" | "proposals">) {
  const invitations = state.proposals
    .filter((p) => p.kind === "invitation")
    .slice().sort(newestFirst);
  const latestApproval = invitations.find((p) => p.status === "approved" || p.status === "applied");
  // Undo invalidates the latest approval; older delivered versions remain history,
  // rather than becoming current again without a new review.
  const approved = latestApproval?.invitationSnapshotRevoked ? undefined : latestApproval;
  const draft = invitations.find((p) =>
    (p.status === "pending" || p.status === "blocked") &&
    (!latestApproval || newestFirst(p, latestApproval) <= 0),
  );
  const f = state.project.facts;
  const workingPlan: InvitationSnapshot = {
    name: state.project.name, date: f.date, time: f.time, timezone: f.timezone,
    venue: f.venue, venueAddress: f.venueAddress, caterer: f.cateringStatus === "confirmed" ? f.caterer : "",
    dietary: f.dietary, format: f.format,
  };
  return {
    approved,
    draft,
    // Older saved invitations without a structured snapshot retain their exact text.
    // Filling missing fields from the current plan would silently approve later changes.
    snapshot: approved ? approved.invitationSnapshot : draft?.invitationSnapshot ?? workingPlan,
  };
}

function eventDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return "Date to be confirmed";
  const date = new Date(`${value}T12:00:00Z`);
  if (!Number.isFinite(date.getTime())) return "Date to be confirmed";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long", month: "long", day: "numeric", timeZone: "UTC",
  }).format(date);
}
function eventTime(value: string) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return "Time to be confirmed";
  const hours = Number(match[1]);
  return `${hours % 12 || 12}:${match[2]} ${hours >= 12 ? "PM" : "AM"}`;
}
const dateLine = (s: InvitationSnapshot) => `${eventDate(s.date)} · ${eventTime(s.time)}`;
const displayAddress = (address: string) => address.replace(/\s*\(demo\)$/, "");
const locationLine = (s: InvitationSnapshot) => [s.venue, displayAddress(s.venueAddress)].filter(Boolean).join(" · ") || "Venue to be confirmed";
const mealLine = (s: InvitationSnapshot) => [s.caterer, guestDietaryCopy(s.dietary)].filter(Boolean).join(" · ") || "Menu to be confirmed";

function pendingChanges(approved: InvitationSnapshot | undefined, draft: InvitationSnapshot) {
  const fields = [
    { label: "Event", value: (s: InvitationSnapshot) => s.name },
    { label: "When", value: dateLine },
    { label: "Where", value: locationLine },
    { label: "Meal", value: mealLine },
  ];
  return fields.filter((field) => !approved || field.value(approved) !== field.value(draft))
    .map((field) => ({ label: field.label, value: field.value(draft) }));
}

export default function InvitationPreview({ state }: { state: Pick<ProjectState, "project" | "proposals"> }) {
  const { approved, draft, snapshot } = selectInvitationPreview(state);
  const changes = draft?.invitationSnapshot ? pendingChanges(approved?.invitationSnapshot, draft.invitationSnapshot) : [];
  const hasPending = Boolean(draft);
  const title = snapshot?.name || approved?.subject || state.project.name;
  const holidayArtwork = title.trim().toLowerCase() === "christmas dinner";
  return (
    <section className="invitation-preview" aria-label="Guest invitation preview">
      <header className="invitation-heading">
        <h2><Mail size={15} />Guest invitation</h2>
        <span>In-app preview</span>
      </header>
      <div className={`invitation-paper${holidayArtwork ? " invitation-designed" : ""}`} key={approved?.id ?? "working-preview"}>
        {holidayArtwork && (
          <div className="invitation-artwork">
            <img src="/invite-art/northstar-holiday.png" alt="Northstar Christmas dinner invitation artwork" width="1024" height="1536" decoding="async" />
          </div>
        )}
        <div className="invitation-copy">
        <div className="invitation-kicker">
          <span>{holidayArtwork ? "The evening" : "You’re invited"}</span>
          <span className={`invitation-status${approved ? " is-approved" : ""}`}>
            {approved ? <Check size={12} /> : <Clock3 size={12} />}
            {approved ? "Approved version" : draft?.status === "blocked" ? "Update on hold" : hasPending ? "Awaiting approval" : "Working draft"}
          </span>
        </div>
        <h3 className={holidayArtwork ? "invitation-accessible-title" : undefined}>{title}</h3>
        {snapshot ? (
          <dl className="invitation-details">
            <div><dt><CalendarDays size={16} /><span>When</span></dt><dd>{eventDate(snapshot.date)}<small>{eventTime(snapshot.time)}{snapshot.timezone && ` · ${snapshot.timezone.replaceAll("_", " ")}`}</small></dd></div>
            <div><dt><MapPin size={16} /><span>Where</span></dt><dd>{snapshot.venue || "Venue to be confirmed"}{snapshot.venueAddress && <small>{displayAddress(snapshot.venueAddress)}</small>}</dd></div>
            <div><dt><Utensils size={16} /><span>Meal</span></dt><dd>{snapshot.caterer || "Menu to be confirmed"}{guestDietaryCopy(snapshot.dietary) && <small>{guestDietaryCopy(snapshot.dietary)}</small>}</dd></div>
          </dl>
        ) : <p className="invitation-exact-copy">{approved?.body || approved?.description}</p>}
        </div>
      </div>
      {approved && draft && (
        <div className="invitation-pending">
          <strong><Clock3 size={13} />{draft.status === "blocked" ? "Update waiting on a prerequisite" : "Update awaiting approval"}</strong>
          {changes.length > 0 ? <dl>{changes.map((change) => <div key={change.label}><dt>{change.label}</dt><dd>{change.value}</dd></div>)}</dl> : <p>{draft.body || draft.description}</p>}
        </div>
      )}
      <p className="invitation-footnote">{approved ? "Approved content is shown here." : "Review guest updates under To send."} Delivery is recorded separately in Activity.</p>
    </section>
  );
}
