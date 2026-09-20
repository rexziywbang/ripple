CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`proposal_id` text NOT NULL,
	`approver` text NOT NULL,
	`content_hash` text NOT NULL,
	`fact_versions` text NOT NULL,
	`scope` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `budget_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`category` text NOT NULL,
	`label` text NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`unit_cents` integer,
	`subtotal_cents` integer,
	`tax_cents` integer DEFAULT 0 NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`commitment_status` text DEFAULT 'estimate' NOT NULL,
	`engagement_id` text,
	`provenance` text DEFAULT '[]' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `connections` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`provider` text NOT NULL,
	`mode` text DEFAULT 'demo' NOT NULL,
	`status` text DEFAULT 'connected' NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`credentials_enc` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connections_project_provider` ON `connections` (`project_id`,`provider`);--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`organization` text,
	`name` text NOT NULL,
	`role` text,
	`email` text,
	`email_verified` integer DEFAULT false NOT NULL,
	`relationship` text NOT NULL,
	`is_fixture` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `external_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`proposal_id` text NOT NULL,
	`provider` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`approval_id` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`simulated` integer DEFAULT true NOT NULL,
	`receipt` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `actions_idem` ON `external_actions` (`idempotency_key`);--> statement-breakpoint
CREATE TABLE `guests` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`email` text,
	`rsvp` text DEFAULT 'pending' NOT NULL,
	`dietary` text
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 5 NOT NULL,
	`run_at` integer NOT NULL,
	`lease_until` integer,
	`lease_owner` text,
	`idempotency_key` text NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_idem` ON `jobs` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `jobs_status_run` ON `jobs` (`status`,`run_at`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`engagement_id` text,
	`thread_id` text,
	`provider` text NOT NULL,
	`provider_message_id` text NOT NULL,
	`direction` text NOT NULL,
	`from_address` text NOT NULL,
	`to_addresses` text DEFAULT '[]' NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`received_at` integer NOT NULL,
	`dedupe_key` text NOT NULL,
	`processed` integer DEFAULT false NOT NULL,
	`processing_result` text,
	`simulated` integer DEFAULT true NOT NULL,
	`fixture_label` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_dedupe` ON `messages` (`dedupe_key`);--> statement-breakpoint
CREATE TABLE `project_facts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text,
	`status` text DEFAULT 'confirmed' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`source_refs` text DEFAULT '[]' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `facts_project_key` ON `project_facts` (`project_id`,`key`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`event_date` text NOT NULL,
	`event_time` text,
	`timezone` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`is_sample` integer DEFAULT false NOT NULL,
	`folder_path` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`project_id` text NOT NULL,
	`task_id` text,
	`area` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`target` text NOT NULL,
	`before` text,
	`after` text,
	`rationale` text NOT NULL,
	`evidence` text DEFAULT '[]' NOT NULL,
	`fact_deps` text DEFAULT '{}' NOT NULL,
	`doc_deps` text DEFAULT '{}' NOT NULL,
	`cost` text,
	`requires` text DEFAULT '[]' NOT NULL,
	`waits_for` text,
	`conditional` integer DEFAULT false NOT NULL,
	`external` integer DEFAULT false NOT NULL,
	`suppression_key` text NOT NULL,
	`decision` text DEFAULT 'pending' NOT NULL,
	`decision_reason` text,
	`applied_at` integer,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `proposals_workflow` ON `proposals` (`workflow_id`);--> statement-breakpoint
CREATE INDEX `proposals_project` ON `proposals` (`project_id`);--> statement-breakpoint
CREATE TABLE `schedule_items` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`start_local` text NOT NULL,
	`end_local` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `source_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_id` text,
	`path` text NOT NULL,
	`revision` text,
	`local_revision` integer DEFAULT 1 NOT NULL,
	`synced_revision` integer DEFAULT 1 NOT NULL,
	`content_hash` text NOT NULL,
	`content` text NOT NULL,
	`extracted_facts` text DEFAULT '{}' NOT NULL,
	`kind` text DEFAULT 'source' NOT NULL,
	`supported` integer DEFAULT true NOT NULL,
	`synced_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `docs_project_path` ON `source_documents` (`project_id`,`path`);--> statement-breakpoint
CREATE TABLE `staff` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`email` text,
	`available` integer DEFAULT true NOT NULL,
	`rate_cents` integer
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`stage` text NOT NULL,
	`input` text,
	`depends_on` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`external` integer DEFAULT false NOT NULL,
	`result` text,
	`detail` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tasks_workflow` ON `tasks` (`workflow_id`);--> statement-breakpoint
CREATE TABLE `vendor_engagements` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`service` text NOT NULL,
	`vendor_name` text NOT NULL,
	`contact_id` text,
	`quote_state` text DEFAULT 'none' NOT NULL,
	`confirmation_state` text DEFAULT 'none' NOT NULL,
	`cancellation_state` text DEFAULT 'none' NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`unit_cents` integer,
	`quantity` integer,
	`fee_cents` integer DEFAULT 0 NOT NULL,
	`deposit_cents` integer,
	`deposit_refundable` integer,
	`cancellation_terms` text,
	`quotes` text DEFAULT '[]' NOT NULL,
	`thread_id` text,
	`notes` text,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `worker_heartbeats` (
	`id` text PRIMARY KEY NOT NULL,
	`last_seen` integer NOT NULL,
	`started_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workflow_events` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`workflow_id` text,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`stage` text,
	`message` text NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `events_project_seq` ON `workflow_events` (`project_id`,`seq`);--> statement-breakpoint
CREATE TABLE `workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`area` text NOT NULL,
	`request` text NOT NULL,
	`intent` text,
	`interpretation_mode` text DEFAULT 'demo' NOT NULL,
	`project_revision` integer NOT NULL,
	`status` text DEFAULT 'planning' NOT NULL,
	`stage` text DEFAULT 'understand' NOT NULL,
	`trigger` text NOT NULL,
	`parent_id` text,
	`clarification` text,
	`answers` text DEFAULT '{}' NOT NULL,
	`summary` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
