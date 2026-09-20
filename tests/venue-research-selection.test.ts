import {afterEach,describe,expect,it} from 'vitest';
import {createService,cleanPatch} from '../server/domain.js';
import {resolveVenueEdit,type VenueSelection} from '../server/venue-research-selection.js';
import type {Facts,Planner,ProjectState} from '../shared/types.js';
import type {ContactResult} from '../server/contact-research.js';

const services:Array<ReturnType<typeof createService>>=[];
const noModel:Planner=async()=>({patch:{},summary:'Checked',questions:[],evidenceIds:[]});
function setup(){const api=createService({dbPath:':memory:',planner:noModel,aiStatus:()=>({mode:'demo',model:'test',fallbackModel:'test',estimatedSpendUsd:0,spendLimitUsd:0})});services.push(api);return api;}
afterEach(()=>{for(const api of services.splice(0))api.close();});
const capacity={guests:600,room:'Grand Ballroom',layout:'banquet',sourceUrl:'https://venue.example/events',excerpt:'Grand Ballroom: Banquet 600.'};
const av={included:true,room:'Grand Ballroom',items:['Projector'],sourceUrl:'https://venue.example/events',excerpt:'Projector included in room hire.'};
const place:VenueSelection={id:'known-venue',name:'Known Hotel',address:'50 Broadway, Cambridge, MA',sourceUrl:'https://venue.example/events',sourceCheckedAt:'2026-09-20',capacity,av};
function selected(facts:Facts,candidate=place){return resolveVenueEdit({area:'venue',patch:{venue:candidate.name,venueAddress:candidate.address,venueResearchId:candidate.id}},facts,id=>id===candidate.id?candidate:undefined);}
const active=(state:ProjectState)=>state.proposals.filter(p=>p.status==='pending');

describe('server-bound venue research selection',()=>{
 it('uses cached evidence, ignores client-invented price/capacity/AV, and keeps research metadata out of facts',()=>{
  const facts=setup().getState().project.facts;
  const resolved=resolveVenueEdit({area:'venue',patch:{venue:place.name,venueAddress:place.address,venueResearchId:place.id,venueCapacity:9000,venueIncludesAV:false,venueCostCents:1},note:'Use a different fixture'},facts,()=>place);
  expect(resolved.patch).toEqual({venue:place.name,venueAddress:place.address,venueCapacity:600,venueIncludesAV:true});
  expect(resolved.note).toBeUndefined();expect(resolved.venueEvidence).toMatchObject({name:place.name,eventFormat:facts.format,capacity,av});
  expect(cleanPatch({venueResearchId:'ignored',venueCapacityPending:false,venueAVPending:false,venueCapacityEvidenceId:'forged'})).toEqual({});
 });
 it('rejects stale IDs, different addresses, and non-venue use without mutating the event',()=>{
  const api=setup();const initial=api.getState();const input={area:'venue' as const,patch:{venue:place.name,venueAddress:'Wrong address',venueResearchId:place.id}};
  expect(()=>resolveVenueEdit(input,initial.project.facts,()=>place)).toThrow('no longer matches');
  expect(()=>resolveVenueEdit({...input,patch:{...input.patch,venueAddress:place.address}},initial.project.facts,()=>undefined)).toThrow('no longer available');
  expect(()=>resolveVenueEdit({...input,area:'catering'},initial.project.facts,()=>place)).toThrow('researched venue');
  expect(api.getState().project).toEqual(initial.project);
 });
 it('passes the current or simultaneously selected event format to the trusted lookup',()=>{
  const facts=setup().getState().project.facts;let lookedUp:Facts|undefined;
  const resolved=resolveVenueEdit({area:'venue',patch:{venue:place.name,venueAddress:place.address,venueResearchId:place.id,format:'Theater presentation'}},facts,(_id,current)=>{lookedUp=current;return {...place,capacity:null};});
  expect(lookedUp?.format).toBe('Theater presentation');expect(resolved.venueEvidence?.eventFormat).toBe('Theater presentation');expect(resolved.patch?.venueCapacity).toBeUndefined();
 });
 it('preserves an unknown layout and a published ceiling without turning either into seated capacity or free pricing',()=>{
  const api=setup();const initial=api.getState();const candidate={...place,capacity:null,av:null,roomLimit:{guests:197,room:'Standard event room',sourceUrl:place.sourceUrl,excerpt:'Maximum 197 people; layout unspecified.'}};
  const state=api.edit(initial.project.id,selected(initial.project.facts,candidate));
  expect(state.project.facts).toMatchObject({venueCapacity:initial.project.facts.venueCapacity,venueCostCents:initial.project.facts.venueCostCents,venueCapacityPending:true,venueAVPending:true,venueDetailsPending:true});
  expect(state.sources.find(source=>source.id===state.project.facts.venueCapacityEvidenceId)?.venueEvidence?.roomLimit?.guests).toBe(197);
 });
 it('uses researched capacity and included AV while rental pricing remains pending',async()=>{
  const api=setup();const initial=api.getState();let state=api.edit(initial.project.id,selected(initial.project.facts));
  expect(state.project.facts).toMatchObject({venue:place.name,venueCapacity:600,venueIncludesAV:true,venueCapacityPending:false,venueAVPending:false,venueDetailsPending:true,venueCostCents:initial.project.facts.venueCostCents});
  expect(state.project.facts).not.toHaveProperty('venueResearchId');
  const source=state.sources.find(source=>source.id===state.project.facts.venueCapacityEvidenceId)!;
  expect(source.venueEvidence).toMatchObject({name:place.name,address:place.address,eventFormat:initial.project.facts.format,capacity});expect(source.content).toContain('historical evidence');
  await api.tick();api.edit(initial.project.id,{area:'guests',patch:{attendance:650}});await api.tick();state=api.getState();
  const warning=active(state).find(p=>p.title==='Venue is 50 seats short');expect(warning?.evidence).toEqual([source.id]);
  expect(state.budget.lines[0].status).toBe('carried estimate');expect(state.project.facts.equipmentCostCents).toBe(initial.project.facts.equipmentCostCents);
  expect(active(state).some(p=>p.title==='Check AV scope before changing the rental')).toBe(true);
 });
 it('does not issue capacity warnings from a previous venue number when capacity is unknown',async()=>{
  const api=setup();const initial=api.getState();api.edit(initial.project.id,selected(initial.project.facts,{...place,capacity:null,av:null}));await api.tick();
  api.edit(initial.project.id,{area:'guests',patch:{attendance:500}});await api.tick();
  expect(active(api.getState()).some(p=>/seats short/.test(p.title))).toBe(false);
 });
 it('invalidates sourced capacity when the format changes or a field is manually overridden',async()=>{
  const api=setup();const initial=api.getState();let state=api.edit(initial.project.id,selected(initial.project.facts));await api.tick();
  state=api.edit(initial.project.id,{area:'brief',patch:{format:'Theater presentation'}});
  expect(state.project.facts.venueCapacityPending).toBe(true);expect(state.project.facts.venueCapacityEvidenceId).toBe('');
  state=api.edit(initial.project.id,{area:'venue',patch:{venueCapacity:420}});
  expect(state.project.facts.venueCapacityPending).toBe(false);expect(state.project.facts.venueCapacityEvidenceId).toBe('');
 });
 it('keeps AV unknown on a new identity and resolves an explicit manual AV value independently',()=>{
  const api=setup();const initial=api.getState();let state=api.edit(initial.project.id,{area:'venue',patch:{venue:'Other venue'}});
  expect(state.project.facts.venueAVPending).toBe(true);
  state=api.edit(initial.project.id,{area:'equipment',patch:{venueIncludesAV:true}});
  expect(state.project.facts.venueAVPending).toBe(false);expect(state.project.facts.venueDetailsPending).toBe(true);expect(state.project.facts.venueCapacityPending).toBe(true);
 });
 it('resolves an explicitly entered rental quote without pretending unknown capacity or AV is confirmed',()=>{
  const api=setup();const initial=api.getState();api.edit(initial.project.id,selected(initial.project.facts,{...place,capacity:null,av:null}));
  const state=api.edit(initial.project.id,{area:'venue',patch:{venueCostCents:900000}});
  expect(state.project.facts).toMatchObject({venueDetailsPending:false,venueCapacityPending:true,venueAVPending:true});
  expect(state.budget.lines[0]).toMatchObject({status:'planned',amountCents:900000});
 });
 it('restores facts and evidence pointer on Undo while retaining clearly identity-bound historical research',async()=>{
  const api=setup();const initial=api.getState();const selectedState=api.edit(initial.project.id,selected(initial.project.facts));
  const change=selectedState.activity.find(a=>a.canUndo)!.changeId!;const sourceId=selectedState.project.facts.venueCapacityEvidenceId!;await api.tick();
  const state=api.undo(initial.project.id,change);
  expect(state.project.facts).toMatchObject({venue:initial.project.facts.venue,venueAddress:initial.project.facts.venueAddress,venueCapacity:initial.project.facts.venueCapacity,venueIncludesAV:initial.project.facts.venueIncludesAV,venueDetailsPending:false,venueCapacityPending:false,venueAVPending:false,venueCapacityEvidenceId:''});
  expect(state.sources.find(source=>source.id===sourceId)?.venueEvidence?.name).toBe(place.name);
 });
 it('does not let Undo of an older selection overwrite a later venue with coincidentally equal capacity',()=>{
  const api=setup();const initial=api.getState();const first=api.edit(initial.project.id,selected(initial.project.facts));const undoId=first.activity.find(a=>a.canUndo)!.changeId!;
  const second=api.edit(initial.project.id,selected(first.project.facts,{...place,id:'other',name:'Different Hotel',address:'1 Other St'}));
  expect(()=>api.undo(initial.project.id,undoId)).toThrow('Newer edits');expect(api.getState().project.facts).toEqual(second.project.facts);
 });
 it('does not manufacture new-location emails or invitations for same-venue capacity, AV, or price updates',async()=>{
  for(const patch of [{venueCapacity:500},{venueIncludesAV:true},{venueCostCents:800000}]){
   const api=setup();const initial=api.getState();api.edit(initial.project.id,{area:'venue',patch});await api.tick();
   expect(active(api.getState()).some(p=>p.kind==='email'||p.kind==='invitation')).toBe(false);
  }
 });
 it('replaces the unresolved quote issue with a sourced venue inquiry when verified contact research arrives',async()=>{
  const api=setup();const initial=api.getState();api.edit(initial.project.id,selected(initial.project.facts));await api.tick();
  expect(active(api.getState()).find(p=>p.title==='Venue quote needed')?.description).not.toContain('capacity');
  const result:ContactResult={status:'found',entity:{kind:'venue',name:place.name,address:place.address},checkedAt:new Date().toISOString(),checkedUrls:[place.sourceUrl],candidates:[{name:place.name,email:'events@venue.example',url:place.sourceUrl,excerpt:'Email events@venue.example for event inquiries.',confidence:'location',requiresReview:true,scope:'Venue events team'}],alternatives:[],message:'Published venue contact'};
  const state=api.applyContactResearch(initial.project.id,{kind:'venue',name:place.name,address:place.address},result);
  const inquiry=active(state).find(p=>p.title===`Request availability and a quote from ${place.name}`);
  expect(inquiry?.recipient).toBe('events@venue.example');expect(inquiry?.body).toContain('inquiry only, not a booking');expect(inquiry?.body).not.toContain('the equipment included');expect(inquiry?.evidence.length).toBe(2);
  expect(active(state).some(p=>p.title==='Venue quote needed')).toBe(false);
 });
 it('keeps a concrete quote issue when the source offers only a contact form, without inventing a venue email',async()=>{
  const api=setup();const initial=api.getState();api.edit(initial.project.id,selected(initial.project.facts));await api.tick();
  const result:ContactResult={status:'alternatives_only',entity:{kind:'venue',name:place.name,address:place.address},checkedAt:new Date().toISOString(),checkedUrls:[place.sourceUrl],candidates:[],alternatives:[{kind:'contact_form',value:place.sourceUrl,url:place.sourceUrl,excerpt:'Request event pricing'}],message:'Use the published inquiry form.'};
  const state=api.applyContactResearch(initial.project.id,{kind:'venue',name:place.name,address:place.address},result);
  expect(active(state).some(p=>p.title==='Venue quote needed')).toBe(true);
  expect(active(state).some(p=>p.kind==='email'&&p.area==='venue')).toBe(false);
 });
});
