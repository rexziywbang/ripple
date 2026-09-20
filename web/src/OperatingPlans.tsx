import { ChevronDown, FileText } from "lucide-react";
import type { ProjectState } from "../../shared/types";
import PlanCardDeck, { getPlanCards } from "./PlanCardDeck";
import "./operating-plans.css";

type PlanRecords = Pick<ProjectState, "proposals" | "sources">;

/** A proposal alone is not a saved document. Cleared records stay hidden after Undo or a context change. */
export function savedOperatingPlans(state: PlanRecords) {
  const sources = new Map(state.sources.map(source => [source.id, source]));
  return state.proposals
    .filter(proposal => proposal.kind === "plan" && proposal.status === "applied")
    .flatMap(proposal => {
      const source = sources.get(`approved-plan:${proposal.id}`);
      if (!source?.content.trim()) return [];
      const heading = `# ${source.title}\n\n`;
      const body = source.content.startsWith(heading) ? source.content.slice(heading.length) : source.content;
      if (!body.trim()) return [];
      const cards = getPlanCards(proposal).filter(card => card.status === "approved");
      return [{ id: proposal.id, title: source.title, body, reason: proposal.description, version: proposal.version, createdAt: proposal.createdAt, proposal, cards }];
    })
    .sort((a, b) => b.version - a.version || b.createdAt.localeCompare(a.createdAt));
}

export default function OperatingPlans({ state }: { state: PlanRecords }) {
  const plans = savedOperatingPlans(state);
  if (!plans.length) return null;
  return (
    <section className="operating-plans" aria-label="Operating plans">
      <header><h3>Operating plans</h3><span>Saved for this event</span></header>
      <div className="op-list">
        {plans.map(plan => (
          <details className="op-document" key={plan.id}>
            <summary><FileText size={14} /><span>{plan.title}</span><ChevronDown size={13} /></summary>
            <div className="op-body">
              {plan.reason && !plan.cards.length && <p className="op-reason">{plan.reason}</p>}
              {plan.cards.length ? <PlanCardDeck proposal={{ ...plan.proposal, planCards: plan.cards }} readOnly embedded /> : <p className="op-content">{plan.body}</p>}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
