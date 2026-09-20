import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createPlanner, classifyFailure, planSchema, sanitize, sanitizePlan, UsageLedger } from '../server/planner.js';
import { initialFacts, sources } from '../server/fixtures.js';
import type { FactPatch, Planner, PlanResult } from '../shared/types.js';
import { RunContext, type Agent } from '@openai/agents';

const input:Parameters<Planner>[0]={area:'guests',note:'Attendance is now 300',facts:structuredClone(initialFacts),sources:structuredClone(sources)};
const dirs:string[]=[];const closers:Array<()=>void>=[];
function output(patch:FactPatch={attendance:300}){return {patch:{...Object.fromEntries(Object.keys(planSchema.shape.patch.shape).map(k=>[k,null])),...patch},summary:'Updated the guest count to 300.',questions:[],evidenceIds:['guests'],insights:[],actions:[]};}
type PlanningAction=NonNullable<PlanResult['actions']>[number];
const accessSource={id:'venue-access',title:'Venue loading instructions',area:'venue' as const,path:'venue/access.md',content:'Loading dock access begins at 17:30. The dining room opens at 18:00. Contact the venue operations desk at operations@venue.example about an earlier setup window. Availability has not been confirmed.'};
const planningInput:Parameters<Planner>[0]={...input,structuredOnly:true,sources:[...input.sources,accessSource]};
function action(patch:Partial<PlanningAction>={}):PlanningAction{return {kind:'email',title:'Ask about an earlier load-in window',reason:'The documented 17:30 dock opening leaves only 30 minutes before guests arrive at 18:00.',area:'venue',evidenceIds:['venue-access'],body:'Hi team,\nThe loading instructions open the dock at 17:30, with guests arriving at 18:00. Could you clarify whether an earlier setup window is available? That would help us sequence unloading and room preparation.',subject:'Setup access before the dinner',recipient:'operations@venue.example',...patch};}
function operatingPlan():PlanningAction{return action({kind:'plan',title:'Proposed arrival and setup sequence',recipient:null,subject:null,body:'Assumption: the documented 17:30 loading access remains in place; earlier entry is unconfirmed.\n1. Before 17:30 — proposed setup lead stages equipment offsite and checks vendor arrival order.\n2. At 17:30 — venue operations checks access before the team unloads; keep guest entrance clear.\n3. Before 18:00 — proposed front-of-house lead checks the route and holds guest entry if unloading is unfinished. Confirm responsible staff before adopting this sequence.'});}
function planner(options:Parameters<typeof createPlanner>[0]={}){const p=createPlanner({apiKey:'unit-test-placeholder',dbPath:':memory:',model:'gpt-6-astra',spendLimitUsd:2,...options});closers.push(p.close);return p;}
async function readSource(agent:Agent<any,any>,sourceId='guests',page:{offset?:number;limit?:number}={}){const sourceTool=agent.tools.find(t=>t.type==='function'&&t.name==='read_source');if(sourceTool?.type==='function')return sourceTool.invoke(new RunContext({}),JSON.stringify({id:sourceId,offset:page.offset??null,limit:page.limit??null}));}
afterEach(()=>{vi.restoreAllMocks();for(const close of closers.splice(0))close();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true});});

describe('bounded Agents SDK planner',()=>{
 it('rewrites one card through the same grounded, metered harness',async()=>{
  const cardRewrite={instruction:'Make access clearer.',card:{title:'Open the route',body:'Check dock access before unloading.'},otherCards:[{title:'Dinner service',body:'Keep the buffet open.',status:'approved' as const},{title:'Add two staff',body:'Bring in two extra staff.',status:'denied' as const}]};
  const p=planner({execute:async(agent,text)=>{expect(JSON.parse(text).cardRewrite).toEqual(cardRewrite);expect(String(agent.instructions)).toContain('SINGLE CARD REWRITE');await readSource(agent,'venue-access');return {finalOutput:{...output({}),evidenceIds:['venue-access'],actions:[action({kind:'plan',title:'Open the loading route',subject:null,recipient:null,body:'At 17:30, ask the setup lead to check the dock before unloading. Keep the guest entrance clear and preserve the approved dinner service. Earlier access still needs confirming; do not assume the two additional staff will be available.'})]},runContext:{usage:{inputTokens:600,outputTokens:150}}};}});
  const result=await p.plan({...planningInput,cardRewrite});expect(result.error).toBeUndefined();expect(result.actions?.[0].title).toBe('Open the loading route');expect(result.patch).toEqual({});expect(p.status().estimatedSpendUsd).toBe(0.0135);
 });

 it('rejects extra actions or initiating patches during a card rewrite',()=>{
  const request={...planningInput,cardRewrite:{instruction:'Shorten.',card:{title:'Access',body:'Check access.'},otherCards:[]}};
  expect(()=>sanitizePlan({...output({}),actions:[operatingPlan(),action()]},request)).toThrow('exactly one');expect(()=>sanitizePlan(output({attendance:300}),request)).toThrow('already committed');
 });

 it('supplies whole-plan polish context and direct card-writing instructions without a new API path',async()=>{
  const planPolish={title:'Old plan',body:'A long planning basis.'};const p=planner({execute:async(agent,text)=>{expect(JSON.parse(text).planPolish).toEqual(planPolish);expect(String(agent.instructions)).toContain('35–60 words');expect(String(agent.instructions)).toContain('Keep the room quiet for awards');expect(String(agent.instructions)).toContain('exactly ONE kind plan action');await readSource(agent,'venue-access');return {finalOutput:{...output({}),evidenceIds:['venue-access'],actions:[operatingPlan()]},runContext:{usage:{inputTokens:500,outputTokens:100}}};}});
  expect((await p.plan({...planningInput,planPolish})).error).toBeUndefined();
 });

 it('uses the explicit deterministic mode only when no key is configured',async()=>{
  let calls=0;const p=planner({apiKey:'',execute:async()=>{calls++;throw new Error('Unexpected model call');}});const result=await p.plan(input);
  expect(result.patch.attendance).toBe(300);expect(p.status().mode).toBe('demo');expect(calls).toBe(0);expect(p.status().estimatedSpendUsd).toBe(0);
 });

 it('uses Astra with bounded read-only tools and records reported token usage',async()=>{
  const p=planner({execute:async(agent,text,options)=>{
    expect(agent.model).toBe('gpt-6-astra');expect(agent.modelSettings.reasoning?.effort).toBe('medium');expect(agent.modelSettings.maxTokens).toBe(4000);
    expect(options.maxTurns).toBe(3);expect(options.signal).toBeInstanceOf(AbortSignal);expect(text.length).toBeLessThanOrEqual(100000);
    expect(agent.tools.map(tool=>tool.type==='function'?tool.name:tool.type)).toEqual(['read_event_context','read_source','read_event_history','calculate_budget']);
    await readSource(agent);
    return {finalOutput:output(),runContext:{usage:{inputTokens:1000,outputTokens:600}}};
  }});
  const result=await p.plan(input);expect(result.patch).toEqual({attendance:300});expect(result.model).toBe('gpt-6-astra');expect(p.status().estimatedSpendUsd).toBe(0.04);
 });

 it('repairs a semantic violation once without silently applying consequential changes',async()=>{
  let calls=0;const p=planner({execute:async(agent,text)=>{
    calls++;if(calls===2)expect(text).toContain('must not silently approve');
    await readSource(agent);
    return {finalOutput:output(calls===1?{attendance:300,staffCount:5}:{attendance:300}),runContext:{usage:{inputTokens:500,outputTokens:100}}};
  }});
  const result=await p.plan(input);expect(calls).toBe(2);expect(result.patch).toEqual({attendance:300});expect(p.status().estimatedSpendUsd).toBe(0.02);
 });

 it('never falls back to a demo interpretation or retries authentication failures',async()=>{
  let calls=0;const p=planner({execute:async()=>{calls++;throw Object.assign(new Error('Incorrect API key provided: sk-secret-never-show'),{status:401});}});
  const result=await p.plan(input);expect(calls).toBe(1);expect(result.patch).toEqual({});expect(result.error).toContain('authentication');expect(result.error).not.toContain('sk-');expect(p.status().mode).toBe('live');
  expect(p.status().estimatedSpendUsd).toBe(0);
 });

 it('bounds network retries with durable conservative reservations',async()=>{
  let calls=0;const p=planner({execute:async()=>{calls++;throw Object.assign(new Error('Connection error'),{status:503});}});
  const result=await p.plan(input);expect(calls).toBe(1);expect(result.error).toContain('local budget');expect(p.status().estimatedSpendUsd).toBe(0);expect(p.status().reservedSpendUsd).toBe(1.5);
  await p.plan(input);expect(calls).toBe(1);
 });

 it('settles completed SDK turns even when the turn limit is reached',async()=>{
  const p=planner({execute:async()=>{throw Object.assign(new Error('Maximum turns exceeded'),{name:'MaxTurnsExceededError',state:{usage:{inputTokens:1000,outputTokens:100}}});}});
  const result=await p.plan(input);expect(result.error).toContain('three-call limit');expect(p.status().estimatedSpendUsd).toBe(0.015);expect(p.status().reservedSpendUsd).toBe(0);
 });

 it('allows two minutes for a planning attempt and preserves an explicit timeout override',async()=>{
  const timeout=vi.spyOn(AbortSignal,'timeout');
  const execute:NonNullable<Parameters<typeof createPlanner>[0]>['execute']=async agent=>{await readSource(agent);return {finalOutput:output(),runContext:{usage:{inputTokens:500,outputTokens:100}}};};
  await planner({execute}).plan(input);expect(timeout).toHaveBeenLastCalledWith(120000);
  await planner({execute,timeoutMs:15}).plan(input);expect(timeout).toHaveBeenLastCalledWith(15);
 });

 it('persists bounded validation diagnostics without rejected private response content',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ripple-validation-'));dirs.push(dir);const dbPath=join(dir,'usage.sqlite');
  const p=planner({dbPath,execute:async agent=>{await readSource(agent);return {finalOutput:{...output({}),actions:[action({body:'private-rejected-body sk-never-record-this-secret'.repeat(300)})]},runContext:{usage:{inputTokens:500,outputTokens:100}}};}});
  expect((await p.plan(planningInput)).error).toContain('validation');
  const db=new DatabaseSync(dbPath,{readOnly:true});const rows=db.prepare('SELECT failure,metadata FROM ai_usage ORDER BY rowid').all() as Array<{failure:string;metadata:string}>;db.close();
  expect(rows).toHaveLength(2);
  for(const row of rows){const metadata=JSON.parse(row.metadata);expect(row.failure).toBe('validation');expect(metadata.validationFailure).toContain('actions.0.body');expect(metadata.validationFailure).toContain('too_big');expect(metadata.validationFailure.length).toBeLessThanOrEqual(500);expect(row.metadata).not.toContain('private-rejected-body');expect(row.metadata).not.toContain('sk-never');}
 });

 it('separates unknown reservations from known usage without discarding the cap',()=>{
  const ledger=new UsageLedger(':memory:',2_000_000);const a=ledger.reserve('gpt-6-astra')!;ledger.settle(a,{inputTokens:1000,outputTokens:100});ledger.reserve('gpt-6-astra');
  expect(ledger.costBreakdown()).toEqual({estimatedSpendUsd:0.015,reservedSpendUsd:1.5,totalCommittedUsd:1.515});expect(ledger.reserve('gpt-6-astra')).toBeUndefined();ledger.close();
 });

 it('disables only admission blocking while preserving an already blocked ledger exactly',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ripple-disabled-cap-'));dirs.push(dir);const dbPath=join(dir,'usage.sqlite');
  const ledger=new UsageLedger(dbPath,8_000_000);const known=ledger.reserve('gpt-6-astra',2_050_000)!;
  ledger.settle(known,{inputTokens:205000,outputTokens:0});const unknown=ledger.reserve('gpt-6-astra',5_400_000)!;ledger.settle(unknown,undefined,'timeout');ledger.close();
  const rows=()=>{const db=new DatabaseSync(dbPath,{readOnly:true});try{return db.prepare('SELECT * FROM ai_usage ORDER BY rowid').all();}finally{db.close();}};
  const original=rows();const execute=vi.fn(async(agent:Agent<any,any>)=>{await readSource(agent);return {finalOutput:output(),runContext:{usage:{inputTokens:1000,outputTokens:100}}};});
  const capped=planner({dbPath,spendLimitUsd:8,spendCapEnabled:true,execute});
  expect((await capped.plan(input)).error).toContain('local budget');expect(execute).not.toHaveBeenCalled();expect(rows()).toEqual(original);
  const uncapped=planner({dbPath,spendLimitUsd:8,spendCapEnabled:false,execute});
  expect(uncapped.status()).toMatchObject({spendCapEnabled:false,spendLimitUsd:8,estimatedSpendUsd:2.05,reservedSpendUsd:5.4});
  expect((await uncapped.plan(input)).error).toBeUndefined();expect(execute).toHaveBeenCalledTimes(1);
  expect(uncapped.status()).toMatchObject({spendCapEnabled:false,estimatedSpendUsd:2.065,reservedSpendUsd:5.4,totalCommittedUsd:7.465});
  expect(uncapped.status().lastError).toBeUndefined();expect(rows().slice(0,2)).toEqual(original);expect(rows()).toHaveLength(3);
 });

 it('retains request, turn and retry bounds with the local spending guard disabled',async()=>{
  const timeout=vi.spyOn(AbortSignal,'timeout');let calls=0;
  const p=planner({spendLimitUsd:0,spendCapEnabled:false,timeoutMs:321,execute:async(agent,_input,options)=>{
   calls++;expect(options.maxTurns).toBe(3);expect(agent.modelSettings.maxTokens).toBe(4000);expect(agent.modelSettings.retry?.maxRetries).toBe(0);
   throw Object.assign(new Error('Connection error'),{status:503});
  }});
  const result=await p.plan(input);expect(calls).toBe(2);expect(result.error).toContain('network');expect(result.error).not.toContain('local budget');
  expect(timeout).toHaveBeenCalledTimes(2);expect(timeout).toHaveBeenLastCalledWith(321);
  expect(p.status()).toMatchObject({spendCapEnabled:false,estimatedSpendUsd:0,reservedSpendUsd:3,totalCommittedUsd:3});
 });

 it('keeps a zero enabled cap blocking before any model request',async()=>{
  const execute=vi.fn(async()=>{throw new Error('Must not invoke the model');});const p=planner({spendLimitUsd:0,spendCapEnabled:true,execute});
  expect((await p.plan(input)).error).toContain('local budget');expect(execute).not.toHaveBeenCalled();expect(p.status()).toMatchObject({spendCapEnabled:true,estimatedSpendUsd:0,reservedSpendUsd:0});
 });

 it('does not retry capability, missing-model, quota, or timeout errors',()=>{
  for(const error of [Object.assign(new Error('Unsupported parameter'),{status:400}),Object.assign(new Error('Model unavailable'),{status:404}),Object.assign(new Error('Quota'),{code:'insufficient_quota'}),Object.assign(new Error('Timeout'),{name:'TimeoutError'})])expect(classifyFailure(error).retryable).toBe(false);
 });

 it('rejects invented evidence and a premature new-vendor price',()=>{
  expect(()=>sanitizePlan({...output(),evidenceIds:['invented-contract']},input)).toThrow('Evidence references');
  expect(()=>sanitizePlan({...output({caterer:'CAVA',cateringPerPersonCents:2600}),evidenceIds:['catering-cava']},{...input,area:'catering'})).toThrow('before their quote');
 });

 it('redacts secrets from error text before exposing them to the UI or repair context',()=>{
  const result=sanitize('API error sk-proj-abcdef_123 Authorization: Bearer a-secret-value api_key=another-secret');
  expect(result).not.toContain('abcdef');expect(result).not.toContain('a-secret-value');expect(result).not.toContain('another-secret');expect(result).toContain('[redacted');
 });

 it('rejects citations that merely name a source without actually reading it',async()=>{
  let calls=0;const p=planner({execute:async()=>{calls++;return {finalOutput:output(),runContext:{usage:{inputTokens:500,outputTokens:100}}};}});
  const result=await p.plan(input);expect(calls).toBe(2);expect(result.patch).toEqual({});expect(result.error).toContain('validation');
 });

 it('persists usage and unfinished reservations across ledger restarts',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ripple-ai-test-'));dirs.push(dir);const path=join(dir,'ai.sqlite');
  let ledger=new UsageLedger(path,2_000_000);const known=ledger.reserve('gpt-6-astra')!;ledger.settle(known,{inputTokens:1000,outputTokens:100});const pending=ledger.reserve('gpt-6-astra');expect(pending).toBeTruthy();ledger.close();
  ledger=new UsageLedger(path,2_000_000);expect(ledger.spentMicroUsd()).toBe(1_515_000);expect(ledger.reserve('gpt-6-astra')).toBeUndefined();ledger.close();
 });

 it('returns a concrete operating draft and a source-grounded inquiry after reading their sources',async()=>{
  const actions=[operatingPlan(),action()];
  const p=planner({execute:async agent=>{await readSource(agent);await readSource(agent,'venue-access');return {finalOutput:{...output({}),actions},runContext:{usage:{inputTokens:800,outputTokens:300}}};}});
  const result=await p.plan(planningInput);expect(result.error).toBeUndefined();expect(result.patch).toEqual({});expect(result.actions).toEqual(actions);
 });

 it('preserves a complete plan beyond the old 4000-character ceiling with its full evidence set',()=>{
  const extra='\nBefore doors: the proposed service lead checks the documented route and reports any unresolved access issue; this remains an approval gate, not a claim of confirmed availability.';
  const draft={...operatingPlan(),body:operatingPlan().body+extra.repeat(24)+'\nFinal step: finish the service handoff before releasing either staff member.',evidenceIds:planningInput.sources.slice(0,8).map(source=>source.id)};
  expect(draft.body.length).toBeGreaterThan(4000);expect(draft.body.length).toBeLessThan(8000);expect(draft.evidenceIds).toHaveLength(8);
  const result=sanitizePlan({...output({}),actions:[draft]},planningInput);expect(result.actions![0].body).toBe(draft.body);expect(result.actions![0].evidenceIds).toEqual(draft.evidenceIds);
 });

 it('exposes authoritative facts and existing decisions through the context tool',async()=>{
  const existingDecisions:NonNullable<Parameters<Planner>[0]['existingDecisions']>=[{title:'Standard guest-count update',kind:'email',status:'pending',area:'staff',description:'This routine notification is already prepared.',body:'Confirm the current headcount with the staff.'}];
  const p=planner({execute:async(agent,text)=>{
    const initial=JSON.parse(text);expect(initial.structuredOnly).toBe(true);expect(initial.facts).toEqual(input.facts);expect(initial.decisionIndex[0].title).toBe(existingDecisions[0].title);
    const context=agent.tools.find(t=>t.type==='function'&&t.name==='read_event_context');if(context?.type!=='function')throw new Error('Missing context tool');
    const seen=JSON.parse(String(await context.invoke(new RunContext({}),'{}')));expect(seen.facts).toEqual(input.facts);expect(seen.decisionIndex).toEqual(initial.decisionIndex);
    const history=agent.tools.find(t=>t.type==='function'&&t.name==='read_event_history');if(history?.type!=='function')throw new Error('Missing history tool');
    const decisions=JSON.parse(String(await history.invoke(new RunContext({}),JSON.stringify({kind:'decisions',offset:null,limit:null}))));expect(decisions.items).toEqual(existingDecisions);
    await readSource(agent);return {finalOutput:output({}),runContext:{usage:{inputTokens:600,outputTokens:100}}};
  }});
  expect((await p.plan({...planningInput,existingDecisions})).error).toBeUndefined();
  expect(()=>sanitizePlan(output({attendance:301}),planningInput)).toThrow('already committed');
 });

 it('requires action evidence to exist and an exact single contact in a cited document',()=>{
  expect(()=>sanitizePlan({...output({}),actions:[action({evidenceIds:['invented']})]},planningInput)).toThrow('Action evidence');
  for(const recipient of ['invented@venue.example','operations@venue.example.evil','operations@venue.example, extra@example.net','Venue <operations@venue.example>'])expect(()=>sanitizePlan({...output({}),actions:[action({recipient})]},planningInput)).toThrow();
  expect(()=>sanitizePlan({...output({}),actions:[action({evidenceIds:['guests']})]},planningInput)).toThrow('verbatim');
 });

 it('does not accept action citations merely because the source ID was supplied',async()=>{
  let calls=0;const p=planner({execute:async agent=>{calls++;await readSource(agent);return {finalOutput:{...output({}),actions:[operatingPlan()]},runContext:{usage:{inputTokens:500,outputTokens:100}}};}});
  const result=await p.plan(planningInput);expect(calls).toBe(2);expect(result.error).toContain('validation');expect(result.actions).toBeUndefined();
 });

 it('rejects a contact hidden beyond the source text actually returned by the tool',async()=>{
  const longSource={...accessSource,content:'A'.repeat(30000)+'\nContact operations@venue.example.'};
  const p=planner({execute:async agent=>{await readSource(agent);await readSource(agent,'venue-access');return {finalOutput:{...output({}),actions:[action()]},runContext:{usage:{inputTokens:500,outputTokens:100}}};}});
  expect((await p.plan({...planningInput,sources:[...input.sources,longSource]})).error).toContain('validation');
 });

 it('reads all document pages without clipping and counts a source only after gap-free coverage',async()=>{
  const longSource={...accessSource,content:'Access notes.\n'+'A'.repeat(30000)+'\nContact operations@venue.example.'};
  const p=planner({execute:async agent=>{
    await readSource(agent);
    const later=JSON.parse(String(await readSource(agent,'venue-access',{offset:24000,limit:24000})));expect(later.content).toBe(longSource.content.slice(24000));expect(later.nextOffset).toBeNull();expect(later.complete).toBe(false);
    const earlier=JSON.parse(String(await readSource(agent,'venue-access',{offset:0,limit:24000})));expect(earlier.content).toHaveLength(24000);expect(earlier.nextOffset).toBe(24000);
    return {finalOutput:{...output({}),actions:[action()]},runContext:{usage:{inputTokens:500,outputTokens:100}}};
  }});
  expect((await p.plan({...planningInput,sources:[...input.sources,longSource]})).error).toBeUndefined();
 });

 it('exposes complete reply, Undo, receipt and decision history in explicit pages',async()=>{
  const longBody='Preserved full vendor reply. '+ 'Details '.repeat(1800);
  const existingDecisions:NonNullable<Parameters<Planner>[0]['existingDecisions']>=Array.from({length:28},(_,i)=>({title:`Decision ${i}`,kind:'plan',status:i===0?'denied':'applied',area:'brief',description:`Original decision ${i}`,body:longBody}));
  const context:NonNullable<Parameters<Planner>[0]['context']>={projectName:'Annual dinner',revision:28,budget:{totalCents:1596000,lines:[]},messages:[{id:'reply',at:'2026-09-20T00:00:00Z',from:'vendor@example.net',subject:'Vendor reply',body:longBody,direction:'inbound',simulated:false}],activity:[{id:'undo',at:'2026-09-20T00:01:00Z',title:'Undid venue change',detail:'Restored the earlier room.',status:'complete'}],receipts:[{id:'receipt',at:'2026-09-20T00:00:00Z',title:'Quote request delivered',provider:'Gmail',status:'delivered',detail:'Verified delivery.'}],connections:[{name:'Email',mode:'live',detail:'Configured'}],workflow:null};
  const p=planner({execute:async(agent,text)=>{
    const initial=JSON.parse(text);expect(initial.projectName).toBe(context.projectName);expect(initial.budget).toEqual(context.budget);expect(initial.decisionIndex).toHaveLength(28);expect(initial.historyCounts).toEqual({decisions:28,messages:1,activity:1,receipts:1});
    const tool=agent.tools.find(t=>t.type==='function'&&t.name==='read_event_history');if(tool?.type!=='function')throw new Error('Missing history tool');
    for(const kind of ['messages','activity','receipts'] as const){const page=JSON.parse(String(await tool.invoke(new RunContext({}),JSON.stringify({kind,offset:null,limit:null}))));expect(page.items).toEqual(context[kind]);expect(page.nextOffset).toBeNull();}
    const page=JSON.parse(String(await tool.invoke(new RunContext({}),JSON.stringify({kind:'decisions',offset:26,limit:1}))));expect(page.items[0]).toEqual(existingDecisions[26]);expect(page.nextOffset).toBe(27);expect(page.total).toBe(28);
    await readSource(agent);return {finalOutput:output({}),runContext:{usage:{inputTokens:600,outputTokens:100}}};
  }});
  expect((await p.plan({...planningInput,existingDecisions,context})).error).toBeUndefined();
 });

 it('reports insufficient context explicitly instead of returning a clipped document',async()=>{
  const oversized={...accessSource,content:'X'.repeat(80000)};
  const p=planner({execute:async agent=>{
    await readSource(agent);const first=JSON.parse(String(await readSource(agent,'venue-access',{limit:60000})));expect(first.content).toHaveLength(60000);
    const repeated=JSON.parse(String(await readSource(agent,'venue-access',{limit:60000})));expect(repeated.error).toBe('context_budget_exceeded');expect(repeated.content).toBeUndefined();
    return {finalOutput:{...output({}),actions:[]},runContext:{usage:{inputTokens:600,outputTokens:100}}};
  }});
  expect((await p.plan({...planningInput,sources:[...input.sources,oversized]})).error).toBeUndefined();
 });

 it.each([
  'Please cancel our equipment rental and release the remaining charge.',
  'Could you book the room for our event and send over the contract?',
  'We accept your quote of $8,000 and authorize the payment today.',
  'Please proceed with the booking based on the price you provided.',
  'Our booking is confirmed. Please tell us where to park on arrival.',
 ])('rejects generated commitment email: %s',body=>{
  expect(()=>sanitizePlan({...output({}),actions:[action({body})]},planningInput)).toThrow('commitments');
 });

 it('allows an inquiry about cancellation terms without authorizing a cancellation',()=>{
  const question=action({body:'Hi team, could you clarify whether a cancellation fee applies if the setup window is unavailable? We are comparing options before deciding on any change.'});
  expect(sanitizePlan({...output({}),actions:[question]},planningInput).actions).toEqual([question]);
 });

 it('rejects vague plans, plan recipients, duplicate work and unsolicited announcements',()=>{
  expect(()=>sanitizePlan({...output({}),actions:[operatingPlan(),action(),action({title:'Third action'})]},planningInput)).toThrow();
  expect(()=>sanitizePlan({...output({}),actions:[action({kind:'plan',subject:null,recipient:null,body:'Check the setup arrangements and make an operating plan for the team.'})]},planningInput)).toThrow('ready-to-use');
  expect(()=>sanitizePlan({...output({}),actions:[operatingPlan(),operatingPlan()]},planningInput)).toThrow('duplicate');
  expect(()=>sanitizePlan({...output({}),actions:[action({kind:'plan'})]},planningInput)).toThrow('local draft');
  expect(()=>sanitizePlan({...output({}),actions:[action({body:'Hi team, the guest count is now 300 and the venue has changed. We look forward to the dinner.'})]},planningInput)).toThrow('inquiries');
  const existingDecisions:NonNullable<Parameters<Planner>[0]['existingDecisions']>=[{title:action().title,kind:'email',status:'denied',area:'venue',description:'Declined this inquiry.'}];
  expect(()=>sanitizePlan({...output({}),actions:[action()]},{...planningInput,existingDecisions})).toThrow('existing or declined');
 });
});
