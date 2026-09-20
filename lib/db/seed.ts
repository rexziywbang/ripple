import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { Db } from "./client";
import * as s from "./schema";
import { newId, hashContent, now } from "@/lib/domain/ids";
import type { StaffingPolicy } from "@/lib/domain/facts";

export const SAMPLE_PROJECT_ID = "proj_sample_christmas";

export const FIXTURE_ROOT = path.join(process.cwd(), "fixtures", "christmas-dinner");

const SAMPLE_FILES = [
  "01 Brief/brief.md",
  "02 Venue/garden-hall-quote.md",
  "02 Venue/marriott-room-proposal.md",
  "03 Vendors/shah-halal-agreement.md",
  "03 Vendors/contacts.csv",
  "04 Budget/budget.csv",
  "05 Guests/guest-list.csv",
  "06 Staff/staff-roster.csv",
  "06 Staff/schedule.csv",
  "07 Equipment/av-rental.md",
];

export function parseCsv(content: string): Record<string, string>[] {
  const lines = content.trim().split(/\r?\n/);
  const header = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row: Record<string, string> = {};
    header.forEach((h, i) => (row[h] = (cells[i] ?? "").trim()));
    return row;
  });
}

export function deleteProjectData(db: Db, projectId: string) {
  const t = db;
  const wfIds = t.select({ id: s.workflows.id }).from(s.workflows).where(eq(s.workflows.projectId, projectId)).all().map((w) => w.id);
  for (const id of wfIds) {
    t.delete(s.tasks).where(eq(s.tasks.workflowId, id)).run();
    t.delete(s.approvals).where(eq(s.approvals.proposalId, id)).run();
  }
  const propIds = t.select({ id: s.proposals.id }).from(s.proposals).where(eq(s.proposals.projectId, projectId)).all().map((p) => p.id);
  for (const id of propIds) t.delete(s.approvals).where(eq(s.approvals.proposalId, id)).run();
  t.delete(s.proposals).where(eq(s.proposals.projectId, projectId)).run();
  t.delete(s.workflows).where(eq(s.workflows.projectId, projectId)).run();
  t.delete(s.externalActions).where(eq(s.externalActions.projectId, projectId)).run();
  t.delete(s.messages).where(eq(s.messages.projectId, projectId)).run();
  t.delete(s.workflowEvents).where(eq(s.workflowEvents.projectId, projectId)).run();
  t.delete(s.projectFacts).where(eq(s.projectFacts.projectId, projectId)).run();
  t.delete(s.connections).where(eq(s.connections.projectId, projectId)).run();
  t.delete(s.sourceDocuments).where(eq(s.sourceDocuments.projectId, projectId)).run();
  t.delete(s.contacts).where(eq(s.contacts.projectId, projectId)).run();
  t.delete(s.vendorEngagements).where(eq(s.vendorEngagements.projectId, projectId)).run();
  t.delete(s.budgetLines).where(eq(s.budgetLines.projectId, projectId)).run();
  t.delete(s.guests).where(eq(s.guests.projectId, projectId)).run();
  t.delete(s.staff).where(eq(s.staff.projectId, projectId)).run();
  t.delete(s.scheduleItems).where(eq(s.scheduleItems.projectId, projectId)).run();
  t.delete(s.projects).where(eq(s.projects.id, projectId)).run();
  const jobRows = t.select().from(s.jobs).all();
  for (const j of jobRows) {
    if ((j.payload as { projectId?: string }).projectId === projectId) t.delete(s.jobs).where(eq(s.jobs.id, j.id)).run();
  }
}

export function seedSampleProject(db: Db, opts: { reset?: boolean } = {}) {
  const existing = db.select().from(s.projects).where(eq(s.projects.id, SAMPLE_PROJECT_ID)).get();
  if (existing && !opts.reset) return existing;
  db.transaction((tx) => {
    if (existing) deleteProjectData(tx, SAMPLE_PROJECT_ID);
    const t = now();
    const pid = SAMPLE_PROJECT_ID;
    tx.insert(s.projects)
      .values({
        id: pid,
        name: "Northwind Christmas Dinner",
        eventDate: "2026-12-18",
        eventTime: "18:00",
        timezone: "America/New_York",
        status: "active",
        revision: 1,
        isSample: true,
        folderPath: "/Christmas dinner",
        createdAt: t,
        updatedAt: t,
      })
      .run();

    const docIds: Record<string, string> = {};
    for (const rel of SAMPLE_FILES) {
      const content = fs.readFileSync(path.join(FIXTURE_ROOT, rel), "utf8");
      const id = newId("doc");
      docIds[path.basename(rel)] = id;
      tx.insert(s.sourceDocuments)
        .values({
          id,
          projectId: pid,
          provider: "demo",
          providerId: `demo:${rel}`,
          path: `/Christmas dinner/${rel}`,
          revision: "rev-seed-1",
          contentHash: hashContent(content),
          content,
          extractedFacts: {},
          kind: rel.startsWith("04") || rel.startsWith("06 Staff/schedule") ? "projection" : "source",
          syncedAt: t,
          updatedAt: t,
        })
        .run();
    }
    const doc = (name: string) => docIds[name];

    const staffingPolicy: StaffingPolicy = { perAttendees: 60, ratePerStaffCents: 30000, currency: "USD", label: "Sample policy from brief.md: 1 staff per 60 guests at $300" };

    const facts: Array<{ key: string; value: unknown; status?: s.FactStatus; refs?: s.FactSourceRef[] }> = [
      { key: "event.name", value: "Northwind Christmas Dinner", refs: [{ type: "document", id: doc("brief.md") }] },
      { key: "event.date", value: "2026-12-18", refs: [{ type: "document", id: doc("brief.md"), excerpt: "Date: Friday 18 December 2026" }] },
      { key: "event.time", value: "18:00", refs: [{ type: "document", id: doc("brief.md"), excerpt: "18:00 Doors and reception drinks" }] },
      { key: "event.timezone", value: "America/New_York", refs: [{ type: "document", id: doc("brief.md") }] },
      { key: "event.format", value: "seated_dinner", refs: [{ type: "document", id: doc("brief.md"), excerpt: "Format: Seated dinner with short awards programme" }] },
      { key: "venue.name", value: "Garden Hall, Riverside Conference Centre", refs: [{ type: "document", id: doc("garden-hall-quote.md") }] },
      { key: "venue.room", value: "Main Hall", refs: [{ type: "document", id: doc("garden-hall-quote.md"), excerpt: "Room: Main Hall" }] },
      { key: "venue.address", value: "14 Riverside Way, Springfield, EX 00000", refs: [{ type: "document", id: doc("garden-hall-quote.md") }] },
      { key: "venue.seated_capacity", value: 260, refs: [{ type: "document", id: doc("garden-hall-quote.md"), excerpt: "Seated capacity (round tables of 10): 260 guests" }] },
      { key: "venue.standing_capacity", value: 400, refs: [{ type: "document", id: doc("garden-hall-quote.md"), excerpt: "Standing reception capacity: 400 guests" }] },
      { key: "venue.availability", value: { confirmed: true, detail: "Held for Northwind on 18 Dec 2026 (sample quote GH-2026-1187)" }, refs: [{ type: "document", id: doc("garden-hall-quote.md") }] },
      { key: "venue.included_av", value: [], refs: [{ type: "document", id: doc("garden-hall-quote.md"), excerpt: "AV: not included; house sound system available for background music only" }] },
      { key: "venue.delivery_access", value: "Loading dock on Riverside Way from 14:00", refs: [{ type: "document", id: doc("garden-hall-quote.md") }] },
      { key: "attendance.expected", value: 240, refs: [{ type: "document", id: doc("brief.md"), excerpt: "Expected attendance: 240 guests" }] },
      { key: "guests.rsvp_accepted", value: 7, status: "tentative", refs: [{ type: "document", id: doc("guest-list.csv") }] },
      { key: "guests.dietary_vegetarian", value: 12, status: "tentative", refs: [{ type: "document", id: doc("brief.md"), excerpt: "12 vegetarian requests so far" }] },
      { key: "invitation.text", value: "Join us for the Northwind Christmas Dinner on Friday 18 December 2026 at Garden Hall, Riverside Conference Centre (14 Riverside Way). Doors 18:00, seated dinner 19:00. Halal menu; vegetarian option available.", refs: [{ type: "seed" }] },
      { key: "catering.vendor", value: "Shah Halal Catering", refs: [{ type: "document", id: doc("shah-halal-agreement.md") }] },
      { key: "catering.unit_cents", value: 2400, refs: [{ type: "document", id: doc("shah-halal-agreement.md"), excerpt: "Price: USD 24.00 per guest" }] },
      { key: "catering.dietary_options", value: ["halal", "vegetarian"], refs: [{ type: "document", id: doc("shah-halal-agreement.md"), excerpt: "vegetarian option available at no extra charge; vegan on request" }] },
      { key: "catering.service_start", value: "19:00", refs: [{ type: "document", id: doc("shah-halal-agreement.md"), excerpt: "dinner service from 19:00" }] },
      { key: "budget.ceiling_cents", value: 1800000, refs: [{ type: "document", id: doc("brief.md"), excerpt: "Total budget ceiling: USD 18,000" }] },
      { key: "staffing.policy", value: staffingPolicy, refs: [{ type: "document", id: doc("brief.md"), excerpt: "one event staff member per 60 attendees, rounded up, at USD 300 per staff member" }] },
      { key: "staffing.required", value: 4, refs: [{ type: "document", id: doc("brief.md") }] },
      { key: "staffing.available", value: 5, refs: [{ type: "document", id: doc("staff-roster.csv") }] },
      { key: "schedule.dinner_start", value: "19:00", refs: [{ type: "document", id: doc("schedule.csv"), excerpt: "19:00,Seated dinner served" }] },
      { key: "equipment.av_rental", value: ["projector and 12ft screen", "PA system with 2 speakers", "4 wireless microphones", "lectern", "technician (5h)"], refs: [{ type: "document", id: doc("av-rental.md") }] },
      { key: "equipment.av_vendor", value: "BrightStage AV Rentals", refs: [{ type: "document", id: doc("av-rental.md") }] },
      { key: "equipment.delivery_window", value: "15:00 delivery, setup complete by 17:00", refs: [{ type: "document", id: doc("av-rental.md") }] },
    ];
    for (const f of facts) {
      tx.insert(s.projectFacts)
        .values({ id: newId("fact"), projectId: pid, key: f.key, value: f.value, status: f.status ?? "confirmed", version: 1, sourceRefs: f.refs ?? [{ type: "seed" }], updatedAt: t })
        .run();
    }

    const contactRows = parseCsv(fs.readFileSync(path.join(FIXTURE_ROOT, "03 Vendors/contacts.csv"), "utf8"));
    const contactIds: Record<string, string> = {};
    for (const c of contactRows) {
      const id = newId("ct");
      contactIds[c.organization] = id;
      tx.insert(s.contacts)
        .values({
          id,
          projectId: pid,
          organization: c.organization,
          name: c.name,
          role: c.role,
          email: c.email,
          emailVerified: c.verified === "yes",
          relationship: c.relationship as "vendor" | "venue",
          isFixture: true,
        })
        .run();
    }

    const engagements = [
      {
        id: "eng_sample_shah",
        service: "catering",
        vendorName: "Shah Halal Catering",
        contactId: contactIds["Shah Halal Catering"],
        quoteState: "accepted" as const,
        confirmationState: "confirmed" as const,
        unitCents: 2400,
        quantity: 240,
        depositCents: 60000,
        depositRefundable: false,
        cancellationTerms: "Written notice required; deposit retained; no further fee if cancelled more than 30 days before the event",
        threadId: "thread_demo_shah_agreement",
        notes: "Signed agreement SH-CD-2026-09 (sample)",
      },
      {
        id: "eng_sample_cava",
        service: "catering",
        vendorName: "CAVA Springfield Catering",
        contactId: contactIds["CAVA Springfield Catering"],
        quoteState: "none" as const,
        confirmationState: "none" as const,
        unitCents: null,
        quantity: null,
        depositCents: null,
        depositRefundable: null,
        cancellationTerms: null,
        threadId: null,
        notes: "Verified sample contact; no quote yet",
      },
      {
        id: "eng_sample_gardenhall",
        service: "venue",
        vendorName: "Garden Hall, Riverside Conference Centre",
        contactId: contactIds["Garden Hall"],
        quoteState: "accepted" as const,
        confirmationState: "confirmed" as const,
        unitCents: 720000,
        quantity: 1,
        depositCents: 200000,
        depositRefundable: false,
        cancellationTerms: "Deposit non-refundable within 60 days of the event",
        threadId: "thread_demo_gardenhall",
        notes: "Quote GH-2026-1187 (sample)",
      },
      {
        id: "eng_sample_marriott",
        service: "venue",
        vendorName: "Marriott Springfield Downtown",
        contactId: contactIds["Marriott Springfield Downtown"],
        quoteState: "received" as const,
        confirmationState: "none" as const,
        unitCents: 800000,
        quantity: 1,
        depositCents: 250000,
        depositRefundable: true,
        cancellationTerms: "Deposit refundable until 30 days before the event",
        threadId: null,
        notes: "Proposal MSD-EV-4471 (sample) — Grand Ballroom, hold until 15 Oct 2026",
      },
      {
        id: "eng_sample_brightstage",
        service: "equipment",
        vendorName: "BrightStage AV Rentals",
        contactId: contactIds["BrightStage AV Rentals"],
        quoteState: "accepted" as const,
        confirmationState: "confirmed" as const,
        unitCents: 180000,
        quantity: 1,
        depositCents: 0,
        depositRefundable: true,
        cancellationTerms: "Free cancellation up to 14 days before the event; 50% fee thereafter",
        threadId: "thread_demo_brightstage",
        notes: "Quote BS-4410 (sample)",
      },
    ];
    for (const e of engagements) {
      tx.insert(s.vendorEngagements).values({ ...e, projectId: pid, cancellationState: "none", currency: "USD", feeCents: 0, quotes: [], version: 1, updatedAt: t }).run();
    }

    const lines = [
      { id: "bl_sample_venue", category: "venue", label: "Garden Hall Main Hall hire", quantity: 1, unitCents: 720000, subtotalCents: 720000, commitmentStatus: "committed" as const, engagementId: "eng_sample_gardenhall", provenance: [{ type: "document" as const, id: doc("garden-hall-quote.md"), excerpt: "Venue hire: USD 7,200.00" }] },
      { id: "bl_sample_catering", category: "catering", label: "Shah Halal seated dinner (includes $600 deposit)", quantity: 240, unitCents: 2400, subtotalCents: 576000, commitmentStatus: "committed" as const, engagementId: "eng_sample_shah", provenance: [{ type: "document" as const, id: doc("shah-halal-agreement.md"), excerpt: "USD 24.00 per guest · 240 guests · USD 5,760.00" }] },
      { id: "bl_sample_staff", category: "staff", label: "Event staff (sample policy: 1 per 60 guests)", quantity: 4, unitCents: 30000, subtotalCents: 120000, commitmentStatus: "estimate" as const, engagementId: null, provenance: [{ type: "document" as const, id: doc("brief.md"), excerpt: "one event staff member per 60 attendees ... USD 300" }] },
      { id: "bl_sample_av", category: "equipment", label: "BrightStage AV rental", quantity: 1, unitCents: 180000, subtotalCents: 180000, commitmentStatus: "committed" as const, engagementId: "eng_sample_brightstage", provenance: [{ type: "document" as const, id: doc("av-rental.md"), excerpt: "Price: USD 1,800.00" }] },
    ];
    for (const l of lines) {
      tx.insert(s.budgetLines).values({ ...l, projectId: pid, taxCents: 0, currency: "USD", active: true, version: 1, updatedAt: t }).run();
    }

    for (const g of parseCsv(fs.readFileSync(path.join(FIXTURE_ROOT, "05 Guests/guest-list.csv"), "utf8"))) {
      tx.insert(s.guests).values({ id: newId("g"), projectId: pid, name: g.name, email: g.email, rsvp: g.rsvp as "accepted", dietary: g.dietary || null }).run();
    }
    for (const m of parseCsv(fs.readFileSync(path.join(FIXTURE_ROOT, "06 Staff/staff-roster.csv"), "utf8"))) {
      tx.insert(s.staff).values({ id: newId("st"), projectId: pid, name: m.name, role: m.role, email: m.email, available: m.available === "yes", rateCents: Number(m.rate_usd) * 100 }).run();
    }
    parseCsv(fs.readFileSync(path.join(FIXTURE_ROOT, "06 Staff/schedule.csv"), "utf8")).forEach((row, i) => {
      tx.insert(s.scheduleItems).values({ id: newId("sch"), projectId: pid, title: row.item, startLocal: row.time, sortOrder: i, version: 1 }).run();
    });

    for (const provider of ["dropbox", "gmail", "invitations"] as const) {
      tx.insert(s.connections)
        .values({ id: newId("conn"), projectId: pid, provider, mode: "demo", status: "connected", config: provider === "dropbox" ? { folder: "/Christmas dinner" } : provider === "gmail" ? { address: "events@northwind.example" } : { provider: "Simulated invitations" }, updatedAt: t })
        .run();
    }

    tx.insert(s.workflowEvents)
      .values({ id: newId("ev"), projectId: pid, workflowId: null, seq: 1, type: "project.seeded", stage: null, message: "Sample event seeded from fixtures (all figures are sample data)", data: {}, createdAt: t })
      .run();
  });
  return db.select().from(s.projects).where(eq(s.projects.id, SAMPLE_PROJECT_ID)).get()!;
}

export function createBlankProject(
  db: Db,
  input: { name: string; eventDate: string; eventTime?: string; timezone: string; attendance: number; budgetCents: number; folderPath?: string },
) {
  const id = newId("proj");
  const t = now();
  db.transaction((tx) => {
    tx.insert(s.projects)
      .values({ id, name: input.name, eventDate: input.eventDate, eventTime: input.eventTime ?? null, timezone: input.timezone, status: "active", revision: 1, isSample: false, folderPath: input.folderPath ?? null, createdAt: t, updatedAt: t })
      .run();
    const facts: Array<{ key: string; value: unknown; status: s.FactStatus }> = [
      { key: "event.name", value: input.name, status: "confirmed" },
      { key: "event.date", value: input.eventDate, status: "confirmed" },
      { key: "event.time", value: input.eventTime ?? null, status: input.eventTime ? "confirmed" : "unknown" },
      { key: "event.timezone", value: input.timezone, status: "confirmed" },
      { key: "event.format", value: "seated_dinner", status: "tentative" },
      { key: "attendance.expected", value: input.attendance, status: "tentative" },
      { key: "budget.ceiling_cents", value: input.budgetCents, status: "confirmed" },
      { key: "venue.name", value: null, status: "unknown" },
      { key: "venue.seated_capacity", value: null, status: "unknown" },
      { key: "catering.vendor", value: null, status: "unknown" },
      { key: "staffing.policy", value: null, status: "unknown" },
    ];
    for (const f of facts) {
      tx.insert(s.projectFacts).values({ id: newId("fact"), projectId: id, key: f.key, value: f.value, status: f.status, version: 1, sourceRefs: [{ type: "user" }], updatedAt: t }).run();
    }
    for (const provider of ["dropbox", "gmail", "invitations"] as const) {
      tx.insert(s.connections).values({ id: newId("conn"), projectId: id, provider, mode: "demo", status: provider === "invitations" ? "connected" : "disconnected", config: {}, updatedAt: t }).run();
    }
    tx.insert(s.workflowEvents).values({ id: newId("ev"), projectId: id, workflowId: null, seq: 1, type: "project.created", stage: null, message: `Project "${input.name}" created`, data: {}, createdAt: t }).run();
  });
  return db.select().from(s.projects).where(eq(s.projects.id, id)).get()!;
}
