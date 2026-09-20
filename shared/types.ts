export type Area = 'venue'|'guests'|'catering'|'budget'|'staff'|'equipment'|'brief';
export type Facts = {
  attendance:number; date:string; time:string; timezone:string; format:string;
  venue:string; venueAddress:string; venueCapacity:number; venueCostCents:number; venueIncludesAV:boolean;
  venueDetailsPending?:boolean; venueCapacityPending?:boolean; venueAVPending?:boolean; venueCapacityEvidenceId?:string;
  caterer:string; cateringPerPersonCents:number; cateringDeliveryCents:number;
  cateringStatus:'confirmed'|'awaiting_quote'|'quoted'|'awaiting_confirmation';
  dietary:string; staffCount:number; staffCostEachCents:number; equipmentCostCents:number;
  budgetLimitCents:number; sunkCostCents:number; notes:string;
};
export type FactPatch = Partial<Facts> & {venueResearchId?:string};
export type VenueResearchEvidence = {
 researchId:string;name:string;address:string;eventFormat:string;checkedAt:string;sourceUrl:string;
 capacity?:{guests:number;room:string;layout:string;sourceUrl:string;excerpt:string}|null;
 av?:{included:boolean;room:string;items:string[];sourceUrl:string;excerpt:string}|null;
 roomLimit?:{guests:number;room:string;sourceUrl:string;excerpt:string}|null;
};
export type Source = {id:string;title:string;area:Area;path:string;content:string;venueEvidence?:VenueResearchEvidence;material?:{path:string;provenance:'user_selected'|'fictional_scenario';contentHash:string}};
export type PlanCard = {id:string;title:string;body:string;status:'pending'|'approved'|'denied';revision:number;revisionToken:string};
export type Proposal = {
  id:string; title:string; area:Area; description:string; before:string; after:string;
  costImpactCents:number|null; status:'pending'|'approved'|'denied'|'stale'|'applied'|'blocked'|'withdrawn';
  kind:'fact'|'email'|'file'|'invitation'|'warning'|'plan'; evidence:string[]; dependencies:string[];
  recipient?:string; subject?:string; body?:string; patch?:FactPatch; version:number; createdAt:string;
  originalRecipient?:string;
  approvalToken?:string; draftToken?:string;
  planCards?:PlanCard[];
  batchWithDependencies?:boolean;
  invitationSnapshot?:{name:string;date:string;time:string;timezone:string;venue:string;venueAddress:string;caterer:string;dietary:string;format:string};
  invitationSnapshotRevoked?:boolean;
  invitationNotifyGuests?:boolean;
  groupId?:string; groupTitle?:string;
};
export type Activity = {id:string;at:string;title:string;detail:string;status:'complete'|'working'|'waiting'|'attention'|'denied';changeId?:string;canUndo?:boolean;automatic?:boolean};
export type Receipt = {id:string;at:string;title:string;provider:string;status:'simulated'|'local'|'failed'|'delivered';detail:string;proposalId?:string;url?:string;externalId?:string};
export type Message = {id:string;at:string;from:string;subject:string;body:string;direction:'inbound'|'outbound';simulated:boolean;url?:string;externalId?:string};
export type Stage = {label:string;status:'pending'|'running'|'done'|'waiting'};
export type WorkflowTrigger = {area:Area;note?:string;changeId?:string;before:FactPatch;after:FactPatch};
export type Workflow = {id:string;status:'planning'|'review'|'waiting'|'complete'|'failed';summary:string;stages:Stage[];model?:string;error?:string;canRetry?:boolean;trigger?:WorkflowTrigger}|null;
export type ChangeImpact = {
 id:string;title:string;area:Area;before?:string;after?:string;note?:string;
 nodes:Array<{id:string;area:Area;label:string;detail:string;status:'checking'|'updated'|'review'|'waiting';proposalIds:string[]}>;
 edges:Array<{from:string;to:string}>;
};
export type Project = {id:string;name:string;revision:number;facts:Facts;createdAt:string};
export type CateringQuoteSummary = {
 status:'quoted'|'recorded';perPersonCents:number;deliveryCents:number;totalCents?:number;
 sourceId?:string;sourceTitle?:string;sourcePath?:string;provenance?:'document'|'received_email'|'simulation';simulated?:boolean;
 inquiry?:'draft'|'approved'|'sent';reviewNeeded?:boolean;
};
export type BudgetLine = {label:string;amountCents:number;status:string;detail:string};
export type AiStatus = {mode:'live'|'demo';model:string;fallbackModel:string;estimatedSpendUsd:number;spendLimitUsd:number;spendCapEnabled?:boolean;lastError?:string};
export type ProjectState = {
 project:Project;projects:Array<{id:string;name:string}>;budget:{totalCents:number;lines:BudgetLine[]};
 proposals:Proposal[];activity:Activity[];receipts:Receipt[];messages:Message[];sources:Source[];workflow:Workflow;
 connections:Array<{name:string;mode:'demo'|'live'|'unavailable';detail:string}>;ai:AiStatus;
 cateringQuote?:CateringQuoteSummary;
 impact?:ChangeImpact;
 emailDelivery?:{account:string;recipient:string;mode:'local_browser';pendingCount:number;configured?:boolean};
};
export type EditRequest = {area:Area;patch?:FactPatch;note?:string};
export type PlanResult = {patch:FactPatch;summary:string;questions:string[];evidenceIds:string[];insights?:Array<{title:string;detail:string;area:Area;evidenceIds:string[]}>;actions?:Array<{kind:'email'|'plan';title:string;reason:string;area:Area;evidenceIds:string[];body:string;subject:string|null;recipient:string|null}>;model?:string;error?:string};
export type Planner = (input:{note:string;area:Area;facts:Facts;sources:Source[];structuredOnly?:boolean;planPolish?:{title:string;body:string};cardRewrite?:{instruction:string;card:Pick<PlanCard,'title'|'body'>;otherCards:Array<Pick<PlanCard,'title'|'body'|'status'>>};existingDecisions?:Array<Pick<Proposal,'title'|'kind'|'status'|'area'|'description'|'body'>>;context?:{projectName:string;revision:number}&Pick<ProjectState,'budget'|'messages'|'activity'|'receipts'|'connections'|'workflow'>})=>Promise<PlanResult>;
