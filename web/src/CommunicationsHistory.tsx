import { ArrowDownLeft, ArrowUpRight, Check, ChevronDown, Clock3, ExternalLink, Mail, Utensils } from "lucide-react";
import type { Message, ProjectState } from "../../shared/types";
import "./communications-history.css";

const money = (cents: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
type VendorState = Pick<ProjectState, "project" | "proposals" | "receipts">;
export function vendorSummary(state: VendorState) {
  const f = state.project.facts;
  const quoteRequest = state.proposals.filter(p => p.kind === "email" && p.title === `Request a quote from ${f.caterer}`)
    .sort((a, b) => b.version - a.version || b.createdAt.localeCompare(a.createdAt))[0];
  if (f.cateringStatus === "awaiting_quote") {
    if (quoteRequest?.status === "pending" || quoteRequest?.status === "blocked")
      return { label: "Quote request ready", detail: "Approve the request below to ask for pricing.", priced: false };
    if (quoteRequest?.status === "approved")
      return { label: "Quote request approved", detail: "The request is queued. New pricing is still pending.", priced: false };
    if (quoteRequest?.status === "applied") {
      const delivered = state.receipts.some(r => r.proposalId === quoteRequest.id && r.status === "delivered");
      return { label: delivered ? "Waiting for quote" : "Quote request recorded", detail: delivered ? "Request delivered. The budget updates when the matching reply arrives." : "New pricing is pending; the budget remains incomplete.", priced: false };
    }
    return { label: quoteRequest?.status === "denied" ? "Quote request declined" : "Quote pending", detail: "No new catering price has been recorded.", priced: false };
  }
  if (f.cateringStatus === "quoted") return { label: "Quote received", detail: "Budget updated. The quoted arrangement still needs booking approval.", priced: true };
  if (f.cateringStatus === "awaiting_confirmation") return { label: "Awaiting booking confirmation", detail: "Final guest and staff updates stay on hold until confirmation.", priced: true };
  return { label: "Catering confirmed", detail: "Current catering arrangement in the event plan.", priced: true };
}

export function VendorStatus({ state }: { state: ProjectState }) {
  const f = state.project.facts;
  if (!f.caterer) return null;
  const summary = vendorSummary(state);
  const received = f.cateringStatus === "quoted" || f.cateringStatus === "confirmed";
  return <section className={`cm-vendor${received ? " cm-vendor-ready" : ""}`} aria-label="Current catering status">
    <span className="cm-vendor-icon"><Utensils size={17} strokeWidth={1.65} aria-hidden="true" /></span>
    <div className="cm-vendor-copy"><span className="cm-vendor-label">Catering</span><h2>{f.caterer}</h2><div className="cm-vendor-state">{received ? <Check size={12} /> : <Clock3 size={12} />}{summary.label}</div><p>{summary.detail}</p></div>
    {summary.priced && <div className="cm-vendor-price"><strong>{money(f.attendance * f.cateringPerPersonCents + f.cateringDeliveryCents)}</strong><span>{money(f.cateringPerPersonCents)} / guest</span><small>{money(f.cateringDeliveryCents)} delivery</small></div>}
  </section>;
}

export function messagePresentation(message: Message) {
  const direction = message.direction === "inbound" ? "Incoming" : "Outgoing";
  const status = message.simulated ? "Recorded" : message.direction === "inbound" ? "Received" : "Sent";
  let gmailUrl: string | undefined;
  if (!message.simulated && message.url) {
    try {
      const url = new URL(message.url);
      if (url.protocol === "https:" && url.hostname === "mail.google.com" && !url.username && !url.password) gmailUrl = url.href;
    } catch { /* A message without a verified Gmail URL still has its local record. */ }
  }
  return { direction, status, gmailUrl };
}
function timestamp(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const sameDay = date.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat("en-US", { ...(sameDay ? {} : { month: "short", day: "numeric" } as const), hour: "numeric", minute: "2-digit" }).format(date);
}
function MessageRow({ message }: { message: Message }) {
  const { direction, status, gmailUrl } = messagePresentation(message);
  const long = message.body.length > 320 || message.body.split("\n").length > 5;
  return <article className={`cm-message cm-${message.direction}`}>
    <header className="cm-message-meta"><span className="cm-direction">{message.direction === "inbound" ? <ArrowDownLeft size={13} /> : <ArrowUpRight size={13} />}{direction}</span><span className="cm-delivery" title={message.simulated ? "Stored in the event; no external delivery receipt." : undefined}>{status}{message.simulated ? " locally" : ""}</span><time dateTime={message.at}>{timestamp(message.at)}</time></header>
    <h3>{message.subject}</h3>
    <p className="cm-address">{message.direction === "inbound" ? "From" : "To"}: {message.from}</p>
    {long ? <details className="cm-message-body"><summary><span className="cm-body-excerpt">{message.body.replace(/\s+/g, " ").trim().slice(0, 190)}…</span><span className="cm-body-toggle"><span className="cm-read-more">Read full message</span><span className="cm-read-less">Collapse message</span><ChevronDown size={12} /></span></summary><p>{message.body}</p></details> : <p className="cm-full-body">{message.body}</p>}
    {gmailUrl && <a className="cm-gmail-link" href={gmailUrl} target="_blank" rel="noreferrer">Open in Gmail<ExternalLink size={11} /></a>}
  </article>;
}

export default function CommunicationsHistory({ state }: { state: ProjectState }) {
  const queued = Math.max(0, state.emailDelivery?.pendingCount ?? 0);
  return <section className="surface cm-history" aria-label="Conversation history">
    <div className="surface-header"><h2>Conversation history</h2><span className="subtle-count">{state.messages.length}</span></div>
    {queued > 0 && <div className="cm-queued" role="status"><Mail size={13} />{queued} {queued === 1 ? "email" : "emails"} queued for Gmail</div>}
    <div className="cm-messages">{state.messages.map(message => <MessageRow key={message.id} message={message} />)}{!state.messages.length && <p className="cm-empty"><Mail size={18} />Approved messages and vendor replies will appear here.</p>}</div>
  </section>;
}
