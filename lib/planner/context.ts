import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/lib/db/client";
import * as s from "@/lib/db/schema";
import type { FactMap } from "@/lib/domain/facts";

export type ProjectContext = {
  project: s.Project;
  facts: FactMap;
  engagements: s.VendorEngagement[];
  contacts: s.Contact[];
  budgetLines: s.BudgetLine[];
  documents: s.SourceDocument[];
  staff: s.StaffMember[];
  guests: s.Guest[];
  schedule: s.ScheduleItem[];
  recentMessages: s.Message[];
  pendingProposals: s.Proposal[];
  rejectedProposals: s.Proposal[];
  appliedProposals: s.Proposal[];
};

export function loadProjectContext(db: Db, projectId: string): ProjectContext {
  const project = db.select().from(s.projects).where(eq(s.projects.id, projectId)).get();
  if (!project) throw new Error(`Project ${projectId} not found`);
  const factRows = db.select().from(s.projectFacts).where(eq(s.projectFacts.projectId, projectId)).all();
  const facts: FactMap = {};
  for (const f of factRows) facts[f.key] = f;
  return {
    project,
    facts,
    engagements: db.select().from(s.vendorEngagements).where(eq(s.vendorEngagements.projectId, projectId)).all(),
    contacts: db.select().from(s.contacts).where(eq(s.contacts.projectId, projectId)).all(),
    budgetLines: db.select().from(s.budgetLines).where(eq(s.budgetLines.projectId, projectId)).all(),
    documents: db.select().from(s.sourceDocuments).where(eq(s.sourceDocuments.projectId, projectId)).all(),
    staff: db.select().from(s.staff).where(eq(s.staff.projectId, projectId)).all(),
    guests: db.select().from(s.guests).where(eq(s.guests.projectId, projectId)).all(),
    schedule: db.select().from(s.scheduleItems).where(eq(s.scheduleItems.projectId, projectId)).orderBy(s.scheduleItems.sortOrder).all(),
    recentMessages: db.select().from(s.messages).where(eq(s.messages.projectId, projectId)).orderBy(desc(s.messages.receivedAt)).limit(20).all(),
    pendingProposals: db.select().from(s.proposals).where(and(eq(s.proposals.projectId, projectId), inArray(s.proposals.decision, ["pending", "approved"]))).all(),
    rejectedProposals: db.select().from(s.proposals).where(and(eq(s.proposals.projectId, projectId), eq(s.proposals.decision, "rejected"))).all(),
    appliedProposals: db.select().from(s.proposals).where(and(eq(s.proposals.projectId, projectId), eq(s.proposals.decision, "applied"))).all(),
  };
}

export function contextSummary(ctx: ProjectContext): string {
  const lines: string[] = [];
  for (const [k, f] of Object.entries(ctx.facts)) lines.push(`${k} = ${JSON.stringify(f.value)} (${f.status}, v${f.version})`);
  for (const e of ctx.engagements) lines.push(`engagement ${e.service}: ${e.vendorName} quote=${e.quoteState} confirmation=${e.confirmationState} cancellation=${e.cancellationState}`);
  return lines.join("\n");
}

export function vocabulary(ctx: ProjectContext) {
  return {
    vendorNames: ctx.engagements.filter((e) => e.service !== "venue").map((e) => e.vendorName).concat(ctx.contacts.filter((c) => c.relationship === "vendor").map((c) => c.organization ?? c.name)),
    venueNames: ctx.engagements.filter((e) => e.service === "venue").map((e) => e.vendorName),
    staffNames: ctx.staff.map((m) => m.name),
  };
}

export function activeBudgetTotal(lines: s.BudgetLine[]): { totalCents: number; unknownCount: number } {
  let totalCents = 0;
  let unknownCount = 0;
  for (const l of lines) {
    if (!l.active) continue;
    if (l.subtotalCents === null) unknownCount++;
    else totalCents += l.subtotalCents + l.taxCents;
  }
  return { totalCents, unknownCount };
}
