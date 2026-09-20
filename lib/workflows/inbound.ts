import { and, eq, inArray, ne, like } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import * as s from "@/lib/db/schema";
import { newId, now } from "@/lib/domain/ids";
import { formatCents } from "@/lib/domain/money";
import { formatLongDate, renderBudgetCsv, renderVendorsMd } from "@/lib/domain/projections";
import { loadProjectContext } from "@/lib/planner/context";
import type { ProposalDraft } from "@/lib/planner/types";
import { appendEvent, bumpProjectRevision } from "./events";
import { persistProposals, setFact, invalidateDependents, wakeWaitingWorkflows, refreshWorkflowStatus } from "./service";

export type InboundInput = {
  projectId: string;
  provider: "gmail";
  providerMessageId: string;
  threadId?: string | null;
  from: string;
  to?: string[];
  subject: string;
  body: string;
  receivedAt?: number;
  simulated?: boolean;
  fixtureLabel?: string | null;
};

export type InboundOutcome = { outcome: string; detail: string; messageId: string | null; extracted?: unknown };

export type ParsedQuote = {
  reference: string | null;
  currency: string;
  quantity: number | null;
  unitCents: number | null;
  feeCents: number;
  totalCents: number | null;
  validUntil: string | null;
  dateQuoted: string | null;
  arithmeticOk: boolean;
  dietary: string[];
};

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function moneyToCents(str: string): number {
  return Math.round(Number(str.replace(/,/g, "")) * 100);
}

export function parseLongDate(text: string): string | null {
  const m = text.match(/(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].toLowerCase()) + 1;
  return `${m[3]}-${String(month).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

/** Deterministic quote extraction from email text. Every number is tied to the line it came from. */
export function parseQuote(body: string): ParsedQuote | null {
  const total = body.match(/Total:\s*USD\s*([\d,]+\.\d{2})/i);
  const line = body.match(/(\d+)\s*guests?\s*x\s*USD\s*([\d,]+\.\d{2})/i);
  if (!total && !line) return null;
  const fee = [...body.matchAll(/(?:fee|delivery)[^\n:]*:\s*USD\s*([\d,]+\.\d{2})/gi)].reduce((acc, m) => acc + moneyToCents(m[1]), 0);
  const quantity = line ? Number(line[1]) : null;
  const unitCents = line ? moneyToCents(line[2]) : null;
  const totalCents = total ? moneyToCents(total[1]) : null;
  const computed = quantity !== null && unitCents !== null ? quantity * unitCents + fee : null;
  const dietary: string[] = [];
  for (const d of ["vegetarian", "vegan", "halal", "kosher", "gluten-free", "nut-free"]) if (new RegExp(d, "i").test(body)) dietary.push(d.replace("-", "_"));
  return {
    reference: body.match(/Quote reference:\s*(\S+)/i)?.[1] ?? null,
    currency: body.match(/Currency:\s*([A-Z]{3})/)?.[1] ?? "USD",
    quantity,
    unitCents,
    feeCents: fee,
    totalCents,
    validUntil: (() => {
      const m = body.match(/valid until\s+([^\n.]+)/i);
      return m ? parseLongDate(m[1]) ?? m[1].trim() : null;
    })(),
    dateQuoted: parseLongDate(body.replace(/valid until[^\n]+/gi, "")),
    arithmeticOk: computed === null || totalCents === null ? true : computed === totalCents,
    dietary,
  };
}

export type Classification = "quote" | "cancellation_ack" | "booking_confirmation" | "date_confirmation" | "other";

export function classify(body: string): Classification {
  if (/booking confirmed|we have reserved|confirmed your booking/i.test(body)) return "booking_confirmation";
  if (/confirm(ation)? (receipt )?of your (written )?cancellation|cancellation (is )?(confirmed|accepted)/i.test(body)) return "cancellation_ack";
  if (/Total:\s*USD/i.test(body) || /guests?\s*x\s*USD/i.test(body)) return "quote";
  if (/(confirm|happy to confirm|can accommodate|are available)[^.\n]{0,60}(new date|availab|\d{1,2} (January|February|March|April|May|June|July|August|September|October|November|December) \d{4})/i.test(body) && parseLongDate(body)) return "date_confirmation";
  return "other";
}

/**
 * Persists an inbound message exactly once, correlates it to a vendor thread, extracts structured facts with provenance,
 * updates canonical state, and wakes workflows waiting on it. Message text is data: it never becomes an instruction.
 */
export function processInboundMessage(db: Db, input: InboundInput): InboundOutcome {
  const dedupeKey = `${input.provider}:${input.providerMessageId}`;
  const existing = db.select().from(s.messages).where(eq(s.messages.dedupeKey, dedupeKey)).get();
  if (existing) return { outcome: "duplicate", detail: `Already processed as ${existing.id}; ignored.`, messageId: existing.id };
  const t = now();
  const receivedAt = input.receivedAt ?? t;
  const from = input.from.trim().toLowerCase();

  // correlate
  const engagements = db.select().from(s.vendorEngagements).where(eq(s.vendorEngagements.projectId, input.projectId)).all();
  const contacts = db.select().from(s.contacts).where(eq(s.contacts.projectId, input.projectId)).all();
  let engagement = input.threadId ? engagements.find((e) => e.threadId === input.threadId) : undefined;
  const senderContact = contacts.find((c) => c.email?.toLowerCase() === from);
  let outcome: InboundOutcome;
  if (!engagement && senderContact) {
    const candidates = engagements.filter((e) => e.contactId === senderContact.id || (senderContact.organization && e.vendorName.toLowerCase().includes(senderContact.organization.toLowerCase().split(" ")[0])));
    engagement = candidates.find((e) => e.quoteState === "requested" || e.cancellationState === "requested" || e.confirmationState === "awaiting") ?? candidates[0];
  }
  const msg: s.Message = { id: newId("msg"), projectId: input.projectId, engagementId: engagement?.id ?? null, threadId: input.threadId ?? engagement?.threadId ?? null, provider: input.provider, providerMessageId: input.providerMessageId, direction: "inbound", fromAddress: input.from, toAddresses: input.to ?? [], subject: input.subject, body: input.body, receivedAt, dedupeKey, processed: false, processingResult: null, simulated: input.simulated ?? true, fixtureLabel: input.fixtureLabel ?? null };
  db.insert(s.messages).values(msg).run();

  if (!engagement) {
    outcome = { outcome: "unmatched", detail: "No matching vendor thread or contact. Filed in the inbox as untrusted content; no facts or actions were changed.", messageId: msg.id };
    appendEvent(db, input.projectId, null, "inbound.unmatched", `Email from ${input.from} (“${input.subject}”) did not match any vendor thread. Treated as untrusted content; nothing changed.`, { data: { messageId: msg.id } });
  } else if (senderContact && engagement.contactId && senderContact.id !== engagement.contactId) {
    outcome = { outcome: "sender_mismatch", detail: `Reply arrived on the ${engagement.vendorName} thread but from ${input.from}, which is not the verified contact. Held for your review.`, messageId: msg.id };
    appendEvent(db, input.projectId, null, "inbound.needs_attention", outcome.detail, { data: { messageId: msg.id } });
  } else if (!senderContact) {
    outcome = { outcome: "sender_unverified", detail: `Reply on the ${engagement.vendorName} thread from an unknown address ${input.from}. Held for your review; no facts changed.`, messageId: msg.id };
    appendEvent(db, input.projectId, null, "inbound.needs_attention", outcome.detail, { data: { messageId: msg.id } });
  } else {
    const kind = classify(input.body);
    if (kind === "quote") outcome = handleQuote(db, msg, engagement);
    else if (kind === "cancellation_ack") outcome = handleCancellationAck(db, msg, engagement);
    else if (kind === "booking_confirmation") outcome = handleConfirmation(db, msg, engagement);
    else if (kind === "date_confirmation") outcome = handleDateConfirmation(db, msg, engagement);
    else {
      outcome = { outcome: "filed", detail: `Reply from ${engagement.vendorName} filed on the thread; no quote, confirmation or cancellation terms were recognised.`, messageId: msg.id };
      appendEvent(db, input.projectId, null, "inbound.filed", outcome.detail, { data: { messageId: msg.id } });
    }
  }
  db.update(s.messages).set({ processed: true, processingResult: { outcome: outcome.outcome, detail: outcome.detail, extracted: outcome.extracted } }).where(eq(s.messages.id, msg.id)).run();
  return outcome;
}

function waitingWorkflowsFor(db: Db, projectId: string, condition: string): s.Workflow[] {
  const props = db
    .select()
    .from(s.proposals)
    .where(and(eq(s.proposals.projectId, projectId), like(s.proposals.waitsFor, `${condition}%`), inArray(s.proposals.decision, ["approved", "pending"])))
    .all();
  const ids = [...new Set(props.map((p) => p.workflowId))];
  if (!ids.length) return [];
  return db.select().from(s.workflows).where(inArray(s.workflows.id, ids)).all().filter((w) => !["superseded", "failed"].includes(w.status));
}

function evidence(msg: s.Message, excerpt: string): s.EvidenceRef[] {
  return [{ sourceType: "message", ref: msg.id, excerpt, label: `${msg.fromAddress} — ${msg.subject}` }];
}

function lineExcerpt(body: string, re: RegExp): string {
  return body.split("\n").find((l) => re.test(l))?.trim() ?? "";
}

function handleQuote(db: Db, msg: s.Message, e: s.VendorEngagement): InboundOutcome {
  const q = parseQuote(msg.body);
  const projectId = msg.projectId;
  if (!q || q.totalCents === null) {
    appendEvent(db, projectId, null, "inbound.needs_attention", `Reply from ${e.vendorName} looks like a quote but no total could be extracted. Review the message.`, { data: { messageId: msg.id } });
    return { outcome: "quote_unparsed", detail: "Quote total could not be extracted.", messageId: msg.id };
  }
  const facts = db.select().from(s.projectFacts).where(eq(s.projectFacts.projectId, projectId)).all();
  const attendance = facts.find((f) => f.key === "attendance.expected")?.value as number | undefined;
  const eventDate = facts.find((f) => f.key === "event.date")?.value as string | undefined;
  const t = now();
  const problems: string[] = [];
  if (!q.arithmeticOk) problems.push("the line items do not add up to the stated total");
  if (q.quantity !== null && attendance !== undefined && q.quantity !== attendance) problems.push(`it is priced for ${q.quantity} guests but the event expects ${attendance}`);
  if (q.dateQuoted && eventDate && q.dateQuoted !== eventDate) problems.push(`it is for ${q.dateQuoted} but the event is on ${eventDate}`);
  const latest = e.quotes.filter((x) => x.status !== "mismatched").sort((a, b) => (b.receivedAt ?? 0) - (a.receivedAt ?? 0))[0];
  const outOfOrder = latest && latest.receivedAt !== undefined && msg.receivedAt < latest.receivedAt;
  const snapshot: s.QuoteSnapshot = { version: e.quotes.length + 1, currency: q.currency, quantity: q.quantity ?? 0, unitCents: q.unitCents ?? 0, feeCents: q.feeCents, taxCents: null, totalCents: q.totalCents, expiresAt: q.validUntil ?? undefined, dietary: q.dietary, attendanceQuoted: q.quantity ?? undefined, dateQuoted: q.dateQuoted ?? undefined, messageId: msg.id, receivedAt: msg.receivedAt, status: problems.length ? "mismatched" : outOfOrder ? "superseded" : "received", notes: q.reference ?? undefined };
  const waiting = waitingWorkflowsFor(db, projectId, `engagement:${e.id}:quote_received`);

  if (problems.length) {
    db.update(s.vendorEngagements).set({ quotes: [...e.quotes, snapshot], version: e.version + 1, updatedAt: t }).where(eq(s.vendorEngagements.id, e.id)).run();
    const detail = `Quote ${q.reference ?? ""} from ${e.vendorName} (${formatCents(q.totalCents)}) was NOT applied: ${problems.join("; ")}. Forecast unchanged.`;
    appendEvent(db, projectId, waiting[0]?.id ?? null, "inbound.needs_attention", detail, { data: { messageId: msg.id, quote: snapshot } });
    for (const wf of waiting) {
      const ctx = loadProjectContext(db, projectId);
      const contact = ctx.contacts.find((c) => c.id === e.contactId);
      const drafts: ProposalDraft[] = [
        { key: "mismatch_check", kind: "check", area: "catering", title: `${e.vendorName} quote does not match the event`, target: { type: "check", note: detail }, before: null, after: null, rationale: detail, evidence: evidence(msg, lineExcerpt(msg.body, /guests?\s*x/i)), factDepKeys: ["attendance.expected", "event.date"], cost: null, requires: [], external: false, stage: "check_sources", informational: true, severity: "warning" },
      ];
      if (contact?.email) {
        drafts.push({ key: "requote", kind: "email", area: "catering", title: `Ask ${e.vendorName} to requote for ${attendance ?? "the current"} guests`, target: { type: "email", to: [{ name: contact.name, email: contact.email }], subject: `Re: ${msg.subject.replace(/^Re:\s*/i, "")}`, body: `Hello ${contact.name.split(" ")[0]},\n\nThank you for quote ${q.reference ?? ""}. It is priced for ${q.quantity} guests${q.dateQuoted && eventDate && q.dateQuoted !== eventDate ? ` on ${q.dateQuoted}` : ""}; our event is ${attendance} guests on ${eventDate ? formatLongDate(eventDate) : "the agreed date"}. Could you please reissue the quote on that basis?\n\nThank you,\n${ctx.project.name} organising team`, threadId: e.threadId, engagementId: e.id, purpose: "requote" }, before: null, after: { to: [contact.email], subject: "requote" }, rationale: "The quote must match the event before it can be compared or accepted.", evidence: evidence(msg, lineExcerpt(msg.body, /guests?\s*x/i)), factDepKeys: ["attendance.expected", "event.date"], cost: null, requires: [], external: true, stage: "prepare_updates" });
      }
      persistProposals(db, ctx, wf, drafts);
      db.update(s.workflows).set({ status: "ready_for_review", stage: "review", updatedAt: t }).where(eq(s.workflows.id, wf.id)).run();
    }
    return { outcome: "quote_mismatch", detail, messageId: msg.id, extracted: snapshot };
  }

  if (outOfOrder) {
    db.update(s.vendorEngagements).set({ quotes: [...e.quotes, snapshot], version: e.version + 1, updatedAt: t }).where(eq(s.vendorEngagements.id, e.id)).run();
    const detail = `Older quote ${q.reference ?? ""} from ${e.vendorName} arrived after a newer one; recorded as superseded, forecast unchanged.`;
    appendEvent(db, projectId, waiting[0]?.id ?? null, "inbound.superseded", detail, { data: { messageId: msg.id } });
    return { outcome: "quote_out_of_order", detail, messageId: msg.id, extracted: snapshot };
  }

  if (e.quoteState === "accepted") {
    db.update(s.vendorEngagements).set({ quotes: [...e.quotes, { ...snapshot, status: "superseded", notes: `${snapshot.notes ?? ""} (arrived after acceptance; not applied)` }], version: e.version + 1, updatedAt: t }).where(eq(s.vendorEngagements.id, e.id)).run();
    const detail = `A further quote from ${e.vendorName} arrived after their quote was accepted. Recorded but not applied — review if the price should change.`;
    appendEvent(db, projectId, waiting[0]?.id ?? null, "inbound.needs_attention", detail, { data: { messageId: msg.id } });
    return { outcome: "quote_after_acceptance", detail, messageId: msg.id, extracted: snapshot };
  }

  // apply: supersede earlier received quotes, update engagement + budget line, revise forecast
  const quotes = [...e.quotes.map((x) => (x.status === "received" ? { ...x, status: "superseded" as const } : x)), snapshot];
  db.update(s.vendorEngagements).set({ quotes, quoteState: "received", unitCents: q.unitCents, quantity: q.quantity, feeCents: q.feeCents, version: e.version + 1, updatedAt: t }).where(eq(s.vendorEngagements.id, e.id)).run();
  const line = db.select().from(s.budgetLines).where(and(eq(s.budgetLines.projectId, projectId), eq(s.budgetLines.engagementId, e.id), eq(s.budgetLines.active, true))).get();
  const provenance: s.FactSourceRef = { type: "message", id: msg.id, excerpt: lineExcerpt(msg.body, /Total:/i) };
  const label = `${e.vendorName} ${e.service} (quoted ${q.reference ?? ""})`.trim();
  if (line) {
    db.update(s.budgetLines).set({ label, quantity: q.quantity ?? line.quantity, unitCents: q.unitCents, subtotalCents: q.totalCents, commitmentStatus: "quoted", provenance: [provenance, ...line.provenance].slice(0, 10), version: line.version + 1, updatedAt: t }).where(eq(s.budgetLines.id, line.id)).run();
  } else {
    db.insert(s.budgetLines).values({ id: newId("line"), projectId, category: e.service, label, quantity: q.quantity ?? 1, unitCents: q.unitCents, subtotalCents: q.totalCents, taxCents: 0, currency: q.currency, commitmentStatus: "quoted", engagementId: e.id, provenance: [provenance], active: true, version: 1, updatedAt: t }).run();
  }
  bumpProjectRevision(db, projectId);
  const all = db.select().from(s.budgetLines).where(and(eq(s.budgetLines.projectId, projectId), eq(s.budgetLines.active, true))).all();
  const forecast = all.reduce((acc, l) => acc + (l.subtotalCents ?? 0) + l.taxCents, 0);
  const unknown = all.filter((l) => l.subtotalCents === null).length;
  const sunk = all.filter((l) => l.commitmentStatus === "sunk").reduce((a, l) => a + (l.subtotalCents ?? 0), 0);
  const ceiling = facts.find((f) => f.key === "budget.ceiling_cents")?.value as number | undefined;
  const cancelling = db.select().from(s.vendorEngagements).where(and(eq(s.vendorEngagements.projectId, projectId), ne(s.vendorEngagements.cancellationState, "none"))).all();
  const pendingRelease = all.filter((l) => l.commitmentStatus === "committed" && cancelling.some((c) => c.id === l.engagementId)).reduce((a, l) => a + (l.subtotalCents ?? 0) + l.taxCents, 0);
  const releaseNote = pendingRelease ? ` The ${formatCents(pendingRelease)} still counted for ${cancelling.map((c) => c.vendorName).join(", ")} is released (minus any retained deposit) when the workflow applies the cancellation.` : "";
  const detail = `Quote ${q.reference ?? ""} from ${e.vendorName}: ${q.quantity} × ${formatCents(q.unitCents)} + ${formatCents(q.feeCents)} fees = ${formatCents(q.totalCents)}${q.validUntil ? `, valid until ${q.validUntil}` : ""}. Forecast revised to ${formatCents(forecast)}${unknown ? ` plus ${unknown} unknown line${unknown > 1 ? "s" : ""}` : ""}${sunk ? ` (includes ${formatCents(sunk)} sunk deposit)` : ""}${ceiling !== undefined ? `, ${forecast <= ceiling ? "within" : "over"} the ${formatCents(ceiling)} ceiling` : ""}.${releaseNote}`;
  appendEvent(db, projectId, waiting[0]?.id ?? null, "inbound.quote", detail, { data: { messageId: msg.id, quote: snapshot, forecastCents: forecast } });

  for (const wf of waiting) {
    const ctx = loadProjectContext(db, projectId);
    const contact = ctx.contacts.find((c) => c.id === e.contactId);
    const cancelled = ctx.engagements.filter((x) => x.service === e.service && x.id !== e.id && x.cancellationState !== "none");
    const former = cancelled[0];
    const formerLine = former ? ctx.budgetLines.find((l) => l.engagementId === former.id) : undefined;
    const formerTotal = former ? (former.unitCents ?? 0) * (former.quantity ?? 0) + former.feeCents : null;
    const comparison = former && formerTotal !== null ? `${former.vendorName}: ${formatCents(formerTotal)} (${former.quantity} × ${formatCents(former.unitCents)}) vs ${e.vendorName}: ${formatCents(q.totalCents)} (${q.quantity} × ${formatCents(q.unitCents)} + ${formatCents(q.feeCents)} fees) — ${formatCents(Math.abs(q.totalCents - formerTotal))} ${q.totalCents > formerTotal ? "more" : "less"}${formerLine?.commitmentStatus === "sunk" ? `, plus the ${formatCents(formerLine.subtotalCents)} ${former.vendorName} deposit already sunk` : ""}.` : `${e.vendorName} quote ${formatCents(q.totalCents)}.`;
    const drafts: ProposalDraft[] = [
      { key: "cmp", kind: "check", area: "budget", title: "Quote comparison", target: { type: "check", note: comparison }, before: null, after: null, rationale: comparison, evidence: evidence(msg, lineExcerpt(msg.body, /Total:/i)), factDepKeys: [], cost: null, requires: [], external: false, stage: "check_sources", informational: true, severity: "info" },
    ];
    if (contact?.email) {
      drafts.push({ key: "accept", kind: "email", area: "catering", title: `Accept the ${e.vendorName} quote${q.reference ? ` ${q.reference}` : ""}`, target: { type: "email", to: [{ name: contact.name, email: contact.email }], subject: `Re: ${msg.subject.replace(/^Re:\s*/i, "")}`, body: `Hello ${contact.name.split(" ")[0]},\n\nThank you for quote ${q.reference ?? ""} (${formatCents(q.totalCents)} for ${q.quantity} guests${q.dateQuoted ? ` on ${formatLongDate(q.dateQuoted)}` : ""}). We would like to accept and book on that basis. Please confirm the booking in writing and send the deposit invoice.\n\nThank you,\n${ctx.project.name} organising team`, threadId: e.threadId, engagementId: e.id, purpose: "accept_quote" }, before: null, after: { to: [contact.email], subject: "accept", reference: q.reference, totalCents: q.totalCents }, rationale: "Accepting is a commitment and needs your approval. The booking is confirmed only when the vendor replies.", evidence: evidence(msg, lineExcerpt(msg.body, /Total:/i)), factDepKeys: ["attendance.expected", "event.date"], cost: { deltaCents: null, status: "quoted", label: `Commits ${formatCents(q.totalCents)} on confirmation`, currency: q.currency }, requires: [], external: true, stage: "prepare_updates" });
      drafts.push({ key: "acc_state", kind: "engagement", area: "catering", title: `Mark ${e.vendorName} quote as accepted`, target: { type: "engagement", engagementId: e.id, field: "quoteState" }, before: "received", after: "accepted", rationale: "Follows the acceptance message.", evidence: [], factDepKeys: [], cost: null, requires: ["accept"], external: false, stage: "follow_consequences" });
      drafts.push({ key: "awaiting", kind: "engagement", area: "catering", title: `Mark ${e.vendorName} booking as awaiting confirmation`, target: { type: "engagement", engagementId: e.id, field: "confirmationState" }, before: e.confirmationState, after: "awaiting", rationale: "Acceptance sent; confirmation pending.", evidence: [], factDepKeys: [], cost: null, requires: ["accept"], external: false, stage: "follow_consequences" });
      drafts.push({ key: "wait_conf", kind: "wait", area: "catering", title: `Waiting for ${e.vendorName} to confirm the booking`, target: { type: "check", note: "Staff, invitation and file updates follow the confirmation." }, before: null, after: `engagement:${e.id}:confirmed`, rationale: "Downstream updates wait for confirmation.", evidence: [], factDepKeys: [], cost: null, requires: ["accept"], waitsFor: `engagement:${e.id}:confirmed`, external: false, stage: "prepare_updates" });
    }
    persistProposals(db, ctx, wf, drafts);
    db.update(s.workflows).set({ status: "ready_for_review", stage: "review", summary: detail, updatedAt: t }).where(eq(s.workflows.id, wf.id)).run();
    appendEvent(db, projectId, wf.id, "workflow.ready_for_review", `Quote received — review the comparison and the acceptance draft.`, { stage: "review" });
  }
  wakeWaitingWorkflows(db, projectId);
  return { outcome: "quote_applied", detail, messageId: msg.id, extracted: snapshot };
}

function handleDateConfirmation(db: Db, msg: s.Message, e: s.VendorEngagement): InboundOutcome {
  const date = parseLongDate(msg.body)!;
  const eventDate = db.select().from(s.projectFacts).where(and(eq(s.projectFacts.projectId, msg.projectId), eq(s.projectFacts.key, "event.date"))).get()?.value;
  if (eventDate !== date) {
    const detail = `${e.vendorName} confirmed availability for ${date}, but the event date is ${String(eventDate)}. Held for review.`;
    appendEvent(db, msg.projectId, null, "inbound.needs_attention", detail, { data: { messageId: msg.id } });
    return { outcome: "date_mismatch", detail, messageId: msg.id, extracted: { date } };
  }
  const detail = `${e.vendorName} confirmed availability for ${formatLongDate(date)}.`;
  const waiting = waitingWorkflowsFor(db, msg.projectId, `engagement:${e.id}:date_confirmed`);
  appendEvent(db, msg.projectId, waiting[0]?.id ?? null, "inbound.date_confirmed", detail, { data: { messageId: msg.id, date } });
  // the message must be marked processed before waiting workflows re-check the condition
  db.update(s.messages).set({ processed: true, processingResult: { outcome: "date_confirmed", detail, extracted: { date } } }).where(eq(s.messages.id, msg.id)).run();
  wakeWaitingWorkflows(db, msg.projectId);
  return { outcome: "date_confirmed", detail, messageId: msg.id, extracted: { date } };
}

function handleCancellationAck(db: Db, msg: s.Message, e: s.VendorEngagement): InboundOutcome {
  const projectId = msg.projectId;
  const t = now();
  const retained = msg.body.match(/USD\s*([\d,]+\.\d{2})\s*deposit is retained/i);
  const released = msg.body.match(/balance of USD\s*([\d,]+\.\d{2}) is released/i);
  const noFee = /no additional cancellation fee/i.test(msg.body);
  const retainedCents = retained ? moneyToCents(retained[1]) : null;
  if (e.cancellationState === "none") {
    const detail = `${e.vendorName} acknowledged a cancellation that Ripple never sent. Held for review; nothing changed.`;
    appendEvent(db, projectId, null, "inbound.needs_attention", detail, { data: { messageId: msg.id } });
    return { outcome: "unexpected_cancellation_ack", detail, messageId: msg.id };
  }
  if (e.cancellationState === "confirmed") {
    return { outcome: "duplicate_ack", detail: `${e.vendorName} cancellation was already confirmed; duplicate acknowledgement filed.`, messageId: msg.id };
  }
  if (retainedCents !== null && e.depositCents !== null && retainedCents !== e.depositCents) {
    const detail = `${e.vendorName} says ${formatCents(retainedCents)} is retained but the agreement records a ${formatCents(e.depositCents)} deposit. Held for review before the forecast changes.`;
    appendEvent(db, projectId, null, "inbound.needs_attention", detail, { data: { messageId: msg.id } });
    db.update(s.vendorEngagements).set({ cancellationState: "disputed", version: e.version + 1, updatedAt: t }).where(eq(s.vendorEngagements.id, e.id)).run();
    return { outcome: "cancellation_disputed", detail, messageId: msg.id };
  }
  db.update(s.vendorEngagements).set({ cancellationState: "confirmed", confirmationState: "declined", version: e.version + 1, notes: `${e.notes ?? ""}\nCancellation confirmed ${new Date(msg.receivedAt).toISOString().slice(0, 10)}: ${lineExcerpt(msg.body, /retained/i)}`.trim(), updatedAt: t }).where(eq(s.vendorEngagements.id, e.id)).run();
  const waiting = waitingWorkflowsFor(db, projectId, `engagement:${e.id}:cancellation_confirmed`);
  const detail = `${e.vendorName} confirmed the cancellation: ${retainedCents !== null ? `${formatCents(retainedCents)} deposit retained (sunk)` : "deposit position stated in message"}${released ? `, ${formatCents(moneyToCents(released[1]))} balance released` : ""}${noFee ? ", no further fee" : ""}.`;
  appendEvent(db, projectId, waiting[0]?.id ?? null, "inbound.cancellation_confirmed", detail, { data: { messageId: msg.id, retainedCents } });
  if (!waiting.length) {
    // no workflow waiting: still record the sunk deposit on the budget line
    const line = db.select().from(s.budgetLines).where(and(eq(s.budgetLines.projectId, projectId), eq(s.budgetLines.engagementId, e.id), eq(s.budgetLines.active, true))).get();
    if (line && retainedCents !== null) {
      db.update(s.budgetLines).set({ label: `${e.vendorName} deposit (retained after cancellation)`, quantity: 1, unitCents: retainedCents, subtotalCents: retainedCents, commitmentStatus: "sunk", provenance: [{ type: "message" as const, id: msg.id, excerpt: lineExcerpt(msg.body, /retained/i) }, ...line.provenance], version: line.version + 1, updatedAt: t }).where(eq(s.budgetLines.id, line.id)).run();
      bumpProjectRevision(db, projectId);
    }
  }
  wakeWaitingWorkflows(db, projectId);
  return { outcome: "cancellation_confirmed", detail, messageId: msg.id, extracted: { retainedCents, noFee } };
}

function handleConfirmation(db: Db, msg: s.Message, e: s.VendorEngagement): InboundOutcome {
  const projectId = msg.projectId;
  const t = now();
  if (e.confirmationState === "confirmed") return { outcome: "duplicate_confirmation", detail: `${e.vendorName} booking was already confirmed; duplicate filed.`, messageId: msg.id };
  if (e.quoteState !== "accepted") {
    const detail = `${e.vendorName} sent a booking confirmation but no acceptance was sent from Ripple (quote state: ${e.quoteState}). Held for review; the booking is not recorded as confirmed.`;
    appendEvent(db, projectId, null, "inbound.needs_attention", detail, { data: { messageId: msg.id } });
    return { outcome: "unexpected_confirmation", detail, messageId: msg.id };
  }
  const accepted = e.quotes.find((q) => q.status === "received" || q.status === "accepted");
  const amount = msg.body.match(/USD\s*([\d,]+\.\d{2})\s*total/i);
  const confirmedCents = amount ? moneyToCents(amount[1]) : null;
  if (accepted && confirmedCents !== null && confirmedCents !== accepted.totalCents) {
    const detail = `${e.vendorName} confirmed ${formatCents(confirmedCents)} but the accepted quote was ${formatCents(accepted.totalCents)}. Held for review.`;
    appendEvent(db, projectId, null, "inbound.needs_attention", detail, { data: { messageId: msg.id } });
    return { outcome: "confirmation_amount_mismatch", detail, messageId: msg.id };
  }
  db.update(s.vendorEngagements).set({ confirmationState: "confirmed", quotes: e.quotes.map((q) => (q.status === "received" ? { ...q, status: "accepted" as const } : q)), version: e.version + 1, updatedAt: t }).where(eq(s.vendorEngagements.id, e.id)).run();
  const line = db.select().from(s.budgetLines).where(and(eq(s.budgetLines.projectId, projectId), eq(s.budgetLines.engagementId, e.id), eq(s.budgetLines.active, true))).get();
  if (line) db.update(s.budgetLines).set({ commitmentStatus: "committed", label: line.label.replace(/\(quoted[^)]*\)/, "(confirmed)"), provenance: [{ type: "message" as const, id: msg.id, excerpt: lineExcerpt(msg.body, /confirmed/i) }, ...line.provenance].slice(0, 10), version: line.version + 1, updatedAt: t }).where(eq(s.budgetLines.id, line.id)).run();
  const waiting = waitingWorkflowsFor(db, projectId, `engagement:${e.id}:confirmed`);
  if (e.service === "catering" && accepted) {
    setFact(db, projectId, "catering.unit_cents", accepted.unitCents, "confirmed", { type: "message", id: msg.id, excerpt: lineExcerpt(msg.body, /confirmed/i) });
    invalidateDependents(db, projectId, "catering.unit_cents", waiting.map((w) => w.id), `${e.vendorName} confirmed a different per-guest price.`);
    if (accepted.dietary?.length) {
      const facts = db.select().from(s.projectFacts).where(eq(s.projectFacts.projectId, projectId)).all();
      const cur = (facts.find((f) => f.key === "catering.dietary_options")?.value as string[] | undefined) ?? [];
      const merged = [...new Set([...cur, ...accepted.dietary])];
      if (merged.length !== cur.length) setFact(db, projectId, "catering.dietary_options", merged, "confirmed", { type: "message", id: accepted.messageId ?? msg.id, excerpt: "Dietary options from the accepted quote" });
    }
  } else bumpProjectRevision(db, projectId);
  const detail = `${e.vendorName} confirmed the booking${accepted ? ` at ${formatCents(accepted.totalCents)}` : ""}; the line is now committed.`;
  appendEvent(db, projectId, waiting[0]?.id ?? null, "inbound.confirmed", detail, { data: { messageId: msg.id } });

  for (const wf of waiting) {
    const ctx = loadProjectContext(db, projectId);
    const drafts = confirmationFollowUps(ctx, e, msg);
    persistProposals(db, ctx, wf, drafts);
    if (drafts.some((d) => !d.informational)) {
      db.update(s.workflows).set({ status: "ready_for_review", stage: "review", updatedAt: t }).where(eq(s.workflows.id, wf.id)).run();
      appendEvent(db, projectId, wf.id, "workflow.ready_for_review", `${e.vendorName} confirmed — review the guest and file updates.`, { stage: "review" });
    } else refreshWorkflowStatus(db, wf.id);
  }
  wakeWaitingWorkflows(db, projectId);
  return { outcome: "booking_confirmed", detail, messageId: msg.id };
}

/** Guest-facing and file updates that only make sense once a replacement vendor is confirmed. */
function confirmationFollowUps(ctx: ReturnType<typeof loadProjectContext>, e: s.VendorEngagement, msg: s.Message): ProposalDraft[] {
  const drafts: ProposalDraft[] = [];
  if (e.service !== "catering") return drafts;
  const ev = evidence(msg, lineExcerpt(msg.body, /confirmed/i));
  const currentInvite = (ctx.facts["invitation.text"]?.value as string | undefined) ?? "";
  const menuLine = ctx.facts["catering.dietary_options"]?.value as string[] | undefined;
  const newInvite = currentInvite.replace(/Dinner[^\n]*\n?/i, "").trimEnd() + `\n\nDinner is catered by ${e.vendorName}${menuLine?.length ? ` with ${menuLine.map((d) => d.replace("_", "-")).join(", ")} options` : ""}.`;
  const recipients = ctx.guests.filter((g) => g.rsvp !== "declined");
  if (newInvite.trim() !== currentInvite.trim()) {
    drafts.push({ key: "inv", kind: "invitation", area: "guests", title: "Update the invitation menu note", target: { type: "invitation", audience: "Invited guests (not declined)", recipientCount: recipients.length, text: newInvite.trim() }, before: currentInvite, after: newInvite.trim(), rationale: "Guests see the caterer only after the booking is confirmed; the location and time are unchanged.", evidence: ev, factDepKeys: ["invitation.text", "catering.vendor"], cost: null, requires: [], external: true, stage: "prepare_updates" });
  }
  const vendorsDoc = ctx.documents.find((d) => d.path.endsWith("vendors.md"));
  const contactsByEngagement = Object.fromEntries(ctx.engagements.map((x) => [x.id, ctx.contacts.filter((c) => c.id === x.contactId).map((c) => ({ name: c.name, email: c.email }))[0]]));
  const content = renderVendorsMd(ctx.engagements, contactsByEngagement);
  if (!vendorsDoc || vendorsDoc.content !== content) {
    drafts.push({ key: "vendors_md", kind: "file", area: "brief", title: "Update vendors.md in the event folder", target: { type: "file", path: vendorsDoc?.path ?? `${ctx.project.folderPath ?? ""}/03 Vendors/vendors.md`, content }, before: vendorsDoc?.content ?? null, after: content, rationale: "Shared vendor list reflects the confirmed change.", evidence: ev, factDepKeys: ["catering.vendor"], docDeps: vendorsDoc ? [vendorsDoc.id] : [], cost: null, requires: [], external: false, stage: "prepare_updates" });
  }
  const budgetDoc = ctx.documents.find((d) => d.path.endsWith("budget.csv"));
  const budgetContent = renderBudgetCsv(ctx.budgetLines.filter((l) => l.active));
  if (budgetDoc && budgetDoc.content !== budgetContent) {
    drafts.push({ key: "budget_csv", kind: "file", area: "brief", title: "Update budget.csv projection", target: { type: "file", path: budgetDoc.path, content: budgetContent }, before: budgetDoc.content, after: budgetContent, rationale: "Budget projection reflects the confirmed caterer and the retained deposit.", evidence: ev, factDepKeys: [], docDeps: [budgetDoc.id], cost: null, requires: [], external: false, stage: "prepare_updates" });
  }
  return drafts;
}
