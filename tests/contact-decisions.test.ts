import {afterEach,describe,expect,it} from 'vitest';
import {createService,fallbackPlan} from '../server/domain.js';
import {createLiveBridge} from '../server/live-bridge.js';
import type {ContactResult} from '../server/contact-research.js';

const services:Array<ReturnType<typeof createService>>=[];const bridges:Array<ReturnType<typeof createLiveBridge>>=[];
const discovered=(email='support@shahshalalfood.com'):ContactResult=>({status:'found',entity:{name:'Shah’s Halal Food — Boston (Cambridge Street)',address:'106 Cambridge Street, Boston, MA',kind:'catering'},candidates:[{name:'Shah’s',email,url:'https://www.shahshalalfood.com/boston-ma/',excerpt:'Public brand support contact',confidence:'brand',requiresReview:true,scope:'General brand support'}],alternatives:[],checkedUrls:['https://www.shahshalalfood.com/boston-ma/'],checkedAt:new Date().toISOString(),message:'General support contact found.'});
function setup(live=false){const bridge=live?createLiveBridge({dbPath:':memory:'}):undefined;if(bridge)bridges.push(bridge);const api=createService({dbPath:':memory:',planner:async input=>fallbackPlan(input),aiStatus:()=>({mode:'demo',model:'test',fallbackModel:'test',estimatedSpendUsd:0,spendLimitUsd:6}),bridge});services.push(api);const id=api.getState().project.id;if(bridge)bridge.configure(id,{emailAccount:'planner@example.net',testRecipient:'recipient@example.net'});return {api,id,bridge};}
afterEach(()=>{services.splice(0).forEach(api=>api.close());bridges.splice(0).forEach(bridge=>bridge.close());});
const headcount=(api:ReturnType<typeof createService>)=>api.getState().proposals.filter(p=>p.kind==='email'&&p.area==='catering'&&p.title==='Confirm the new catering headcount');
async function budgetUndo(api:ReturnType<typeof createService>,id:string){const edited=api.edit(id,{area:'budget',patch:{budgetLimitCents:2000000}});const changeId=edited.activity.find(a=>a.canUndo)!.changeId!;await api.tick();api.undo(id,changeId);}

describe('contact discovery preserves reviewed email intent',()=>{
 it.each(['approve','deny'] as const)('keeps a prior %s decision when contact discovery is followed by unrelated Undo',async decision=>{
  const {api,id}=setup();api.edit(id,{area:'guests',patch:{attendance:300}});await api.tick();const original=headcount(api)[0];api.decide(id,original.id,decision);await api.tick();const reviewed=headcount(api)[0];
  api.applyContactResearch(id,{kind:'catering',name:'Shah Halal'},discovered());await budgetUndo(api,id);
  expect(headcount(api)).toHaveLength(1);expect(headcount(api)[0]).toMatchObject({id:reviewed.id,status:reviewed.status,recipient:reviewed.recipient,body:reviewed.body});
  api.edit(id,{area:'guests',patch:{attendance:310}});await api.tick();const fresh=headcount(api).filter(p=>p.status==='pending');expect(fresh).toHaveLength(1);expect(fresh[0].recipient).toBe('support@shahshalalfood.com');expect(fresh[0].body).toContain('310');
 });
 it('keeps an approved browser job immutable through repeated contact changes and Undo',async()=>{
  const {api,id,bridge}=setup(true);api.edit(id,{area:'guests',patch:{attendance:300}});await api.tick();let original=headcount(api)[0];api.applyContactResearch(id,{kind:'catering',name:'Shah Halal'},discovered());const routed=headcount(api)[0];expect(routed.approvalToken).not.toBe(original.approvalToken);expect(()=>api.decide(id,routed.id,'approve',original.approvalToken)).toThrow('preview changed');api.decide(id,routed.id,'approve',routed.approvalToken);await api.tick();const job=structuredClone(bridge!.listJobs(id)[0]);
  api.applyContactResearch(id,{kind:'catering',name:'Shah Halal'},discovered('events@shahshalalfood.com'));await budgetUndo(api,id);
  expect(headcount(api)).toHaveLength(1);expect(bridge!.listJobs(id)).toEqual([job]);expect(headcount(api)[0].body).toBe(routed.body);expect(headcount(api)[0].originalRecipient).toBe('support@shahshalalfood.com');
 });
});
