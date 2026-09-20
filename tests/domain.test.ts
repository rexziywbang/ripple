import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createService, fallbackPlan } from '../server/domain.js';
import type { AiStatus, Planner, ProjectState } from '../shared/types.js';
import { createLiveBridge } from '../server/live-bridge.js';
import { syncInvitations } from '../server/invitation-sync.js';

const aiStatus=():AiStatus=>({mode:'demo',model:'fixture',fallbackModel:'fixture',estimatedSpendUsd:0,spendLimitUsd:8});
const services:Array<ReturnType<typeof createService>>=[];
const dirs:string[]=[];
const bridges:Array<ReturnType<typeof createLiveBridge>>=[];
function setup(dbPath=':memory:',planner:Planner=async input=>fallbackPlan(input)){
  const service=createService({dbPath,planner,aiStatus});services.push(service);return service;
}
function proposal(s:ProjectState,title:string){const p=s.proposals.find(p=>p.title.includes(title)&&p.status==='pending');if(!p)throw new Error(`Missing pending proposal: ${title}`);return p;}
afterEach(()=>{vi.useRealTimers();for(const service of services.splice(0)){try{service.close();}catch{}}for(const bridge of bridges.splice(0))bridge.close();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true});});
function setupLive(configure=true){
  const bridge=createLiveBridge({dbPath:':memory:'});bridges.push(bridge);
  const api=createService({dbPath:':memory:',planner:async input=>fallbackPlan(input),aiStatus,bridge});services.push(api);
  const projectId=api.getState().project.id;
  if(configure)bridge.configure(projectId,{emailAccount:'planner@gmail.com',testRecipient:'recipient@example.net'});
  return {api,bridge,projectId};
}
async function requestedLiveQuote(){
  const live=setupLive();live.api.edit(live.projectId,{area:'catering',patch:{caterer:'CAVA'}});await live.api.tick();
  const request=proposal(live.api.getState(),'Request a quote from CAVA');live.api.decide(live.projectId,request.id,'approve',request.approvalToken);await live.api.tick();
  const job=live.bridge.claimNext('quote-test-worker')!;live.bridge.complete(job.id,{detail:'Verified the quote request in Gmail Sent.'});await live.api.tick();return live;
}
function capturedQuote(overrides:Partial<{externalId:string;sender:string;vendor:string;date:string;guests:number;perPerson:string;delivery:string;total:string;body:string}>={}){
  const values={externalId:'gmail-quote-1',sender:'recipient@example.net',vendor:'CAVA',date:'2026-12-11',guests:240,perPerson:'31.75',delivery:'125.00',total:'7745.00',...overrides};
  return {externalId:values.externalId,sender:values.sender,subject:'Re: Christmas dinner: Request a quote from CAVA',receivedAt:new Date().toISOString(),body:values.body??`Vendor: ${values.vendor}\nEvent date: ${values.date}\nGuests: ${values.guests}\nPer person: USD ${values.perPerson}\nDelivery: USD ${values.delivery}\nQuoted total: USD ${values.total}`};
}

describe('Ripple consequence engine',()=>{
 it('checks only the latest explicit venue and budget after paused edits accumulate',async()=>{
  const seen:Array<{note:string;venue:string;limit:number}>=[];
  const api=setup(':memory:',async input=>{seen.push({note:input.note,venue:input.facts.venue,limit:input.facts.budgetLimitCents});return {patch:{},summary:'Checked current plan',questions:[],evidenceIds:[]};});
  const projectId=api.getState().project.id;
  api.edit(projectId,{area:'venue',patch:{venue:'Old ice rink'},note:'The venue changed to Old ice rink. Check its arrangements.'});
  api.edit(projectId,{area:'budget',note:'keep the total under 15000'});
  api.edit(projectId,{area:'venue',patch:{venue:'Boston Marriott Cambridge',venueAddress:'50 Broadway, Cambridge, MA'}});
  api.edit(projectId,{area:'budget',note:'under 12k is the budget'});
  await api.tick();
  expect(seen).toHaveLength(1);expect(seen[0].note).not.toContain('Old ice rink');
  expect(seen[0]).toMatchObject({venue:'Boston Marriott Cambridge',limit:1200000});
  expect(api.getState().project.facts).toMatchObject({venue:'Boston Marriott Cambridge',budgetLimitCents:1200000});
 });

 it('does not spend a model call or create work for an unchanged field',async()=>{let calls=0;const api=setup(':memory:',async input=>{calls++;return fallbackPlan(input);});const initial=api.getState();api.edit(initial.project.id,{area:'guests',patch:{attendance:240}});await api.tick();expect(calls).toBe(0);expect(api.getState().workflow).toBeNull();expect(api.getState().activity).toEqual(initial.activity);});

 it('seeds the budget with deposit included exactly once',()=>{const s=setup().getState();expect(s.budget.totalCents).toBe(1596000);expect(s.project.facts.attendance).toBe(240);expect(s.project.facts.budgetLimitCents).toBe(1800000);});

 it('checks capacity, recalculates cost, and proposes staffing from a guest edit',async()=>{
  const api=setup();const projectId=api.getState().project.id;
  let s=api.edit(projectId,{area:'guests',patch:{attendance:300}});expect(s.project.facts.attendance).toBe(300);expect(s.workflow?.status).toBe('planning');
  await api.tick();s=api.getState();expect(s.budget.totalCents).toBe(1740000);expect(proposal(s,'40 seats short')).toBeTruthy();
  expect(s.proposals.filter(p=>p.kind==='file'&&p.area==='budget'&&p.status==='pending')).toHaveLength(0);
  expect(s.proposals.filter(p=>p.kind==='file'&&p.area==='budget'&&p.status==='applied')).toHaveLength(1);
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

 it('publishes and processes basic decisions while optional model checking is still waiting',async()=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  const api=setup(':memory:',async input=>{await gate;return fallbackPlan(input);});const projectId=api.getState().project.id;
  api.edit(projectId,{area:'guests',patch:{attendance:300}});const inFlight=api.tick();
  const ready=api.getState();expect(ready.workflow?.status).toBe('review');expect(ready.budget.totalCents).toBe(1740000);
  expect(ready.sources.find(source=>source.id==='record:budget')?.content).toContain('Current forecast: $17,400.00');
  const displayed=ready.proposals.filter(p=>p.status==='pending'&&['fact','email'].includes(p.kind));expect(displayed).toHaveLength(3);
  api.decideMany(projectId,displayed.map(p=>p.id),'approve');await api.tick();await api.tick();
  expect(api.getState().messages).toHaveLength(2);expect(api.getState().project.facts.staffCount).toBe(5);
  release();await inFlight;
  expect(api.getState().messages).toHaveLength(2);expect(api.getState().proposals.some(p=>p.kind==='email'&&p.status==='pending')).toBe(false);
 });

 it('keeps basic updates on model failure and retries the same request without duplicate changes or revived denials',async()=>{
  let calls=0;const api=setup(':memory:',async input=>{if(++calls===1)throw new Error('Optional model spend limit reached.');return fallbackPlan(input);});
  const projectId=api.getState().project.id;api.edit(projectId,{area:'guests',patch:{attendance:300}});await api.tick();
  const failed=api.getState();expect(failed.workflow).toMatchObject({status:'review',canRetry:true});expect(proposal(failed,'40 seats short')).toBeTruthy();
  const staffing=proposal(failed,'Adjust staffing to 5');api.decide(projectId,staffing.id,'deny');
  const beforeRetry=api.getState();const first=api.retryPlanning(projectId);const second=api.retryPlanning(projectId);expect(second.workflow?.id).toBe(first.workflow?.id);
  await api.tick();await api.tick();const done=api.getState();
  expect(calls).toBe(2);expect(done.project.revision).toBe(beforeRetry.project.revision);expect(done.receipts).toEqual(beforeRetry.receipts);
  expect(done.proposals.find(p=>p.id===staffing.id)?.status).toBe('denied');expect(done.workflow?.canRetry).toBe(false);expect(done.messages).toHaveLength(0);
  expect(done.activity.filter(item=>item.canUndo)).toHaveLength(1);
 });

 it('finishes saved-field checks at the local AI cap, preserves approvals, and resumes AI when available',async()=>{
  const budgetError='AI checks are paused by Ripple’s $8.00 local budget. Recorded usage: $2.05; unconfirmed requests: up to $5.40. Your edits are saved. This is not your OpenAI account balance.';
  let paused=true;let calls=0;
  const api=setup(':memory:',async()=>{calls++;return paused?{patch:{attendance:999},summary:'Paused',questions:[],evidenceIds:[],error:budgetError}:{patch:{},summary:'Checked access',questions:[],evidenceIds:['venue-garden'],model:'live-test',insights:[{title:'Confirm delivery access',detail:'Check supplier access before dinner.',area:'venue',evidenceIds:['venue-garden']}]};});
  const projectId=api.getState().project.id;
  api.edit(projectId,{area:'guests',patch:{attendance:300}});await api.tick();
  const ready=api.getState();expect(ready.project.facts.attendance).toBe(300);expect(ready.budget.totalCents).toBe(1740000);
  expect(ready.workflow).toMatchObject({status:'review',canRetry:false,model:'Source-backed planning rules',error:budgetError,summary:'Saved details checked. Optional AI review is paused.'});
  expect(proposal(ready,'Adjust staffing to 5')).toBeTruthy();expect(proposal(ready,'catering')).toBeTruthy();expect(ready.messages).toEqual([]);
  expect(ready.activity.find(item=>item.title==='Optional AI checks paused')?.detail).toContain(budgetError);
  const staffing=proposal(ready,'Adjust staffing to 5');api.decide(projectId,staffing.id,'deny');
  api.edit(projectId,{area:'budget',patch:{budgetLimitCents:1900000}});await api.tick();
  expect(api.getState().proposals.find(p=>p.id===staffing.id)?.status).toBe('denied');
  expect(api.getState().activity.filter(item=>item.title==='Optional AI checks paused')).toHaveLength(1);
  paused=false;api.edit(projectId,{area:'guests',patch:{attendance:280}});await api.tick();
  expect(calls).toBe(3);expect(api.getState().workflow?.model).toBe('live-test');expect(proposal(api.getState(),'Confirm delivery access')).toBeTruthy();expect(api.getState().messages).toEqual([]);
 });

 it('does not treat an uninterpreted note as completed when the AI budget is paused',async()=>{
  const error='AI checks are paused by Ripple’s $8.00 local budget. Your edits are saved.';
  const api=setup(':memory:',async()=>({patch:{},summary:'Paused',questions:[],evidenceIds:[],error}));
  const original=api.getState();api.edit(original.project.id,{area:'guests',note:'We need a smaller invitation list; prioritize the leadership group.'});await api.tick();
  const state=api.getState();expect(state.project.facts).toEqual(original.project.facts);expect(state.workflow).toMatchObject({status:'failed',canRetry:true,error});expect(state.messages).toEqual([]);
 });

 it.each(['100','100 people','100 guests','attendance is now 100','change guest count to 100','Please set the headcount to 100.'])('commits the precise guest note %s before optional AI checking',async note=>{
  const error='AI checks are paused by Ripple’s $8.00 local budget. Your edits are saved.';
  const api=setup(':memory:',async input=>{expect(input.structuredOnly).toBe(true);expect(input.facts.attendance).toBe(100);return {patch:{},summary:'Paused',questions:[],evidenceIds:[],error};});
  const before=api.getState();const saved=api.edit(before.project.id,{area:'guests',note});expect(saved.project.facts.attendance).toBe(100);
  await api.tick();const ready=api.getState();
  expect(ready.budget.totalCents).toBe(1260000);expect(ready.workflow).toMatchObject({status:'review',canRetry:false,error});
  expect(ready.workflow?.stages.every(stage=>stage.status==='done')).toBe(true);expect(proposal(ready,'Adjust staffing to 2')).toBeTruthy();
  expect(proposal(ready,'catering').body).toContain('100');expect(ready.messages).toEqual([]);
  const undone=api.undo(before.project.id,saved.activity.find(item=>item.canUndo)!.changeId!);expect(undone.project.facts.attendance).toBe(before.project.facts.attendance);
 });

 it.each(['100 people on December 11','100 guests at $25 each','not 100 people','maybe 100 guests','100–150 guests','100 people, cancel the caterer','100.5 people','1,00 guests','attendance is now 2026-12-11'])('leaves complex or ambiguous guest note %s for interpretation',async note=>{
  const error='AI checks are paused by Ripple’s $8.00 local budget. Your edits are saved.';
  const api=setup(':memory:',async input=>{expect(input.structuredOnly).toBe(false);return {patch:{},summary:'Paused',questions:[],evidenceIds:[],error};});
  const before=api.getState();expect(api.edit(before.project.id,{area:'guests',note}).project.facts).toEqual(before.project.facts);await api.tick();
  expect(api.getState().workflow).toMatchObject({status:'failed',canRetry:true,error});expect(api.getState().project.facts).toEqual(before.project.facts);
 });

 it.each([false,true])('recovers a persisted precise guest note without overriding a later field edit (%s)',async newerEdit=>{
  const dir=mkdtempSync(join(tmpdir(),'ripple-legacy-guests-'));dirs.push(dir);const dbPath=join(dir,'event.sqlite');
  const initial=setup(dbPath);const projectId=initial.getState().project.id;initial.close();
  const db=new DatabaseSync(dbPath);const row=db.prepare('SELECT state FROM projects WHERE id=?').get(projectId) as {state:string};const persisted=JSON.parse(row.state);
  persisted.requests=[{area:'guests',note:'100 people'}];persisted.state.workflow={id:'old-check',status:'failed',summary:'Needs attention',stages:[],canRetry:true,error:'AI checks are paused by Ripple’s $8.00 local budget.'};
  db.prepare('UPDATE projects SET state=? WHERE id=?').run(JSON.stringify(persisted),projectId);db.close();
  const resumed=setup(dbPath,async()=>({patch:{},summary:'Paused',questions:[],evidenceIds:[],error:'AI checks are paused by Ripple’s $8.00 local budget.'}));
  if(newerEdit)resumed.edit(projectId,{area:'guests',patch:{attendance:280}});else resumed.retryPlanning(projectId);
  await resumed.tick();const ready=resumed.getState();expect(ready.project.facts.attendance).toBe(newerEdit?280:100);expect(ready.workflow).toMatchObject({status:'review',canRetry:false});expect(ready.messages).toEqual([]);
 });

 it.each(['were now expecting 120 people','we’re now expecting 120 people',"we're now expecting 120 guests",'we are now expecting 120 attendees'])('saves the precise expected attendance %s immediately',async note=>{
  const api=setup();const original=api.getState();const saved=api.edit(original.project.id,{area:'guests',note});expect(saved.project.facts.attendance).toBe(120);
  await api.tick();expect(api.getState().project.facts.attendance).toBe(120);expect(api.getState().messages).toEqual([]);
 });

 it.each([
  ['12k',1200000],['$12k',1200000],['12,000',1200000],['new budget is 12k',1200000],['under 12k is the budget',1200000],
  ['keep the total under 15000',1500000],['keep the total under 10k',1000000],['Please set the budget limit to $12,500.',1250000],['budget is 12.5k',1250000],['budget is $12,000.50',1200050],
 ] as const)('saves the precise budget limit %s without changing the forecast',async(note,cents)=>{
  const error='AI checks are paused by Ripple’s $8.00 local budget. Your edits are saved.';
  const api=setup(':memory:',async input=>{expect(input.structuredOnly).toBe(true);return {patch:{},summary:'Paused',questions:[],evidenceIds:[],error};});
  const original=api.getState();const saved=api.edit(original.project.id,{area:'budget',note});expect(saved.project.facts.budgetLimitCents).toBe(cents);expect(saved.budget.totalCents).toBe(original.budget.totalCents);
  await api.tick();const ready=api.getState();expect(ready.project.facts.budgetLimitCents).toBe(cents);expect(ready.workflow?.canRetry).toBe(false);expect(proposal(ready,'over budget')).toBeTruthy();expect(ready.messages).toEqual([]);
  expect(api.undo(original.project.id,saved.activity.find(item=>item.canUndo)!.changeId!).project.facts.budgetLimitCents).toBe(original.project.facts.budgetLimitCents);
 });

 it.each(['we spent 12k','the venue quote is 12k','budget could be 12k or 15k','budget is not 12k','budget is 12k if 100 guests attend','budget is $12,00','budget is 2026-12-11','keep the total under 12k and cancel catering','the vendor said "budget is 12k"'])('leaves ambiguous budget note %s for the planner',async note=>{
  const error='AI checks are paused by Ripple’s $8.00 local budget. Your edits are saved.';
  const api=setup(':memory:',async input=>{expect(input.structuredOnly).toBe(false);return {patch:{},summary:'Paused',questions:[],evidenceIds:[],error};});
  const original=api.getState();expect(api.edit(original.project.id,{area:'budget',note}).project.facts).toEqual(original.project.facts);await api.tick();expect(api.getState().workflow).toMatchObject({status:'failed',canRetry:true,error});
 });

 it.each([false,true])('recovers the latest persisted budget note while preserving newer values and guest edits (%s)',async newerEdit=>{
  const dir=mkdtempSync(join(tmpdir(),'ripple-legacy-budget-'));dirs.push(dir);const dbPath=join(dir,'event.sqlite');
  const initial=setup(dbPath);const projectId=initial.getState().project.id;initial.close();
  const db=new DatabaseSync(dbPath);const row=db.prepare('SELECT state FROM projects WHERE id=?').get(projectId) as {state:string};const persisted=JSON.parse(row.state);
  persisted.requests=[{area:'budget',note:'keep the total under 15000'},{area:'budget',note:'keep the total under 10k'},{area:'budget',note:'under 12k is the budget'},{area:'guests',note:'were now expecting 120 people'}];
  persisted.state.workflow={id:'old-budget-check',status:'failed',summary:'Needs attention',stages:[],canRetry:true,error:'AI checks are paused by Ripple’s $8.00 local budget.'};
  db.prepare('UPDATE projects SET state=? WHERE id=?').run(JSON.stringify(persisted),projectId);db.close();
  const resumed=setup(dbPath,async()=>({patch:{},summary:'Paused',questions:[],evidenceIds:[],error:'AI checks are paused by Ripple’s $8.00 local budget.'}));
  if(newerEdit)resumed.edit(projectId,{area:'budget',patch:{budgetLimitCents:1400000}});else resumed.retryPlanning(projectId);
  await resumed.tick();const ready=resumed.getState();expect(ready.project.facts).toMatchObject({budgetLimitCents:newerEdit?1400000:1200000,attendance:120});expect(ready.workflow?.canRetry).toBe(false);expect(ready.messages).toEqual([]);
 });

 it('publishes newer structured consequences without starting overlapping model calls',async()=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let calls=0;
  const api=setup(':memory:',async input=>{if(++calls===1)await gate;return fallbackPlan(input);});const projectId=api.getState().project.id;
  api.edit(projectId,{area:'guests',patch:{attendance:300}});const older=api.tick();const oldWarning=proposal(api.getState(),'40 seats short');
  api.edit(projectId,{area:'guests',patch:{attendance:280}});await api.tick();
  expect(calls).toBe(1);expect(proposal(api.getState(),'20 seats short')).toBeTruthy();expect(api.getState().proposals.find(p=>p.id===oldWarning.id)?.status).toBe('stale');
  release();await older;await api.tick();expect(calls).toBe(2);expect(api.getState().project.facts.attendance).toBe(280);
 });

 it('does not replay saved fields over a local correction approved while the model waits',async()=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  const api=setup(':memory:',async input=>{await gate;return fallbackPlan(input);});const projectId=api.getState().project.id;
  api.edit(projectId,{area:'guests',patch:{attendance:300}});const inFlight=api.tick();
  api.decide(projectId,proposal(api.getState(),'Adjust staffing to 5').id,'approve');expect(api.getState().project.facts.staffCount).toBe(5);
  release();await inFlight;expect(api.getState().project.facts.staffCount).toBe(5);
 });

 it('derives the known included-AV cancellation path even when optional enrichment fails',async()=>{
  const api=setup(':memory:',async()=>{throw new Error('Model unavailable.');});const projectId=api.getState().project.id;
  api.edit(projectId,{area:'venue',patch:{venue:'Marriott Downtown · Grand Ballroom',venueAddress:'500 Harbor Street, Boston, MA (demo)',venueCapacity:360,venueCostCents:800000,venueIncludesAV:true},note:'Check the venue proposal for additional details.'});await api.tick();
  const ready=api.getState();const cancellation=proposal(ready,'Cancel the duplicate AV rental');const removal=proposal(ready,'Remove the duplicate AV cost');
  expect(removal.dependencies).toEqual([cancellation.id]);expect(ready.project.facts.equipmentCostCents).toBe(180000);expect(ready.workflow?.canRetry).toBe(true);
  expect(()=>api.decide(projectId,removal.id,'approve')).toThrow('prerequisite');
 });

 it('does not resolve a real Marriott name to the fictional room in the fallback planner',()=>{
  const state=setup().getState();const result=fallbackPlan({note:'Change venue to Boston Marriott Cambridge',area:'venue',facts:state.project.facts,sources:state.sources});
  expect(result.patch).toEqual({});expect(result.questions.length).toBeGreaterThan(0);
  expect(fallbackPlan({note:'Move the event to Marriott Downtown Grand Ballroom',area:'venue',facts:state.project.facts,sources:state.sources}).patch).toMatchObject({venue:'Marriott Downtown · Grand Ballroom',venueIncludesAV:true});
 });

 it('keeps selected real venue details pending and rejects unrelated fixture enrichment',async()=>{
  const api=setup(':memory:',async()=>({patch:{venue:'Marriott Downtown · Grand Ballroom',venueAddress:'500 Harbor Street, Boston, MA (demo)',venueCapacity:360,venueCostCents:800000,venueIncludesAV:true},summary:'Venue',questions:[],evidenceIds:['venue-marriott']}));
  const projectId=api.getState().project.id;
  api.edit(projectId,{area:'venue',patch:{venue:'Boston Marriott Cambridge',venueAddress:'50 Broadway, Cambridge, MA 02142'},note:'Check the selected venue details.'});await api.tick();
  api.edit(projectId,{area:'guests',patch:{attendance:300}});await api.tick();const state=api.getState();
  expect(state.project.facts).toMatchObject({venue:'Boston Marriott Cambridge',venueAddress:'50 Broadway, Cambridge, MA 02142',venueCostCents:720000,venueCapacity:260,venueIncludesAV:false,venueDetailsPending:true});
  expect(state.budget.lines[0]).toMatchObject({status:'carried estimate',amountCents:720000});
  expect(state.proposals.some(p=>p.status==='pending'&&/seats short|duplicate AV/i.test(p.title))).toBe(false);
  expect(state.budget.lines.find(line=>line.label==='Equipment')?.detail).not.toContain('House AV is included');
 });

 it('clears the old address and requires real-venue AV terms rather than applying fixture cancellation terms',async()=>{
  const api=setup();const projectId=api.getState().project.id;
  api.edit(projectId,{area:'venue',patch:{venue:'The Charles Hotel'}});await api.tick();
  expect(api.getState().project.facts.venueAddress).toBe('');expect(api.getState().project.facts.venueDetailsPending).toBe(true);
  api.edit(projectId,{area:'venue',patch:{venueCapacity:320,venueCostCents:900000,venueIncludesAV:true}});await api.tick();
  const state=api.getState();expect(state.project.facts.venueDetailsPending).toBe(false);
  expect(proposal(state,'Check AV scope')).toBeTruthy();expect(state.proposals.some(p=>p.status==='pending'&&p.title==='Cancel the duplicate AV rental')).toBe(false);
  expect(state.project.facts.equipmentCostCents).toBe(180000);
 });

 it('treats known canonical vendor aliases as a name correction without cancellation or a replacement quote',async()=>{
  const api=setup();const projectId=api.getState().project.id;
  api.edit(projectId,{area:'catering',patch:{caterer:"Shah's Halal Food — Boston (Cambridge Street)"}});await api.tick();
  let state=api.getState();expect(state.project.facts.cateringStatus).toBe('confirmed');expect(state.proposals.some(p=>p.kind==='email'&&p.status==='pending')).toBe(false);
  api.edit(projectId,{area:'catering',patch:{caterer:'CAVA'}});await api.tick();
  const pendingQuote=proposal(api.getState(),'Request a quote from CAVA');
  api.edit(projectId,{area:'catering',patch:{caterer:'CAVA — Harvard Square'}});await api.tick();state=api.getState();
  expect(state.proposals.filter(p=>p.status==='pending'&&p.title.startsWith('Request a quote'))).toHaveLength(1);expect(state.proposals.find(p=>p.id===pendingQuote.id)?.status).toBe('pending');
  api.edit(projectId,{area:'catering',patch:{caterer:'CAVA — Seaport'}});await api.tick();expect(proposal(api.getState(),'Request a quote from CAVA — Seaport')).toBeTruthy();
 });

 it('consolidates sequential guest, dietary and staff edits into one current draft per confirmation audience',async()=>{
  let calls=0;const api=setup(':memory:',async input=>{calls++;return fallbackPlan(input);});const projectId=api.getState().project.id;
  api.edit(projectId,{area:'guests',patch:{attendance:300}});await api.tick();
  api.edit(projectId,{area:'catering',patch:{dietary:'Vegan options and nut allergy precautions'}});await api.tick();
  api.edit(projectId,{area:'staff',patch:{staffCount:3}});await api.tick();
  const before=api.getState();const refreshed=api.refreshReview(projectId);
  const emails=refreshed.proposals.filter(p=>p.kind==='email'&&p.status==='pending');
  expect(emails.filter(p=>p.area==='staff')).toHaveLength(1);expect(emails.filter(p=>p.area==='catering')).toHaveLength(1);
  const catering=emails.find(p=>p.area==='catering')!;expect(catering.body).toContain('300 guests');expect(catering.body).toContain('Vegan options and nut allergy precautions');
  const staff=emails.find(p=>p.area==='staff')!;expect(staff.body).toContain('3 staff');expect(staff.body).toContain('Vegan options and nut allergy precautions');
  expect(refreshed.project.revision).toBe(before.project.revision);expect(calls).toBe(3);expect(refreshed.messages).toHaveLength(0);
  expect(api.refreshReview(projectId).proposals).toEqual(refreshed.proposals);
  expect(staff.dependencies).toEqual([]);api.decide(projectId,staff.id,'approve');await api.tick();
  expect(api.getState().messages.filter(message=>message.subject===staff.subject)).toHaveLength(1);
  expect(api.getState().proposals.some(p=>p.kind==='email'&&p.area==='staff'&&p.status==='pending')).toBe(false);
 });

 it('refreshes pending review without changing approved drafts, denied decisions or vendor cancellation/quote purposes',async()=>{
  const api=setup();const projectId=api.getState().project.id;
  api.edit(projectId,{area:'guests',patch:{attendance:300}});await api.tick();
  const approved=proposal(api.getState(),'Confirm the new catering headcount');api.decide(projectId,approved.id,'approve');
  const staff=proposal(api.getState(),'Update staff on the guest count');api.decide(projectId,staff.id,'deny');
  const original=api.getState();const refreshed=api.refreshReview(projectId);
  expect(refreshed.proposals.find(p=>p.id===approved.id)).toEqual(original.proposals.find(p=>p.id===approved.id));expect(refreshed.proposals.find(p=>p.id===staff.id)?.status).toBe('denied');
  expect(refreshed.messages).toEqual(original.messages);expect(refreshed.receipts).toEqual(original.receipts);
  api.edit(projectId,{area:'catering',patch:{caterer:'CAVA'}});await api.tick();await api.tick();
  const vendor=api.getState().proposals.filter(p=>p.status==='pending'&&/^(Cancel|Request a quote)/.test(p.title));expect(vendor).toHaveLength(2);
  const after=api.refreshReview(projectId);expect(after.proposals.filter(p=>vendor.some(old=>old.id===p.id))).toEqual(vendor);
 });

 it('discards stale in-flight plans and respects a newer structured edit over an older note',async()=>{
  let release:()=>void=()=>{};let calls=0;const gate=new Promise<void>(resolve=>{release=resolve;});
  const api=setup(':memory:',async input=>{calls++;if(calls===1)await gate;return fallbackPlan(input);});const projectId=api.getState().project.id;
  api.edit(projectId,{area:'guests',note:'Change attendance to 300'});const oldTick=api.tick();
  const originalWarning=proposal(api.getState(),'Venue is 40 seats short');
  api.edit(projectId,{area:'guests',patch:{attendance:250}});release();await oldTick;
  expect(api.getState().project.facts.attendance).toBe(250);await api.tick();const s=api.getState();expect(s.project.facts.attendance).toBe(250);expect(s.proposals.find(p=>p.id===originalWarning.id)?.status).toBe('stale');expect(s.proposals.some(p=>p.title==='Venue is 40 seats short'&&p.status==='pending')).toBe(false);
 });

 it('keeps AV budget removal dependent on the cancellation action',async()=>{
  const api=setup();const projectId=api.getState().project.id;api.edit(projectId,{area:'venue',note:'Venue has changed to Marriott Downtown · Grand Ballroom'});await api.tick();
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
  expect(booking.groupTitle).toBe('CAVA quote received');
  s=api.inject(projectId,'confirmation');expect(s.project.facts.cateringStatus).toBe('confirmed');expect(proposal(s,'Tell staff about the confirmed meal')).toBeTruthy();expect(proposal(s,'Update the invitation details')).toBeTruthy();
  expect(proposal(s,'Tell staff about the confirmed meal').groupTitle).toBe('CAVA booking confirmed');
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

 it('automatically writes the current budget total into the local budget document',async()=>{
  const api=setup();const projectId=api.getState().project.id;api.edit(projectId,{area:'guests',patch:{attendance:250}});await api.tick();
  const s=api.getState();expect(s.sources.find(source=>source.id==='record:budget')?.content).toContain(new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(s.budget.totalCents/100));
  expect(s.proposals.some(p=>p.kind==='file'&&p.status==='pending')).toBe(false);
 });

 it('keeps guest consequences when undoing an unrelated budget edit from the same planning batch',async()=>{
  const api=setup();const projectId=api.getState().project.id;
  api.edit(projectId,{area:'guests',patch:{attendance:300}});
  const edited=api.edit(projectId,{area:'budget',patch:{budgetLimitCents:1900000}});
  const budgetChangeId=edited.activity.find(a=>a.canUndo)!.changeId!;
  await api.tick();
  const before=api.getState();
  const guestUpdates=['Confirm the new catering headcount','Update staff on the guest count','Adjust staffing to 5','40 seats short'].map(title=>proposal(before,title));
  const after=api.undo(projectId,budgetChangeId);
  expect(after.project.facts.attendance).toBe(300);
  expect(after.project.facts.budgetLimitCents).toBe(1800000);
  for(const update of guestUpdates)expect(after.proposals.find(p=>p.id===update.id)?.status,update.title).toBe('pending');
  expect(after.proposals.filter(p=>p.kind==='file'&&p.area==='budget'&&p.status==='pending')).toHaveLength(0);
  expect(after.sources.find(source=>source.id==='record:budget')?.content).toContain('Current forecast: $17,400.00');
 });

 it('preserves the queued guest edit when undoing a budget edit before planning starts',async()=>{
  const checkedAreas:string[]=[];
  const api=setup(':memory:',async request=>{checkedAreas.push(request.area);return fallbackPlan(request);});
  const projectId=api.getState().project.id;
  api.edit(projectId,{area:'guests',patch:{attendance:300}});
  const edited=api.edit(projectId,{area:'budget',patch:{budgetLimitCents:1900000}});
  const undone=api.undo(projectId,edited.activity.find(a=>a.canUndo)!.changeId!);
  expect(undone.workflow?.status).toBe('planning');
  await api.tick();
  const after=api.getState();
  expect(checkedAreas).toEqual(['guests']);
  expect(after.project.facts.attendance).toBe(300);
  expect(after.project.facts.budgetLimitCents).toBe(1800000);
  for(const title of ['Confirm the new catering headcount','Adjust staffing to 5','40 seats short'])expect(proposal(after,title)).toBeTruthy();
 });

 it('supersedes an in-flight batch on Undo without dropping the remaining guest request',async()=>{
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const checkedAreas:string[]=[];
  const api=setup(':memory:',async request=>{checkedAreas.push(request.area);if(checkedAreas.length===1)await gate;return fallbackPlan(request);});
  const projectId=api.getState().project.id;
  api.edit(projectId,{area:'guests',patch:{attendance:300}});
  const edited=api.edit(projectId,{area:'budget',patch:{budgetLimitCents:1900000}});
  const inFlight=api.tick();
  api.undo(projectId,edited.activity.find(a=>a.canUndo)!.changeId!);
  release();await inFlight;await api.tick();
  const after=api.getState();
  expect(checkedAreas).toEqual(['budget','guests']);
  expect(after.project.facts.attendance).toBe(300);
  expect(after.project.facts.budgetLimitCents).toBe(1800000);
  expect(proposal(after,'Confirm the new catering headcount')).toBeTruthy();
  expect(proposal(after,'Adjust staffing to 5')).toBeTruthy();
  expect(proposal(after,'40 seats short')).toBeTruthy();
 });

 it('does not revive a denied guest suggestion while recomputing after unrelated Undo',async()=>{
  const api=setup();const projectId=api.getState().project.id;
  api.edit(projectId,{area:'guests',patch:{attendance:300}});
  const edited=api.edit(projectId,{area:'budget',patch:{budgetLimitCents:1900000}});
  const budgetChangeId=edited.activity.find(a=>a.canUndo)!.changeId!;
  await api.tick();const staffing=proposal(api.getState(),'Adjust staffing to 5');
  api.decide(projectId,staffing.id,'deny');
  const after=api.undo(projectId,budgetChangeId);
  expect(after.proposals.find(p=>p.id===staffing.id)?.status).toBe('denied');
  expect(after.proposals.some(p=>p.title===staffing.title&&p.status==='pending')).toBe(false);
 });

 it('quietly syncs local records without sending messages and restores them on Undo',async()=>{
  const api=setup();const initial=api.getState();const projectId=initial.project.id;
  const edited=api.edit(projectId,{area:'guests',patch:{attendance:300}});const changeId=edited.activity.find(a=>a.canUndo)!.changeId!;
  await api.tick();const synced=api.getState();
  expect(synced.messages).toHaveLength(0);
  const files=synced.proposals.filter(p=>p.kind==='file');expect(files.length).toBeGreaterThan(0);
  expect(files.every(p=>p.status==='applied')).toBe(true);
  expect(synced.receipts.filter(r=>files.some(p=>p.id===r.proposalId)).every(r=>r.status==='local')).toBe(true);
  expect(synced.activity.filter(a=>files.some(p=>p.title===a.title)).every(a=>a.automatic===true)).toBe(true);
  expect(synced.sources.find(source=>source.id==='record:guests')?.content).toContain('300');
  const restored=api.undo(projectId,changeId);
  expect(restored.sources.find(source=>source.id==='guests')?.content).toBe(initial.sources.find(source=>source.id==='guests')?.content);
  expect(restored.sources.find(source=>source.id==='budget')?.content).toBe(initial.sources.find(source=>source.id==='budget')?.content);
  expect(restored.receipts.length).toBeGreaterThanOrEqual(synced.receipts.length);
 });

 it('approves the displayed staffing adjustment and its exact email in one review without a follow-up',async()=>{
  const api=setup();const projectId=api.getState().project.id;api.edit(projectId,{area:'guests',patch:{attendance:300}});await api.tick();
  const before=api.getState();const emails=before.proposals.filter(p=>p.kind==='email'&&p.status==='pending');
  expect(emails).toHaveLength(2);expect(new Set(emails.map(p=>p.groupId)).size).toBe(1);expect(emails[0].groupTitle).toBe('Guest count changed to 300');
  const staffing=proposal(before,'Adjust staffing to 5');expect(staffing.groupId).toBe(emails[0].groupId);
  const staffEmail=proposal(before,'Update staff on the guest count');expect(staffEmail.body).toContain('5 staff');expect(staffEmail.dependencies).toEqual([staffing.id]);expect(staffEmail.batchWithDependencies).toBe(true);
  const selected=api.decideMany(projectId,[...emails.map(p=>p.id),staffing.id],'approve');
  expect(selected.messages).toHaveLength(0);expect(selected.proposals.find(p=>p.id===staffing.id)?.status).toBe('applied');expect(selected.project.facts.staffCount).toBe(5);
  await api.tick();await api.tick();const sent=api.getState();
  expect(sent.messages.filter(message=>message.direction==='outbound')).toHaveLength(2);
  expect(sent.messages.every(message=>message.simulated)).toBe(true);
  expect(sent.messages.find(message=>message.subject===staffEmail.subject)?.body).toBe(staffEmail.body);
  expect(sent.proposals.some(p=>p.kind==='email'&&p.status==='pending')).toBe(false);
  expect(sent.proposals.some(p=>p.title==='Confirm the staffing arrangement')).toBe(false);
  const budgetEdit=api.edit(projectId,{area:'budget',patch:{budgetLimitCents:2000000}});const budgetChangeId=budgetEdit.activity.find(item=>item.canUndo)!.changeId!;
  await api.tick();const restored=api.undo(projectId,budgetChangeId);
  expect(restored.proposals.some(p=>p.kind==='email'&&p.status==='pending')).toBe(false);
 });

 it('requires the staffing fact individually and never sends its email when only the fact was approved',async()=>{
  const api=setup();const projectId=api.getState().project.id;api.edit(projectId,{area:'guests',patch:{attendance:300}});await api.tick();
  const before=api.getState();const staffEmail=proposal(before,'Update staff on the guest count');const staffing=proposal(before,'Adjust staffing to 5');
  expect(()=>api.decide(projectId,staffEmail.id,'approve')).toThrow('prerequisite');
  expect(()=>api.decideMany(projectId,[staffEmail.id],'approve')).toThrow('prerequisite');
  api.decide(projectId,staffing.id,'approve');await api.tick();
  const waiting=api.getState();expect(waiting.messages).toHaveLength(0);
  expect(waiting.proposals.find(p=>p.id===staffEmail.id)).toMatchObject({status:'pending',body:staffEmail.body});
  expect(waiting.proposals.some(p=>p.title==='Confirm the staffing arrangement')).toBe(false);
  api.decide(projectId,staffEmail.id,'approve');await api.tick();expect(api.getState().messages).toHaveLength(1);
 });

 it('keeps the staff email blocked after its staffing adjustment was denied',async()=>{
  const api=setup();const projectId=api.getState().project.id;api.edit(projectId,{area:'guests',patch:{attendance:300}});await api.tick();
  const staffEmail=proposal(api.getState(),'Update staff on the guest count');const staffing=proposal(api.getState(),'Adjust staffing to 5');
  api.decide(projectId,staffing.id,'deny');
  expect(api.getState().proposals.find(p=>p.id===staffEmail.id)?.status).toBe('blocked');
  expect(()=>api.decide(projectId,staffEmail.id,'approve')).toThrow('prerequisite');
  expect(()=>api.decideMany(projectId,[staffing.id,staffEmail.id],'approve')).toThrow('no longer ready');
  await api.tick();expect(api.getState().messages).toHaveLength(0);expect(api.getState().project.facts.staffCount).toBe(4);
 });

 it('rejects the entire batch when any explicit proposal is stale',async()=>{
  const api=setup();const projectId=api.getState().project.id;api.edit(projectId,{area:'guests',patch:{attendance:300}});await api.tick();
  const stale=proposal(api.getState(),'Confirm the new catering headcount');
  api.edit(projectId,{area:'guests',patch:{attendance:280}});await api.tick();
  const before=api.getState();const ready=proposal(before,'Confirm the new catering headcount');
  expect(()=>api.decideMany(projectId,[ready.id,stale.id],'approve')).toThrow('no longer ready');
  const after=api.getState();expect(after.proposals.find(p=>p.id===ready.id)?.status).toBe('pending');expect(after.receipts).toHaveLength(before.receipts.length);
  await api.tick();expect(api.getState().messages).toHaveLength(0);
  expect(()=>api.decideMany(projectId,[],'approve')).toThrow('distinct');
  expect(()=>api.decideMany(projectId,['missing'],'approve')).toThrow('no longer ready');
 });

 it('does not bypass unfinished dependencies just because both proposals are selected',async()=>{
  const api=setup();const projectId=api.getState().project.id;api.edit(projectId,{area:'venue',note:'Change the venue to Marriott Downtown · Grand Ballroom'});await api.tick();
  const before=api.getState();const cancellation=proposal(before,'Cancel the duplicate AV rental');const removal=proposal(before,'Remove the duplicate AV cost');
  expect(()=>api.decideMany(projectId,[cancellation.id,removal.id],'approve')).toThrow('prerequisite');
  expect(api.getState().proposals.find(p=>p.id===cancellation.id)?.status).toBe('pending');expect(api.getState().project.facts.equipmentCostCents).toBe(180000);
  api.decideMany(projectId,[cancellation.id],'approve');await api.tick();expect(api.getState().project.facts.equipmentCostCents).toBe(0);expect(api.getState().proposals.find(p=>p.id===removal.id)?.status).toBe('applied');
 });

 it('automatically updates fixture AV bookkeeping once, without an extra equipment email, and restores it on Undo',async()=>{
  const api=setup();const projectId=api.getState().project.id;
  api.edit(projectId,{area:'venue',note:'Move to Marriott Downtown Grand Ballroom'});await api.tick();
  const before=api.getState();const changeId=before.activity.find(item=>item.canUndo)!.changeId!;const cancel=proposal(before,'Cancel the duplicate AV rental');
  expect(cancel.body).toContain('$1,800.00');api.decide(projectId,cancel.id,'approve');await api.tick();
  const updated=api.getState();expect(updated.project.facts.equipmentCostCents).toBe(0);
  expect(updated.proposals.find(p=>p.title==='Remove the duplicate AV cost')?.status).toBe('applied');
  expect(updated.proposals.some(p=>p.title==='Confirm the equipment plan'&&p.status==='pending')).toBe(false);
  const count=updated.receipts.length;await api.tick();expect(api.getState().receipts).toHaveLength(count);
  const restored=api.undo(projectId,changeId);expect(restored.project.facts.equipmentCostCents).toBe(180000);expect(restored.project.facts.venue).toBe('Garden Hall');
 });

 it('retains the AV charge after real email delivery until cancellation is confirmed',async()=>{
  const {api,bridge,projectId}=setupLive();api.edit(projectId,{area:'venue',note:'Move to Marriott Downtown Grand Ballroom'});await api.tick();
  const cancel=proposal(api.getState(),'Cancel the duplicate AV rental');const removal=proposal(api.getState(),'Remove the duplicate AV cost');
  api.decide(projectId,cancel.id,'approve',cancel.approvalToken);await api.tick();
  const job=bridge.claimNext('test-worker')!;bridge.complete(job.id,{detail:'Verified cancellation request delivery in Gmail.'});await api.tick();
  const waiting=api.getState();expect(waiting.project.facts.equipmentCostCents).toBe(180000);expect(waiting.proposals.find(p=>p.id===removal.id)).toMatchObject({status:'blocked',description:expect.stringContaining('vendor cancellation confirmation')});
  expect(()=>api.decide(projectId,removal.id,'approve')).toThrow('cancellation confirmation');
 });

 it.each(['simulated','delivered'] as const)('recovers legacy AV bookkeeping after an already %s cancellation without resending it',async receiptStatus=>{
  const dir=mkdtempSync(join(tmpdir(),'ripple-legacy-av-'));dirs.push(dir);const dbPath=join(dir,'event.sqlite');
  const api=setup(dbPath);const projectId=api.getState().project.id;
  api.edit(projectId,{area:'venue',note:'Move to Marriott Downtown Grand Ballroom'});await api.tick();
  const ready=api.getState();const changeId=ready.activity.find(item=>item.canUndo)!.changeId!;
  const cancellation=proposal(ready,'Cancel the duplicate AV rental');const removal=proposal(ready,'Remove the duplicate AV cost');api.close();
  // Recreate a saved plan from before the automatic marker was introduced.
  const db=new DatabaseSync(dbPath);const row=db.prepare('SELECT state FROM projects WHERE id=?').get(projectId) as {state:string};const persisted=JSON.parse(row.state);
  delete persisted.meta[removal.id].automaticAfterCancellation;
  persisted.state.proposals.find((p:{id:string})=>p.id===cancellation.id).status='applied';
  persisted.state.receipts.unshift({id:'legacy-cancellation-receipt',proposalId:cancellation.id,at:new Date().toISOString(),title:cancellation.title,provider:receiptStatus==='simulated'?'Email demo':'Gmail browser',status:receiptStatus,detail:'Preserved earlier cancellation request.'});
  db.prepare('UPDATE projects SET state=? WHERE id=?').run(JSON.stringify(persisted),projectId);db.close();
  const resumed=setup(dbPath);const updated=resumed.refreshReview(projectId);
  expect(updated.project.facts.equipmentCostCents).toBe(receiptStatus==='simulated'?0:180000);
  expect(updated.proposals.find(p=>p.id===removal.id)?.status).toBe(receiptStatus==='simulated'?'applied':'blocked');
  expect(updated.messages).toHaveLength(0);expect(updated.receipts.filter(r=>r.proposalId===cancellation.id)).toHaveLength(1);
  const count=updated.receipts.length;resumed.refreshReview(projectId);await resumed.tick();expect(resumed.getState().receipts).toHaveLength(count);
  if(receiptStatus==='simulated')expect(resumed.undo(projectId,changeId).project.facts.equipmentCostCents).toBe(180000);
 });

 it.each(['queued','running'] as const)('revokes undone applied invitation metadata while preserving %s delivery history',async deliveryStatus=>{
  const {api,bridge,projectId}=setupLive(false);bridge.configure(projectId,{eviteEventUrl:'https://www.evite.com/event/undo-test'});
  const edited=api.edit(projectId,{area:'venue',patch:{venue:'New event room',venueAddress:'New address'}});const changeId=edited.activity.find(item=>item.canUndo)!.changeId!;await api.tick();
  const invitation=api.getState().proposals.find(p=>p.kind==='invitation'&&p.status==='pending')!;api.decide(projectId,invitation.id,'approve');await api.tick();
  const queued=syncInvitations(api.getState(),bridge)[0];if(deliveryStatus==='running')bridge.claimNext('test-browser');
  const restored=api.undo(projectId,changeId);expect(restored.project.facts.venue).toBe('Garden Hall');
  expect(restored.proposals.find(p=>p.id===invitation.id)).toMatchObject({status:'applied',invitationSnapshotRevoked:true,invitationSnapshot:{venue:'New event room'}});
  expect(restored.receipts.some(r=>r.proposalId===invitation.id)).toBe(true);
  expect(syncInvitations(restored,bridge)).toEqual([]);
  expect(bridge.listJobs().find(job=>job.id===queued.id)?.status).toBe(deliveryStatus==='queued'?'cancelled':'running');
  expect(syncInvitations(restored,bridge)).toEqual([]);expect(bridge.listJobs()).toHaveLength(1);
 });

 it('revokes a later approved full invitation snapshot that includes an earlier undone venue',async()=>{
  const {api,bridge,projectId}=setupLive(false);bridge.configure(projectId,{eviteEventUrl:'https://www.evite.com/event/cross-change-undo'});
  const edited=api.edit(projectId,{area:'venue',patch:{venue:'New event room',venueAddress:'New address'}});const venueChangeId=edited.activity.find(item=>item.canUndo)!.changeId!;await api.tick();
  const venueInvitation=api.getState().proposals.find(p=>p.kind==='invitation'&&p.status==='pending')!;api.decide(projectId,venueInvitation.id,'approve');await api.tick();
  api.edit(projectId,{area:'brief',patch:{time:'19:00'}});await api.tick();
  const scheduleInvitation=api.getState().proposals.find(p=>p.kind==='invitation'&&p.status==='pending')!;api.decide(projectId,scheduleInvitation.id,'approve');await api.tick();
  const job=syncInvitations(api.getState(),bridge)[0];expect(job.payload.snapshot).toMatchObject({venue:'New event room',time:'19:00'});
  const restored=api.undo(projectId,venueChangeId);expect(restored.project.facts).toMatchObject({venue:'Garden Hall',time:'19:00'});
  expect(restored.proposals.find(p=>p.id===scheduleInvitation.id)?.invitationSnapshotRevoked).toBe(true);
  expect(syncInvitations(restored,bridge)).toEqual([]);expect(bridge.listJobs()[0].status).toBe('cancelled');
 });

 it('denies only the explicit batch and retains unrelated pending decisions',async()=>{
  const api=setup();const projectId=api.getState().project.id;api.edit(projectId,{area:'guests',patch:{attendance:300}});await api.tick();
  const before=api.getState();const emails=before.proposals.filter(p=>p.kind==='email'&&p.status==='pending');const staffing=proposal(before,'Adjust staffing to 5');
  const after=api.decideMany(projectId,emails.map(p=>p.id),'deny');expect(emails.every(p=>after.proposals.find(next=>next.id===p.id)?.status==='denied')).toBe(true);expect(after.proposals.find(p=>p.id===staffing.id)?.status).toBe('pending');
  api.decide(projectId,staffing.id,'approve');await api.tick();
  expect(api.getState().proposals.some(p=>p.kind==='email'&&p.status==='pending')).toBe(false);expect(api.getState().messages).toHaveLength(0);
 });

 it('waits for a brief quiet period before checking rapid inline edits',async()=>{
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-09-19T12:00:00Z'));let calls=0;
  const api=createService({dbPath:':memory:',planningDelayMs:1200,aiStatus,planner:async request=>{calls++;return fallbackPlan(request);}});services.push(api);
  const projectId=api.getState().project.id;api.edit(projectId,{area:'guests',patch:{attendance:280}});await api.tick();expect(calls).toBe(0);
  vi.advanceTimersByTime(600);api.edit(projectId,{area:'guests',patch:{attendance:300}});vi.advanceTimersByTime(600);await api.tick();expect(calls).toBe(0);
  vi.advanceTimersByTime(600);await api.tick();expect(calls).toBe(1);expect(api.getState().project.facts.attendance).toBe(300);expect(proposal(api.getState(),'40 seats short')).toBeTruthy();
 });

 it('previews the actual test recipient and captures immutable approved Gmail content',async()=>{
  const {api,bridge,projectId}=setupLive();api.edit(projectId,{area:'guests',patch:{attendance:300}});await api.tick();
  const preview=proposal(api.getState(),'Confirm the new catering headcount');
  expect(preview.recipient).toBe('recipient@example.net');expect(preview.originalRecipient).toBe('catering@shahhalal.example');
  expect(api.getState().emailDelivery).toEqual({account:'planner@gmail.com',recipient:'recipient@example.net',mode:'local_browser',pendingCount:0,configured:true});
  api.decide(projectId,preview.id,'approve',preview.approvalToken);bridge.configure(projectId,{testRecipient:'changed@example.net'});await api.tick();
  const jobs=bridge.listJobs(projectId);expect(jobs).toHaveLength(1);
  expect(jobs[0].payload).toEqual({proposalId:preview.id,account:'planner@gmail.com',recipient:'recipient@example.net',originalRecipient:preview.originalRecipient,subject:preview.subject,body:preview.body});
  const waiting=api.getState();expect(waiting.proposals.find(p=>p.id===preview.id)?.status).toBe('approved');expect(waiting.proposals.find(p=>p.id===preview.id)?.recipient).toBe('recipient@example.net');
  expect(waiting.messages).toHaveLength(0);expect(waiting.receipts.some(r=>r.proposalId===preview.id)).toBe(false);expect(waiting.emailDelivery?.pendingCount).toBe(1);
 });

 it('records delivery and applies vendor effects exactly once after verified completion',async()=>{
  const {api,bridge,projectId}=setupLive();api.edit(projectId,{area:'catering',patch:{caterer:'CAVA'}});await api.tick();
  const request=proposal(api.getState(),'Request a quote from CAVA');api.decide(projectId,request.id,'approve',request.approvalToken);await api.tick();
  expect(()=>api.inject(projectId,'quote')).toThrow('quote request');expect(api.getState().messages).toHaveLength(0);
  const job=bridge.claimNext('test-worker')!;const url='https://mail.google.com/mail/u/0/#sent/verified-message';
  bridge.complete(job.id,{externalId:'verified-message',url,detail:'Verified the message in Gmail Sent.'});
  await api.tick();await api.tick();const delivered=api.getState();
  expect(delivered.proposals.find(p=>p.id===request.id)?.status).toBe('applied');
  expect(delivered.receipts.filter(r=>r.proposalId===request.id&&r.status==='delivered')).toHaveLength(1);
  expect(delivered.messages.filter(message=>!message.simulated)).toHaveLength(1);expect(delivered.messages[0].url).toBe(url);expect(delivered.messages[0].body).toBe(request.body);
  expect(delivered.emailDelivery?.pendingCount).toBe(0);expect(()=>api.inject(projectId,'quote')).not.toThrow();
 });

 it('cancels queued browser delivery on Undo without producing a sent receipt',async()=>{
  const {api,bridge,projectId}=setupLive();const changed=api.edit(projectId,{area:'guests',patch:{attendance:300}});const changeId=changed.activity.find(a=>a.canUndo)!.changeId!;await api.tick();
  const request=proposal(api.getState(),'Confirm the new catering headcount');api.decide(projectId,request.id,'approve',request.approvalToken);await api.tick();
  expect(bridge.listJobs(projectId)[0].status).toBe('queued');const undone=api.undo(projectId,changeId);
  expect(bridge.listJobs(projectId)[0].status).toBe('cancelled');expect(bridge.claimNext('worker')).toBeUndefined();expect(undone.messages).toHaveLength(0);expect(undone.receipts.some(r=>r.status==='delivered')).toBe(false);
 });

 it('reconciles a running send after Undo and prepares a correction without sending it',async()=>{
  const {api,bridge,projectId}=setupLive();const changed=api.edit(projectId,{area:'guests',patch:{attendance:300}});const changeId=changed.activity.find(a=>a.canUndo)!.changeId!;await api.tick();
  const request=proposal(api.getState(),'Confirm the new catering headcount');api.decide(projectId,request.id,'approve',request.approvalToken);await api.tick();const job=bridge.claimNext('worker')!;
  api.undo(projectId,changeId);expect(bridge.listJobs(projectId)[0].status).toBe('running');
  bridge.complete(job.id,{detail:'Message verified in Gmail Sent.'});await api.tick();const state=api.getState();
  expect(state.messages.filter(message=>!message.simulated)).toHaveLength(1);expect(state.project.facts.attendance).toBe(240);
  const correction=proposal(state,'Correct the previous update');expect(correction.status).toBe('pending');expect(correction.recipient).toBe('recipient@example.net');expect(bridge.listJobs(projectId)).toHaveLength(1);
 });

 it('shows browser delivery failures without marking the email sent or applying effects',async()=>{
  const {api,bridge,projectId}=setupLive();api.edit(projectId,{area:'catering',patch:{caterer:'CAVA'}});await api.tick();
  const request=proposal(api.getState(),'Request a quote from CAVA');api.decide(projectId,request.id,'approve',request.approvalToken);await api.tick();const job=bridge.listJobs(projectId)[0];
  bridge.fail(job.id,'Gmail could not verify that the message was sent.');await api.tick();const once=api.getState();await api.tick();const twice=api.getState();
  expect(twice.messages).toHaveLength(0);expect(twice.proposals.find(p=>p.id===request.id)?.status).toBe('blocked');expect(twice.receipts.filter(r=>r.status==='failed')).toHaveLength(1);expect(twice.activity).toHaveLength(once.activity.length);expect(()=>api.inject(projectId,'quote')).toThrow('quote request');
 });

 it('requires both account and recipient and does not upgrade an earlier demo approval to live sending',async()=>{
  const {api,bridge,projectId}=setupLive(false);bridge.configure(projectId,{emailAccount:'planner@gmail.com'});
  api.edit(projectId,{area:'guests',patch:{attendance:300}});await api.tick();expect(api.getState().emailDelivery).toBeUndefined();
  const request=proposal(api.getState(),'Confirm the new catering headcount');expect(request.recipient).toBe('catering@shahhalal.example');api.decide(projectId,request.id,'approve',request.approvalToken);
  bridge.configure(projectId,{testRecipient:'recipient@example.net'});await api.tick();
  expect(bridge.listJobs(projectId)).toHaveLength(0);expect(api.getState().messages[0].simulated).toBe(true);
 });

 it('updates the forecast from actual captured quote amounts and retains Gmail provenance once',async()=>{
  const {api,bridge,projectId}=await requestedLiveQuote();const message=capturedQuote();
  const updated=api.ingestReply(projectId,message);
  expect(updated.project.facts.cateringPerPersonCents).toBe(3175);expect(updated.project.facts.cateringDeliveryCents).toBe(12500);expect(updated.project.facts.cateringStatus).toBe('quoted');
  expect(updated.budget.totalCents).toBe(2370500);expect(updated.budget.lines.find(line=>line.label==='CAVA catering')?.amountCents).toBe(774500);
  const booking=proposal(updated,'Request booking with CAVA');expect(booking.body).toContain('$7,745.00');expect(booking.evidence).toEqual(['gmail:gmail-quote-1']);expect(booking.groupTitle).toBe('CAVA quote received');
  expect(updated.messages.find(mail=>mail.externalId===message.externalId)?.simulated).toBe(false);expect(updated.sources.find(source=>source.id==='gmail:gmail-quote-1')?.content).toContain('31.75');
  expect(bridge.listJobs(projectId)).toHaveLength(1);
  const again=api.ingestReply(projectId,message);expect(again.messages).toHaveLength(updated.messages.length);expect(again.sources).toHaveLength(updated.sources.length);expect(again.project.revision).toBe(updated.project.revision);
 });

 it('preserves the forecast for wrong-sender, wrong-vendor, or stale-context replies',async()=>{
  const {api,projectId}=await requestedLiveQuote();const before=api.getState().budget.totalCents;
  const cases=[capturedQuote({externalId:'wrong-sender',sender:'someone-else@example.net'}),capturedQuote({externalId:'wrong-vendor',vendor:'Another caterer'}),capturedQuote({externalId:'wrong-date',date:'2026-12-12'}),capturedQuote({externalId:'wrong-count',guests:250,total:'8062.50'})];
  for(const message of cases){const state=api.ingestReply(projectId,message);expect(state.budget.totalCents).toBe(before);expect(state.project.facts.cateringStatus).toBe('awaiting_quote');expect(state.activity[0].title).toBe('Reply needs review');}
 });

 it('requires a verified delivered request before accepting even a well-formed quote',async()=>{
  const {api,projectId}=setupLive();api.edit(projectId,{area:'catering',patch:{caterer:'CAVA'}});await api.tick();
  const quoted=api.ingestReply(projectId,capturedQuote());expect(quoted.project.facts.cateringStatus).toBe('awaiting_quote');expect(quoted.budget.totalCents).toBe(1596000);
 });

 it('does not use a delivered request for old guest details as authority for a new quote',async()=>{
  const {api,projectId}=await requestedLiveQuote();api.edit(projectId,{area:'guests',patch:{attendance:250}});await api.tick();
  const before=api.getState();const state=api.ingestReply(projectId,capturedQuote({guests:250,total:'8062.50'}));
  expect(state.budget.totalCents).toBe(before.budget.totalCents);expect(state.project.facts.cateringStatus).toBe('awaiting_quote');expect(state.activity[0].detail).toContain('delivered Gmail quote request');
 });

 it('rejects a different event subject and a reply older than the delivered request',async()=>{
  const {api,projectId}=await requestedLiveQuote();const baseline=api.getState().budget.totalCents;
  const wrongEvent={...capturedQuote({externalId:'wrong-event'}),subject:'Re: Other project: Request a quote from CAVA'};
  expect(api.ingestReply(projectId,wrongEvent).budget.totalCents).toBe(baseline);
  const oldReply={...capturedQuote({externalId:'old-reply'}),receivedAt:new Date(Date.now()-120000).toISOString()};
  expect(api.ingestReply(projectId,oldReply).budget.totalCents).toBe(baseline);
 });

 it('does not let an older captured message replace the newer accepted quote',async()=>{
  const {api,projectId}=await requestedLiveQuote();const newer={...capturedQuote({externalId:'newer'}),receivedAt:new Date(Date.now()+5000).toISOString()};
  const accepted=api.ingestReply(projectId,newer);
  const older={...capturedQuote({externalId:'older',perPerson:'27.50',delivery:'180.00',total:'6780.00'}),receivedAt:new Date(Date.now()+1000).toISOString()};
  const unchanged=api.ingestReply(projectId,older);expect(unchanged.budget.totalCents).toBe(accepted.budget.totalCents);expect(unchanged.project.facts.cateringPerPersonCents).toBe(3175);expect(unchanged.activity[0].detail).toContain('newer quote');
 });

 it('reprocesses only identical rejected mail without duplicating evidence or accepted updates',async()=>{
  const {api,bridge,projectId}=setupLive();api.edit(projectId,{area:'catering',patch:{caterer:'CAVA'}});await api.tick();
  const request=proposal(api.getState(),'Request a quote from CAVA');api.decide(projectId,request.id,'approve',request.approvalToken);await api.tick();
  const message=capturedQuote();const rejected=api.ingestReply(projectId,message);expect(rejected.project.facts.cateringStatus).toBe('awaiting_quote');
  expect(()=>api.ingestReply(projectId,{...message,body:message.body+'\nChanged evidence'}, {reprocess:true})).toThrow('identical captured message');
  const job=bridge.claimNext('worker')!;bridge.complete(job.id,{detail:'Message verified in Gmail Sent.'});await api.tick();
  expect(api.ingestReply(projectId,message).project.facts.cateringStatus).toBe('awaiting_quote');
  const accepted=api.ingestReply(projectId,message,{reprocess:true});expect(accepted.project.facts.cateringStatus).toBe('quoted');
  expect(accepted.messages.filter(mail=>mail.externalId===message.externalId)).toHaveLength(1);expect(accepted.sources.filter(source=>source.id===`gmail:${message.externalId}`)).toHaveLength(1);
  const again=api.ingestReply(projectId,message,{reprocess:true});expect(again.project.revision).toBe(accepted.project.revision);expect(again.messages).toHaveLength(accepted.messages.length);expect(again.sources).toEqual(accepted.sources);
 });

 it('rejects missing or stale live-email preview tokens atomically when routing changed',async()=>{
  const {api,bridge,projectId}=setupLive();api.edit(projectId,{area:'guests',patch:{attendance:300}});await api.tick();
  const rendered=api.getState().proposals.filter(p=>p.kind==='email'&&p.status==='pending');
  const oldTokens=Object.fromEntries(rendered.map(p=>[p.id,p.approvalToken!]));expect(rendered.every(p=>/^[a-f0-9]{64}$/.test(p.approvalToken??''))).toBe(true);
  expect(()=>api.decide(projectId,rendered[0].id,'approve')).toThrow('preview changed');
  bridge.configure(projectId,{emailAccount:'another-planner@gmail.com',testRecipient:'new-target@example.net'});
  const staffing=proposal(api.getState(),'Adjust staffing to 5');
  expect(()=>api.decideMany(projectId,[...rendered.map(p=>p.id),staffing.id],'approve',oldTokens)).toThrow('preview changed');
  expect(api.getState().project.facts.staffCount).toBe(4);
  expect(api.getState().proposals.filter(p=>rendered.some(old=>old.id===p.id)).every(p=>p.status==='pending')).toBe(true);expect(bridge.listJobs(projectId)).toHaveLength(0);
  const fresh=api.getState().proposals.filter(p=>rendered.some(old=>old.id===p.id));const tokens=Object.fromEntries(fresh.map(p=>[p.id,p.approvalToken!]));
  api.decideMany(projectId,[...fresh.map(p=>p.id),staffing.id],'approve',tokens);await api.tick();await api.tick();
  expect(bridge.listJobs(projectId)).toHaveLength(2);expect(bridge.listJobs(projectId).every(job=>job.payload.recipient==='new-target@example.net'&&job.payload.account==='another-planner@gmail.com')).toBe(true);
  for(const email of fresh){expect(bridge.listJobs(projectId).find(job=>job.payload.proposalId===email.id)?.payload.body).toBe(email.body);}
  expect(api.getState().proposals.some(p=>p.kind==='email'&&p.status==='pending')).toBe(false);
 });

 it('keeps immutable queued and running deliveries visible after routing is disconnected',async()=>{
  const {api,bridge,projectId}=setupLive();api.edit(projectId,{area:'guests',patch:{attendance:300}});await api.tick();
  const request=proposal(api.getState(),'Confirm the new catering headcount');api.decide(projectId,request.id,'approve',request.approvalToken);await api.tick();
  bridge.configure(projectId,{emailAccount:'',testRecipient:''});const disconnected=api.getState();
  expect(disconnected.emailDelivery).toEqual({account:'planner@gmail.com',recipient:'recipient@example.net',mode:'local_browser',pendingCount:1,configured:false});
  expect(disconnected.proposals.find(p=>p.id===request.id)?.recipient).toBe('recipient@example.net');
  const job=bridge.claimNext('worker')!;expect(api.getState().emailDelivery?.pendingCount).toBe(1);expect(job.payload.recipient).toBe('recipient@example.net');
  bridge.complete(job.id,{detail:'Previously approved delivery verified in Gmail.'});await api.tick();expect(api.getState().emailDelivery).toBeUndefined();expect(api.getState().receipts.some(receipt=>receipt.status==='delivered'&&receipt.proposalId===request.id)).toBe(true);
 });

 it('archives a project from the picker while retaining direct access and real delivery evidence',async()=>{
  const {api,projectId}=await requestedLiveQuote();const before=api.getState(projectId);
  const main=api.createProject('Christmas dinner — planning');
  const archived=api.archiveProject(projectId);
  expect(archived.projects).toEqual([{id:main.project.id,name:main.project.name}]);
  expect(api.getState().project.id).toBe(main.project.id);
  const retained=api.getState(projectId);
  expect(retained.project).toEqual(before.project);expect(retained.receipts).toEqual(before.receipts);
  expect(retained.receipts.some(receipt=>receipt.status==='delivered')).toBe(true);
  expect(retained.messages).toEqual(before.messages);expect(retained.sources).toEqual(before.sources);
  expect(retained.activity).toEqual(before.activity);expect(retained.proposals).toEqual(before.proposals);
  expect(api.archiveProject(projectId,false).projects.map(project=>project.id)).toEqual([projectId,main.project.id]);
 });

 it('persists archive status across restarts without reseeding or deleting the archived event',()=>{
  const directory=mkdtempSync(join(tmpdir(),'ripple-archive-'));dirs.push(directory);const dbPath=join(directory,'state.sqlite');
  const first=setup(dbPath);const initial=first.getState();first.archiveProject(initial.project.id);first.close();
  const restarted=setup(dbPath);expect(restarted.getState(initial.project.id).projects).toEqual([]);
  expect(restarted.getState(initial.project.id).project).toEqual(initial.project);
  const newProject=restarted.createProject('New event');
  expect(newProject.projects).toEqual([{id:newProject.project.id,name:'New event'}]);
  expect(restarted.getState(initial.project.id).sources).toEqual(initial.sources);
  expect(()=>restarted.archiveProject('missing-project')).toThrow('Event not found');
 });

 it('freezes the approved invitation snapshot while later event edits prepare a separate draft',async()=>{
  const api=setup();const projectId=api.getState().project.id;
  api.edit(projectId,{area:'venue',patch:{venue:'River Hall',venueAddress:'10 River Street'}});await api.tick();
  const invitation=proposal(api.getState(),'Tell guests about the venue change');
  const approvedSnapshot={name:'Christmas dinner',date:'2026-12-11',time:'18:00',timezone:'America/New_York',venue:'River Hall',venueAddress:'10 River Street',caterer:'Shah Halal',dietary:'Vegetarian and halal options required',format:'Seated dinner'};
  expect(invitation.invitationSnapshot).toEqual(approvedSnapshot);
  api.decide(projectId,invitation.id,'approve');await api.tick();
  api.edit(projectId,{area:'catering',patch:{caterer:'CAVA'}});await api.tick();
  api.edit(projectId,{area:'brief',patch:{date:'2026-12-18',time:'19:00'}});await api.tick();
  const s=api.getState();const saved=s.proposals.find(p=>p.id===invitation.id)!;
  expect(saved.status).toBe('applied');expect(saved.invitationSnapshot).toEqual(approvedSnapshot);
  const draft=proposal(s,'Update the event schedule in invitations');
  expect(s.project.facts.cateringStatus).toBe('awaiting_quote');
  expect(draft.invitationSnapshot).toEqual({...approvedSnapshot,date:'2026-12-18',time:'19:00',caterer:''});
  expect(draft.status).toBe('pending');
 });
});
