import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  ArrowRight,
  Check,
  CheckCheck,
  ChevronDown,
  CircleAlert,
  FileText,
  LoaderCircle,
  Mail,
  Send,
  SlidersHorizontal,
  X,
} from "lucide-react";
import type { Area, ProjectState, Proposal } from "../../shared/types";
import { captureEmailDrafts, emailDraftChanged, type DraftReview, type LocalEmailDraft } from "./review-drafts";
import PlanCardDeck, { getPlanCards, reviewPlanDecks, type OnPlanCardAction } from "./PlanCardDeck";
import "./review-queue.css";

type GroupedProposal = Proposal & { groupId?: string; groupTitle?: string; approvalToken?: string };
export type ReviewGroup = {
  id: string;
  title: string;
  proposals: Proposal[];
  proposalIds: string[];
  messageCount: number;
  costImpactCents: number;
};
export type ReviewQueueProps = {
  state: ProjectState;
  busy: string | null;
  onDecide: (
    proposalIds: string[],
    decision: "approve" | "deny",
    approvalTokens: Record<string, string>,
    review?: DraftReview,
  ) => Promise<boolean>;
  communicationsOnly?: boolean;
  emailDrafts?: Record<string, LocalEmailDraft>;
  setEmailDrafts?: Dispatch<SetStateAction<Record<string, LocalEmailDraft>>>;
  onPlanCardAction?: OnPlanCardAction;
};

const GROUP_TITLES: Record<Area, string> = {
  venue: "Venue update",
  guests: "Guest update",
  catering: "Catering change",
  budget: "Budget adjustment",
  staff: "Staffing update",
  equipment: "Equipment update",
  brief: "Event update",
};
const amount = (cents: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
const isMessage = (p: Proposal) =>
  p.kind === "email" || p.kind === "invitation";
const isDescriptionUpdate = (p: Proposal) =>
  p.kind === "invitation" && p.invitationNotifyGuests === false;
const isDecision = (p: Proposal, communicationsOnly: boolean) =>
  p.kind !== "file" &&
  p.kind !== "warning" &&
  (!communicationsOnly || isMessage(p));
const dependenciesReady = (p: Proposal, byId: Map<string, Proposal>) =>
  p.dependencies.every((id) => byId.get(id)?.status === "applied");

// Only an explicitly marked message may share approval with its visible local
// fact prerequisite. External actions and fact chains still have to finish first.
const readyInView = (p: Proposal, byId: Map<string, Proposal>, communicationsOnly: boolean) =>
  dependenciesReady(p, byId) || (
    p.batchWithDependencies === true && p.kind === "email" && !!p.groupId &&
    p.dependencies.every((id) => {
      const prerequisite = byId.get(id);
      return prerequisite?.status === "applied" || (
        prerequisite?.kind === "fact" && prerequisite.status === "pending" &&
        prerequisite.groupId === p.groupId && isDecision(prerequisite, communicationsOnly) &&
        dependenciesReady(prerequisite, byId)
      );
    })
  );

/** The count and the UI use the same explicit, currently actionable ID sets. */
export function reviewGroups(
  proposals: readonly Proposal[],
  communicationsOnly = false,
): ReviewGroup[] {
  const byId = new Map(proposals.map((p) => [p.id, p]));
  const groups = new Map<string, ReviewGroup>();
  for (const proposal of proposals as readonly GroupedProposal[]) {
    if (
      proposal.status !== "pending" ||
      (proposal.kind === "plan" && getPlanCards(proposal).length > 0) ||
      !isDecision(proposal, communicationsOnly) ||
      !readyInView(proposal, byId, communicationsOnly)
    )
      continue;
    const id = proposal.groupId || `area:${proposal.area}`;
    let group = groups.get(id);
    if (!group) {
      group = {
        id,
        title: proposal.groupTitle?.trim() || GROUP_TITLES[proposal.area],
        proposals: [],
        proposalIds: [],
        messageCount: 0,
        costImpactCents: 0,
      };
      groups.set(id, group);
    }
    group.proposals.push(proposal);
    group.proposalIds.push(proposal.id);
    if (isMessage(proposal)) group.messageCount++;
    if (proposal.kind === "fact")
      group.costImpactCents += proposal.costImpactCents ?? 0;
  }
  return Array.from(groups.values());
}

/** Bind this decision to the exact preview the user saw, before any queued save. */
export function captureReviewDecision(group: ReviewGroup): {
  proposalIds: string[];
  approvalTokens: Record<string, string>;
} {
  const proposalIds = [...group.proposalIds];
  const visible = new Map(group.proposals.map(proposal => [proposal.id, proposal as GroupedProposal]));
  const approvalTokens: Record<string, string> = {};
  for (const id of proposalIds) {
    const token = visible.get(id)?.approvalToken;
    if (typeof token === "string" && token.length > 0) approvalTokens[id] = token;
  }
  return { proposalIds, approvalTokens };
}

const compact = (value: string) => value.replace(/\s+/g, " ").trim();
const genericUpdate = (value: string) => /^(?:(?:the|new)\s+)?(?:event|staff|staffing|venue|guest|guests|catering|budget|equipment|plan)(?:\s+(?:details?|count|schedule|arrangements?))?\s+(?:updates?|updated|changes?|changed|adjustments?)(?:\s+to\b.*)?[.!]?$/i.test(value);
const actionHeading = (value: string) => /^(?:arrange|ask|confirm|request|book|cancel|send|tell|share|adjust|remove|set|check|review|prepare|reserve|reduce|increase|update)\b/i.test(value);

/** Presentation uses only the displayed proposals, never newer unreviewed facts. */
export function describeReviewGroup(group: Pick<ReviewGroup, "title" | "proposals">) {
  const cause = compact(group.title);
  const subjectHeadcounts = new Set(group.proposals.flatMap(p => {
    const count = p.kind === "email" ? /\bfor (\d+) guests\b/i.exec(p.subject || "")?.[1] : undefined;
    return count ? [count] : [];
  }));
  const attendance = /^Guest count changed to (\d+)$/i.exec(cause)?.[1] ??
    (subjectHeadcounts.size === 1 ? [...subjectHeadcounts][0] : undefined);
  const staffing = group.proposals.find(p => p.kind === "fact" && typeof p.patch?.staffCount === "number");
  const specific = group.proposals.filter(p => compact(p.title) && !genericUpdate(compact(p.title)));
  // Keep a concrete group request when supplied; otherwise lead with the actual
  // staffing decision or the first actionable deliverable already in this bundle.
  const action = specific.find(p => p.kind === "plan") ?? specific.find(p => actionHeading(compact(p.title))) ?? specific[0];
  const title = actionHeading(cause) && !genericUpdate(cause) ? cause
    : staffing ? `Arrange coverage with ${staffing.patch!.staffCount} staff${attendance ? ` for ${attendance} guests` : ""}`
    : action ? compact(action.title)
    : group.proposals.every(isMessage) ? "Review the prepared messages" : "Review the proposed plan changes";
  return {
    title,
    cause: cause !== title && !/^(?:Event|Staff|Staffing|Venue|Guests?|Catering|Budget|Equipment) (?:updates?|updated|change|adjustment)$/i.test(cause) ? cause : undefined,
  };
}

/** A visible extract complements, but never replaces, the exact draft preview. */
export function reviewActionDetail(proposal: Proposal) {
  const text = compact(isMessage(proposal) ? proposal.body || "" : proposal.description);
  if (text.length <= 230) return text;
  const excerpt = text.slice(0, 227);
  const boundary = excerpt.lastIndexOf(" ");
  return `${excerpt.slice(0, boundary > 180 ? boundary : excerpt.length)}…`;
}

function GroupCard({
  group,
  disabled,
  submitting,
  error,
  onDecide,
  drafts,
  onEditDraft,
  onResetDraft,
  sources,
}: {
  group: ReviewGroup;
  disabled: boolean;
  submitting: "approve" | "deny" | null;
  error?: string;
  onDecide: (group: ReviewGroup, decision: "approve" | "deny") => void;
  drafts: Record<string, LocalEmailDraft>;
  onEditDraft: (proposal: Proposal, field: "subject" | "body", value: string) => void;
  onResetDraft: (proposalId: string) => void;
  sources: ProjectState["sources"];
}) {
  const presentation = describeReviewGroup(group);
  const messages = group.proposals.filter(isMessage);
  return (
    <article className="rq-group" aria-label={presentation.title}>
      <header className="rq-group-heading">
        <div>
          <h3>{presentation.title}</h3>
        </div>
        {group.costImpactCents !== 0 && (
          <span
            className={`rq-cost${group.costImpactCents < 0 ? " rq-cost-saving" : ""}`}
          >
            {group.costImpactCents < 0 ? "−" : "+"}
            {amount(Math.abs(group.costImpactCents))}
          </span>
        )}
      </header>
      <ul className="rq-actions-list" aria-label="Included in this decision">
        {group.proposals.map((p) => {
          const detail = !isMessage(p) && p.kind !== "plan" ? p.description : "";
          return (
          <li key={p.id}>
            <span className="rq-action-icon">
              {p.kind === "email" ? (
                <Mail size={14} />
              ) : p.kind === "invitation" ? (
                <Send size={14} />
              ) : p.kind === "plan" ? (
                <FileText size={14} />
              ) : (
                <SlidersHorizontal size={14} />
              )}
            </span>
            <div className="rq-action-copy">
              <span className="rq-action-title">{p.title}</span>
              {isMessage(p) ? (
                <span className="rq-recipient">
                  {isDescriptionUpdate(p) ? "Event description · no guest email" : `To ${p.recipient || "Recipient not provided"}`}
                  {p.originalRecipient && p.originalRecipient !== p.recipient && (
                    <> · for {p.originalRecipient}</>
                  )}
                </span>
              ) : p.kind === "plan" ? (
                <div className="rq-operational-plan">
                  <p>{p.body}</p>
                  {p.evidence.some(id => sources.some(source => source.id === id)) && <small>Based on {p.evidence.flatMap(id => sources.filter(source => source.id === id).map(source => source.title)).join(" · ")}</small>}
                  <small>Approval saves this plan to the event records. No booking is made.</small>
                </div>
              ) : (
                <>
                  <div className="rq-fact-change">
                    <span><small>Current</small>{p.before}</span>
                    <ArrowRight size={12} />
                    <strong><small>Proposed</small>{p.after}</strong>
                  </div>
                  {group.proposals.filter(item => item.kind === "fact").length > 1 && p.costImpactCents !== null && p.costImpactCents !== 0 && (
                    <span className="rq-fact-cost">
                      {p.costImpactCents > 0 ? "+" : "−"}
                      {amount(Math.abs(p.costImpactCents))} in estimated costs
                    </span>
                  )}
                  {detail && <details className="rq-rationale"><summary>Why this change<ChevronDown size={12} /></summary><p>{detail}</p></details>}
                </>
              )}
            </div>
          </li>
          );
        })}
      </ul>
      {messages.length > 0 && (
        <details className="rq-preview">
          <summary>
            <Mail size={13} />
            <span>
              {messages.some(p => p.kind === "email" && p.draftToken) ? "Review and edit" : "Preview"} {messages.every(p => p.kind === "invitation") ? (messages.length === 1 ? "invitation" : "invitations") : (messages.length === 1 ? "message" : "messages")}
            </span>
            <ChevronDown size={13} />
          </summary>
          <div className="rq-drafts">
            {messages.map((p) => (
              <section
                className="rq-draft"
                key={p.id}
                aria-label={`Draft: ${p.title}`}
              >
                <dl>
                  {!isDescriptionUpdate(p) && <div>
                    <dt>To</dt>
                    <dd>{p.recipient || "Recipient not provided"}</dd>
                  </div>}
                  {p.originalRecipient && p.originalRecipient !== p.recipient && (
                    <div>
                      <dt>Regarding</dt>
                      <dd>{p.originalRecipient}</dd>
                    </div>
                  )}
                  {p.kind !== "email" || !p.draftToken ? <div>
                    <dt>{isDescriptionUpdate(p) ? "Event" : "Subject"}</dt>
                    <dd>{p.subject || "(No subject)"}</dd>
                  </div> : null}
                </dl>
                {p.kind === "email" && p.draftToken ? (
                  <div className="rq-draft-editor">
                    <label>Subject<input
                      value={drafts[p.id]?.subject ?? p.subject ?? ""}
                      onChange={event => onEditDraft(p, "subject", event.target.value)}
                      disabled={disabled} maxLength={300} aria-label={`Subject: ${p.title}`}
                    /></label>
                    <label>Message<textarea
                      value={drafts[p.id]?.body ?? p.body ?? ""}
                      onChange={event => onEditDraft(p, "body", event.target.value)}
                      disabled={disabled} maxLength={12000} rows={7} aria-label={`Message: ${p.title}`}
                    /></label>
                    {emailDraftChanged(p, drafts[p.id]) && drafts[p.id].draftToken !== p.draftToken ? (
                      <p className="rq-draft-conflict">This draft changed while you were editing. <button type="button" disabled={disabled} onClick={() => onResetDraft(p.id)}>Use latest draft</button></p>
                    ) : null}
                  </div>
                ) : <p>{p.body || p.description}</p>}
              </section>
            ))}
          </div>
        </details>
      )}
      <footer className="rq-group-footer">
        <div className="rq-decision-buttons">
          <button
            type="button"
            className="rq-approve"
            disabled={disabled}
            onClick={() => onDecide(group, "approve")}
          >
            {submitting === "approve" ? (
              <LoaderCircle size={14} className="rq-spin" />
            ) : (
              <Check size={14} />
            )}
            Approve
          </button>
          <button
            type="button"
            className="rq-deny"
            disabled={disabled}
            onClick={() => onDecide(group, "deny")}
          >
            {submitting === "deny" ? (
              <LoaderCircle size={14} className="rq-spin" />
            ) : (
              <X size={14} />
            )}
            Deny
          </button>
        </div>
        <span className="rq-scope">
          {group.proposals.length} {group.proposals.length === 1 ? "action" : "actions"}
        </span>
      </footer>
      {error && (
        <div className="rq-error" role="alert">
          <CircleAlert size={13} />
          <span>{error}</span>
        </div>
      )}
    </article>
  );
}

export default function ReviewQueue({
  state,
  busy,
  onDecide,
  communicationsOnly = false,
  emailDrafts,
  setEmailDrafts,
  onPlanCardAction,
}: ReviewQueueProps) {
  const [submitting, setSubmitting] = useState<{
    id: string;
    decision: "approve" | "deny";
  } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [localDrafts, setLocalDrafts] = useState<Record<string, LocalEmailDraft>>({});
  const drafts = emailDrafts ?? localDrafts;
  const setDrafts = setEmailDrafts ?? setLocalDrafts;
  const locked = useRef(false);
  const groups = reviewGroups(state.proposals, communicationsOnly);
  const planDecks = communicationsOnly ? [] : reviewPlanDecks(state.proposals);
  const venuePending = state.project.facts.venueCapacityPending ?? state.project.facts.venueDetailsPending ?? false;
  const overCapacity = venuePending || state.project.facts.venueCapacity <= 0 ? 0 : Math.max(
    0,
    state.project.facts.attendance - state.project.facts.venueCapacity,
  );
  const overBudget = Math.max(
    0,
    state.budget.totalCents - state.project.facts.budgetLimitCents,
  );
  const hasPlanningChecks =
    !communicationsOnly &&
    (overCapacity > 0 || overBudget > 0);

  async function decide(group: ReviewGroup, decision: "approve" | "deny") {
    if (locked.current || (busy && busy !== "save")) return;
    locked.current = true;
    // Capture IDs and preview tokens together. A later poll must not reauthorize
    // a changed recipient, account, or draft while this request waits in a queue.
    const snapshot = captureReviewDecision(group);
    setSubmitting({ id: group.id, decision });
    setErrors((previous) => {
      const next = { ...previous };
      delete next[group.id];
      return next;
    });
    try {
      const review = decision === "approve" ? {
        proposals: structuredClone(group.proposals),
        drafts: captureEmailDrafts(group.proposals, drafts),
      } : undefined;
      const ok = await onDecide(snapshot.proposalIds, decision, snapshot.approvalTokens, review);
      if (!ok)
        setErrors((previous) => ({
          ...previous,
          [group.id]:
            "This decision could not be saved. Review the latest details and try again.",
        }));
    } catch (error) {
      setErrors((previous) => ({
        ...previous,
          [group.id]: error instanceof Error ? error.message : "This decision could not be saved. Review the latest details and try again.",
      }));
    } finally {
      locked.current = false;
      setSubmitting(null);
    }
  }

  return (
    <div className="review-queue">
      {planDecks.map(proposal => <PlanCardDeck key={proposal.id} proposal={proposal} disabled={(!!busy && busy !== "save") || !!submitting} onAction={onPlanCardAction} />)}
      {groups.length > 0 ? (
        <div className="rq-groups">
          {groups.map((group) => (
            <GroupCard
              key={group.id}
              group={group}
              disabled={(!!busy && busy !== "save") || !!submitting}
              submitting={
                submitting?.id === group.id ? submitting.decision : null
              }
              error={errors[group.id]}
              onDecide={(selected, decision) => void decide(selected, decision)}
              drafts={drafts}
              sources={state.sources}
              onEditDraft={(proposal, field, value) => setDrafts(current => ({
                ...current,
                [proposal.id]: { ...(emailDraftChanged(proposal, current[proposal.id]) ? current[proposal.id] : {
                  subject: proposal.subject || "", body: proposal.body || "", draftToken: proposal.draftToken || "",
                }), [field]: value },
              }))}
              onResetDraft={proposalId => setDrafts(current => {
                const next = { ...current }; delete next[proposalId]; return next;
              })}
            />
          ))}
        </div>
      ) : !planDecks.length ? (
        <div className="rq-empty">
          <CheckCheck size={17} />
          <span>No decisions needed</span>
        </div>
      ) : null}
      {hasPlanningChecks && (
        <div className="rq-planning-checks">
          {(overCapacity > 0 || overBudget > 0) && (
            <div className="rq-constraints">
              <CircleAlert size={14} />
              <span>
                {[
                  overCapacity > 0
                    ? `${overCapacity} guests over venue capacity`
                    : "",
                  overBudget > 0 ? `${amount(overBudget)} over budget` : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
