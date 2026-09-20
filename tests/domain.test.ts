import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService, fallbackPlan } from '../server/domain.js';
import type { AiStatus, Planner, ProjectState } from '../shared/types.js';

const aiStatus=():AiStatus=>({mode:'demo',model:'fixture',fallbackModel:'fixture',estimatedSpendUsd:0,spendLimitUsd:8});
const services:Array<ReturnType<typeof createService>>=[];
const dirs:string[]=[];
function setup(dbPath=':memory:',planner:Planner=async input=>fallbackPlan(input)){
  const service=createService({dbPath,planner,aiStatus});services.push(service);return service;
}
function proposal(s:ProjectState,title:string){const p=s.proposals.find(p=>p.title.includes(title)&&p.status==='pending');if(!p)throw new Error(`Missing pending proposal: ${title}`);return p;}
afterEach(()=>{for(const service of services.splice(0)){try{service.close();}catch{}}for(const dir of dirs.splice(0))rmSync(dir,{recursive:true});});

describe('Ripple consequence engine',()=>{
 it('does not spend a model call or create work for an unchanged field',async()=>{let calls=0;const api=setup(':memory:',async input=>{calls++;return fallbackPlan(input);});const initial=api.getState();api.edit(initial.project.id,{area:'guests',patch:{attendance:240}});await api.tick();expect(calls).toBe(0);expect(api.getState().workflow).toBeNull();expect(api.getState().activity).toEqual(initial.activity);});

 it('seeds the budget with deposit included exactly once',()=>{const s=setup().getState();expect(s.budget.totalCents).toBe(1596000);expect(s.project.facts.attendance).toBe(240);expect(s.project.facts.budgetLimitCents).toBe(1800000);});

 it('checks capacity, recalculates cost, and proposes staffing from a guest edit',async()=>{
  const api=setup();const projectId=api.getState().project.id;
  let s=api.edit(projectId,{area:'guests',patch:{attendance:300}});expect(s.project.facts.attendance).toBe(300);expect(s.workflow?.status).toBe('planning');
  await api.tick();s=api.getState();expect(s.budget.totalCents).toBe(1740000);expect(proposal(s,'40 seats short')).toBeTruthy();
  expect(s.proposals.filter(p=>p.kind==='file'&&p.area==='budget'&&p.status==='pending')).toHaveLength(1);
  const staffing=proposal(s,'Adjust staffing to 5');expect(staffing.costImpactCents).toBe(30000);
  api.decide(projectId,staffing.id,'approve');s=api.getState();expect(s.project.facts.staffCount).toBe(5);expect(s.budget.totalCents).toBe(1770000);
  api.decide(projectId,staffing.id,'approve');expect(api.getState().receipts.filter(r=>r.proposalId===staffing.id)).toHaveLength(1);
 });

 it('reverses a change and its approved local consequence while preserving unrelated edits',async()=>{
  const api=setup();const projectId=api.getState().project.id;
  const edited=api.edit(projectId,{area:'guests',patch:{attendance:300}});const changeId=edited.activity.find(a=>a.canUndo)!.changeId!;
  await api.tick();api.decide(projectId,proposal(api.getState(),'Adjust staffing to 5').id,'approve');
  api.edit(projectId,{area:'budget',patch:{budgetLimitCents:2000000}});await api.tick();
  const s=api.undo(projectId,changeId);expect(s.project.facts.attendance).toBe(240);expect(s.project.facts.staffCount).toBe(4);expect(s.project.facts.budgetLimitCents).toBe(2000000);expect(s.budget.totalCents).toBe(1596000);
  expect(s.proposals.filter(p=>p.status==='pending').some(p=>p.title.includes('300'))).toBe(false);
 });

 it('retains a denied suggestion through an unrelated edit',async()=>{
  const api=setup();const projectId=api.getState().project.id;api.edit(projectId,{area:'guests',patch:{attendance:300}});await api.tick();
  const staffing=proposal(api.getState(),'Adjust staffing to 5');api.decide(projectId,staffing.id,'deny');
  api.edit(projectId,{area:'brief',patch:{notes:'Awards will follow dinner.'}});await api.tick();
  expect(api.getState().proposals.find(p=>p.id===staffing.id)?.status).toBe('denied');
  expect(api.getState().proposals.filter(p=>p.title==='Adjust staffing to 5 people'&&p.status==='pending')).toHaveLength(0);
 });

 it('checks structured edits with the planner while keeping explicit values authoritative',async()=>{
  let called=0;const api=setup(':memory:',async request=>{called++;expect(request.note).toContain('already committed');expect(request.facts.attendance).toBe(280);return {patch:{attendance:999,venueCostCents:0},summary:'Check access',questions:[],evidenceIds:['venue-garden'],insights:[{title:'Confirm delivery access',detail:'Confirm catering delivery access with Garden Hall before service.',area:'venue',evidenceIds:['venue-garden']}]};});
  api.edit(api.getState().project.id,{area:'guests',patch:{attendance:280}});await api.tick();const s=api.getState();expect(called).toBe(1);expect(s.project.facts.attendance).toBe(280);expect(s.project.facts.venueCostCents).toBe(720000);expect(proposal(s,'Confirm delivery access').evidence).toEqual(['venue-garden']);
 });

 it('discards stale in-flight plans and respects a newer structured edit over an older note',async()=>{
  let release:()=>void=()=>{};let calls=0;const gate=new Promise<void>(resolve=>{release=resolve;});
  const api=setup(':memory:',async input=>{calls++;if(calls===1)await gate;return fallbackPlan(input);});const projectId=api.getState().project.id;
  api.edit(projectId,{area:'guests',note:'Change attendance to 300'});const oldTick=api.tick();
  api.edit(projectId,{area:'guests',patch:{attendance:250}});release();await oldTick;
  expect(api.getState().project.facts.attendance).toBe(250);await api.tick();const s=api.getState();expect(s.project.facts.attendance).toBe(250);expect(s.proposals.some(p=>p.title==='Venue is 40 seats short')).toBe(false);
 });

 it('keeps AV budget removal dependent on the cancellation action',async()=>{
  const api=setup();const projectId=api.getState().project.id;api.edit(projectId,{area:'venue',note:'Venue has changed to Marriott'});await api.tick();
  let s=api.getState();expect(s.project.facts.venueIncludesAV).toBe(true);expect(s.budget.totalCents).toBe(1676000);
  const removal=proposal(s,'Remove the duplicate AV cost');const cancellation=proposal(s,'Cancel the duplicate AV rental');
  expect(()=>api.decide(projectId,removal.id,'approve')).toThrow('prerequisite');
  api.decide(projectId,cancellation.id,'approve');await api.tick();api.decide(projectId,removal.id,'approve');s=api.getState();
  expect(s.budget.totalCents).toBe(1496000);expect(s.project.facts.equipmentCostCents).toBe(0);
 });

 it('waits for vendor replies, preserves commitments, and gates final communications on booking confirmation',async()=>{
  const api=setup();const projectId=api.getState().project.id;api.edit(projectId,{area:'catering',note:'Cancel Shah Halal and contact CAVA instead'});await api.tick();
  let s=api.getState();expect(s.project.facts.caterer).toBe('CAVA');expect(s.budget.totalCents).toBe(1596000);expect(()=>api.inject(projectId,'quote')).toThrow('quote request');
  api.decide(projectId,proposal(s,'Cancel Shah Halal').id,'approve');api.decide(projectId,proposal(s,'Request a quote from CAVA').id,'approve');await api.tick();await api.tick();
  expect(()=>api.inject(projectId,'confirmation')).toThrow('booking request');
  s=api.inject(projectId,'quote');expect(s.budget.totalCents).toBe(2244000);expect(s.project.facts.cateringStatus).toBe('quoted');expect(s.proposals.some(p=>p.title==='Tell staff about the confirmed meal')).toBe(false);
  s=api.inject(projectId,'cancellation');expect(s.budget.totalCents).toBe(1728000);expect(s.project.facts.sunkCostCents).toBe(60000);api.inject(projectId,'cancellation');expect(api.getState().budget.totalCents).toBe(1728000);
  const booking=proposal(s,'Request booking with CAVA');api.decide(projectId,booking.id,'approve');await api.tick();expect(api.getState().project.facts.cateringStatus).toBe('awaiting_confirmation');
  s=api.inject(projectId,'confirmation');expect(s.project.facts.cateringStatus).toBe('confirmed');expect(proposal(s,'Tell staff about the confirmed meal')).toBeTruthy();expect(proposal(s,'Update the confirmed meal in invitations')).toBeTruthy();
  const count=s.proposals.length;api.inject(projectId,'confirmation');expect(api.getState().proposals).toHaveLength(count);
  expect(s.receipts.every(r=>r.status==='local'||r.status==='simulated')).toBe(true);
 });

 it('treats stale replies as audit records without changing the forecast',async()=>{
  const api=setup();const projectId=api.getState().project.id;api.edit(projectId,{area:'catering',patch:{caterer:'CAVA'}});await api.tick();api.decide(projectId,proposal(api.getState(),'Request a quote from CAVA').id,'approve');await api.tick();
  const total=api.getState().budget.totalCents;const s=api.inject(projectId,'stale_quote');expect(s.budget.totalCents).toBe(total);expect(s.project.facts.cateringStatus).toBe('awaiting_quote');expect(s.activity[0].title).toBe('Older quote ignored');
 });

 it('keeps approvals idempotent across a process restart and records correction work on undo',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ripple-test-'));dirs.push(dir);const path=join(dir,'state.sqlite');
  let api=setup(path);const projectId=api.getState().project.id;const edit=api.edit(projectId,{area:'guests',patch:{attendance:300}});const changeId=edit.activity.find(a=>a.canUndo)!.changeId!;await api.tick();
  const email=proposal(api.getState(),'Confirm the new catering headcount');api.decide(projectId,email.id,'approve');api.close();services.splice(services.indexOf(api),1);
  api=setup(path);await api.tick();api.decide(projectId,email.id,'approve');await api.tick();expect(api.getState().receipts.filter(r=>r.proposalId===email.id)).toHaveLength(1);
  const s=api.undo(projectId,changeId);expect(s.receipts.some(r=>r.proposalId===email.id)).toBe(true);expect(proposal(s,'Correct the previous update')).toBeTruthy();
 });

 it.each([
  ['budget',{budgetLimitCents:1500000},'over budget'],['staff',{staffCount:3},'Confirm the staffing arrangement'],
  ['equipment',{equipmentCostCents:220000},'Confirm the equipment plan'],['brief',{date:'2026-12-12'},'Confirm venue availability'],
 ] as const)('checks consequences for %s edits',async(area,patch,title)=>{
  const api=setup();api.edit(api.getState().project.id,{area,patch});await api.tick();expect(proposal(api.getState(),title)).toBeTruthy();
 });

 it('creates independent projects and persists pending plans',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ripple-test-'));dirs.push(dir);const path=join(dir,'state.sqlite');let api=setup(path);const first=api.getState().project.id;
  const second=api.createProject('Leadership dinner').project.id;api.edit(second,{area:'guests',patch:{attendance:300}});api.close();services.splice(services.indexOf(api),1);api=setup(path);await api.tick();
  expect(api.getState(first).project.facts.attendance).toBe(240);expect(api.getState(second).project.facts.attendance).toBe(300);expect(proposal(api.getState(second),'40 seats short')).toBeTruthy();
 });

 it('writes the current budget total into the approved local budget document',async()=>{
  const api=setup();const projectId=api.getState().project.id;api.edit(projectId,{area:'guests',patch:{attendance:250}});await api.tick();
  const budgetFile=proposal(api.getState(),'Update budget details in Dropbox');api.decide(projectId,budgetFile.id,'approve');await api.tick();
  const s=api.getState();expect(s.sources.find(source=>source.id==='budget')?.content).toContain(`"totalCents": ${s.budget.totalCents}`);
 });
});
