import type { AreaId } from "@/lib/domain/areas";
import type { CostEffect, EvidenceRef, ProposalTarget, WorkflowStage } from "@/lib/db/schema";

export type ProposalKind = "fact" | "budget_line" | "engagement" | "email" | "invitation" | "staff_notice" | "file" | "schedule" | "staff" | "check" | "wait";

export type ProposalDraft = {
  key: string;
  kind: ProposalKind;
  area: AreaId;
  title: string;
  target: ProposalTarget;
  before: unknown;
  after: unknown;
  rationale: string;
  evidence: EvidenceRef[];
  factDepKeys: string[];
  docDeps?: string[];
  cost: CostEffect | null;
  requires: string[];
  waitsFor?: string;
  conditional?: boolean;
  external: boolean;
  stage: WorkflowStage;
  /** informational check performed during planning; recorded as already applied */
  informational?: boolean;
  severity?: "info" | "warning";
  suppressionSalt?: string;
};

export type PlanQuestion = { id: string; question: string; options?: string[] };

export type PlanResult = {
  drafts: ProposalDraft[];
  questions: PlanQuestion[];
  notes: string[];
  changedFactKeys: string[];
  noChange: boolean;
};
