import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "@/lib/db/schema";
import { freshDb, request, proposalsOf, approveAll, fact, forecast, lines, inject, engagement, run, tasksOf, PID } from "./helpers";
import { getWorkflow, submitReview } from "@/lib/workflows/service";

describe("attendance changes", () => {
  it("240 → 300 finds the capacity limit, adjusts catering and staffing, and shows budget effects", async () => {
    const db = freshDb();
    const wf = await request(db, "Attendance is now 300 guests", "venue");
    expect(wf.status).toBe("ready_for_review");
    const props = proposalsOf(db, wf.id);
    const titles = props.map((p) => p.title);
    expect(titles.some((t) => /260/.test(t) && /capacity/i.test(t))).toBe(true);
    const staff = props.find((p) => p.target.type === "fact" && p.target.key === "staffing.required");
    expect((staff?.after as { value: number }).value).toBe(5);
    const catering = props.find((p) => p.kind === "budget_line" && /catering/i.test(p.area + p.title));
    expect(catering?.cost?.deltaCents).toBe(60 * 2400);
    const areas = new Set(props.filter((p) => p.decision === "pending").map((p) => p.area));
    expect(areas.has("catering")).toBe(true);
    expect(areas.has("staff")).toBe(true);
    expect(props.some((p) => p.area === "budget" && /forecast/i.test(p.title))).toBe(true);
  });

  it("reverting to 240 before applying withdraws the pending 300 proposals", async () => {
    const db = freshDb();
    const a = await request(db, "Attendance is now 300 guests", "guests");
    const b = await request(db, "Attendance back to 240", "guests");
    const aProps = proposalsOf(db, a.id).filter((p) => p.kind !== "check" && p.kind !== "wait");
    expect(aProps.length).toBeGreaterThan(0);
    expect(aProps.every((p) => p.decision === "withdrawn")).toBe(true);
    expect(getWorkflow(db, a.id)!.status).toBe("superseded");
    expect(b.status).toBe("completed");
  });

  it("applied 300 then 240 leaves history and proposes compensating changes", async () => {
    const db = freshDb();
    const a = await request(db, "Attendance is now 300 guests", "guests");
    await approveAll(db, a.id);
    expect(fact(db, "attendance.expected")!.value).toBe(300);
    expect(fact(db, "attendance.expected")!.version).toBe(2);
    expect(getWorkflow(db, a.id)!.status).toBe("completed");
    const b = await request(db, "Attendance back to 240", "guests");
    const props = proposalsOf(db, b.id);
    const att = props.find((p) => p.target.type === "fact" && p.target.key === "attendance.expected");
    expect((att?.after as { value: number }).value).toBe(240);
    const staff = props.find((p) => p.target.type === "fact" && p.target.key === "staffing.required");
    expect((staff?.after as { value: number }).value).toBe(4);
    expect(getWorkflow(db, a.id)!.status).toBe("completed");
  });

  it("a proposal approved after its fact moved is rejected as stale", async () => {
    const db = freshDb();
    const a = await request(db, "Attendance is now 300 guests", "guests");
    const b = await request(db, "Attendance is now 280 guests", "guests");
    await approveAll(db, b.id);
    // a's proposals were withdrawn by b; a fresh one against old versions must be stale too
    const c = await request(db, "Attendance is now 300 guests", "guests");
    const pending = proposalsOf(db, c.id).filter((p) => p.decision === "pending");
    // simulate a concurrent fact bump
    const f = fact(db, "attendance.expected")!;
    db.update(s.projectFacts).set({ version: f.version + 1, value: 290 }).where(eq(s.projectFacts.id, f.id)).run();
    submitReview(db, c.id, pending.map((p) => ({ proposalId: p.id, decision: "approve" as const })));
    await run(db);
    const after = proposalsOf(db, c.id);
    expect(after.some((p) => p.decision === "stale")).toBe(true);
    expect(fact(db, "attendance.expected")!.value).toBe(290);
    void a;
  });

  it("rejected proposals are suppressed until facts change", async () => {
    const db = freshDb();
    const a = await request(db, "Attendance is now 300 guests", "guests");
    await approveAll(db, a.id, (p) => p.kind === "staff_notice" || p.kind === "file");
    const b = await request(db, "Attendance is now 300 guests", "guests");
    expect(b.status).toBe("completed"); // nothing new to do
    const c = await request(db, "Attendance is now 320 guests", "guests");
    expect(proposalsOf(db, c.id).some((p) => p.decision === "pending")).toBe(true);
  });
});

describe("Shah Halal → CAVA", () => {
  it("runs the full asynchronous sequence with correct sunk-deposit accounting", async () => {
    const db = freshDb();
    expect(forecast(db)).toBe(1_596_000);
    const wf = await request(db, "Cancel catering from Shah Halal and contact CAVA instead.", "catering");
    expect(wf.status).toBe("ready_for_review");
    const props = proposalsOf(db, wf.id);
    const mails = props.filter((p) => p.kind === "email" && p.decision === "pending");
    expect(mails.map((m) => (m.target as { purpose: string }).purpose).sort()).toEqual(["cancellation", "quote_request"]);
    expect(props.some((p) => p.kind === "check" && /600/.test(p.title))).toBe(true);
    const cavaLine = props.find((p) => p.kind === "budget_line" && /CAVA/.test(p.title));
    expect(cavaLine?.cost?.status).toBe("unknown");

    await approveAll(db, wf.id);
    let w = getWorkflow(db, wf.id)!;
    expect(w.status).toBe("waiting_external");
    const sent = db.select().from(s.externalActions).where(eq(s.externalActions.workflowId, wf.id)).all();
    expect(sent.filter((a) => a.state === "sent")).toHaveLength(2);
    expect(engagement(db, "eng_sample_shah").cancellationState).toBe("requested");
    expect(engagement(db, "eng_sample_cava").quoteState).toBe("requested");
    // unknown cost is not zero: forecast total excludes it but reports unknown lines
    expect(lines(db).some((l) => l.subtotalCents === null)).toBe(true);

    // Shah acknowledges: balance released, 600 sunk
    const ack = inject(db, "shah-cancellation-ack");
    expect(ack.outcome).toBe("cancellation_confirmed");
    await run(db);
    const shahLine = lines(db).find((l) => l.engagementId === "eng_sample_shah")!;
    expect(shahLine.commitmentStatus).toBe("sunk");
    expect(shahLine.subtotalCents).toBe(60_000);

    // CAVA quote arrives
    const q = inject(db, "cava-quote");
    expect(q.outcome).toBe("quote_applied");
    await run(db);
    const cava = lines(db).find((l) => l.engagementId === "eng_sample_cava")!;
    expect(cava.subtotalCents).toBe(648_000);
    expect(cava.commitmentStatus).toBe("quoted");
    expect(forecast(db)).toBe(1_728_000);
    w = getWorkflow(db, wf.id)!;
    expect(w.status).toBe("ready_for_review");
    const accept = proposalsOf(db, wf.id).find((p) => p.kind === "email" && (p.target as { purpose: string }).purpose === "accept_quote" && p.decision === "pending");
    expect(accept).toBeTruthy();
    expect(proposalsOf(db, wf.id).some((p) => p.title === "Quote comparison")).toBe(true);

    await approveAll(db, wf.id);
    w = getWorkflow(db, wf.id)!;
    expect(w.status).toBe("waiting_external");
    expect(engagement(db, "eng_sample_cava").quoteState).toBe("accepted");

    // duplicate quote delivery is ignored
    const dup = inject(db, "cava-quote", { providerMessageId: "same-id" });
    const dup2 = inject(db, "cava-quote", { providerMessageId: "same-id" });
    expect(dup2.outcome).toBe("duplicate");
    void dup;

    // booking confirmation
    const c = inject(db, "cava-booking-confirmation");
    expect(c.outcome).toBe("booking_confirmed");
    await run(db);
    expect(engagement(db, "eng_sample_cava").confirmationState).toBe("confirmed");
    expect(fact(db, "catering.vendor")!.value).toBe("CAVA Springfield Catering");
    const staffNotice = tasksOf(db, wf.id).find((t) => t.title.startsWith("Tell event staff"));
    expect(staffNotice?.status).toBe("succeeded");
    w = getWorkflow(db, wf.id)!;
    expect(w.status).toBe("ready_for_review");
    const inv = proposalsOf(db, wf.id).find((p) => p.kind === "invitation" && p.decision === "pending");
    expect(inv).toBeTruthy();
    await approveAll(db, wf.id);
    w = getWorkflow(db, wf.id)!;
    expect(w.status).toBe("completed");
    expect(forecast(db)).toBe(1_728_000);
    expect(lines(db).find((l) => l.engagementId === "eng_sample_cava")!.commitmentStatus).toBe("committed");
    // no duplicate sends
    const acts = db.select().from(s.externalActions).where(eq(s.externalActions.workflowId, wf.id)).all();
    expect(new Set(acts.map((a) => a.idempotencyKey)).size).toBe(acts.length);
  });

  it("flags a mismatched quote instead of applying it", async () => {
    const db = freshDb();
    const wf = await request(db, "Cancel Shah Halal and get a quote from CAVA", "catering");
    await approveAll(db, wf.id);
    const before = forecast(db);
    const r = inject(db, "cava-mismatched-attendance");
    expect(r.outcome).toBe("quote_mismatch");
    expect(forecast(db)).toBe(before);
    expect(engagement(db, "eng_sample_cava").quoteState).toBe("requested");
    expect(proposalsOf(db, wf.id).some((p) => /requote/i.test(p.title) && p.decision === "pending")).toBe(true);
  });

  it("an older quote arriving after a newer one is recorded as superseded", async () => {
    const db = freshDb();
    const wf = await request(db, "Cancel Shah Halal and get a quote from CAVA", "catering");
    await approveAll(db, wf.id);
    inject(db, "cava-superseding-quote", { receivedAt: 2_000 });
    await run(db);
    expect(lines(db).find((l) => l.engagementId === "eng_sample_cava")!.subtotalCents).toBe(624_000);
    const r = inject(db, "cava-quote", { receivedAt: 1_000 });
    expect(r.outcome).toBe("quote_out_of_order");
    expect(lines(db).find((l) => l.engagementId === "eng_sample_cava")!.subtotalCents).toBe(624_000);
  });

  it("treats prompt-injection email as untrusted content", async () => {
    const db = freshDb();
    const ceiling = fact(db, "budget.ceiling_cents")!.value;
    const r = inject(db, "injection-email");
    expect(r.outcome).toBe("unmatched");
    expect(fact(db, "budget.ceiling_cents")!.value).toBe(ceiling);
    expect(db.select().from(s.externalActions).all()).toHaveLength(0);
    expect(db.select().from(s.messages).where(eq(s.messages.projectId, PID)).all().some((m) => m.processingResult?.outcome === "unmatched")).toBe(true);
  });
});
