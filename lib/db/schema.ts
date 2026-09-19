import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core";

const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();
const ts = (name: string) => integer(name).notNull();

export type FactStatus = "confirmed" | "tentative" | "unknown";
export type FactSourceRef = { type: "document" | "message" | "user" | "seed" | "workflow"; id?: string; excerpt?: string };

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  eventDate: text("event_date").notNull(),
  eventTime: text("event_time"),
  timezone: text("timezone").notNull(),
  status: text("status").notNull().default("active"),
  revision: integer("revision").notNull().default(1),
  isSample: integer("is_sample", { mode: "boolean" }).notNull().default(false),
  folderPath: text("folder_path"),
  createdAt: ts("created_at"),
  updatedAt: ts("updated_at"),
});

export const projectFacts = sqliteTable(
  "project_facts",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    key: text("key").notNull(),
    value: json<unknown>("value"),
    status: text("status").$type<FactStatus>().notNull().default("confirmed"),
    version: integer("version").notNull().default(1),
    sourceRefs: json<FactSourceRef[]>("source_refs").notNull().default([]),
    updatedAt: ts("updated_at"),
  },
  (t) => [uniqueIndex("facts_project_key").on(t.projectId, t.key)],
);

export const connections = sqliteTable(
  "connections",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    provider: text("provider").$type<"dropbox" | "gmail" | "invitations">().notNull(),
    mode: text("mode").$type<"demo" | "live">().notNull().default("demo"),
    status: text("status").$type<"connected" | "disconnected" | "error" | "unavailable">().notNull().default("connected"),
    config: json<Record<string, unknown>>("config").notNull().default({}),
    credentialsEnc: text("credentials_enc"),
    updatedAt: ts("updated_at"),
  },
  (t) => [uniqueIndex("connections_project_provider").on(t.projectId, t.provider)],
);

export const sourceDocuments = sqliteTable(
  "source_documents",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    provider: text("provider").notNull(),
    providerId: text("provider_id"),
    path: text("path").notNull(),
    revision: text("revision"),
    localRevision: integer("local_revision").notNull().default(1),
    syncedRevision: integer("synced_revision").notNull().default(1),
    contentHash: text("content_hash").notNull(),
    content: text("content").notNull(),
    extractedFacts: json<Record<string, unknown>>("extracted_facts").notNull().default({}),
    kind: text("kind").$type<"source" | "projection">().notNull().default("source"),
    supported: integer("supported", { mode: "boolean" }).notNull().default(true),
    syncedAt: integer("synced_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [uniqueIndex("docs_project_path").on(t.projectId, t.path)],
);

export const contacts = sqliteTable("contacts", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  organization: text("organization"),
  name: text("name").notNull(),
  role: text("role"),
  email: text("email"),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  relationship: text("relationship").$type<"vendor" | "staff" | "attendee" | "venue" | "other">().notNull(),
  isFixture: integer("is_fixture", { mode: "boolean" }).notNull().default(false),
});

export type QuoteSnapshot = {
  version: number;
  currency: string;
  quantity: number;
  unitCents: number;
  feeCents: number;
  taxCents: number | null;
  totalCents: number;
  expiresAt?: string;
  serviceDetails?: string;
  dietary?: string[];
  attendanceQuoted?: number;
  dateQuoted?: string;
  messageId?: string;
  receivedAt?: number;
  status: "received" | "accepted" | "superseded" | "mismatched";
  notes?: string;
};

export const vendorEngagements = sqliteTable("vendor_engagements", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  service: text("service").notNull(),
  vendorName: text("vendor_name").notNull(),
  contactId: text("contact_id"),
  quoteState: text("quote_state").$type<"none" | "requested" | "received" | "accepted" | "expired">().notNull().default("none"),
  confirmationState: text("confirmation_state").$type<"none" | "awaiting" | "confirmed" | "declined">().notNull().default("none"),
  cancellationState: text("cancellation_state").$type<"none" | "requested" | "confirmed" | "disputed">().notNull().default("none"),
  currency: text("currency").notNull().default("USD"),
  unitCents: integer("unit_cents"),
  quantity: integer("quantity"),
  feeCents: integer("fee_cents").notNull().default(0),
  depositCents: integer("deposit_cents"),
  depositRefundable: integer("deposit_refundable", { mode: "boolean" }),
  cancellationTerms: text("cancellation_terms"),
  quotes: json<QuoteSnapshot[]>("quotes").notNull().default([]),
  threadId: text("thread_id"),
  notes: text("notes"),
  version: integer("version").notNull().default(1),
  updatedAt: ts("updated_at"),
});

export type CommitmentStatus = "unknown" | "estimate" | "quoted" | "committed" | "sunk" | "released";

export const budgetLines = sqliteTable("budget_lines", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  category: text("category").notNull(),
  label: text("label").notNull(),
  quantity: integer("quantity").notNull().default(1),
  unitCents: integer("unit_cents"),
  subtotalCents: integer("subtotal_cents"),
  taxCents: integer("tax_cents").notNull().default(0),
  currency: text("currency").notNull().default("USD"),
  commitmentStatus: text("commitment_status").$type<CommitmentStatus>().notNull().default("estimate"),
  engagementId: text("engagement_id"),
  provenance: json<FactSourceRef[]>("provenance").notNull().default([]),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  version: integer("version").notNull().default(1),
  updatedAt: ts("updated_at"),
});

export const guests = sqliteTable("guests", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  name: text("name").notNull(),
  email: text("email"),
  rsvp: text("rsvp").$type<"invited" | "accepted" | "declined" | "pending">().notNull().default("pending"),
  dietary: text("dietary"),
});

export const staff = sqliteTable("staff", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  name: text("name").notNull(),
  role: text("role").notNull(),
  email: text("email"),
  available: integer("available", { mode: "boolean" }).notNull().default(true),
  rateCents: integer("rate_cents"),
});

export const scheduleItems = sqliteTable("schedule_items", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  title: text("title").notNull(),
  startLocal: text("start_local").notNull(),
  endLocal: text("end_local"),
  sortOrder: integer("sort_order").notNull().default(0),
  version: integer("version").notNull().default(1),
});

export type WorkflowStatus =
  | "planning"
  | "needs_input"
  | "ready_for_review"
  | "executing"
  | "waiting_external"
  | "partially_complete"
  | "completed"
  | "failed"
  | "superseded";

export type WorkflowStage = "understand" | "check_sources" | "follow_consequences" | "prepare_updates" | "review" | "apply" | "waiting" | "done";

export const workflows = sqliteTable("workflows", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  area: text("area").notNull(),
  request: text("request").notNull(),
  intent: json<unknown>("intent"),
  interpretationMode: text("interpretation_mode").$type<"llm" | "demo">().notNull().default("demo"),
  projectRevision: integer("project_revision").notNull(),
  status: text("status").$type<WorkflowStatus>().notNull().default("planning"),
  stage: text("stage").$type<WorkflowStage>().notNull().default("understand"),
  trigger: json<{ type: string; ref?: string; label?: string }>("trigger").notNull(),
  parentId: text("parent_id"),
  clarification: json<{ id: string; question: string; options?: string[] }[] | null>("clarification"),
  answers: json<Record<string, string>>("answers").notNull().default({}),
  summary: text("summary"),
  error: text("error"),
  createdAt: ts("created_at"),
  updatedAt: ts("updated_at"),
});

export type TaskStatus = "queued" | "running" | "waiting_approval" | "blocked" | "waiting_external" | "succeeded" | "failed" | "skipped" | "superseded";

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    stage: text("stage").$type<WorkflowStage>().notNull(),
    input: json<unknown>("input"),
    dependsOn: json<string[]>("depends_on").notNull().default([]),
    status: text("status").$type<TaskStatus>().notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    external: integer("external", { mode: "boolean" }).notNull().default(false),
    result: json<unknown>("result"),
    detail: text("detail"),
    sortOrder: integer("sort_order").notNull().default(0),
    updatedAt: ts("updated_at"),
  },
  (t) => [index("tasks_workflow").on(t.workflowId)],
);

export type ProposalDecision = "pending" | "approved" | "rejected" | "stale" | "withdrawn" | "applied";
export type CostEffect = { deltaCents: number | null; status: CommitmentStatus | "prospective"; label: string; currency: string };
export type EvidenceRef = { sourceType: "document" | "message" | "fact" | "policy" | "fixture"; ref: string; excerpt: string; label?: string };

export type ProposalTarget =
  | { type: "fact"; key: string }
  | { type: "budget_line"; lineId?: string; category: string }
  | { type: "engagement"; engagementId: string; field: string }
  | { type: "email"; to: { name: string; email: string }[]; subject: string; body: string; threadId?: string | null; engagementId?: string | null; purpose: string }
  | { type: "invitation"; audience: string; recipientCount: number; text: string }
  | { type: "staff_notice"; recipients: { name: string; email: string }[]; text: string }
  | { type: "file"; path: string; content: string }
  | { type: "schedule"; itemId?: string; title: string; startLocal: string; endLocal?: string }
  | { type: "staff"; staffId: string; field: string }
  | { type: "check"; note: string; severity?: "info" | "warning" };

export const proposals = sqliteTable(
  "proposals",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id").notNull(),
    projectId: text("project_id").notNull(),
    taskId: text("task_id"),
    area: text("area").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    target: json<ProposalTarget>("target").notNull(),
    before: json<unknown>("before"),
    after: json<unknown>("after"),
    rationale: text("rationale").notNull(),
    evidence: json<EvidenceRef[]>("evidence").notNull().default([]),
    factDeps: json<Record<string, number>>("fact_deps").notNull().default({}),
    docDeps: json<Record<string, string>>("doc_deps").notNull().default({}),
    cost: json<CostEffect | null>("cost"),
    requires: json<string[]>("requires").notNull().default([]),
    waitsFor: text("waits_for"),
    conditional: integer("conditional", { mode: "boolean" }).notNull().default(false),
    external: integer("external", { mode: "boolean" }).notNull().default(false),
    suppressionKey: text("suppression_key").notNull(),
    decision: text("decision").$type<ProposalDecision>().notNull().default("pending"),
    decisionReason: text("decision_reason"),
    appliedAt: integer("applied_at"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [index("proposals_workflow").on(t.workflowId), index("proposals_project").on(t.projectId)],
);

export const approvals = sqliteTable("approvals", {
  id: text("id").primaryKey(),
  proposalId: text("proposal_id").notNull(),
  approver: text("approver").notNull(),
  contentHash: text("content_hash").notNull(),
  factVersions: json<Record<string, number>>("fact_versions").notNull(),
  scope: json<{ projectId: string; actionTypes: string[]; recipients: string[]; costCeilingCents: number | null; conditional: boolean }>("scope").notNull(),
  createdAt: ts("created_at"),
});

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    engagementId: text("engagement_id"),
    threadId: text("thread_id"),
    provider: text("provider").notNull(),
    providerMessageId: text("provider_message_id").notNull(),
    direction: text("direction").$type<"inbound" | "outbound">().notNull(),
    fromAddress: text("from_address").notNull(),
    toAddresses: json<string[]>("to_addresses").notNull().default([]),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    receivedAt: ts("received_at"),
    dedupeKey: text("dedupe_key").notNull(),
    processed: integer("processed", { mode: "boolean" }).notNull().default(false),
    processingResult: json<{ outcome: string; detail: string; extracted?: unknown }>("processing_result"),
    simulated: integer("simulated", { mode: "boolean" }).notNull().default(true),
    fixtureLabel: text("fixture_label"),
  },
  (t) => [uniqueIndex("messages_dedupe").on(t.dedupeKey)],
);

export type ActionState = "pending" | "dispatching" | "uncertain" | "sent" | "failed" | "manual_pending" | "manual_done";

export const externalActions = sqliteTable(
  "external_actions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    workflowId: text("workflow_id").notNull(),
    proposalId: text("proposal_id").notNull(),
    provider: text("provider").notNull(),
    kind: text("kind").notNull(),
    payload: json<Record<string, unknown>>("payload").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    approvalId: text("approval_id"),
    state: text("state").$type<ActionState>().notNull().default("pending"),
    simulated: integer("simulated", { mode: "boolean" }).notNull().default(true),
    receipt: json<Record<string, unknown> | null>("receipt"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [uniqueIndex("actions_idem").on(t.idempotencyKey)],
);

export const workflowEvents = sqliteTable(
  "workflow_events",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    workflowId: text("workflow_id"),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    stage: text("stage"),
    message: text("message").notNull(),
    data: json<Record<string, unknown>>("data").notNull().default({}),
    createdAt: ts("created_at"),
  },
  (t) => [index("events_project_seq").on(t.projectId, t.seq)],
);

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "dead";

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    payload: json<Record<string, unknown>>("payload").notNull(),
    status: text("status").$type<JobStatus>().notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    runAt: ts("run_at"),
    leaseUntil: integer("lease_until"),
    leaseOwner: text("lease_owner"),
    idempotencyKey: text("idempotency_key").notNull(),
    lastError: text("last_error"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [uniqueIndex("jobs_idem").on(t.idempotencyKey), index("jobs_status_run").on(t.status, t.runAt)],
);

export const workerHeartbeats = sqliteTable("worker_heartbeats", {
  id: text("id").primaryKey(),
  lastSeen: ts("last_seen"),
  startedAt: ts("started_at"),
});

export type Project = typeof projects.$inferSelect;
export type ProjectFact = typeof projectFacts.$inferSelect;
export type Connection = typeof connections.$inferSelect;
export type SourceDocument = typeof sourceDocuments.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type VendorEngagement = typeof vendorEngagements.$inferSelect;
export type BudgetLine = typeof budgetLines.$inferSelect;
export type Guest = typeof guests.$inferSelect;
export type StaffMember = typeof staff.$inferSelect;
export type ScheduleItem = typeof scheduleItems.$inferSelect;
export type Workflow = typeof workflows.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type Proposal = typeof proposals.$inferSelect;
export type Approval = typeof approvals.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type ExternalAction = typeof externalActions.$inferSelect;
export type WorkflowEvent = typeof workflowEvents.$inferSelect;
export type Job = typeof jobs.$inferSelect;
