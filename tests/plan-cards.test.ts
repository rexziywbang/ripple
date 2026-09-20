import {afterEach,describe,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createService} from '../server/domain.js';
import {cardsMarkdown,planCards,updateCard} from '../server/plan-cards.js';
import type {Planner,PlanResult,ProjectState,Proposal} from '../shared/types.js';

const body='## Setup gate\n\nAt 17:30, the proposed setup lead checks dock access before unloading. Keep guest access clear and hold unloading if the venue cannot open the documented route. Staff ownership remains to be confirmed.\n\n## Service sequence\n\nKeep the buffet running during the speech. The proposed service lead watches the queue while the host introduces the speaker. Confirm the vendor can maintain service with the existing team; this plan does not book additional staff.\n\n## Guest arrival\n\nThe proposed welcome lead opens the guest route after setup clears it. Use the documented attendance and avoid directing guests through the unloading area.\n\n## Recovery\n\nIf access slips, hold service setup until the venue confirms a safe route. Preserve the current guest arrival time unless the organizer separately approves a schedule change.';
const planResult=(text=body):PlanResult=>({patch:{},summary:'Prepared an operating plan.',questions:[],evidenceIds:['venue-garden'],actions:[{kind:'plan',title:'Evening operations',reason:'Sequence setup and service using the current venue arrangements.',area:'brief',evidenceIds:['venue-garden'],body:text,subject:null,recipient:null}]});
const services:Array<ReturnType<typeof createService>>=[];const dirs:string[]=[];
function service(planner:Planner=async()=>planResult(),dbPath=':memory:'){
  const api=createService({dbPath,planner,aiStatus:()=>({mode:'demo',model:'test',fallbackModel:'test',estimatedSpendUsd:0,spendLimitUsd:6})});services.push(api);return api;
}
async function ready(planner?:Planner,dbPath?:string){const api=service(planner,dbPath);const id=api.getState().project.id;api.edit(id,{area:'brief',patch:{notes:'The speaker needs a continuous dinner service.'}});await api.tick();const proposal=api.getState().proposals.find(p=>p.kind==='plan'&&p.status==='pending')!;return {api,id,proposal};}
const current=(state:ProjectState,id:string)=>state.proposals.find(p=>p.id===id)!;
const source=(state:ProjectState,id:string)=>state.sources.find(s=>s.id===`approved-plan:${id}`);
afterEach(()=>{for(const api of services.splice(0))try{api.close();}catch{}for(const dir of dirs.splice(0))rmSync(dir,{recursive:true});});

describe('operating plan decision cards',()=>{
 it('splits markdown into stable cards without discarding legacy text',()=>{
  const proposal={id:'old',title:'Run of show',body,status:'pending' as const};const cards=planCards(proposal);
  expect(cards.map(card=>card.title)).toEqual(['Setup gate','Service sequence','Guest arrival','Recovery']);expect(planCards(proposal)).toEqual(cards);expect(cardsMarkdown(cards)).toBe(body);
  const legacy=planCards({...proposal,body:'Assumption: access is unconfirmed.\n1. Stage cases outside the room.\n2. Keep the entrance clear.'});expect(legacy).toHaveLength(3);expect(cardsMarkdown(legacy)).toContain('Assumption: access is unconfirmed.');expect(cardsMarkdown(legacy)).toContain('2. Keep the entrance clear.');
  expect(updateCard(cards[0],{body:'Revised content'}).revisionToken).not.toBe(cards[0].revisionToken);
 });

 it('saves only explicitly approved sections and resolves mixed choices without sending messages',async()=>{
  const {api,id,proposal}=await ready();const cards=proposal.planCards!;let state=api.decideCard(id,proposal.id,cards[0].id,'approve',cards[0].revisionToken);
  expect(current(state,proposal.id).status).toBe('pending');expect(source(state,proposal.id)?.content).toContain('Setup gate');expect(source(state,proposal.id)?.content).not.toContain('Service sequence');
  state=api.decideCard(id,proposal.id,cards[1].id,'deny',cards[1].revisionToken);
  for(const card of cards.slice(2))state=api.decideCard(id,proposal.id,card.id,'approve',card.revisionToken);
  expect(current(state,proposal.id).status).toBe('applied');expect(source(state,proposal.id)?.content).not.toContain('Service sequence');expect(state.messages).toHaveLength(0);expect(state.receipts.filter(r=>r.proposalId===proposal.id)).toHaveLength(3);
  expect(()=>api.decideCard(id,proposal.id,cards[0].id,'approve',cards[0].revisionToken)).toThrow();expect(api.getState().receipts).toEqual(state.receipts);
 });

 it('denies every card without creating a saved plan',async()=>{
  const {api,id,proposal}=await ready();for(const card of proposal.planCards!)api.decideCard(id,proposal.id,card.id,'deny',card.revisionToken);
  expect(current(api.getState(),proposal.id).status).toBe('denied');expect(source(api.getState(),proposal.id)).toBeUndefined();
 });

 it('persists partial choices across restart and initializes legacy proposals once',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ripple-cards-'));dirs.push(dir);const path=join(dir,'state.sqlite');let {api,id,proposal}=await ready(undefined,path);api.close();
  const db=new DatabaseSync(path);const row=db.prepare('SELECT state FROM projects WHERE id=?').get(id) as {state:string};const state=JSON.parse(row.state);delete state.state.proposals.find((p:Proposal)=>p.id===proposal.id).planCards;db.prepare('UPDATE projects SET state=? WHERE id=?').run(JSON.stringify(state),id);db.close();
  api=service(undefined,path);const legacy=current(api.getState(),proposal.id).planCards!;expect(legacy).toHaveLength(4);api.decideCard(id,proposal.id,legacy[0].id,'approve',legacy[0].revisionToken);api.close();
  api=service(undefined,path);expect(current(api.getState(),proposal.id).planCards?.[0].status).toBe('approved');expect(source(api.getState(),proposal.id)?.content).toContain('Setup gate');
 });

 it('keeps whole-plan approval compatible while excluding previously denied sections',async()=>{
  const {api,id,proposal}=await ready();const denied=proposal.planCards![1];api.decideCard(id,proposal.id,denied.id,'deny',denied.revisionToken);api.decide(id,proposal.id,'approve');await api.tick();
  const state=api.getState();expect(current(state,proposal.id).status).toBe('applied');expect(current(state,proposal.id).planCards?.filter(card=>card.status==='approved')).toHaveLength(3);expect(source(state,proposal.id)?.content).not.toContain('Service sequence');
 });

 it('rewrites repeatedly, includes reviewed sibling cards, and requires the newest token',async()=>{
  let rewrites=0;const {api,id,proposal}=await ready(async input=>{
   if(!input.cardRewrite)return planResult();rewrites++;expect(input.structuredOnly).toBe(true);expect(input.context?.projectName).toBe('Christmas dinner');expect(input.cardRewrite.otherCards).toEqual(expect.arrayContaining([expect.objectContaining({status:'approved'}),expect.objectContaining({status:'denied'})]));return planResult(`Revision ${rewrites}. Keep the approved setup gate in place. Ask the proposed welcome lead to direct guests along the cleared route and preserve the existing service schedule. No extra staff or bookings are assumed.`);
  });
  const cards=proposal.planCards!;api.decideCard(id,proposal.id,cards[0].id,'approve',cards[0].revisionToken);api.decideCard(id,proposal.id,cards[1].id,'deny',cards[1].revisionToken);
  let state=await api.rewritePlanCard(id,proposal.id,cards[2].id,{instruction:'Make the arrival step clearer.',revisionToken:cards[2].revisionToken});const revised=current(state,proposal.id).planCards![2];expect(revised.status).toBe('pending');expect(revised.revision).toBe(2);expect(source(state,proposal.id)?.content).not.toContain('Revision 1');
  await expect(api.rewritePlanCard(id,proposal.id,cards[2].id,{instruction:'Again',revisionToken:cards[2].revisionToken})).rejects.toThrow('changed');expect(rewrites).toBe(1);
  state=await api.rewritePlanCard(id,proposal.id,cards[2].id,{instruction:'Use shorter sentences.',revisionToken:revised.revisionToken});expect(current(state,proposal.id).planCards![2].body).toContain('Revision 2');expect(rewrites).toBe(2);
 });

 it('rejects a rewrite if another card is decided while the model is working',async()=>{
  let release!:(result:PlanResult)=>void;const gate=new Promise<PlanResult>(resolve=>{release=resolve;});const {api,id,proposal}=await ready(async input=>input.cardRewrite?gate:planResult());const cards=proposal.planCards!;
  const pending=api.rewritePlanCard(id,proposal.id,cards[0].id,{instruction:'Clarify access.',revisionToken:cards[0].revisionToken});api.decideCard(id,proposal.id,cards[1].id,'deny',cards[1].revisionToken);release(planResult('Revised access draft with a proposed setup lead checking the route before unloading and keeping guests outside the loading zone until safe access has been confirmed.'));
  await expect(pending).rejects.toThrow('changed while');expect(current(api.getState(),proposal.id).planCards![0].body).toBe(cards[0].body);
 });

 it('invalidates a rewrite and a partially saved plan when event facts change',async()=>{
  let release!:(result:PlanResult)=>void;const gate=new Promise<PlanResult>(resolve=>{release=resolve;});const {api,id,proposal}=await ready(async input=>input.cardRewrite?gate:planResult());const cards=proposal.planCards!;api.decideCard(id,proposal.id,cards[0].id,'approve',cards[0].revisionToken);
  const pending=api.rewritePlanCard(id,proposal.id,cards[1].id,{instruction:'Shorten service.',revisionToken:cards[1].revisionToken});api.edit(id,{area:'guests',patch:{attendance:300}});release(planResult('A revised service card using the current guest queue and proposed roles, with no extra staff or invented contracts and a clear venue access confirmation gate.'));
  await expect(pending).rejects.toThrow('no longer');expect(current(api.getState(),proposal.id).status).toBe('stale');expect(source(api.getState(),proposal.id)?.content).toBe('');expect(api.getState().receipts.some(r=>r.proposalId===proposal.id)).toBe(true);
 });

 it('preserves the card and earlier approvals when rewriting fails',async()=>{
  const {api,id,proposal}=await ready(async input=>input.cardRewrite?{patch:{},summary:'Unchanged',questions:[],evidenceIds:[],error:'Local model budget reached.'}:planResult());const card=proposal.planCards![0];await expect(api.rewritePlanCard(id,proposal.id,card.id,{instruction:'Simplify.',revisionToken:card.revisionToken})).rejects.toThrow('budget');expect(current(api.getState(),proposal.id).planCards![0]).toEqual(card);
 });

 it('polishes all untouched cards in one call with the full event context',async()=>{
  let calls=0;const {api,id,proposal}=await ready(async input=>{if(!input.planPolish)return planResult();calls++;expect(input.existingDecisions?.some(p=>p.title==='Evening operations')).toBe(false);expect(input.context?.budget.totalCents).toBe(1596000);expect(input.planPolish.body).toBe(body);const result=planResult(body.replace('Setup gate','Open the loading route').replace('Service sequence','Keep dinner moving'));result.actions![0].reason='Keep arrival and dinner on time.';return result;});
  const state=await api.polishPlan(id,proposal.id);const updated=current(state,proposal.id);expect(calls).toBe(1);expect(updated.description).toBe('Keep arrival and dinner on time.');expect(updated.planCards).toHaveLength(4);expect(updated.planCards![0].title).toBe('Open the loading route');expect(updated.planCards!.every(card=>card.status==='pending')).toBe(true);expect(updated.planCards![0].revisionToken).not.toBe(proposal.planCards![0].revisionToken);expect(source(state,proposal.id)).toBeUndefined();
 });

 it('refuses whole-plan polish after any card choice without spending a model call',async()=>{
  let calls=0;const {api,id,proposal}=await ready(async input=>{if(input.planPolish)calls++;return planResult();});const card=proposal.planCards![0];api.decideCard(id,proposal.id,card.id,'deny',card.revisionToken);await expect(api.polishPlan(id,proposal.id)).rejects.toThrow('untouched');expect(calls).toBe(0);
 });

 it('rejects a whole-plan polish if event details change in flight',async()=>{
  let release!:(result:PlanResult)=>void;const gate=new Promise<PlanResult>(resolve=>{release=resolve;});const {api,id,proposal}=await ready(async input=>input.planPolish?gate:planResult());const pending=api.polishPlan(id,proposal.id);api.edit(id,{area:'brief',patch:{time:'19:00'}});release(planResult());await expect(pending).rejects.toThrow('untouched');expect(current(api.getState(),proposal.id).body).toBe(body);
 });
});
