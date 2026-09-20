import {afterEach,describe,expect,it} from 'vitest';
import {createService,fallbackPlan} from '../server/domain.js';
import type {ProjectState} from '../shared/types.js';

const services:Array<ReturnType<typeof createService>>=[];
function setup(mailMode:'live'|'rehearsal'='rehearsal'){
 const api=createService({dbPath:':memory:',mailMode,planner:async input=>fallbackPlan(input),aiStatus:()=>({mode:'demo',model:'test',fallbackModel:'test',estimatedSpendUsd:0,spendLimitUsd:6})});services.push(api);
 return {api,id:api.getState().project.id};
}
afterEach(()=>services.splice(0).forEach(api=>api.close()));
function quote(overrides:Partial<{vendor:string;date:string;guests:number;rate:number;delivery:number}>={}){
 const values={vendor:'Maple Table Catering',date:'2026-12-11',guests:240,rate:2750,delivery:18000,...overrides};
 return `# Catering quote\nVendor: ${values.vendor}\nEvent date: ${values.date}\nGuests: ${values.guests}\nPer person: USD ${(values.rate/100).toFixed(2)}\nDelivery: USD ${(values.delivery/100).toFixed(2)}\nTotal: USD ${((values.guests*values.rate+values.delivery)/100).toFixed(2)}`;
}
const document=(content=quote())=>[{path:'Catering/Maple Table quote.md',content}];
const activeInquiries=(state:ProjectState)=>state.proposals.filter(p=>p.kind==='email'&&['pending','approved','blocked'].includes(p.status)&&/^Request a quote from/.test(p.title));
const booking=(state:ProjectState)=>state.proposals.find(p=>p.status==='pending'&&p.title==='Request booking with Maple Table Catering');
async function selectVendor(api:ReturnType<typeof createService>,id:string){api.edit(id,{area:'catering',patch:{caterer:'Maple Table Catering'}});await api.tick();}

describe('catering quote reuse from event materials',()=>{
 it('fills a matching imported quote for an arbitrary vendor without booking or another inquiry',async()=>{
  const {api,id}=setup();await selectVendor(api,id);const state=api.importDropboxMaterials(id,document());
  expect(state.project.facts).toMatchObject({caterer:'Maple Table Catering',cateringPerPersonCents:2750,cateringDeliveryCents:18000,cateringStatus:'quoted'});
  expect(state.budget.lines.find(line=>line.label==='Maple Table Catering catering')).toMatchObject({amountCents:678000,status:'quoted'});
  expect(activeInquiries(state)).toHaveLength(0);expect(state.messages).toHaveLength(0);
  const review=booking(state);expect(review).toBeDefined();expect(review!.evidence.some(sourceId=>state.sources.some(source=>source.id===sourceId&&source.material?.path===document()[0].path))).toBe(true);
 });
 it('uses an already imported current quote when the organizer selects its vendor',async()=>{
  const {api,id}=setup();api.importDropboxMaterials(id,document());await selectVendor(api,id);const state=api.getState();
  expect(state.project.facts).toMatchObject({cateringStatus:'quoted',cateringPerPersonCents:2750,cateringDeliveryCents:18000});expect(activeInquiries(state)).toHaveLength(0);expect(booking(state)).toBeDefined();
 });
 it.each([
  ['different event date',()=>quote({date:'2026-12-12'})],
  ['different headcount',()=>quote({guests:250})],
  ['different vendor',()=>quote({vendor:'Another Catering Company'})],
  ['missing delivery',()=>quote().replace(/^Delivery:.*\n/m,'')],
  ['a request rather than a quote',()=>`# Quote request\nPlease quote the following proposed catering budget; these are our requested prices, not a vendor offer.\n${quote().replace('# Catering quote\n','')}`],
 ] as const)('keeps the forecast unchanged for %s',async(_label,content)=>{
  const {api,id}=setup();await selectVendor(api,id);const before=api.getState().project.facts;const state=api.importDropboxMaterials(id,document(content()));
  expect(state.project.facts.cateringPerPersonCents).toBe(before.cateringPerPersonCents);expect(state.project.facts.cateringDeliveryCents).toBe(before.cateringDeliveryCents);expect(state.project.facts.cateringStatus).toBe('awaiting_quote');expect(booking(state)).toBeUndefined();
 });
 it('keeps a previously sent current quote inquiry instead of generating a duplicate on import',async()=>{
  const {api,id}=setup();await selectVendor(api,id);const request=activeInquiries(api.getState())[0];expect(request).toBeDefined();api.decide(id,request.id,'approve');await api.tick();
  const before=api.getState();expect(before.proposals.find(p=>p.id===request.id)?.status).toBe('applied');expect(before.messages).toHaveLength(1);
  api.importDropboxMaterials(id,[{path:'Brief/Service notes.md',content:'# Service notes\nKeep the awards segment quiet.'}]);await api.tick();const state=api.getState();
  expect(state.proposals.filter(p=>p.title===request.title&&!['stale','withdrawn'].includes(p.status))).toHaveLength(1);expect(state.proposals.find(p=>p.id===request.id)?.status).toBe('applied');expect(activeInquiries(state)).toHaveLength(0);expect(state.messages).toEqual(before.messages);
 });
 it('reuses an ordinary current headcount confirmation without inventing a second price inquiry',async()=>{
  const {api,id}=setup();api.edit(id,{area:'guests',patch:{attendance:300}});await api.tick();const request=api.getState().proposals.find(p=>p.status==='pending'&&p.title==='Confirm the new catering headcount')!;expect(request).toBeDefined();api.decide(id,request.id,'approve');await api.tick();const before=api.getState();
  api.importDropboxMaterials(id,[{path:'Brief/Agenda.md',content:'# Agenda\nDinner and employee recognition.'}]);await api.tick();const state=api.getState();
  expect(state.messages).toEqual(before.messages);expect(state.proposals.filter(p=>p.status==='pending'&&p.kind==='email'&&p.area==='catering')).toHaveLength(0);
 });
 it('reimporting identical quote bytes is idempotent for proposals, revision, receipts, and activity',async()=>{
  const {api,id}=setup();await selectVendor(api,id);const first=api.importDropboxMaterials(id,document());const second=api.importDropboxMaterials(id,document());
  expect(second).toEqual(first);expect(second.proposals.filter(p=>p.title==='Request booking with Maple Table Catering'&&p.status==='pending')).toHaveLength(1);
 });
 it.each(['rehearsal','live'] as const)('uses fictional scenario quote amounts only in rehearsal (%s)',async mailMode=>{
  const {api,id}=setup(mailMode);await selectVendor(api,id);const state=api.importDropboxMaterials(id,document(),'fictional_scenario');
  if(mailMode==='rehearsal')expect(state.project.facts).toMatchObject({cateringStatus:'quoted',cateringPerPersonCents:2750,cateringDeliveryCents:18000});
  else {expect(state.project.facts.cateringStatus).toBe('awaiting_quote');expect(state.project.facts.cateringPerPersonCents).toBe(2400);expect(booking(state)).toBeUndefined();}
 });
 it('does not replace quote amounts once the reviewed booking request is in progress',async()=>{
  const {api,id}=setup();await selectVendor(api,id);const imported=api.importDropboxMaterials(id,document());const request=booking(imported);expect(request).toBeDefined();api.decide(id,request!.id,'approve');await api.tick();const before=api.getState();expect(before.project.facts.cateringStatus).toBe('awaiting_confirmation');
  const state=api.importDropboxMaterials(id,document(quote({rate:3000,delivery:25000})));
  expect(state.project.facts).toMatchObject({cateringPerPersonCents:2750,cateringDeliveryCents:18000,cateringStatus:'awaiting_confirmation'});expect(state.messages).toEqual(before.messages);expect(state.proposals.find(p=>p.id===request!.id)?.body).toBe(request!.body);
 });
 it.each(['pending','applied'] as const)('keeps a %s booking and quote for equivalent dietary confirmation wording',async reviewStatus=>{
  const {api,id}=setup();api.edit(id,{area:'catering',patch:{dietary:'Kosher options are needed'}});await api.tick();await selectVendor(api,id);
  const imported=api.importDropboxMaterials(id,document());const request=booking(imported)!;expect(request).toBeDefined();
  if(reviewStatus==='applied'){api.decide(id,request.id,'approve');await api.tick();}
  const before=api.getState();const booked=before.proposals.find(proposal=>proposal.id===request.id)!;const receipts=before.receipts.filter(receipt=>receipt.proposalId===request.id);
  api.edit(id,{area:'catering',patch:{dietary:'Kosher options are available'}});await api.tick();const state=api.getState();
  expect(state.project.facts).toMatchObject({cateringStatus:reviewStatus==='applied'?'awaiting_confirmation':'quoted',cateringPerPersonCents:2750,cateringDeliveryCents:18000});
  expect(activeInquiries(state)).toHaveLength(0);expect(state.proposals.find(proposal=>proposal.id===request.id)).toMatchObject({status:reviewStatus,body:booked.body});expect(state.receipts.filter(receipt=>receipt.proposalId===request.id)).toEqual(receipts);expect(state.messages).toEqual(before.messages);
  if(reviewStatus==='pending'){api.decide(id,request.id,'approve');await api.tick();expect(api.getState().project.facts.cateringStatus).toBe('awaiting_confirmation');}
 });
});
