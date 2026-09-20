export type Area = 'venue'|'guests'|'catering'|'budget'|'staff'|'equipment'|'brief';
export type Facts = {
  attendance:number; date:string; time:string; timezone:string; format:string;
  venue:string; venueAddress:string; venueCapacity:number; venueCostCents:number; venueIncludesAV:boolean;
  caterer:string; cateringPerPersonCents:number; cateringDeliveryCents:number;
  cateringStatus:'confirmed'|'awaiting_quote'|'quoted'|'awaiting_confirmation';
  dietary:string; staffCount:number; staffCostEachCents:number; equipmentCostCents:number;
  budgetLimitCents:number; sunkCostCents:number; notes:string;
};
export type FactPatch = Partial<Facts>;
export type Source = {id:string;title:string;area:Area;path:string;content:string};
export type Proposal = {
  id:string; title:string; area:Area; description:string; before:string; after:string;
  costImpactCents:number|null; status:'pending'|'approved'|'denied'|'stale'|'applied'|'blocked'|'withdrawn';
  kind:'fact'|'email'|'file'|'invitation'|'warning'; evidence:string[]; dependencies:string[];
  recipient?:string; subject?:string; body?:string; patch?:FactPatch; version:number; createdAt:string;
};
export type Activity = {id:string;at:string;title:string;detail:string;status:'complete'|'working'|'waiting'|'attention'|'denied';changeId?:string;canUndo?:boolean};
export type Receipt = {id:string;at:string;title:string;provider:string;status:'simulated'|'local'|'failed';detail:string;proposalId?:string};
export type Message = {id:string;at:string;from:string;subject:string;body:string;direction:'inbound'|'outbound';simulated:boolean};
export type Stage = {label:string;status:'pending'|'running'|'done'|'waiting'};
export type Workflow = {id:string;status:'planning'|'review'|'waiting'|'complete'|'failed';summary:string;stages:Stage[];model?:string;error?:string}|null;
export type Project = {id:string;name:string;revision:number;facts:Facts;createdAt:string};
export type BudgetLine = {label:string;amountCents:number;status:string;detail:string};
export type AiStatus = {mode:'live'|'demo';model:string;fallbackModel:string;estimatedSpendUsd:number;spendLimitUsd:number;lastError?:string};
export type ProjectState = {
 project:Project;projects:Array<{id:string;name:string}>;budget:{totalCents:number;lines:BudgetLine[]};
 proposals:Proposal[];activity:Activity[];receipts:Receipt[];messages:Message[];sources:Source[];workflow:Workflow;
 connections:Array<{name:string;mode:'demo'|'live'|'unavailable';detail:string}>;ai:AiStatus;
};
export type EditRequest = {area:Area;patch?:FactPatch;note?:string};
export type PlanResult = {patch:FactPatch;summary:string;questions:string[];evidenceIds:string[];insights?:Array<{title:string;detail:string;area:Area;evidenceIds:string[]}>;model?:string;error?:string};
export type Planner = (input:{note:string;area:Area;facts:Facts;sources:Source[]})=>Promise<PlanResult>;
