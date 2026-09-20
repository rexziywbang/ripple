import { useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { ArrowLeft, ArrowRight, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, ClipboardList, Clock3, FileText, LoaderCircle, Mail, MapPin, Monitor, Pencil, Send, SlidersHorizontal, Users, Utensils, Wallet, X } from "lucide-react";
import type { Area, FactPatch, PlanCard, ProjectState, Proposal, Source } from "../../shared/types";
import { placeSelectionPatch, type PlaceMatch } from "./PlaceMatches";
import { reviewGroups, type ReviewQueueProps } from "./ReviewQueue";
import { planCardCopy, reviewPlanDecks, type OnPlanCardAction } from "./PlanCardDeck";
import { captureEmailDrafts, emailDraftChanged, type DraftReview, type LocalEmailDraft } from "./review-drafts";
import { parseInlineValue } from "./InlinePlan";
import ChangeRipple from "./ChangeRipple";
import "./event-workspace.css";

const currency = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100);
type ComponentId = Area | "schedule";
export const eventComponents: Array<{ id: ComponentId; area: Area; label: string; icon: typeof Users; placeholder: string }> = [
  { id: "guests", area: "guests", label: "Guests", icon: Users, placeholder: "We’re now expecting 120 people." },
  { id: "venue", area: "venue", label: "Venue", icon: MapPin, placeholder: "The venue has changed to Marriott." },
  { id: "catering", area: "catering", label: "Catering", icon: Utensils, placeholder: "Switch catering to CAVA. We’ll need vegetarian options." },
  { id: "budget", area: "budget", label: "Budget", icon: Wallet, placeholder: "Keep the total under $15,000." },
  { id: "staff", area: "staff", label: "Staff", icon: Users, placeholder: "We’ll have four people helping with setup and service." },
  { id: "equipment", area: "equipment", label: "Equipment", icon: Monitor, placeholder: "We need a projector and two wireless microphones." },
  { id: "schedule", area: "brief", label: "Schedule", icon: CalendarDays, placeholder: "Move dinner to 7 PM and leave 30 minutes for awards." },
  { id: "brief", area: "brief", label: "Event brief", icon: ClipboardList, placeholder: "Make this a relaxed team celebration with dinner and short awards." },
];

export function venueSearchQuery(note: string) {
  return note.trim()
    .replace(/^(?:please\s+)?(?:(?:the|our)\s+)?(?:event\s+)?(?:venue|location)\s+(?:(?:has|have)\s+)?(?:now\s+)?(?:changed|moved|switched|is|will be|should be)(?:\s+now)?(?:\s+to)?\s+/i, "")
    .replace(/^(?:please\s+)?(?:move|change|switch)(?:\s+(?:the|our))?(?:\s+(?:event|venue|location))?(?:\s+(?:venue|location))?\s+to\s+/i, "")
    .replace(/[.!?]+$/, "").trim().slice(0, 160);
}

export function visibleReviewItems(state: Pick<ProjectState, "proposals">): Proposal[] {
  const items = [...reviewPlanDecks(state.proposals), ...reviewGroups(state.proposals).flatMap(group => group.proposals)];
  const byId = new Map(state.proposals.map(item => [item.id, item]));
  // A single email slide cannot approve its prerequisite in the background.
  return [...new Map(items.map(item => [item.id, item])).values()].filter(item => item.dependencies.every(id => byId.get(id)?.status === "applied"));
}

export type ReviewSlide = { key: string; proposal: Proposal; card?: PlanCard };
export function visibleReviewSlides(state: Pick<ProjectState, "proposals">): ReviewSlide[] {
  return visibleReviewItems(state).flatMap(proposal => proposal.kind === "plan" && proposal.planCards?.length
    ? proposal.planCards.filter(card => card.status === "pending").map(card => ({ key: `${proposal.id}:${card.id}`, proposal, card }))
    : [{ key: proposal.id, proposal }]);
}

export type BatchReview = DraftReview & { revision: number; planCardTokens: Record<string, Record<string, string>> };
export function captureBatchReview(state: Pick<ProjectState, "project" | "proposals">, drafts: Record<string, LocalEmailDraft>): BatchReview {
  const proposals = visibleReviewItems(state);
  return {
    revision: state.project.revision,
    proposals: structuredClone(proposals),
    drafts: captureEmailDrafts(proposals, drafts),
    planCardTokens: Object.fromEntries(proposals.filter(proposal => proposal.kind === "plan").map(proposal => [proposal.id, Object.fromEntries((proposal.planCards ?? []).filter(card => card.status === "pending").map(card => [card.id, card.revisionToken]))])),
  };
}

function summaryDetail(proposal: Proposal, draft?: LocalEmailDraft) {
  if (proposal.kind === "email") return `${proposal.recipient || "Email"} · ${draft?.subject ?? proposal.subject ?? ""}`;
  if (proposal.kind === "plan") return proposal.planCards?.filter(card => card.status === "pending").map(card => planCardCopy(card).title).join(" · ") || proposal.description;
  if (proposal.kind === "invitation") return [proposal.invitationSnapshot?.venue, proposal.invitationNotifyGuests === false ? "Event description only" : "Guest invitation"].filter(Boolean).join(" · ");
  return proposal.before && proposal.after ? `${proposal.before} → ${proposal.after}` : proposal.after || proposal.description;
}

/** Keep the deck open for work that can become ready after an approved action. */
export function hasRemainingReviewWork(state: Pick<ProjectState, "proposals">): boolean {
  const byId = new Map(state.proposals.map(proposal => [proposal.id, proposal]));
  const canResume = (proposal: Proposal, trail = new Set<string>()): boolean => {
    if (proposal.status === "applied") return true;
    if (!["pending", "blocked", "approved"].includes(proposal.status) || trail.has(proposal.id)) return false;
    const nextTrail = new Set(trail).add(proposal.id);
    return proposal.dependencies.every(id => { const prerequisite = byId.get(id); return !!prerequisite && canResume(prerequisite, nextTrail); });
  };
  return state.proposals.some(proposal => ["pending", "blocked"].includes(proposal.status) && ["email", "fact", "invitation", "plan"].includes(proposal.kind) && canResume(proposal));
}

export function updatedPlanningFiles(state: Pick<ProjectState, "proposals" | "sources" | "receipts">): Source[] {
  const files = new Map<string, Source>();
  for (const proposal of state.proposals) {
    if (proposal.kind !== "file" || proposal.status !== "applied" || !state.receipts.some(receipt => receipt.proposalId === proposal.id && ["local", "delivered"].includes(receipt.status))) continue;
    const source = state.sources.find(item => item.id === `record:${proposal.area}`)
      ?? state.sources.find(item => item.area === proposal.area && !item.material && !item.venueEvidence && !/^(?:reference:|contact:|approved-plan:)/.test(item.id));
    if (source?.content.trim()) files.set(source.id, source);
  }
  for (const source of state.sources) if (source.id.startsWith("approved-plan:") && source.content.trim()) {
    const proposalId = source.id.slice("approved-plan:".length);
    const proposal = state.proposals.find(item => item.id === proposalId);
    if (proposal && !["stale", "withdrawn", "denied"].includes(proposal.status) && state.receipts.some(receipt => receipt.proposalId === proposalId && receipt.status === "local")) files.set(source.id, source);
  }
  return [...files.values()];
}

function componentValue(area: ComponentId, state: ProjectState) {
  const f = state.project.facts;
  switch (area) {
    case "guests": return f.attendance ? `${f.attendance} guests` : "Guest list and attendance";
    case "venue": return f.venue || "Choose a location";
    case "catering": return f.caterer || "Food and dietary needs";
    case "budget": return f.budgetLimitCents ? `${currency(state.budget.totalCents)} of ${currency(f.budgetLimitCents)}` : "Costs and spending limit";
    case "staff": return f.staffCount ? `${f.staffCount} team ${f.staffCount === 1 ? "member" : "members"}` : "People and responsibilities";
    case "equipment": return f.venueIncludesAV && !f.venueAVPending ? "AV included at venue" : "AV, furniture and rentals";
    case "schedule": return f.date ? `${new Date(`${f.date}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" })}${f.time ? ` · ${f.time}` : ""}` : "Timing and event details";
    case "brief": return f.format || "Purpose, format and details";
  }
}

type Props = {
  state: ProjectState;
  busy: boolean;
  mode: "edit" | "review" | "complete";
  onSave: (area: Area, note: string, patch?: FactPatch) => Promise<boolean>;
  onDecide: ReviewQueueProps["onDecide"];
  onPlanCardAction: OnPlanCardAction;
  onAcceptAll?: (review: BatchReview) => Promise<boolean>;
  reviewOverview?: boolean;
  emailDrafts: Record<string, LocalEmailDraft>;
  setEmailDrafts: Dispatch<SetStateAction<Record<string, LocalEmailDraft>>>;
  onDetails: (area: Area) => void;
  onEdit: () => void;
};

export default function EventWorkspace({ state, busy, mode, onSave, onDecide, onPlanCardAction, onAcceptAll, reviewOverview, emailDrafts, setEmailDrafts, onDetails, onEdit }: Props) {
  const [selected, setSelected] = useState<ComponentId | null>(null);
  const [note, setNote] = useState("");
  const [places, setPlaces] = useState<PlaceMatch[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const component = eventComponents.find(item => item.id === selected);
  const slides = visibleReviewSlides(state);
  const locked = busy || searching || saving;

  function select(area: ComponentId) {
    if (locked) return;
    setSelected(area); setNote(""); setPlaces(null); setError(""); onEdit();
  }

  async function save(patch?: FactPatch) {
    if (!component || !note.trim() || locked) return;
    setSaving(true); setError("");
    try {
      if (await onSave(component.area, note.trim(), patch)) { setSelected(null); setNote(""); setPlaces(null); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "This change couldn’t be saved. Try again."); }
    finally { setSaving(false); }
  }

  async function submit() {
    if (!selected || !note.trim() || locked) return;
    if (selected !== "venue") { await save(); return; }
    setSearching(true); setError(""); setPlaces(null);
    try {
      const query = new URLSearchParams({ query: venueSearchQuery(note), kind: "venue", projectId: state.project.id });
      const response = await fetch(`/api/places?${query}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Nearby places couldn’t be loaded.");
      setPlaces(Array.isArray(result.results) ? result.results.slice(0, 3) : []);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Nearby places couldn’t be loaded."); }
    finally { setSearching(false); }
  }

  if (mode === "complete") return <section className="ew-complete" aria-labelledby="event-updated-title">
    <div className="ew-complete-heading"><span className="ew-complete-mark"><Check size={22} /></span><div><h2 id="event-updated-title">Review complete</h2><p>Your event reflects the changes you approved.</p></div></div>
    {state.impact && <ChangeRipple impact={state.impact} compact />}
    <div className="ew-final-details">
      {eventComponents.filter(item => ["venue", "guests", "catering", "budget", "schedule"].includes(item.id)).map(item => <div key={item.id}><item.icon size={17} /><span>{item.label}</span><p>{componentValue(item.id, state)}</p>{item.id === "venue" && state.project.facts.venueAddress && <small>{state.project.facts.venueAddress}</small>}</div>)}
    </div>
    <UpdatedFiles state={state} />
    <button className="secondary" onClick={onEdit}>Make another change<ArrowRight size={15} /></button>
  </section>;

  if (mode === "review") return <EventReviewDeck state={state} busy={locked} onDecide={onDecide} onPlanCardAction={onPlanCardAction} onAcceptAll={onAcceptAll} reviewOverview={reviewOverview} emailDrafts={emailDrafts} setEmailDrafts={setEmailDrafts} onBack={onEdit} onChangeArea={select} />;

  return <section className="event-components" aria-label="Event components">
    <div className="ew-components-heading"><h2>What’s changing?</h2>{slides.length > 0 && mode === "edit" && <span>{reviewOverview ? visibleReviewItems(state).length : slides.length} to review</span>}</div>
    <div className="ew-component-grid">{eventComponents.map(item => <button key={item.id} type="button" className={`ew-component${selected === item.id ? " is-selected" : ""}`} onClick={() => select(item.id)} aria-expanded={selected === item.id} aria-controls="event-component-editor" disabled={locked}><span className="ew-component-icon"><item.icon size={20} /></span><span className="ew-component-label">{item.label}</span><span className="ew-component-value">{componentValue(item.id, state)}</span><ArrowRight className="ew-component-arrow" size={16} /></button>)}</div>
    <div className={`ew-editor-presence${component ? " is-open" : ""}`}><div>{component && <section className="ew-editor" id="event-component-editor" aria-label={`Update ${component.label.toLowerCase()}`}>
      <header><div><component.icon size={17} /><h3>{component.label}</h3></div><button type="button" className="icon-button" onClick={() => { setSelected(null); setPlaces(null); }} aria-label="Close editor" disabled={locked}><X size={16} /></button></header>
      <form onSubmit={event => { event.preventDefault(); void submit(); }}><label className="sr-only" htmlFor="component-instruction">What should change?</label><textarea id="component-instruction" autoFocus rows={2} maxLength={4000} placeholder={component.placeholder} value={note} disabled={locked} onChange={event => { setNote(event.target.value); setPlaces(null); setError(""); }} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void submit(); } }} />
      {places === null && <div className="ew-editor-actions"><span>Ripple takes care of the follow-through.</span><button type="submit" className="primary" disabled={locked || !note.trim()}>{searching || saving ? <LoaderCircle className="spin" size={15} /> : <ArrowRight size={15} />}{searching ? "Finding venue…" : saving ? "Updating…" : "Update"}</button></div>}</form>
      {selected === "catering" && <ComponentDetailField label="Dietary options" value={state.project.facts.dietary} placeholder="Vegetarian, halal, kosher options…" disabled={locked} onSave={value => onSave("guests", "", { dietary: value })} />}
      {selected === "staff" && <ComponentDetailField label="Team members" kind="integer" value={String(state.project.facts.staffCount)} disabled={locked} onSave={value => onSave("staff", "", { staffCount: Number(value) })} />}
      <button type="button" className="text-button ew-details-shortcut" disabled={locked} onClick={() => onDetails(component.area)}><SlidersHorizontal size={13} />Edit individual details</button>
      {places !== null && <div className="ew-place-confirmation"><h4>{places.length ? "Is this the right venue?" : "No nearby match yet"}</h4>{places.length ? places.map((place, index) => <article className="ew-place" key={place.id}><span className="ew-place-pin"><MapPin size={20} /></span><div><h4>{place.name}</h4><p>{place.address}</p>{index === 0 && <small>Cambridge, MA</small>}</div><button type="button" className={index === 0 ? "primary" : "secondary"} disabled={locked} onClick={() => void save(placeSelectionPatch("venue", place))}>{saving ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}{index === 0 ? "Yes, this venue" : "Use this venue"}</button></article>) : <p>Try the venue’s name, or keep the location as written.</p>}{!places.length && <button type="button" className="secondary" disabled={locked} onClick={() => void save()}>Use this location<ArrowRight size={14} /></button>}</div>}
      {error && <p className="ew-error" role="alert">{error}</p>}
    </section>}</div></div>
  </section>;
}

function UpdatedFiles({ state }: { state: ProjectState }) {
  const files = updatedPlanningFiles(state);
  if (!files.length) return null;
  return <aside className="ew-updated-files" aria-label="Updated planning files">
    <span>Updated in your plan</span>
    <div>{files.map(file => <details key={file.id}><summary><FileText size={13} /><span>{file.title}</span><Check size={12} /></summary><div><small>{file.path}</small><pre>{file.content}</pre></div></details>)}</div>
  </aside>;
}

export function EventReviewDeck({ state, busy, onDecide, onPlanCardAction, onAcceptAll, reviewOverview = false, emailDrafts, setEmailDrafts, onBack, onChangeArea }: {
  state: ProjectState;
  busy: boolean;
  onDecide: ReviewQueueProps["onDecide"];
  onPlanCardAction: OnPlanCardAction;
  onAcceptAll?: (review: BatchReview) => Promise<boolean>;
  reviewOverview?: boolean;
  emailDrafts: Record<string, LocalEmailDraft>;
  setEmailDrafts: Dispatch<SetStateAction<Record<string, LocalEmailDraft>>>;
  onBack: () => void;
  onChangeArea: (area: Area) => void;
}) {
  const slides = visibleReviewSlides(state);
  const reviewItems = visibleReviewItems(state);
  const [overview, setOverview] = useState(reviewOverview);
  const [activeKey, setActiveKey] = useState("");
  const [working, setWorking] = useState<"approve" | "deny" | "rewrite" | "all" | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<{ key: string; revisionToken: string; instruction: string } | null>(null);
  const lock = useRef(false);
  const current = slides.find(slide => slide.key === activeKey) ?? slides[0];
  const index = current ? slides.findIndex(slide => slide.key === current.key) : 0;
  const proposal = current?.proposal;
  const draft = proposal ? emailDrafts[proposal.id] : undefined;
  const draftConflict = !!proposal && emailDraftChanged(proposal, draft) && draft?.draftToken !== proposal.draftToken;
  const disabled = busy || working !== null;

  function navigate(offset: number) {
    const next = slides[index + offset];
    if (!next || disabled) return;
    setActiveKey(next.key); setError(""); setEditing(null);
  }

  function editEmail(field: "subject" | "body", value: string) {
    if (!proposal?.draftToken || disabled) return;
    setEmailDrafts(previous => ({ ...previous, [proposal.id]: {
      ...(previous[proposal.id] ?? { subject: proposal.subject || "", body: proposal.body || "", draftToken: proposal.draftToken! }), [field]: value,
    } }));
  }

  async function decide(decision: "approve" | "deny") {
    if (!current || disabled || lock.current || decision === "approve" && draftConflict) return;
    const reviewed = current;
    const nextKey = slides[index + 1]?.key ?? slides[index - 1]?.key ?? "";
    lock.current = true; setWorking(decision); setError("");
    try {
      let succeeded = true;
      if (reviewed.card) {
        await onPlanCardAction(reviewed.proposal.id, reviewed.card.id, decision, reviewed.card.revisionToken);
      } else {
        const token = reviewed.proposal.approvalToken;
        succeeded = await onDecide([reviewed.proposal.id], decision, token ? { [reviewed.proposal.id]: token } : {},
          decision === "approve" ? { proposals: [reviewed.proposal], drafts: captureEmailDrafts([reviewed.proposal], emailDrafts) } : undefined);
      }
      if (succeeded) { setActiveKey(nextKey); setEditing(null); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "This change couldn’t be saved. Try again."); }
    finally { lock.current = false; setWorking(null); }
  }

  async function rewrite() {
    if (!current?.card || !editing || editing.key !== current.key || !editing.instruction.trim() || disabled || lock.current) return;
    lock.current = true; setWorking("rewrite"); setError("");
    try {
      await onPlanCardAction(current.proposal.id, current.card.id, "rewrite", editing.revisionToken, editing.instruction.trim());
      setEditing(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "This section couldn’t be revised. Try again."); }
    finally { lock.current = false; setWorking(null); }
  }

  async function acceptAll() {
    if (!onAcceptAll || disabled || lock.current || !reviewItems.length) return;
    lock.current = true; setWorking("all"); setError("");
    try { await onAcceptAll(captureBatchReview(state, emailDrafts)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "These changes couldn’t be saved. Review them and try again."); }
    finally { lock.current = false; setWorking(null); }
  }

  if (!current || !proposal) {
    const waiting = hasRemainingReviewWork(state);
    return <section className="ew-review ew-review-empty" aria-live="polite">
    {state.impact && <ChangeRipple impact={state.impact} compact />}
    <span className="ew-complete-mark">{waiting ? <Clock3 size={22} /> : <Check size={22} />}</span><h2>{waiting ? "Waiting for the previous update" : "Nothing else to review"}</h2><p>{waiting ? "Your next decision will appear here." : "Your saved event details are below."}</p>
    <UpdatedFiles state={state} /><button className="secondary" onClick={onBack}>Back to event<ArrowRight size={14} /></button>
  </section>;
  }

  if (overview && onAcceptAll) {
    const invalidDraft = reviewItems.find(item => emailDraftChanged(item, emailDrafts[item.id]) && emailDrafts[item.id]?.draftToken !== item.draftToken);
    return <section className="ew-review ew-summary-review" aria-label="Summary of proposed changes">
      {state.impact && <ChangeRipple impact={state.impact} compact />}
      <header><button className="text-button" disabled={disabled} onClick={onBack}><ArrowLeft size={14} />Back to event</button><span className="ew-slide-position">{reviewItems.length} changes</span></header>
      <div className="ew-summary-heading"><h2>Ready to update</h2><p>Review the changes, or accept them together.</p></div>
      <ul className="ew-summary-list">{reviewItems.map(item => {
        const SummaryIcon = item.kind === "email" ? Mail : item.kind === "invitation" ? CalendarDays : item.kind === "plan" ? ClipboardList : SlidersHorizontal;
        return <li key={item.id}><button type="button" disabled={disabled} onClick={() => { setActiveKey(slides.find(slide => slide.proposal.id === item.id)?.key ?? ""); setOverview(false); setError(""); }}><span className="ew-summary-icon"><SummaryIcon size={17} /></span><span><span className="ew-summary-title">{item.title}</span><span className="ew-summary-detail">{summaryDetail(item, emailDrafts[item.id])}</span></span><ChevronRight size={15} /></button></li>;
      })}</ul>
      {invalidDraft && <p className="ew-draft-conflict" role="alert">An edited email has changed. Open it and review the latest draft.</p>}
      {error && <p className="ew-error" role="alert">{error}</p>}
      <footer className="ew-summary-actions"><button className="primary" type="button" disabled={disabled || !!invalidDraft} onClick={() => void acceptAll()}>{working === "all" ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}{working === "all" ? "Applying changes…" : "Accept all"}</button><button className="text-button" disabled={disabled} onClick={() => { setOverview(false); setError(""); }}>Review individually<ArrowRight size={14} /></button></footer>
      <UpdatedFiles state={state} />
    </section>;
  }

  const copy = current.card ? planCardCopy(current.card) : null;
  const Icon = proposal.kind === "email" ? Mail : proposal.kind === "invitation" ? CalendarDays : proposal.kind === "plan" ? ClipboardList : SlidersHorizontal;
  const isEditing = editing?.key === current.key;
  const approvalLabel = proposal.kind === "email" ? "Send email" : "Approve";
  const typeLabel = proposal.kind === "email" ? "Email" : proposal.kind === "invitation" ? "Invitation" : proposal.kind === "plan" ? "Operating plan" : "Plan change";

  return <section className="ew-review ew-slide-review" aria-label="Review event changes">
    {state.impact && <ChangeRipple impact={state.impact} compact activeProposalId={proposal.id} />}
    <header><button className="text-button" disabled={disabled} onClick={onBack}><ArrowLeft size={14} />Back to event</button><span className="ew-slide-position" aria-live="polite">{index + 1} of {slides.length} to review</span>{onAcceptAll && <button className="text-button ew-summary-switch" disabled={disabled || !!editing} onClick={() => { setOverview(true); setError(""); }}>Summary</button>}</header>
    <article className="ew-decision-slide" key={current.key} aria-label={copy?.title || proposal.title}>
      <div className="ew-slide-type"><span><Icon size={15} />{typeLabel}</span>{current.card && <small>{proposal.title}</small>}</div>
      <div className={`ew-slide-content${working === "rewrite" ? " is-rewriting" : ""}`} aria-busy={working === "rewrite"}>
        <h2>{copy?.title || proposal.title}</h2>
        {proposal.kind === "email" ? <div className="ew-slide-email">
          <div className="ew-email-recipient"><span>To</span><p>{proposal.recipient || "Recipient not provided"}</p></div>
          {proposal.originalRecipient && proposal.originalRecipient !== proposal.recipient && <div className="ew-email-regarding"><span>Regarding</span><p>{proposal.originalRecipient}</p></div>}
          <label>Subject<input aria-label="Email subject" value={draft?.subject ?? proposal.subject ?? ""} onChange={event => editEmail("subject", event.target.value)} maxLength={300} readOnly={!proposal.draftToken} disabled={disabled} /></label>
          <label>Message<textarea aria-label="Email message" rows={8} value={draft?.body ?? proposal.body ?? ""} onChange={event => editEmail("body", event.target.value)} maxLength={12000} readOnly={!proposal.draftToken} disabled={disabled} /></label>
          {draftConflict && <p className="ew-draft-conflict" role="alert">This email changed while you were editing. <button type="button" disabled={disabled} onClick={() => { setEmailDrafts(previous => { const next = { ...previous }; delete next[proposal.id]; return next; }); setError(""); }}>Use latest draft</button></p>}
        </div> : current.card ? <p className="ew-slide-body">{copy?.body}</p> : proposal.kind === "invitation" ? <>
          <p className="ew-slide-note">{proposal.invitationNotifyGuests === false ? "Update the event description. No guest email." : proposal.recipient ? `For ${proposal.recipient}` : "Update the guest invitation."}</p><p className="ew-slide-body">{proposal.body || proposal.description}</p>
        </> : <>
          {proposal.before && proposal.after && <div className="ew-fact-change"><div><span>Current</span><p>{proposal.before}</p></div><ArrowRight size={17} /><div><span>Proposed</span><p>{proposal.after}</p></div></div>}
          {(proposal.description || proposal.body) && <p className="ew-slide-body">{proposal.body || proposal.description}</p>}
          {proposal.costImpactCents !== null && proposal.costImpactCents !== 0 && <p className="ew-cost-impact">Forecast {proposal.costImpactCents < 0 ? "−" : "+"}{currency(Math.abs(proposal.costImpactCents))}</p>}
        </>}
      </div>
      {working === "rewrite" && <div className="ew-rewriting-status" role="status"><LoaderCircle size={16} className="spin" />Revising this section…</div>}
      {isEditing && current.card && <form className="ew-slide-rewrite" onSubmit={event => { event.preventDefault(); void rewrite(); }}><label htmlFor="review-card-instruction">What should change?</label><textarea id="review-card-instruction" value={editing.instruction} maxLength={1200} rows={2} autoFocus disabled={disabled} placeholder="Shorten this, adjust the timing, or change an assignment…" onChange={event => setEditing({ ...editing, instruction: event.target.value })} /><div><button type="submit" className="primary" disabled={disabled || !editing.instruction.trim()}><ArrowRight size={14} />Update section</button><button className="text-button" type="button" disabled={disabled} onClick={() => setEditing(null)}>Cancel</button></div></form>}
      {error && <p className="ew-error" role="alert">{error}</p>}
      {!isEditing && <footer className="ew-slide-actions"><button className="primary" type="button" disabled={disabled || draftConflict} onClick={() => void decide("approve")}>{working === "approve" ? <LoaderCircle size={15} className="spin" /> : proposal.kind === "email" ? <Send size={15} /> : <Check size={15} />}{approvalLabel}</button><button className="secondary" type="button" disabled={disabled} onClick={() => void decide("deny")}><X size={14} />Deny</button>{proposal.kind !== "email" && <button className="text-button" type="button" disabled={disabled} onClick={() => current.card ? setEditing({ key: current.key, revisionToken: current.card.revisionToken, instruction: "" }) : onChangeArea(proposal.area)}><Pencil size={13} />Edit</button>}</footer>}
    </article>
    <div className="ew-slide-navigation"><button type="button" className="text-button" disabled={disabled || index === 0 || isEditing} onClick={() => navigate(-1)}><ChevronLeft size={15} />Back</button><span>{slides.length} remaining</span><button type="button" className="text-button" disabled={disabled || index >= slides.length - 1 || isEditing} onClick={() => navigate(1)}>Next<ChevronRight size={15} /></button></div>
    <UpdatedFiles state={state} />
  </section>;
}

export function ComponentDetailField({ label, value, kind = "text", placeholder, disabled, onSave }: { label: string; value: string; kind?: "text" | "integer"; placeholder?: string; disabled: boolean; onSave: (value: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const dirty = useRef(false);
  const lock = useRef(false);
  useEffect(() => { if (!dirty.current) setDraft(value); }, [value]);
  async function save() {
    if (!dirty.current || lock.current || disabled || draft.trim() === value) return;
    const parsed = parseInlineValue(draft, { kind, optional: kind === "text", min: 0, max: 100000 });
    if (!parsed.ok) { setError(parsed.error); return; }
    lock.current = true; setSaving(true); setError("");
    try { if (await onSave(String(parsed.value))) dirty.current = false; }
    catch (cause) { setError(cause instanceof Error ? cause.message : "This detail couldn’t be saved."); }
    finally { lock.current = false; setSaving(false); }
  }
  return <div className="ew-dietary-field"><label>{label}<input type={kind === "integer" ? "number" : "text"} inputMode={kind === "integer" ? "numeric" : undefined} min={kind === "integer" ? 0 : undefined} max={kind === "integer" ? 100000 : undefined} step={kind === "integer" ? 1 : undefined} value={draft} disabled={disabled || saving} maxLength={1000} placeholder={placeholder} onChange={event => { dirty.current = true; setDraft(event.target.value); }} onBlur={() => void save()} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void save(); } }} /></label>{saving && <small>Saving…</small>}{error && <p className="ew-error" role="alert">{error}</p>}</div>;
}
