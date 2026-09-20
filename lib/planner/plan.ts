import type { AreaId } from "@/lib/domain/areas";
import { areaForFactKey } from "@/lib/domain/areas";
import { factString, factValue, requiredStaff, type StaffingPolicy, type EventFormat, humanFactKey, formatFactValue } from "@/lib/domain/facts";
import { formatCents } from "@/lib/domain/money";
import { addMinutes, defaultInvitationText, formatLongDate, renderBriefMd, renderBudgetCsv, renderScheduleCsv } from "@/lib/domain/projections";
import type { BudgetLine, EvidenceRef, VendorEngagement, ProposalTarget, CostEffect } from "@/lib/db/schema";
import type { ChangeIntent, RequestedChange } from "./intent";
import type { ProjectContext } from "./context";
import { contactForEngagement, docExcerpt, extractVenueFacts, findDocument, resolveEngagement, resolveVenue, venueDocument } from "./resolve";
import type { PlanQuestion, PlanResult, ProposalDraft, ProposalKind } from "./types";

type EngagementOverlay = Partial<Pick<VendorEngagement, "quoteState" | "confirmationState" | "cancellationState">>;

class Planner {
  readonly drafts: ProposalDraft[] = [];
  readonly questions: PlanQuestion[] = [];
  readonly notes: string[] = [];
  readonly after = new Map<string, unknown>();
  readonly changed = new Set<string>();
  readonly engagementOverlay = new Map<string, EngagementOverlay>();
  readonly lineOverlay = new Map<string, Partial<BudgetLine> & { _new?: boolean; _key?: string; _conditional?: boolean }>();
  private counter = 0;

  constructor(readonly ctx: ProjectContext, readonly today: string) {}

  key(prefix: string) {
    return `${prefix}_${++this.counter}`;
  }

  get<T>(key: string): T | undefined {
    if (this.after.has(key)) return this.after.get(key) as T;
    return factValue<T>(this.ctx.facts, key);
  }
  before<T>(key: string): T | undefined {
    return factValue<T>(this.ctx.facts, key);
  }

  add(d: Omit<ProposalDraft, "key"> & { key?: string }): ProposalDraft {
    const draft: ProposalDraft = { ...d, key: d.key ?? this.key(d.kind) };
    if (draft.kind !== "check" && draft.kind !== "wait" && JSON.stringify(draft.before) === JSON.stringify(draft.after)) {
      return draft;
    }
    this.drafts.push(draft);
    return draft;
  }

  check(area: AreaId, title: string, note: string, evidence: EvidenceRef[], factDepKeys: string[], severity: "info" | "warning" = "info", stage: ProposalDraft["stage"] = "check_sources"): ProposalDraft {
    return this.add({ kind: "check", area, title, target: { type: "check", note, severity }, before: null, after: null, rationale: note, evidence, factDepKeys, cost: null, requires: [], external: false, stage, informational: true, severity });
  }

  setFact(key: string, value: unknown, rationale: string, evidence: EvidenceRef[], opts: { requires?: string[]; conditional?: boolean; waitsFor?: string; status?: "confirmed" | "tentative"; title?: string; area?: AreaId } = {}): ProposalDraft | null {
    const before = this.before<unknown>(key);
    if (JSON.stringify(before) === JSON.stringify(value)) return null;
    this.after.set(key, value);
    this.changed.add(key);
    return this.add({
      kind: "fact",
      area: opts.area ?? areaForFactKey(key),
      title: opts.title ?? `Update ${humanFactKey(key).toLowerCase()}`,
      target: { type: "fact", key },
      before: { value: before, status: this.ctx.facts[key]?.status ?? "unknown" },
      after: { value, status: opts.status ?? "confirmed" },
      rationale,
      evidence,
      factDepKeys: [key],
      cost: null,
      requires: opts.requires ?? [],
      conditional: opts.conditional,
      waitsFor: opts.waitsFor,
      external: false,
      stage: "follow_consequences",
    });
  }

  /** Budget lines with planned changes applied. Conditional (prospective) changes are excluded unless asked for. */
  activeLines(includeConditional = false): BudgetLine[] {
    const use = (v: (Partial<BudgetLine> & { _conditional?: boolean }) | undefined) => v && (includeConditional || !v._conditional);
    const base = this.ctx.budgetLines.map((l) => {
      const o = this.lineOverlay.get(l.id);
      return use(o) ? { ...l, ...o } : l;
    });
    const added = [...this.lineOverlay.entries()].filter(([, v]) => v._new && use(v)).map(([id, v]) => ({ ...(v as BudgetLine), id }));
    return [...base, ...added];
  }

  forecastCents(lines = this.activeLines()): { total: number; unknown: number } {
    let total = 0;
    let unknown = 0;
    for (const l of lines) {
      if (!l.active) continue;
      if (l.subtotalCents === null) unknown++;
      else total += l.subtotalCents + l.taxCents;
    }
    return { total, unknown };
  }

  budgetLine(
    line: BudgetLine | null,
    patch: { category: string; label: string; quantity: number; unitCents: number | null; subtotalCents: number | null; commitmentStatus: BudgetLine["commitmentStatus"]; engagementId?: string | null; active?: boolean },
    title: string,
    rationale: string,
    evidence: EvidenceRef[],
    factDepKeys: string[],
    costLabel: string,
    costStatus: CostEffect["status"],
    opts: { requires?: string[]; conditional?: boolean; waitsFor?: string; area?: AreaId } = {},
  ): ProposalDraft {
    const beforeSubtotal = line && line.active ? line.subtotalCents : null;
    const afterSubtotal = patch.active === false ? null : patch.subtotalCents;
    const delta = beforeSubtotal === null && afterSubtotal === null ? null : afterSubtotal === null ? (beforeSubtotal === null ? null : -beforeSubtotal) : beforeSubtotal === null ? (line ? afterSubtotal : afterSubtotal) : afterSubtotal - beforeSubtotal;
    const key = this.key("budget_line");
    const lineId = line?.id ?? `new_${key}`;
    this.lineOverlay.set(lineId, line ? { ...patch, active: patch.active ?? true, _conditional: opts.conditional } : { ...patch, active: patch.active ?? true, taxCents: 0, currency: "USD", projectId: this.ctx.project.id, provenance: [], version: 1, updatedAt: 0, id: lineId, _new: true, _key: key, _conditional: opts.conditional });
    this.changed.add("budget.forecast");
    return this.add({
      key,
      kind: "budget_line",
      area: opts.area ?? "budget",
      title,
      target: { type: "budget_line", lineId: line?.id, category: patch.category },
      before: line ? { label: line.label, quantity: line.quantity, unitCents: line.unitCents, subtotalCents: line.subtotalCents, commitmentStatus: line.commitmentStatus, active: line.active } : null,
      after: { ...patch, engagementId: patch.engagementId ?? line?.engagementId ?? null, active: patch.active ?? true },
      rationale,
      evidence,
      factDepKeys,
      cost: { deltaCents: delta, status: costStatus, label: costLabel, currency: "USD" },
      requires: opts.requires ?? [],
      conditional: opts.conditional,
      waitsFor: opts.waitsFor,
      external: false,
      stage: "follow_consequences",
    });
  }

  email(
    area: AreaId,
    engagement: VendorEngagement | null,
    to: { name: string; email: string }[],
    subject: string,
    body: string,
    purpose: string,
    title: string,
    rationale: string,
    evidence: EvidenceRef[],
    factDepKeys: string[],
    opts: { requires?: string[]; conditional?: boolean; waitsFor?: string; cost?: CostEffect | null } = {},
  ): ProposalDraft {
    return this.add({
      kind: "email",
      area,
      title,
      target: { type: "email", to, subject, body, threadId: engagement?.threadId ?? null, engagementId: engagement?.id ?? null, purpose },
      before: null,
      after: { to: to.map((t) => t.email), subject },
      rationale,
      evidence,
      factDepKeys,
      cost: opts.cost ?? null,
      requires: opts.requires ?? [],
      conditional: opts.conditional,
      waitsFor: opts.waitsFor,
      external: true,
      stage: "prepare_updates",
    });
  }

  engagementChange(e: VendorEngagement, field: "quoteState" | "confirmationState" | "cancellationState", value: string, title: string, rationale: string, evidence: EvidenceRef[], requires: string[], opts: { conditional?: boolean; waitsFor?: string } = {}) {
    this.engagementOverlay.set(e.id, { ...(this.engagementOverlay.get(e.id) ?? {}), [field]: value });
    return this.add({
      kind: "engagement",
      area: e.service === "venue" ? "venue" : e.service === "equipment" ? "equipment" : "catering",
      title,
      target: { type: "engagement", engagementId: e.id, field },
      before: e[field],
      after: value,
      rationale,
      evidence,
      factDepKeys: [],
      cost: null,
      requires,
      conditional: opts.conditional,
      waitsFor: opts.waitsFor,
      external: false,
      stage: "follow_consequences",
    });
  }

  wait(area: AreaId, title: string, waitsFor: string, requires: string[], note: string) {
    return this.add({ kind: "wait", area, title, target: { type: "check", note }, before: null, after: waitsFor, rationale: note, evidence: [], factDepKeys: [], cost: null, requires, waitsFor, external: false, stage: "prepare_updates" });
  }

  staffNotice(text: string, title: string, rationale: string, factDepKeys: string[], opts: { requires?: string[]; conditional?: boolean; waitsFor?: string } = {}) {
    const recipients = this.ctx.staff.filter((m) => m.available && m.email).map((m) => ({ name: m.name, email: m.email! }));
    if (!recipients.length) {
      this.check("staff", "No staff contacts on file", "Staff notice skipped: no staff members with email addresses are on the roster.", [], factDepKeys, "warning");
      return null;
    }
    return this.add({
      kind: "staff_notice",
      area: "staff",
      title,
      target: { type: "staff_notice", recipients, text },
      before: null,
      after: { recipients: recipients.length, text },
      rationale,
      evidence: [{ sourceType: "document", ref: findDocument(this.ctx, "staff-roster")?.id ?? "", excerpt: `${recipients.length} staff on roster with email`, label: "staff-roster.csv" }],
      factDepKeys,
      cost: null,
      requires: opts.requires ?? [],
      conditional: opts.conditional,
      waitsFor: opts.waitsFor,
      external: true,
      stage: "prepare_updates",
    });
  }

  invitationUpdate(newText: string, title: string, rationale: string, factDepKeys: string[], evidence: EvidenceRef[], opts: { requires?: string[]; conditional?: boolean; waitsFor?: string } = {}) {
    const current = factString(this.ctx.facts, "invitation.text") ?? "";
    if (current === newText) return null;
    const recipients = this.ctx.guests.filter((g) => g.rsvp !== "declined");
    return this.add({
      kind: "invitation",
      area: "guests",
      title,
      target: { type: "invitation", audience: "Invited guests (not declined)", recipientCount: recipients.length, text: newText },
      before: current,
      after: newText,
      rationale,
      evidence,
      factDepKeys: ["invitation.text", ...factDepKeys],
      cost: null,
      requires: opts.requires ?? [],
      conditional: opts.conditional,
      waitsFor: opts.waitsFor,
      external: true,
      stage: "prepare_updates",
    });
  }

  fileUpdate(path: string, content: string, title: string, rationale: string, factDepKeys: string[], opts: { requires?: string[]; conditional?: boolean; waitsFor?: string } = {}) {
    const doc = this.ctx.documents.find((d) => d.path.endsWith(path));
    if (doc && doc.content === content) return null;
    return this.add({
      kind: "file",
      area: "brief",
      title,
      target: { type: "file", path: doc?.path ?? `${this.ctx.project.folderPath ?? ""}/${path}`, content },
      before: doc?.content ?? null,
      after: content,
      rationale,
      evidence: doc ? [{ sourceType: "document", ref: doc.id, excerpt: `Current revision ${doc.revision ?? "local"}`, label: path }] : [],
      factDepKeys,
      docDeps: doc ? [doc.id] : [],
      cost: null,
      requires: opts.requires ?? [],
      conditional: opts.conditional,
      waitsFor: opts.waitsFor,
      external: false,
      stage: "prepare_updates",
    });
  }

  ev(doc: { id: string; path: string } | undefined, excerpt: string | undefined, label?: string): EvidenceRef[] {
    if (!doc) return excerpt ? [{ sourceType: "fixture", ref: "", excerpt, label }] : [];
    return [{ sourceType: "document", ref: doc.id, excerpt: excerpt ?? "", label: label ?? doc.path.split("/").pop() }];
  }

  factEv(key: string): EvidenceRef[] {
    const f = this.ctx.facts[key];
    if (!f) return [];
    const ref = f.sourceRefs[0];
    const doc = ref?.type === "document" ? this.ctx.documents.find((d) => d.id === ref.id) : undefined;
    return [{ sourceType: doc ? "document" : "fact", ref: doc?.id ?? key, excerpt: ref?.excerpt ?? `${humanFactKey(key)}: ${formatFactValue(key, f.value)} (v${f.version}, ${f.status})`, label: doc?.path.split("/").pop() ?? humanFactKey(key) }];
  }

  activeCaterer(): VendorEngagement | undefined {
    return this.ctx.engagements.find((e) => e.service === "catering" && e.confirmationState === "confirmed" && e.cancellationState === "none" && !this.engagementOverlay.get(e.id)?.cancellationState);
  }
  requestedCaterer(): VendorEngagement | undefined {
    return this.ctx.engagements.find((e) => e.service === "catering" && ["requested", "received"].includes(this.engagementOverlay.get(e.id)?.quoteState ?? e.quoteState) && e.confirmationState !== "confirmed");
  }
  lineFor(engagementId: string): BudgetLine | undefined {
    return this.ctx.budgetLines.find((l) => l.engagementId === engagementId && l.active);
  }
  daysUntilEvent(): number | undefined {
    const d = this.get<string>("event.date");
    if (!d) return undefined;
    return Math.round((new Date(`${d}T00:00:00Z`).getTime() - new Date(`${this.today}T00:00:00Z`).getTime()) / 86400000);
  }
  eventDateLong(): string {
    return formatLongDate(this.get<string>("event.date") ?? this.ctx.project.eventDate);
  }
}

type Rule = { id: string; inputs: string[]; run: (p: Planner) => void };

const RULES: Rule[] = [
  {
    id: "capacity",
    inputs: ["attendance.expected", "venue.seated_capacity", "venue.standing_capacity", "event.format", "venue.name"],
    run(p) {
      const att = p.get<number>("attendance.expected");
      const format = (p.get<EventFormat>("event.format") ?? "seated_dinner") as EventFormat;
      const capKey = format === "seated_dinner" ? "venue.seated_capacity" : "venue.standing_capacity";
      const cap = p.get<number>(capKey);
      const room = p.get<string>("venue.room") ?? "the room";
      const venue = p.get<string>("venue.name") ?? "the venue";
      if (att === undefined) return;
      if (cap === undefined) {
        p.check("venue", "Capacity not verified", `No ${format === "seated_dinner" ? "seated" : "standing"} capacity is recorded for ${venue}. Attendance of ${att} cannot be assured until a room capacity is sourced.`, [], ["attendance.expected", capKey], "warning");
        return;
      }
      const evidence = p.after.has(capKey) ? [] : p.factEv(capKey);
      if (att > cap) {
        p.check(
          "venue",
          `Capacity exceeded: ${att} guests vs ${cap} ${format === "seated_dinner" ? "seated" : "standing"}`,
          `${room} at ${venue} is documented for ${cap} ${format === "seated_dinner" ? "seated" : "standing"} guests. ${att} exceeds this by ${att - cap}. Options: switch to a standing reception (${p.get<number>("venue.standing_capacity") ?? "unknown"} capacity), choose a larger room, or reduce attendance. No booking change is proposed automatically.`,
          evidence,
          ["attendance.expected", capKey, "event.format"],
          "warning",
        );
      } else {
        p.check("venue", `Capacity check passed: ${att} of ${cap} ${format === "seated_dinner" ? "seated" : "standing"}`, `${room} at ${venue} accommodates ${att} guests ${format === "seated_dinner" ? "seated" : "standing"} (${cap - att} spare).`, evidence, ["attendance.expected", capKey, "event.format"]);
      }
    },
  },
  {
    id: "catering_quantity",
    inputs: ["attendance.expected"],
    run(p) {
      const att = p.get<number>("attendance.expected");
      const before = p.before<number>("attendance.expected");
      if (att === undefined || att === before) return;
      const caterer = p.activeCaterer();
      const pending = p.requestedCaterer();
      if (caterer) {
        const line = p.lineFor(caterer.id);
        const unit = caterer.unitCents ?? line?.unitCents ?? null;
        const doc = findDocument(p.ctx, caterer.vendorName.split(" ")[0].toLowerCase());
        const minLine = docExcerpt(doc, /minimum/i);
        const min = minLine?.match(/(\d{2,4})/);
        if (min && att < Number(min[1])) {
          p.check("catering", `Below guaranteed minimum of ${min[1]} guests`, `${caterer.vendorName}'s agreement sets a guaranteed minimum of ${min[1]} guests; ${att} is below it, so the minimum would still be charged unless renegotiated.`, p.ev(doc, minLine), ["attendance.expected"], "warning");
        }
        if (line && unit !== null) {
          const subtotal = unit * att;
          p.budgetLine(
            line,
            { category: line.category, label: line.label, quantity: att, unitCents: unit, subtotalCents: subtotal, commitmentStatus: "estimate", engagementId: caterer.id },
            `Catering forecast: ${att} × ${formatCents(unit)}`,
            `${caterer.vendorName} charges ${formatCents(unit)} per guest; the committed count is ${line.quantity}. The new total is a forecast until the vendor confirms.`,
            p.ev(doc, docExcerpt(doc, /per guest/i)),
            ["attendance.expected", "catering.unit_cents"],
            "Forecast — vendor confirmation needed",
            "estimate",
            { area: "catering" },
          );
        }
        const contact = contactForEngagement(p.ctx, caterer);
        if (contact?.email) {
          p.email(
            "catering",
            caterer,
            [{ name: contact.name, email: contact.email }],
            `Guest count update — ${p.ctx.project.name}, ${p.eventDateLong()}`,
            `Hello ${contact.name.split(" ")[0]},\n\nOur expected guest count for the ${p.ctx.project.name} on ${p.eventDateLong()} has changed from ${before} to ${att}. Please confirm you can cater for ${att} guests at the agreed ${unit !== null ? formatCents(unit) : "per-guest"} rate and let us know of any change to delivery or service timing.\n\nThank you,\n${p.ctx.project.name} organising team`,
            "attendance_update",
            `Tell ${caterer.vendorName} the new guest count`,
            "The caterer's committed quantity must be confirmed by the vendor; the forecast above is not a confirmed change.",
            p.ev(doc, docExcerpt(doc, /Current guest count/i)),
            ["attendance.expected"],
          );
        }
      } else if (pending) {
        p.check("catering", `Pending ${pending.vendorName} quote uses a different guest count`, `A quote has been requested from ${pending.vendorName}. Any quote received for a different guest count will be flagged as mismatched rather than applied.`, [], ["attendance.expected"], "warning", "follow_consequences");
      } else {
        p.check("catering", "No confirmed caterer", "No catering quantity to adjust: there is no confirmed caterer on this project.", [], ["attendance.expected"], "info", "follow_consequences");
      }
    },
  },
  {
    id: "staffing",
    inputs: ["attendance.expected", "staffing.policy", "staffing.available"],
    run(p) {
      const policy = p.get<StaffingPolicy | null>("staffing.policy");
      const att = p.get<number>("attendance.expected");
      if (!policy || att === undefined) {
        p.check("staff", "No staffing policy documented", "Staffing was not recalculated because this project has no documented staffing policy.", [], ["staffing.policy"], "warning", "follow_consequences");
        return;
      }
      const required = requiredStaff(att, policy);
      const requiredBefore = p.before<number>("staffing.required");
      const policyEv = p.factEv("staffing.policy");
      if (required !== requiredBefore) {
        p.setFact("staffing.required", required, `Sample policy: 1 staff per ${policy.perAttendees} guests, rounded up → ${required} for ${att} guests.`, policyEv, { title: `Staff required: ${requiredBefore ?? "?"} → ${required}` });
        const line = p.ctx.budgetLines.find((l) => l.category === "staff" && l.active);
        if (line) {
          p.budgetLine(
            line,
            { category: "staff", label: line.label, quantity: required, unitCents: policy.ratePerStaffCents, subtotalCents: required * policy.ratePerStaffCents, commitmentStatus: "estimate" },
            `Staff cost: ${required} × ${formatCents(policy.ratePerStaffCents)}`,
            `Derived from the project's sample staffing policy; not a confirmed booking.`,
            policyEv,
            ["attendance.expected", "staffing.policy"],
            "Estimate from staffing policy",
            "estimate",
            { area: "staff" },
          );
        }
      }
      const available = p.get<number>("staffing.available") ?? p.ctx.staff.filter((m) => m.available).length;
      if (available < required) {
        p.check("staff", `Coverage gap: ${required} needed, ${available} available`, `Policy requires ${required} staff for ${att} guests but only ${available} are marked available. Agency or overtime costs are not documented for this project, so no cost is assumed.`, policyEv, ["attendance.expected", "staffing.available", "staffing.policy"], "warning", "follow_consequences");
      } else if (p.changed.has("staffing.available") || required !== requiredBefore) {
        p.check("staff", `Coverage ok: ${available} available for ${required} required`, `Roster covers the policy requirement with ${available - required} spare.`, policyEv, ["staffing.available", "staffing.required"], "info", "follow_consequences");
      }
    },
  },
  {
    id: "dietary",
    inputs: ["catering.dietary_options"],
    run(p) {
      const after = p.get<string[]>("catering.dietary_options") ?? [];
      const before = p.before<string[]>("catering.dietary_options") ?? [];
      const added = after.filter((o) => !before.includes(o));
      if (!added.length) return;
      const caterer = p.activeCaterer();
      const doc = caterer ? findDocument(p.ctx, caterer.vendorName.split(" ")[0].toLowerCase()) : undefined;
      for (const opt of added) {
        const label = opt.replace("_", "-");
        const line = docExcerpt(doc, new RegExp(label.split("-")[0], "i"));
        const offered = !!line && /no extra charge|available|on request/i.test(line);
        if (caterer) {
          p.check("catering", offered ? `${caterer.vendorName} offers a ${label} option` : `${label} option not documented for ${caterer.vendorName}`, offered ? `The agreement documents a ${label} option: “${line}”. A surcharge is ${/no extra charge/i.test(line!) ? "not" : "possibly"} applicable.` : `The agreement does not mention a ${label} option; availability and any surcharge are unknown until the vendor confirms.`, p.ev(doc, line), ["catering.dietary_options"], offered ? "info" : "warning");
          const contact = contactForEngagement(p.ctx, caterer);
          const count = opt === "vegetarian" ? p.get<number>("guests.dietary_vegetarian") : undefined;
          if (contact?.email) {
            p.email(
              "catering",
              caterer,
              [{ name: contact.name, email: contact.email }],
              `${label[0].toUpperCase()}${label.slice(1)} meals — ${p.ctx.project.name}, ${p.eventDateLong()}`,
              `Hello ${contact.name.split(" ")[0]},\n\nPlease add a ${label} option to the menu for the ${p.ctx.project.name} on ${p.eventDateLong()}.${count ? ` We currently have ${count} ${label} requests; the final count will follow.` : " We will confirm the count once RSVPs close."} Please confirm availability and whether any surcharge applies.\n\nThank you,\n${p.ctx.project.name} organising team`,
              "dietary_update",
              `Ask ${caterer.vendorName} to confirm the ${label} option`,
              offered ? "Vendor documents the option; confirmation of quantities is still needed." : "Availability and surcharge are unknown; the vendor must confirm before it is announced.",
              p.ev(doc, line),
              ["catering.dietary_options"],
            );
          }
        } else {
          p.check("catering", `No confirmed caterer to provide a ${label} option`, "The dietary requirement is recorded; include it in any catering quote request.", [], ["catering.dietary_options"], "warning");
        }
      }
      const text = defaultInvitationText(p.ctx.facts, Object.fromEntries(p.after));
      p.invitationUpdate(text, "Update invitation menu note", "Guests should learn about newly available dietary options; sent only after the caterer confirms.", ["catering.dietary_options"], [], {
        requires: p.drafts.filter((d) => d.kind === "email" && (d.target as { purpose?: string }).purpose === "dietary_update").map((d) => d.key),
      });
    },
  },
  {
    id: "budget_variance",
    inputs: ["budget.ceiling_cents", "budget.forecast"],
    run(p) {
      const ceiling = p.get<number>("budget.ceiling_cents");
      const { total, unknown } = p.forecastCents();
      if (ceiling === undefined) {
        p.check("budget", "No budget ceiling set", `Forecast is ${formatCents(total)}${unknown ? ` plus ${unknown} item(s) with unknown cost` : ""}; no ceiling to compare against.`, [], ["budget.ceiling_cents"], "info", "follow_consequences");
        return;
      }
      const variance = ceiling - total;
      const prospective = p.forecastCents(p.activeLines(true));
      const prospectiveNote = prospective.total !== total ? ` If every pending cancellation is acknowledged, the forecast becomes ${formatCents(prospective.total)} (${prospective.total <= ceiling ? "within" : "still over"} the ceiling) — that saving is prospective, not booked.` : "";
      const unknownNote = (unknown ? ` ${unknown} line item(s) have unknown cost and are excluded from the total.` : "") + prospectiveNote;
      if (variance < 0) {
        const touched = new Set([...p.lineOverlay.keys()]);
        const lines = p.activeLines().filter((l) => l.active && l.subtotalCents !== null && !touched.has(l.id));
        const flexible = lines
          .map((l) => {
            const eng = p.ctx.engagements.find((e) => e.id === l.engagementId);
            const cancellable = l.commitmentStatus === "estimate" || l.commitmentStatus === "quoted" || (eng?.cancellationTerms ? /free cancellation|refundable/i.test(eng.cancellationTerms) && !/non-refundable/i.test(eng.cancellationTerms) : false);
            return { l, eng, cancellable };
          })
          .filter((x) => x.cancellable)
          .sort((a, b) => (b.l.subtotalCents ?? 0) - (a.l.subtotalCents ?? 0));
        const committed = lines.filter((l) => l.commitmentStatus === "committed" || l.commitmentStatus === "sunk");
        p.check(
          "budget",
          `Over ceiling by ${formatCents(-variance)}: forecast ${formatCents(total)} vs ${formatCents(ceiling)}`,
          `The forecast exceeds the ceiling.${unknownNote} Largest flexible items: ${flexible.length ? flexible.map((x) => `${x.l.label} (${formatCents(x.l.subtotalCents)}, ${x.l.commitmentStatus}${x.eng?.cancellationTerms ? `; ${x.eng.cancellationTerms}` : ""})`).join("; ") : "none identified"}. Committed or sunk items (${committed.map((l) => `${l.label} ${formatCents(l.subtotalCents)}`).join(", ") || "none"}) are not reduced automatically.`,
          flexible.map((x) => ({ sourceType: "fact" as const, ref: x.l.id, excerpt: `${x.l.label}: ${formatCents(x.l.subtotalCents)} — ${x.l.commitmentStatus}`, label: "Budget line" })),
          ["budget.ceiling_cents", ...p.changed].filter((k) => k !== "budget.forecast"),
          "warning",
          "follow_consequences",
        );
        for (const x of flexible.slice(0, 3)) {
          const saving = x.l.subtotalCents ?? 0;
          p.check(
            "budget",
            `Option: ${x.l.commitmentStatus === "estimate" ? "reduce" : "cancel"} ${x.l.label} to save up to ${formatCents(saving)}`,
            x.eng
              ? `${x.eng.vendorName} terms: ${x.eng.cancellationTerms ?? "not documented"}. This is an option to review, not an action; nothing is cancelled without a separate request.`
              : `This line is an estimate and can be revised. This is an option to review, not an action.`,
            x.eng ? p.ev(venueDocument(p.ctx, x.eng) ?? findDocument(p.ctx, x.eng.vendorName.split(" ")[0].toLowerCase()), x.eng.cancellationTerms ?? undefined) : [],
            ["budget.ceiling_cents"],
            "info",
            "follow_consequences",
          );
        }
      } else {
        p.check("budget", `Within ceiling: forecast ${formatCents(total)} vs ${formatCents(ceiling)} (${formatCents(variance)} headroom)`, `Forecast recalculated from budget lines.${unknownNote}`, [], ["budget.ceiling_cents"], "info", "follow_consequences");
      }
    },
  },
  {
    id: "schedule",
    inputs: ["schedule.dinner_start", "event.time"],
    run(p) {
      const dinnerBefore = p.before<string>("schedule.dinner_start");
      const dinnerAfter = p.get<string>("schedule.dinner_start");
      const doorsBefore = p.before<string>("event.time");
      const doorsAfter = p.get<string>("event.time");
      const dinnerChanged = dinnerAfter !== dinnerBefore && dinnerAfter !== undefined;
      const doorsChanged = doorsAfter !== doorsBefore && doorsAfter !== undefined;
      if (!dinnerChanged && !doorsChanged) return;
      const delta = dinnerChanged && dinnerBefore ? minutesBetween(dinnerBefore, dinnerAfter!) : doorsChanged && doorsBefore ? minutesBetween(doorsBefore, doorsAfter!) : 0;
      const factKeys = [dinnerChanged ? "schedule.dinner_start" : "event.time"];
      const scheduleReqs: string[] = [];
      for (const item of p.ctx.schedule) {
        const isDinner = /dinner/i.test(item.title);
        const isDoors = /doors|reception drinks/i.test(item.title);
        const afterDinner = dinnerBefore ? item.startLocal >= dinnerBefore : false;
        const shouldShift = dinnerChanged ? isDinner || (afterDinner && !isDoors) : doorsChanged ? true : false;
        if (!shouldShift) continue;
        const newStart = addMinutes(item.startLocal, delta);
        const d = p.add({
          kind: "schedule",
          area: "staff",
          title: `${item.title}: ${item.startLocal} → ${newStart}`,
          target: { type: "schedule", itemId: item.id, title: item.title, startLocal: newStart },
          before: item.startLocal,
          after: newStart,
          rationale: dinnerChanged && !isDinner ? "Follows the dinner service in the run-of-show, so it moves with it." : "Requested timing change.",
          evidence: p.ev(findDocument(p.ctx, "schedule.csv"), `${item.startLocal},${item.title}`),
          factDepKeys: factKeys,
          cost: null,
          requires: [],
          external: false,
          stage: "follow_consequences",
        });
        scheduleReqs.push(d.key);
      }
      const closeItem = p.ctx.schedule.find((i) => /close/i.test(i.title));
      if (closeItem && delta > 0) {
        p.check("venue", "Venue hire end time not documented", `The programme now ends at ${addMinutes(closeItem.startLocal, delta)}. The venue quote does not state a latest finish time; confirm with the venue before announcing.`, p.ev(findDocument(p.ctx, "garden-hall") ?? findDocument(p.ctx, "quote"), "Venue hire: USD 7,200.00 (includes tables, chairs, linens, basic lighting)"), factKeys, "warning");
      }
      const avDoc = findDocument(p.ctx, "av-rental");
      const techLine = docExcerpt(avDoc, /technician/i);
      if (avDoc && techLine && delta > 0) {
        p.check("equipment", "AV technician hours may no longer cover the programme", `The rental includes a technician for 5 hours from setup; a later finish may exceed the booked hours (overtime cost not documented).`, p.ev(avDoc, techLine), factKeys, "warning");
      }
      const caterer = p.activeCaterer();
      if (dinnerChanged && caterer) {
        const contact = contactForEngagement(p.ctx, caterer);
        const doc = findDocument(p.ctx, caterer.vendorName.split(" ")[0].toLowerCase());
        if (contact?.email) {
          p.email(
            "catering",
            caterer,
            [{ name: contact.name, email: contact.email }],
            `Service time change — ${p.ctx.project.name}, ${p.eventDateLong()}`,
            `Hello ${contact.name.split(" ")[0]},\n\nDinner service for the ${p.ctx.project.name} on ${p.eventDateLong()} now starts at ${dinnerAfter} instead of ${dinnerBefore}. Delivery and setup times are unchanged unless you advise otherwise. Please confirm.\n\nThank you,\n${p.ctx.project.name} organising team`,
            "schedule_update",
            `Tell ${caterer.vendorName} the new service time`,
            "The catering agreement specifies the service start time, so the vendor must be informed.",
            p.ev(doc, docExcerpt(doc, /dinner service from/i)),
            factKeys,
            { requires: scheduleReqs },
          );
        }
      }
      p.staffNotice(
        `Run-of-show update for ${p.ctx.project.name} (${p.eventDateLong()}): ${dinnerChanged ? `dinner service moves from ${dinnerBefore} to ${dinnerAfter}` : `doors move from ${doorsBefore} to ${doorsAfter}`}; later items shift by ${Math.abs(delta)} minutes. Staff briefing time is unchanged.`,
        "Notify event staff of the new timings",
        "Staff on the roster work to the run-of-show.",
        factKeys,
        { requires: scheduleReqs },
      );
      const inviteText = defaultInvitationText(p.ctx.facts, Object.fromEntries(p.after));
      p.invitationUpdate(inviteText, "Update the invitation timing", "The invitation states the doors and dinner times.", factKeys, [], { requires: scheduleReqs });
    },
  },
  {
    id: "format",
    inputs: ["event.format"],
    run(p) {
      const before = p.before<EventFormat>("event.format");
      const after = p.get<EventFormat>("event.format");
      if (!after || after === before) return;
      const label = after === "standing_reception" ? "standing reception" : "seated dinner";
      const caterer = p.activeCaterer();
      const doc = caterer ? findDocument(p.ctx, caterer.vendorName.split(" ")[0].toLowerCase()) : undefined;
      if (caterer) {
        const contact = contactForEngagement(p.ctx, caterer);
        const menuLine = docExcerpt(doc, /Menu:/i);
        p.check("catering", `Menu is contracted as ${menuLine?.split(":").slice(1).join(":").trim() ?? "a seated service"}`, `Changing to a ${label} changes the service style and may change the per-guest price; the vendor's revised price is unknown until quoted.`, p.ev(doc, menuLine), ["event.format"], "warning");
        if (contact?.email) {
          p.email(
            "catering",
            caterer,
            [{ name: contact.name, email: contact.email }],
            `Service style change — ${p.ctx.project.name}, ${p.eventDateLong()}`,
            `Hello ${contact.name.split(" ")[0]},\n\nWe would like to change the ${p.ctx.project.name} on ${p.eventDateLong()} from a ${before === "standing_reception" ? "standing reception" : "seated dinner"} to a ${label}. Please send a revised menu proposal and price for ${p.get<number>("attendance.expected") ?? "the current"} guests, and confirm any change to service staffing and timing.\n\nThank you,\n${p.ctx.project.name} organising team`,
            "format_update",
            `Ask ${caterer.vendorName} for a ${label} menu and price`,
            "Service style is part of the catering agreement.",
            p.ev(doc, menuLine),
            ["event.format"],
          );
        }
      }
      const venueDoc = findDocument(p.ctx, "garden-hall") ?? findDocument(p.ctx, "quote");
      p.check("venue", "Room layout and furniture change", `The venue hire includes tables and chairs for a seated layout; a ${label} needs a different floor plan. Ask the venue to confirm the layout change (no cost documented).`, p.ev(venueDoc, docExcerpt(venueDoc, /Venue hire|Room hire/i)), ["event.format"], "info");
      p.check("equipment", "Equipment reviewed for the new format", `AV items (projector, PA, microphones) remain needed for the awards; high tables or cocktail furniture are not in any rental yet and their cost is unknown.`, p.factEv("equipment.av_rental"), ["event.format"], "info");
      p.staffNotice(`${p.ctx.project.name} (${p.eventDateLong()}) is now a ${label}. Floor roles will be re-briefed at the 17:00 staff briefing.`, "Notify event staff of the format change", "Floor staffing differs between seated service and a reception.", ["event.format"]);
      const text = defaultInvitationText(p.ctx.facts, Object.fromEntries(p.after));
      p.invitationUpdate(text, "Update the invitation format", "Guests were invited to a seated dinner.", ["event.format"], [], { requires: p.drafts.filter((d) => d.kind === "email" && (d.target as { purpose?: string }).purpose === "format_update").map((d) => d.key) });
    },
  },
  {
    id: "included_av",
    inputs: ["venue.included_av"],
    run(p) {
      const included = p.get<string[]>("venue.included_av") ?? [];
      const before = p.before<string[]>("venue.included_av") ?? [];
      if (JSON.stringify(included) === JSON.stringify(before) || !included.length) return;
      const rental = p.get<string[]>("equipment.av_rental") ?? [];
      const avVendor = p.ctx.engagements.find((e) => e.service === "equipment" && e.confirmationState === "confirmed" && e.cancellationState === "none");
      const avDoc = findDocument(p.ctx, "av-rental");
      const overlap = rental.filter((r) => included.some((i) => sharesEquipmentTerm(r, i)));
      if (!avVendor || !rental.length) {
        p.check("equipment", "No AV rental to reconcile", "The venue now includes AV and there is no rental commitment to adjust.", [], ["venue.included_av", "equipment.av_rental"]);
        return;
      }
      if (!overlap.length) {
        p.check("equipment", "No duplicated equipment", `Venue-provided items (${included.join(", ")}) do not overlap the rental (${rental.join(", ")}).`, p.ev(avDoc, docExcerpt(avDoc, /Package/i)), ["venue.included_av", "equipment.av_rental"]);
        return;
      }
      const full = overlap.length === rental.filter((r) => !/technician/i.test(r)).length;
      const terms = avVendor.cancellationTerms ?? docExcerpt(avDoc, /Cancellation/i);
      const days = p.daysUntilEvent();
      const freeMatch = terms?.match(/up to (\d+) days/i);
      const freeWindow = freeMatch ? Number(freeMatch[1]) : undefined;
      const freeNow = freeWindow !== undefined && days !== undefined ? days > freeWindow : undefined;
      p.check(
        "equipment",
        `Duplicate equipment: ${overlap.join(", ")}`,
        `The venue now provides ${included.join(", ")}, which duplicates ${overlap.length} of ${rental.length} rented items from ${avVendor.vendorName}. Cancellation terms: ${terms ?? "not documented"}${freeNow !== undefined ? ` — ${days} days before the event, so ${freeNow ? "free cancellation currently applies" : "a fee would apply"}` : ""}. Nothing is saved until the rental change is confirmed.`,
        p.ev(avDoc, terms),
        ["venue.included_av", "equipment.av_rental"],
        "warning",
      );
      const contact = contactForEngagement(p.ctx, avVendor);
      const line = p.lineFor(avVendor.id);
      if (contact?.email) {
        const mail = p.email(
          "equipment",
          avVendor,
          [{ name: contact.name, email: contact.email }],
          `${full ? "Cancellation" : "Change"} of AV rental — ${p.ctx.project.name}, ${p.eventDateLong()}`,
          full
            ? `Hello ${contact.name.split(" ")[0]},\n\nThe venue for the ${p.ctx.project.name} on ${p.eventDateLong()} now includes ${included.join(", ")}, so we would like to cancel rental ${avVendor.notes?.match(/[A-Z]{2}-\d+/)?.[0] ?? ""} in full under the free-cancellation terms. Please confirm the cancellation and that no fee is due.\n\nThank you,\n${p.ctx.project.name} organising team`
            : `Hello ${contact.name.split(" ")[0]},\n\nThe venue for the ${p.ctx.project.name} on ${p.eventDateLong()} now provides ${included.join(", ")}. Please remove ${overlap.join(", ")} from our rental and send a revised quote for the remaining items (${rental.filter((r) => !overlap.includes(r)).join(", ")}).\n\nThank you,\n${p.ctx.project.name} organising team`,
          full ? "cancel_rental" : "reduce_rental",
          full ? `Cancel the ${avVendor.vendorName} rental` : `Ask ${avVendor.vendorName} to remove duplicated items and requote`,
          "Rental items duplicated by the venue should not be paid for twice; the vendor must confirm any change.",
          p.ev(avDoc, terms),
          ["venue.included_av", "equipment.av_rental"],
        );
        if (full) {
          p.engagementChange(avVendor, "cancellationState", "requested", `Mark ${avVendor.vendorName} rental as cancellation requested`, "Sending the request does not confirm cancellation.", [], [mail.key]);
          if (line) {
            p.budgetLine(
              line,
              { category: line.category, label: `${line.label} (cancelled)`, quantity: 0, unitCents: line.unitCents, subtotalCents: 0, commitmentStatus: "released", active: false },
              `Remove AV rental ${formatCents(line.subtotalCents)} once cancellation is confirmed`,
              "Prospective saving; applied automatically when the vendor confirms cancellation under the documented free-cancellation terms.",
              p.ev(avDoc, terms),
              ["venue.included_av", "equipment.av_rental"],
              "Prospective — pending cancellation confirmation",
              "prospective",
              { requires: [mail.key], conditional: true, waitsFor: `engagement:${avVendor.id}:cancellation_confirmed`, area: "equipment" },
            );
            p.wait("equipment", `Waiting for ${avVendor.vendorName} to confirm cancellation`, `engagement:${avVendor.id}:cancellation_confirmed`, [mail.key], "The saving is realised only when the rental cancellation is confirmed.");
          }
        } else if (line) {
          p.check("budget", `AV rental cost will change (amount unknown)`, `Removing ${overlap.join(", ")} should reduce the ${formatCents(line.subtotalCents)} rental, but the revised price is unknown until ${avVendor.vendorName} requotes. The budget keeps the current figure.`, p.ev(avDoc, docExcerpt(avDoc, /Price/i)), ["equipment.av_rental"], "info", "follow_consequences");
          p.wait("equipment", `Waiting for ${avVendor.vendorName} revised quote`, `engagement:${avVendor.id}:quote_received:v${avVendor.quotes.length + 1}`, [mail.key], "The rental line is updated when a revised quote arrives.");
        }
      }
      p.staffNotice(`Equipment update for ${p.ctx.project.name}: the venue now provides ${included.join(", ")}. Crew should use venue equipment for the awards; rental changes are pending vendor confirmation.`, "Brief crew on venue-provided equipment", "Crew setup instructions change; guests are not affected.", ["venue.included_av"]);
      p.check("guests", "No guest communication needed", "Equipment changes do not affect what guests need to know.", [], ["venue.included_av"], "info", "follow_consequences");
    },
  },
];

function sharesEquipmentTerm(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/wireless|built-in|system|and|\d+|ft|with|\s+/g, " ").split(" ").filter((t) => t.length > 2);
  const ta = norm(a);
  const tb = norm(b);
  return ta.some((t) => tb.some((u) => u.startsWith(t) || t.startsWith(u) || (t === "mics" && u.startsWith("microphone"))));
}

function minutesBetween(a: string, b: string): number {
  const [ah, am] = a.split(":").map(Number);
  const [bh, bm] = b.split(":").map(Number);
  return bh * 60 + bm - (ah * 60 + am);
}

/** Applies the interpreted operations to the planner as direct changes; returns whether anything was requested. */
function applyOperations(p: Planner, changes: RequestedChange[]): void {
  const cancelled = new Set<string>();
  for (const c of changes) {
    switch (c.op) {
      case "set_attendance": {
        const before = p.before<number>("attendance.expected");
        if (before === c.value) {
          p.notes.push(`Attendance is already ${c.value}; no change needed.`);
          break;
        }
        p.setFact("attendance.expected", c.value, `Requested change from ${before ?? "unknown"} to ${c.value}.`, [{ sourceType: "fact", ref: "request", excerpt: "User request" }], { title: `Expected attendance: ${before ?? "?"} → ${c.value}`, area: "guests" });
        break;
      }
      case "set_budget_ceiling": {
        const before = p.before<number>("budget.ceiling_cents");
        if (before === c.cents) {
          p.notes.push(`Budget ceiling is already ${formatCents(c.cents)}.`);
          break;
        }
        p.setFact("budget.ceiling_cents", c.cents, `Requested change from ${formatCents(before)} to ${formatCents(c.cents)}. Commitments are not edited automatically.`, [{ sourceType: "fact", ref: "request", excerpt: "User request" }], { title: `Budget ceiling: ${formatCents(before)} → ${formatCents(c.cents)}` });
        break;
      }
      case "add_dietary_option": {
        const before = p.before<string[]>("catering.dietary_options") ?? [];
        if (before.includes(c.option)) {
          p.notes.push(`A ${c.option.replace("_", "-")} option is already offered.`);
          p.check("catering", `${c.option} option already available`, `The current caterer already offers a ${c.option.replace("_", "-")} option; no change is needed.`, p.factEv("catering.dietary_options"), ["catering.dietary_options"]);
          break;
        }
        p.setFact("catering.dietary_options", [...before, c.option], `Requested new dietary option; recorded as tentative until the caterer confirms.`, [{ sourceType: "fact", ref: "request", excerpt: "User request" }], { status: "tentative", title: `Add ${c.option.replace("_", "-")} option`, area: "catering" });
        break;
      }
      case "shift_schedule": {
        if (c.item === "dinner" || c.item === "awards") {
          const before = p.before<string>("schedule.dinner_start");
          if (!before) {
            p.notes.push("No dinner start time is recorded; nothing to shift.");
            break;
          }
          const after = addMinutes(before, c.deltaMinutes);
          p.setFact("schedule.dinner_start", after, `Requested shift of ${Math.abs(c.deltaMinutes)} minutes ${c.deltaMinutes > 0 ? "later" : "earlier"}.`, [{ sourceType: "fact", ref: "request", excerpt: "User request" }], { title: `Dinner service: ${before} → ${after}`, area: "staff" });
          p.setFact("catering.service_start", after, "Follows the dinner start.", [], { title: `Catering service start: ${before} → ${after}`, area: "catering" });
        } else {
          const before = p.before<string>("event.time");
          if (!before) {
            p.notes.push("No start time is recorded; nothing to shift.");
            break;
          }
          const after = addMinutes(before, c.deltaMinutes);
          p.setFact("event.time", after, `Requested shift of ${Math.abs(c.deltaMinutes)} minutes.`, [{ sourceType: "fact", ref: "request", excerpt: "User request" }], { title: `Doors: ${before} → ${after}` });
          const dinnerBefore = p.before<string>("schedule.dinner_start");
          if (dinnerBefore) p.setFact("schedule.dinner_start", addMinutes(dinnerBefore, c.deltaMinutes), "Whole programme shifts with the start time.", [], { title: `Dinner service: ${dinnerBefore} → ${addMinutes(dinnerBefore, c.deltaMinutes)}`, area: "staff" });
        }
        break;
      }
      case "set_time": {
        const key = c.item === "dinner" || c.item === "awards" ? "schedule.dinner_start" : "event.time";
        const before = p.before<string>(key);
        p.setFact(key, c.time, `Requested ${c.item.replace("_", " ")} time ${c.time}.`, [{ sourceType: "fact", ref: "request", excerpt: "User request" }], { title: `${humanFactKey(key)}: ${before ?? "?"} → ${c.time}`, area: key === "event.time" ? "brief" : "staff" });
        break;
      }
      case "set_date": {
        const before = p.before<string>("event.date");
        p.setFact("event.date", c.date, "Requested date change. Venue and vendor availability for the new date are unverified.", [{ sourceType: "fact", ref: "request", excerpt: "User request" }], { status: "tentative", title: `Event date: ${before ?? "?"} → ${c.date}` });
        for (const e of p.ctx.engagements.filter((e) => e.confirmationState === "confirmed" && e.cancellationState === "none")) {
          const contact = contactForEngagement(p.ctx, e);
          p.check(e.service === "venue" ? "venue" : e.service === "equipment" ? "equipment" : "catering", `${e.vendorName} availability for ${c.date} unknown`, `The ${e.service} commitment is dated for ${before}. Availability and any rescheduling fee for ${c.date} are unknown. Terms: ${e.cancellationTerms ?? "not documented"}.`, [], ["event.date"], "warning");
          if (contact?.email) {
            const mail = p.email(e.service === "venue" ? "venue" : e.service === "equipment" ? "equipment" : "catering", e, [{ name: contact.name, email: contact.email }], `Date change enquiry — ${p.ctx.project.name}`, `Hello ${contact.name.split(" ")[0]},\n\nWe are considering moving the ${p.ctx.project.name} from ${formatLongDate(before ?? "")} to ${formatLongDate(c.date)}. Please confirm your availability for the new date and any rescheduling fee under our agreement.\n\nThank you,\n${p.ctx.project.name} organising team`, "date_enquiry", `Ask ${e.vendorName} about ${formatLongDate(c.date)}`, "Confirmed vendors must agree to a new date before it is announced.", [], ["event.date"]);
            p.wait(e.service === "venue" ? "venue" : "catering", `Waiting for ${e.vendorName} to confirm the new date`, `engagement:${e.id}:date_confirmed`, [mail.key], "The date stays tentative until every confirmed vendor agrees.");
          }
        }
        p.staffNotice(`Heads-up: the ${p.ctx.project.name} may move to ${formatLongDate(c.date)}. Please hold the date; a confirmation will follow.`, "Ask staff to hold the new date", "Staff availability must be re-checked.", ["event.date"]);
        p.invitationUpdate(defaultInvitationText(p.ctx.facts, Object.fromEntries(p.after)), "Update the invitation date", "Guests are told only after the venue confirms the new date.", ["event.date"], [], { conditional: true, waitsFor: `engagement:${p.ctx.engagements.find((e) => e.service === "venue" && e.confirmationState === "confirmed")?.id ?? "venue"}:date_confirmed` });
        break;
      }
      case "set_format": {
        const before = p.before<EventFormat>("event.format");
        if (before === c.format) {
          p.notes.push("The event already has that format.");
          break;
        }
        p.setFact("event.format", c.format, "Requested format change.", [{ sourceType: "fact", ref: "request", excerpt: "User request" }], { title: `Format: ${before === "standing_reception" ? "standing reception" : "seated dinner"} → ${c.format === "standing_reception" ? "standing reception" : "seated dinner"}` });
        break;
      }
      case "venue_provides_equipment": {
        const before = p.before<string[]>("venue.included_av") ?? [];
        const merged = [...before, ...c.items.filter((i) => !before.some((b) => sharesEquipmentTerm(b, i)))];
        p.setFact("venue.included_av", merged, "Reported by the organiser; not yet confirmed in a venue document.", [{ sourceType: "fact", ref: "request", excerpt: "User request" }], { status: "tentative", title: `Venue includes: ${c.items.join(", ")}`, area: "venue" });
        break;
      }
      case "staff_unavailable": {
        const available = p.before<number>("staffing.available") ?? p.ctx.staff.filter((m) => m.available).length;
        const named = (c.names ?? []).map((n) => p.ctx.staff.find((m) => m.name.toLowerCase() === n.toLowerCase() || m.name.toLowerCase().split(" ")[0] === n.toLowerCase().split(" ")[0])).filter((m): m is NonNullable<typeof m> => !!m && m.available);
        const count = named.length || c.count;
        const after = Math.max(0, available - count);
        const who = named.length ? named.map((m) => m.name).join(", ") : `${count} staff member${count === 1 ? "" : "s"}`;
        p.setFact("staffing.available", after, `${who} reported unavailable.`, [{ sourceType: "fact", ref: "request", excerpt: "User request" }], { title: `Staff available: ${available} → ${after}`, area: "staff" });
        for (const m of named) {
          p.drafts.push({ key: `staff_${m.id}`, kind: "staff", area: "staff", title: `Mark ${m.name} (${m.role}) as unavailable`, target: { type: "staff", staffId: m.id, field: "available" }, before: true, after: false, rationale: "Roster record follows the organiser's report.", evidence: p.ev(findDocument(p.ctx, "staff-roster"), m.name), factDepKeys: ["staffing.available"], cost: null, requires: [], external: false, stage: "follow_consequences" });
        }
        const reserve = p.ctx.staff.filter((m) => /reserve/i.test(m.role) && m.available && !named.includes(m));
        if (reserve.length) {
          p.check("staff", `${reserve.length} reserve staff on roster`, `${reserve.map((r) => r.name).join(", ")} ${reserve.length === 1 ? "is" : "are"} listed as reserve and could cover a gap; asking them is included below.`, p.ev(findDocument(p.ctx, "staff-roster"), `${reserve[0].name},${reserve[0].role}`), ["staffing.available"]);
        }
        p.staffNotice(`${named.length ? who : `${count} colleague${count === 1 ? "" : "s"}`} can no longer work the ${p.ctx.project.name} on ${p.eventDateLong()}. Reserve staff: please confirm availability. Roles will be reassigned at the 17:00 briefing.`, "Ask remaining and reserve staff to confirm roles", "Coverage must be re-planned with the people actually available.", ["staffing.available"]);
        p.check("guests", "No guest communication needed", "Staffing changes do not affect what guests need to know.", [], ["staffing.available"], "info", "follow_consequences");
        break;
      }
      case "cancel_vendor": {
        const res = resolveEngagement(p.ctx, c.vendorRef, c.service);
        if (res.status !== "resolved") {
          p.questions.push({ id: `cancel_${c.vendorRef}`, question: res.status === "ambiguous" ? `Which ${c.service === "unknown" ? "vendor" : c.service + " vendor"} did you mean by “${c.vendorRef}”?` : `I could not find a vendor matching “${c.vendorRef}” on this project. Which engagement should be cancelled?`, options: (res.status === "ambiguous" ? res.options : p.ctx.engagements.filter((e) => e.confirmationState === "confirmed")).map((e) => e.vendorName) });
          break;
        }
        const e = res.value;
        cancelled.add(e.id);
        planCancellation(p, e);
        break;
      }
      case "request_quote": {
        const res = resolveEngagement(p.ctx, c.vendorRef, c.service);
        if (res.status !== "resolved") {
          const vendorContacts = p.ctx.contacts.filter((ct) => ct.relationship === "vendor" && ct.emailVerified);
          p.questions.push({ id: `quote_${c.vendorRef}`, question: res.status === "ambiguous" ? `Which vendor did you mean by “${c.vendorRef}”?` : `There is no verified contact for “${c.vendorRef}” on this project, so I cannot draft a quote request without inventing an address. Add the contact, or choose an existing vendor.`, options: (res.status === "ambiguous" ? res.options.map((o) => o.vendorName) : vendorContacts.map((ct) => ct.organization ?? ct.name)) });
          break;
        }
        planQuoteRequest(p, res.value, c.service === "unknown" ? res.value.service : c.service, cancelled);
        break;
      }
      case "set_venue": {
        planVenueChange(p, c.venueRef);
        break;
      }
      case "add_equipment": {
        const avVendor = p.ctx.engagements.find((e) => e.service === "equipment" && e.cancellationState === "none");
        const contact = avVendor ? contactForEngagement(p.ctx, avVendor) : undefined;
        const rental = p.before<string[]>("equipment.av_rental") ?? [];
        const included = p.before<string[]>("venue.included_av") ?? [];
        if (included.some((i) => sharesEquipmentTerm(i, c.item))) {
          p.check("equipment", `Venue already provides ${c.item}`, `The venue's included equipment lists ${included.join(", ")}; check quantities with the venue before renting more.`, p.factEv("venue.included_av"), ["venue.included_av"], "info");
        }
        p.setFact("equipment.av_rental", [...rental, `${c.quantity} × ${c.item} (requested)`], "Requested addition; price unknown until quoted.", [{ sourceType: "fact", ref: "request", excerpt: "User request" }], { status: "tentative", title: `Add ${c.quantity} × ${c.item}`, area: "equipment" });
        if (avVendor && contact?.email) {
          const mail = p.email("equipment", avVendor, [{ name: contact.name, email: contact.email }], `Additional equipment — ${p.ctx.project.name}, ${p.eventDateLong()}`, `Hello ${contact.name.split(" ")[0]},\n\nPlease add ${c.quantity} × ${c.item} to our rental for the ${p.ctx.project.name} on ${p.eventDateLong()} and send a revised quote.\n\nThank you,\n${p.ctx.project.name} organising team`, "add_equipment", `Ask ${avVendor.vendorName} to quote ${c.quantity} × ${c.item}`, "Additional rental cost is unknown until quoted.", [], ["equipment.av_rental"]);
          p.wait("equipment", `Waiting for ${avVendor.vendorName} revised quote`, `engagement:${avVendor.id}:quote_received:v${avVendor.quotes.length + 1}`, [mail.key], "Budget line is updated when the revised quote arrives.");
          p.check("budget", "Additional equipment cost unknown", "No price is assumed for the extra items until the vendor quotes.", [], ["equipment.av_rental"], "info", "follow_consequences");
        } else {
          p.check("equipment", "No equipment vendor on file", "Record a vendor contact to request a quote for the extra items.", [], ["equipment.av_rental"], "warning");
        }
        break;
      }
      case "unsupported":
        p.notes.push(`Not interpreted: “${c.text}” — ${c.reason}`);
        break;
    }
  }
}

function planCancellation(p: Planner, e: VendorEngagement) {
  const contact = contactForEngagement(p.ctx, e);
  const doc = findDocument(p.ctx, e.vendorName.split(" ")[0].toLowerCase()) ?? venueDocument(p.ctx, e);
  const area: AreaId = e.service === "venue" ? "venue" : e.service === "equipment" ? "equipment" : "catering";
  if (e.cancellationState !== "none") {
    p.check(area, `${e.vendorName} cancellation already ${e.cancellationState}`, "No new cancellation request is needed.", [], []);
    return;
  }
  const line = p.lineFor(e.id);
  const depositLine = docExcerpt(doc, /Deposit:/i);
  const termsLine = docExcerpt(doc, /Cancellation/i) ?? e.cancellationTerms ?? undefined;
  if (e.depositCents === null || e.depositRefundable === null || !e.cancellationTerms) {
    p.check(area, `${e.vendorName} cancellation terms unknown`, "The agreement does not document a deposit or cancellation terms. No fee can be assumed to be zero; the vendor must state what is owed.", p.ev(doc, termsLine), [], "warning");
  } else {
    const days = p.daysUntilEvent();
    const window = e.cancellationTerms.match(/more than (\d+) days/i);
    const withinFree = window && days !== undefined ? days > Number(window[1]) : undefined;
    p.check(
      area,
      e.depositRefundable ? `${e.vendorName} deposit ${formatCents(e.depositCents)} is refundable` : `Non-refundable deposit of ${formatCents(e.depositCents)} found`,
      `${e.vendorName}: ${e.cancellationTerms}. ${e.depositRefundable ? "" : `The ${formatCents(e.depositCents)} deposit is already paid and is retained as a sunk cost.`}${withinFree !== undefined ? ` The event is ${days} days away, so ${withinFree ? "no further fee should be due" : "an additional fee may apply"} — the vendor must confirm.` : ""}`,
      [...p.ev(doc, depositLine), ...p.ev(doc, termsLine)],
      [],
      "warning",
    );
  }
  if (!contact?.email) {
    p.check(area, `No verified contact for ${e.vendorName}`, "Cannot draft a cancellation notice without a verified contact address.", [], [], "warning");
    return;
  }
  const mail = p.email(
    area,
    e,
    [{ name: contact.name, email: contact.email }],
    `Cancellation of ${e.service} — ${p.ctx.project.name}, ${p.eventDateLong()}`,
    `Hello ${contact.name.split(" ")[0]},\n\nPlease treat this as written notice that we are cancelling our ${e.service} booking with ${e.vendorName} for the ${p.ctx.project.name} on ${p.eventDateLong()}${e.notes?.match(/[A-Z]{2}-[A-Z]{2}-\d{4}-\d{2}|[A-Z]{2}-\d{4}-\d+|[A-Z]{2,3}-\d+/) ? ` (${e.notes.match(/[A-Z]{2}-[A-Z]{2}-\d{4}-\d{2}|[A-Z]{2}-\d{4}-\d+|[A-Z]{2,3}-\d+/)![0]})` : ""}.\n\nWe understand the ${e.depositCents ? formatCents(e.depositCents) + " deposit" : "deposit terms"} ${e.depositRefundable === false ? "is non-refundable" : "will be handled"} per our agreement. Please confirm in writing that the remaining balance is released and state any further fee that applies.\n\nThank you for your work on this event.\n\n${p.ctx.project.name} organising team`,
    "cancellation",
    `Send cancellation notice to ${e.vendorName}`,
    "Written notice is required by the agreement; sending it does not confirm the cancellation.",
    p.ev(doc, termsLine),
    [],
  );
  p.engagementChange(e, "cancellationState", "requested", `Mark ${e.vendorName} as cancellation requested`, "Requested is not confirmed; the balance stays committed until the vendor acknowledges.", [], [mail.key]);
  if (line) {
    const sunk = e.depositRefundable === false ? (e.depositCents ?? 0) : 0;
    p.budgetLine(
      line,
      { category: line.category, label: `${e.vendorName} deposit (retained after cancellation)`, quantity: 1, unitCents: sunk, subtotalCents: sunk, commitmentStatus: "sunk", engagementId: e.id },
      `Release ${formatCents((line.subtotalCents ?? 0) - sunk)} balance once ${e.vendorName} confirms; keep ${formatCents(sunk)} deposit as sunk`,
      `The ${formatCents(line.subtotalCents)} commitment includes the ${formatCents(sunk)} deposit. On confirmed cancellation the balance is no longer owed; the deposit remains a sunk cost and is not counted again.`,
      [...p.ev(doc, depositLine)],
      [],
      "Prospective — pending vendor acknowledgement",
      "prospective",
      { requires: [mail.key], conditional: true, waitsFor: `engagement:${e.id}:cancellation_confirmed`, area },
    );
    p.wait(area, `Waiting for ${e.vendorName} to acknowledge the cancellation`, `engagement:${e.id}:cancellation_confirmed`, [mail.key], "The released balance and any fee are recorded when the acknowledgement arrives.");
  }
  if (e.service === "catering") {
    p.check("guests", "No guest communication yet", "Guests are not told about a catering change until a replacement is confirmed.", [], [], "info", "follow_consequences");
  }
}

function planQuoteRequest(p: Planner, e: VendorEngagement, service: string, cancelled: Set<string>) {
  const contact = contactForEngagement(p.ctx, e);
  const area: AreaId = service === "venue" ? "venue" : service === "equipment" ? "equipment" : "catering";
  if (!contact?.email || !contact.emailVerified) {
    p.questions.push({ id: `contact_${e.id}`, question: `${e.vendorName} has no verified email address on this project. Add a contact before requesting a quote.` });
    return;
  }
  if (e.quoteState === "requested") {
    p.check(area, `Quote already requested from ${e.vendorName}`, "A quote request is already outstanding; no duplicate request is drafted.", [], []);
    return;
  }
  const att = p.get<number>("attendance.expected");
  const diet = p.get<string[]>("catering.dietary_options") ?? [];
  const address = p.get<string>("venue.address");
  const venue = p.get<string>("venue.name");
  const service_start = p.get<string>("schedule.dinner_start");
  const format = p.get<EventFormat>("event.format") === "standing_reception" ? "standing reception" : "seated dinner";
  const replacing = [...cancelled].map((id) => p.ctx.engagements.find((x) => x.id === id)).filter((x): x is VendorEngagement => !!x && x.service === service);
  const mail = p.email(
    area,
    e,
    [{ name: contact.name, email: contact.email }],
    `${service[0].toUpperCase()}${service.slice(1)} quote request — ${p.ctx.project.name}, ${p.eventDateLong()}`,
    `Hello ${contact.name.split(" ")[0]},\n\nWe would like a quote for ${service} at the ${p.ctx.project.name}:\n\n- Date: ${p.eventDateLong()}\n- Venue: ${venue ?? "to be confirmed"}${address ? `, ${address}` : ""}\n- Guests: ${att ?? "to be confirmed"}\n- Format: ${format}${service === "catering" ? `\n- Dietary: ${diet.length ? diet.map((d) => d.replace("_", "-")).join(", ") : "to be confirmed"}${p.get<number>("guests.dietary_vegetarian") ? ` (${p.get<number>("guests.dietary_vegetarian")} vegetarian requests so far)` : ""}\n- Service: staff-served, dinner service from ${service_start ?? "TBC"}; delivery via ${p.get<string>("venue.delivery_access") ?? "venue loading access"}` : ""}\n\nPlease include per-guest pricing, delivery or service fees, tax treatment, deposit and cancellation terms, dietary options, availability on the date, and the quote's validity period.\n\nThank you,\n${p.ctx.project.name} organising team`,
    "quote_request",
    `Request a ${service} quote from ${e.vendorName}`,
    `${e.vendorName} has a verified contact on this project. ${replacing.length ? `It would replace ${replacing.map((r) => r.vendorName).join(", ")}, whose cancellation proceeds independently.` : ""}`,
    [{ sourceType: "document", ref: findDocument(p.ctx, "contacts.csv")?.id ?? "", excerpt: `${contact.organization},${contact.name},${contact.role},${contact.email},verified`, label: "contacts.csv" }],
    ["attendance.expected", "event.date", "venue.address", "catering.dietary_options"],
  );
  p.engagementChange(e, "quoteState", "requested", `Mark ${e.vendorName} quote as requested`, "A requested quote is not a booking.", [], [mail.key]);
  p.budgetLine(
    null,
    { category: service, label: `${e.vendorName} ${service} (quote pending)`, quantity: att ?? 1, unitCents: null, subtotalCents: null, commitmentStatus: "unknown", engagementId: e.id },
    `Add ${e.vendorName} line with unknown cost`,
    "Replacement cost is unknown until the quote arrives; it is not estimated from the former vendor's price.",
    [],
    ["attendance.expected"],
    "Unknown until quoted",
    "unknown",
    { requires: [mail.key], area },
  );
  p.wait(area, `Waiting for ${e.vendorName} quote`, `engagement:${e.id}:quote_received`, [mail.key], "When a matching quote arrives the forecast is revised automatically and an acceptance draft is prepared for review.");
  if (service === "catering") {
    p.setFact("catering.vendor", e.vendorName, `Becomes the caterer of record only when ${e.vendorName} confirms the booking.`, [], { conditional: true, waitsFor: `engagement:${e.id}:confirmed`, requires: [mail.key], title: `Caterer of record → ${e.vendorName} (on confirmation)`, area: "catering" });
    p.staffNotice(
      `Catering update for ${p.ctx.project.name} (${p.eventDateLong()}): ${replacing.length ? `${replacing.map((r) => r.vendorName).join(", ")} has been replaced by ` : "the caterer is "}${e.vendorName}. Delivery and service details will be shared once confirmed with the vendor. Staff meals will be arranged with the new caterer.`,
      `Tell event staff about the ${e.vendorName} booking (after confirmation)`,
      "Staff need to know the vendor they will work with; sent automatically once the booking is confirmed if nothing relevant has changed.",
      ["catering.vendor"],
      { conditional: true, waitsFor: `engagement:${e.id}:confirmed`, requires: [mail.key] },
    );
    p.check("guests", "Invitation menu update deferred", "Guest-facing menu wording depends on the accepted quote; it will be proposed for review once the booking is confirmed.", [], [], "info", "follow_consequences");
  }
}

function planVenueChange(p: Planner, venueRef: string) {
  const res = resolveVenue(p.ctx, venueRef);
  if (res.status !== "resolved") {
    const options = p.ctx.engagements.filter((e) => e.service === "venue" && e.confirmationState !== "confirmed").map((e) => `${e.vendorName}${e.notes ? ` — ${e.notes}` : ""}`);
    p.questions.push({ id: "venue", question: res.status === "ambiguous" ? `Several properties match “${venueRef}”. Which exact property and room?` : `I could not match “${venueRef}” to a property and room on this project, and will not guess an address. Which venue proposal did you mean?`, options: res.status === "ambiguous" ? res.options.map((o) => o.engagement.vendorName) : options });
    return;
  }
  const { engagement: newVenue, document: doc } = res.value;
  const currentVenueEng = p.ctx.engagements.find((e) => e.service === "venue" && e.confirmationState === "confirmed" && e.cancellationState === "none");
  if (currentVenueEng?.id === newVenue.id) {
    p.check("venue", `${newVenue.vendorName} is already the confirmed venue`, "No change is needed.", [], []);
    return;
  }
  const vf = doc ? extractVenueFacts(doc) : undefined;
  if (!doc || !vf?.room) {
    p.questions.push({ id: "venue_room", question: `${newVenue.vendorName} is on the project but no proposal document names an exact room. Which room should be used?` });
    return;
  }
  const ev = (k: string) => p.ev(doc, vf.excerpts[k]);
  p.check("venue", `Resolved to ${newVenue.vendorName} — ${vf.room}`, `Matched “${venueRef}” to the sample proposal ${vf.reference ?? ""} dated ${vf.dated ?? "unknown"}. All figures below come from that document, not from public web data.`, ev("room"), []);
  const att = p.get<number>("attendance.expected") ?? 0;
  const format = p.get<EventFormat>("event.format") ?? "seated_dinner";
  const cap = format === "seated_dinner" ? vf.seatedCapacity : vf.standingCapacity;
  if (cap === undefined) p.check("venue", "Room capacity not stated", "The proposal does not state a capacity for the intended layout.", [], ["attendance.expected"], "warning");
  else p.check("venue", `${vf.room} ${format === "seated_dinner" ? "seated" : "standing"} capacity ${cap} vs ${att} guests`, `${att <= cap ? "Fits" : "Does not fit"}: the proposal states ${cap} ${format === "seated_dinner" ? "seated" : "standing"}. The property's larger advertised maximum (${vf.standingCapacity ?? "n/a"} standing) is not the seated figure.`, ev("seatedCapacity"), ["attendance.expected", "event.format"], att <= cap ? "info" : "warning");
  p.check("venue", vf.availability ? `Availability: ${vf.availability}` : "Availability unknown", vf.availability ? `Stated in a dated proposal (${vf.dated}); this is a hold, not a booking. Capacity pages never prove date availability.` : "The document does not state availability for the event date.", ev("availability"), ["event.date"], vf.availability ? "info" : "warning");

  p.setFact("venue.name", newVenue.vendorName, "Proposed venue; tentative until the booking is confirmed.", ev("room"), { status: "tentative", title: `Venue → ${newVenue.vendorName}` });
  p.setFact("venue.room", vf.room, "From the venue proposal.", ev("room"), { status: "tentative", title: `Room → ${vf.room}` });
  if (vf.address) p.setFact("venue.address", vf.address, "From the venue proposal.", ev("address"), { status: "tentative", title: `Address → ${vf.address}` });
  if (vf.seatedCapacity !== undefined) p.setFact("venue.seated_capacity", vf.seatedCapacity, "From the venue proposal.", ev("seatedCapacity"), { status: "tentative", title: `Seated capacity → ${vf.seatedCapacity}` });
  if (vf.standingCapacity !== undefined) p.setFact("venue.standing_capacity", vf.standingCapacity, "From the venue proposal.", ev("standingCapacity"), { status: "tentative", title: `Standing capacity → ${vf.standingCapacity}` });
  p.setFact("venue.included_av", vf.includedAv, "From the venue proposal.", ev("includedAv"), { status: "tentative", title: `Included AV → ${vf.includedAv.length ? vf.includedAv.join(", ") : "none"}` });
  if (vf.deliveryAccess) p.setFact("venue.delivery_access", vf.deliveryAccess, "From the venue proposal.", ev("deliveryAccess"), { status: "tentative", title: "Update delivery access" });
  p.setFact("venue.availability", { confirmed: false, detail: `${vf.availability ?? "unknown"} (proposal ${vf.reference ?? ""}, ${vf.dated ?? ""})` }, "A proposal hold is not a confirmed booking.", ev("availability"), { status: "tentative", title: "Availability → held, not booked" });

  const contact = contactForEngagement(p.ctx, newVenue);
  let bookingMail: ProposalDraft | null = null;
  if (contact?.email) {
    bookingMail = p.email("venue", newVenue, [{ name: contact.name, email: contact.email }], `Booking request — ${vf.room}, ${p.eventDateLong()}`, `Hello ${contact.name.split(" ")[0]},\n\nFollowing proposal ${vf.reference ?? ""}, we would like to proceed with ${vf.room} at ${newVenue.vendorName} for the ${p.ctx.project.name} on ${p.eventDateLong()} for ${att} guests (${format === "seated_dinner" ? "seated dinner" : "standing reception"}). Please confirm the date, send the contract and deposit invoice, and confirm the included AV and outside-catering arrangements.\n\nThank you,\n${p.ctx.project.name} organising team`, "booking_request", `Ask ${newVenue.vendorName} to confirm the booking`, "The room is only held; a booking request starts confirmation.", ev("availability"), ["event.date", "attendance.expected"]);
    p.wait("venue", `Waiting for ${newVenue.vendorName} to confirm the booking`, `engagement:${newVenue.id}:confirmed`, [bookingMail.key], "Announcements and dependent cancellations wait for the venue's written confirmation.");
    p.engagementChange(newVenue, "confirmationState", "awaiting", `Mark ${newVenue.vendorName} as awaiting confirmation`, "Requested is not booked.", [], [bookingMail.key]);
  }
  const confirmWait = `engagement:${newVenue.id}:confirmed`;
  const venueLine = currentVenueEng ? p.lineFor(currentVenueEng.id) : undefined;
  if (vf.hireCents !== undefined) {
    p.budgetLine(
      null,
      { category: "venue", label: `${newVenue.vendorName} ${vf.room} hire`, quantity: 1, unitCents: vf.hireCents, subtotalCents: vf.hireCents, commitmentStatus: "quoted", engagementId: newVenue.id },
      `Add ${newVenue.vendorName} hire ${formatCents(vf.hireCents)} (quoted)`,
      `Price from the dated proposal; becomes committed on confirmation. Deposit: ${vf.depositTerms ?? "not stated"}.`,
      ev("hireCents"),
      ["venue.name"],
      "Quoted — from dated proposal",
      "quoted",
      { requires: bookingMail ? [bookingMail.key] : [], area: "venue" },
    );
  }
  if (vf.kitchenFeeCents) {
    p.budgetLine(null, { category: "venue", label: `${newVenue.vendorName} outside-catering kitchen fee`, quantity: 1, unitCents: vf.kitchenFeeCents, subtotalCents: vf.kitchenFeeCents, commitmentStatus: "quoted", engagementId: newVenue.id }, `Add kitchen fee ${formatCents(vf.kitchenFeeCents)} for outside catering`, "The proposal charges a kitchen fee when outside catering is used, which this event does.", ev("deliveryAccess"), ["venue.name", "catering.vendor"], "Quoted — from dated proposal", "quoted", { requires: bookingMail ? [bookingMail.key] : [], area: "venue" });
  }
  if (currentVenueEng) {
    const oldDoc = venueDocument(p.ctx, currentVenueEng);
    const oldContact = contactForEngagement(p.ctx, currentVenueEng);
    const days = p.daysUntilEvent();
    const window = currentVenueEng.cancellationTerms?.match(/within (\d+) days/i);
    const outside = window && days !== undefined ? days > Number(window[1]) : undefined;
    p.check("venue", `${currentVenueEng.vendorName} deposit ${formatCents(currentVenueEng.depositCents)}: ${currentVenueEng.cancellationTerms ?? "terms unknown"}`, `${outside === true ? `The event is ${days} days away, outside the non-refundable window, so the deposit should be refundable — the venue must confirm.` : outside === false ? `The event is ${days} days away, inside the non-refundable window; the deposit would be a sunk cost.` : "Refund position cannot be determined from the documents."}`, p.ev(oldDoc, docExcerpt(oldDoc, /Deposit:/i)), ["event.date"], "warning");
    if (oldContact?.email) {
      const cancelMail = p.email("venue", currentVenueEng, [{ name: oldContact.name, email: oldContact.email }], `Cancellation of venue booking — ${p.ctx.project.name}, ${p.eventDateLong()}`, `Hello ${oldContact.name.split(" ")[0]},\n\nPlease treat this as written notice that we are cancelling our booking of the ${p.get<string>("venue.room") ?? "room"} for the ${p.ctx.project.name} on ${p.eventDateLong()}. Please confirm the position on our ${formatCents(currentVenueEng.depositCents)} deposit under the agreed terms and any further fee.\n\nThank you,\n${p.ctx.project.name} organising team`, "cancellation", `Send cancellation notice to ${currentVenueEng.vendorName} (after new venue confirms)`, "Do not release the current venue before the replacement is confirmed.", p.ev(oldDoc, docExcerpt(oldDoc, /Deposit:/i)), ["venue.name"], { conditional: true, waitsFor: confirmWait, requires: bookingMail ? [bookingMail.key] : [] });
      p.engagementChange(currentVenueEng, "cancellationState", "requested", `Mark ${currentVenueEng.vendorName} as cancellation requested`, "Follows the cancellation notice.", [], [cancelMail.key], { conditional: true, waitsFor: confirmWait });
      if (venueLine) {
        p.budgetLine(venueLine, { category: "venue", label: `${venueLine.label} (cancelled — refund position pending)`, quantity: 0, unitCents: venueLine.unitCents, subtotalCents: 0, commitmentStatus: "released", active: false }, `Release ${formatCents(venueLine.subtotalCents)} ${currentVenueEng.vendorName} hire once cancellation is acknowledged`, "Any retained deposit is recorded as sunk when the venue replies.", p.ev(oldDoc, docExcerpt(oldDoc, /Deposit:/i)), ["venue.name"], "Prospective — pending venue acknowledgement", "prospective", { requires: [cancelMail.key], conditional: true, waitsFor: `engagement:${currentVenueEng.id}:cancellation_confirmed`, area: "venue" });
      }
    }
  }
  // AV duplication
  const rental = p.get<string[]>("equipment.av_rental") ?? [];
  const avVendor = p.ctx.engagements.find((e) => e.service === "equipment" && e.confirmationState === "confirmed" && e.cancellationState === "none");
  const overlap = rental.filter((r) => vf.includedAv.some((i) => sharesEquipmentTerm(r, i)));
  if (avVendor && overlap.length) {
    const avDoc = findDocument(p.ctx, "av-rental");
    const terms = avVendor.cancellationTerms ?? docExcerpt(avDoc, /Cancellation/i);
    const avLine = p.lineFor(avVendor.id);
    const full = overlap.length >= rental.filter((r) => !/technician/i.test(r)).length;
    p.check("equipment", `Included AV duplicates ${overlap.length} rented item(s)`, `${newVenue.vendorName} includes ${vf.includedAv.join(", ")}. The ${avVendor.vendorName} rental (${formatCents(avLine?.subtotalCents)}) covers ${rental.join(", ")}. Terms: ${terms ?? "not documented"}. The saving is prospective until the rental is cancelled and confirmed.`, [...ev("includedAv"), ...p.ev(avDoc, terms)], ["venue.included_av", "equipment.av_rental"], "warning");
    const avContact = contactForEngagement(p.ctx, avVendor);
    if (avContact?.email) {
      const avMail = p.email("equipment", avVendor, [{ name: avContact.name, email: avContact.email }], `${full ? "Cancellation" : "Change"} of AV rental — ${p.ctx.project.name}, ${p.eventDateLong()}`, `Hello ${avContact.name.split(" ")[0]},\n\nOur venue for the ${p.ctx.project.name} on ${p.eventDateLong()} is changing to one that includes ${vf.includedAv.join(", ")}. ${full ? "We would like to cancel our rental in full under the free-cancellation terms; please confirm no fee is due." : `Please remove ${overlap.join(", ")} and requote the remainder.`}\n\nThank you,\n${p.ctx.project.name} organising team`, full ? "cancel_rental" : "reduce_rental", full ? `Cancel the ${avVendor.vendorName} rental (after venue confirms)` : `Reduce the ${avVendor.vendorName} rental (after venue confirms)`, "Cancelling the rental before the venue is confirmed would leave the event without AV.", p.ev(avDoc, terms), ["venue.included_av", "equipment.av_rental"], { conditional: true, waitsFor: confirmWait, requires: bookingMail ? [bookingMail.key] : [] });
      p.engagementChange(avVendor, "cancellationState", "requested", `Mark ${avVendor.vendorName} rental as cancellation requested`, "Requested is not confirmed.", [], [avMail.key], { conditional: true, waitsFor: confirmWait });
      if (avLine && full) {
        p.budgetLine(avLine, { category: "equipment", label: `${avLine.label} (cancelled)`, quantity: 0, unitCents: avLine.unitCents, subtotalCents: 0, commitmentStatus: "released", active: false }, `Remove ${formatCents(avLine.subtotalCents)} AV rental once cancellation is confirmed`, "Prospective saving; realised only on the vendor's confirmation.", p.ev(avDoc, terms), ["venue.included_av", "equipment.av_rental"], "Prospective — pending cancellation confirmation", "prospective", { requires: [avMail.key], conditional: true, waitsFor: `engagement:${avVendor.id}:cancellation_confirmed`, area: "equipment" });
        p.wait("equipment", `Waiting for ${avVendor.vendorName} to confirm cancellation`, `engagement:${avVendor.id}:cancellation_confirmed`, [avMail.key], "The AV saving is recorded when the rental cancellation is confirmed.");
      }
    }
  }
  // Downstream communications, all conditional on venue confirmation
  const caterer = p.activeCaterer();
  if (caterer && vf.address) {
    const cc = contactForEngagement(p.ctx, caterer);
    if (cc?.email) p.email("catering", caterer, [{ name: cc.name, email: cc.email }], `Venue change — ${p.ctx.project.name}, ${p.eventDateLong()}`, `Hello ${cc.name.split(" ")[0]},\n\nThe ${p.ctx.project.name} on ${p.eventDateLong()} is moving to ${newVenue.vendorName}, ${vf.room}, ${vf.address}. Delivery access: ${vf.deliveryAccess ?? "to be confirmed"}. Please confirm delivery arrangements${vf.kitchenFeeCents ? " (the venue charges a kitchen fee for outside catering, which we will cover)" : ""}.\n\nThank you,\n${p.ctx.project.name} organising team`, "venue_update", `Tell ${caterer.vendorName} the new delivery address (after venue confirms)`, "The caterer delivers to the venue's service entrance.", ev("deliveryAccess"), ["venue.address", "venue.delivery_access"], { conditional: true, waitsFor: confirmWait, requires: bookingMail ? [bookingMail.key] : [] });
  }
  p.staffNotice(`Venue update for ${p.ctx.project.name} (${p.eventDateLong()}): the event moves to ${newVenue.vendorName}, ${vf.room}, ${vf.address ?? ""}. Staff briefing location changes accordingly; timings unchanged.`, "Notify event staff of the new venue (after confirmation)", "Staff report to the venue.", ["venue.name", "venue.address"], { conditional: true, waitsFor: confirmWait, requires: bookingMail ? [bookingMail.key] : [] });
  const overlay = Object.fromEntries(p.after);
  p.invitationUpdate(defaultInvitationText(p.ctx.facts, overlay), "Update the invitation location (after confirmation)", "Guests must not receive a location announcement until the venue is confirmed and the address is exact.", ["venue.name", "venue.address"], ev("address"), { conditional: true, waitsFor: confirmWait, requires: bookingMail ? [bookingMail.key] : [] });
  p.fileUpdate("01 Brief/brief.md", renderBriefMd(p.ctx.facts, overlay), "Update brief.md with the new venue (after confirmation)", "Keeps the shared brief in step with confirmed facts.", ["venue.name", "venue.address"], { conditional: true, waitsFor: confirmWait, requires: bookingMail ? [bookingMail.key] : [] });
}

export function planConsequences(ctx: ProjectContext, intent: ChangeIntent, today = new Date().toISOString().slice(0, 10)): PlanResult {
  const p = new Planner(ctx, today);
  for (const q of intent.questions) p.questions.push(q);
  applyOperations(p, intent.requestedChanges);

  const ran = new Set<string>();
  for (let pass = 0; pass < 6; pass++) {
    let progressed = false;
    for (const rule of RULES) {
      if (ran.has(rule.id)) continue;
      if (!rule.inputs.some((k) => p.changed.has(k))) continue;
      ran.add(rule.id);
      const before = p.drafts.length;
      rule.run(p);
      // A rule's outputs follow the fact changes that triggered it.
      const triggers = p.drafts.slice(0, before).filter((d) => d.kind === "fact" && !d.conditional && rule.inputs.includes((d.target as { key: string }).key)).map((d) => d.key);
      for (const d of p.drafts.slice(before)) {
        if (d.informational) continue;
        for (const k of triggers) if (k !== d.key && !d.requires.includes(k)) d.requires.push(k);
      }
      progressed = true;
    }
    if (!progressed) break;
  }

  // budget projection file follows any budget change
  if (p.changed.has("budget.forecast")) {
    const lines = p.activeLines().filter((l) => l.active !== false);
    const unconditional = p.drafts.filter((d) => d.kind === "budget_line" && !d.conditional).map((d) => d.key);
    if (unconditional.length) p.fileUpdate("04 Budget/budget.csv", renderBudgetCsv(lines), "Update budget.csv projection", "Human-readable budget projection in the event folder.", ["budget.ceiling_cents"], { requires: unconditional });
  }
  if (p.changed.has("schedule.dinner_start") || p.changed.has("event.time")) {
    const items = ctx.schedule.map((i) => {
      const d = p.drafts.find((x) => x.kind === "schedule" && (x.target as { itemId?: string }).itemId === i.id);
      return d ? { ...i, startLocal: d.after as string } : i;
    });
    p.fileUpdate("06 Staff/schedule.csv", renderScheduleCsv(items), "Update schedule.csv projection", "Run-of-show projection in the event folder.", ["schedule.dinner_start", "event.time"], { requires: p.drafts.filter((d) => d.kind === "schedule").map((d) => d.key) });
  }

  // Every consequence that reads a fact this plan changes must wait for that fact update to be applied,
  // so skipping the root change blocks its dependents instead of applying them against the old value.
  const factDraftByKey = new Map(p.drafts.filter((d) => d.kind === "fact" && !d.conditional).map((d) => [(d.target as { key: string }).key, d.key]));
  for (const d of p.drafts) {
    if (d.informational) continue;
    for (const k of d.factDepKeys) {
      const req = factDraftByKey.get(k);
      if (req && req !== d.key && !d.requires.includes(req)) d.requires.push(req);
    }
  }

  const changedFactKeys = [...p.changed].filter((k) => k !== "budget.forecast");
  const noChange = p.drafts.filter((d) => !d.informational).length === 0;
  return { drafts: p.drafts, questions: p.questions, notes: p.notes, changedFactKeys, noChange };
}

export function suppressionKeyFor(d: { kind: ProposalKind; target: ProposalTarget; after: unknown }): string {
  const t = d.target;
  const identity =
    t.type === "fact" ? t.key : t.type === "budget_line" ? `${t.lineId ?? "new"}:${t.category}` : t.type === "engagement" ? `${t.engagementId}:${t.field}` : t.type === "email" ? `${t.purpose}:${t.to.map((x) => x.email).join(",")}` : t.type === "invitation" ? "invitation" : t.type === "staff_notice" ? "staff_notice" : t.type === "file" ? t.path : t.type === "schedule" ? t.itemId ?? t.title : t.type === "staff" ? `${t.staffId}:${t.field}` : t.note;
  const afterStr = JSON.stringify(d.after ?? null);
  let h = 0;
  for (let i = 0; i < afterStr.length; i++) h = (h * 31 + afterStr.charCodeAt(i)) | 0;
  return `${d.kind}:${identity}:${(h >>> 0).toString(16)}`;
}
