import { useRef, useState } from "react";
import { ArrowRight, Check, ChevronLeft, ChevronRight, CircleAlert, LoaderCircle, Pencil, X } from "lucide-react";
import type { PlanCard, ProjectState, Proposal } from "../../shared/types";
import "./plan-card-deck.css";

export type { PlanCard } from "../../shared/types";
export type PlanCardAction = "approve" | "deny" | "rewrite";
export type OnPlanCardAction = (proposalId: string, cardId: string, action: PlanCardAction, revisionToken: string, instruction?: string) => Promise<ProjectState>;

export const getPlanCards = (proposal: Proposal): PlanCard[] => proposal.planCards ?? [];

export function reviewPlanDecks(proposals: readonly Proposal[]) {
  const byId = new Map(proposals.map(proposal => [proposal.id, proposal]));
  return proposals.filter(proposal => proposal.kind === "plan" && proposal.status === "pending" &&
    getPlanCards(proposal).some(card => card.status === "pending") &&
    proposal.dependencies.every(id => byId.get(id)?.status === "applied"));
}

export function nextPlanCardId(cards: readonly PlanCard[], currentId: string) {
  const index = cards.findIndex(card => card.id === currentId);
  const candidates = [...cards.slice(index + 1), ...cards.slice(0, index + 1)];
  return candidates.find(card => card.status === "pending")?.id ?? currentId;
}

export function planCardCopy(card: Pick<PlanCard, "title" | "body">) {
  const clean = (text: string) => text.replace(/^\s{0,3}#{1,6}\s+/gm, "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/__([^_]+)__/g, "$1").trim();
  let title = clean(card.title);
  let body = clean(card.body);
  if (/^(?:step|card|section)\s+\d+[.:]?$/i.test(title)) {
    const heading = /^([^:\n]{3,55}):\s*/.exec(body);
    if (heading) { title = heading[1]; body = body.slice(heading[0].length); }
    else if (body.includes("\n") && body.split("\n")[0].length <= 55) {
      title = body.split("\n")[0]; body = body.slice(title.length).trim();
    }
  }
  return { title, body: body.replace(/^\s*[-*]\s+/gm, "• ") };
}

export default function PlanCardDeck({ proposal, disabled = false, readOnly = false, embedded = false, onAction }: {
  proposal: Proposal; disabled?: boolean; readOnly?: boolean; embedded?: boolean; onAction?: OnPlanCardAction;
}) {
  const cards = getPlanCards(proposal);
  const [activeId, setActiveId] = useState(() => cards.find(card => card.status === "pending")?.id ?? cards[0]?.id);
  const [editing, setEditing] = useState<{ id: string; revisionToken: string } | null>(null);
  const [instruction, setInstruction] = useState("");
  const [working, setWorking] = useState<PlanCardAction | null>(null);
  const [error, setError] = useState("");
  const locked = useRef(false);
  const card = cards.find(item => item.id === activeId) ?? cards.find(item => item.status === "pending") ?? cards[0];
  if (!card) return null;
  const index = cards.findIndex(item => item.id === card.id);
  const remaining = cards.filter(item => item.status === "pending").length;
  const unavailable = disabled || !!working;
  const editable = !readOnly && proposal.status === "pending" && card.status === "pending" && !!onAction;
  const isEditing = editing?.id === card.id;
  const navigationLocked = unavailable || isEditing;
  const rewriting = working === "rewrite";
  const copy = planCardCopy(card);

  function select(id: string) {
    if (navigationLocked) return;
    setActiveId(id); setEditing(null); setInstruction(""); setError("");
  }

  async function act(action: PlanCardAction) {
    if (locked.current || unavailable || !editable || !onAction) return;
    const prompt = instruction.trim();
    if (action === "rewrite" && (!prompt || prompt.length > 1200)) {
      setError("Describe the change in 1–1,200 characters."); return;
    }
    const id = card.id;
    const revisionToken = action === "rewrite" ? editing?.revisionToken : card.revisionToken;
    if (!revisionToken) return;
    locked.current = true; setWorking(action); setError("");
    try {
      const next = await onAction(proposal.id, id, action, revisionToken, action === "rewrite" ? prompt : undefined);
      const updated = next.proposals.find(item => item.id === proposal.id);
      if (action !== "rewrite" && updated) setActiveId(nextPlanCardId(getPlanCards(updated), id));
      setEditing(null); setInstruction("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "This card could not be updated. Try again.");
    } finally {
      locked.current = false; setWorking(null);
    }
  }

  return (
    <section className={`plan-card-deck${embedded ? " pcd-embedded" : ""}`} aria-label={proposal.title}>
      <div className="pcd-meta"><span>Card {index + 1} of {cards.length}</span>{card.status !== "pending" && <span className={`pcd-state pcd-state-${card.status}`}>{card.status === "approved" ? <><Check size={12} />Approved</> : "Declined"}</span>}</div>
      <div className="pcd-stage" aria-busy={rewriting}>
        <div className={`pcd-content${rewriting ? " is-rewriting" : ""}`} key={`${card.id}:${card.revision}`} aria-hidden={rewriting || undefined}>
          <h4>{copy.title}</h4><p>{copy.body}</p>
        </div>
        {rewriting && <div className="pcd-rewriting" role="status"><LoaderCircle size={17} className="pcd-spin" />Revising this card…</div>}
      </div>
      {editable && (isEditing ? (
        <form className="pcd-editor" onSubmit={event => { event.preventDefault(); void act("rewrite"); }}>
          <label htmlFor={`plan-card-edit-${card.id}`}>What should change?</label>
          <textarea id={`plan-card-edit-${card.id}`} value={instruction} onChange={event => setInstruction(event.target.value)} maxLength={1200} rows={2} disabled={unavailable} autoFocus placeholder="Make arrival simpler, or adjust an assignment…" />
          <div><button className="pcd-approve" type="submit" disabled={unavailable || !instruction.trim()}>{rewriting ? <LoaderCircle size={13} className="pcd-spin" /> : <ArrowRight size={13} />}Update card</button><button type="button" disabled={unavailable} onClick={() => { setEditing(null); setInstruction(""); setError(""); }}>Cancel</button></div>
        </form>
      ) : (
        <div className="pcd-actions">
          <button type="button" className="pcd-approve" disabled={unavailable} onClick={() => void act("approve")}>{working === "approve" ? <LoaderCircle size={13} className="pcd-spin" /> : <Check size={13} />}Approve</button>
          <button type="button" disabled={unavailable} onClick={() => { setEditing({ id: card.id, revisionToken: card.revisionToken }); setError(""); }}><Pencil size={12} />Edit</button>
          <button type="button" className="pcd-deny" disabled={unavailable} onClick={() => void act("deny")}>{working === "deny" ? <LoaderCircle size={13} className="pcd-spin" /> : <X size={13} />}Deny</button>
        </div>
      ))}
      {error && <p className="pcd-error" role="alert"><CircleAlert size={13} />{error}</p>}
      <footer className="pcd-navigation">
        <button type="button" aria-label="Previous plan card" disabled={navigationLocked || index === 0} onClick={() => select(cards[index - 1].id)}><ChevronLeft size={17} /></button>
        <div className="pcd-dots" aria-label="Choose a plan card">{cards.map((item, at) => <button type="button" className={`pcd-dot pcd-dot-${item.status}${item.id === card.id ? " is-current" : ""}`} key={item.id} aria-label={`Card ${at + 1}: ${planCardCopy(item).title}`} aria-current={item.id === card.id ? "step" : undefined} disabled={navigationLocked} onClick={() => select(item.id)} />)}</div>
        <span>{readOnly ? "Saved plan" : `${remaining} to review`}</span>
        <button type="button" aria-label="Next plan card" disabled={navigationLocked || index === cards.length - 1} onClick={() => select(cards[index + 1].id)}><ChevronRight size={17} /></button>
      </footer>
    </section>
  );
}
