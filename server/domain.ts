import { randomUUID } from 'node:crypto';
import type { Activity, AiStatus, Area, BudgetLine, EditRequest, FactPatch, Facts, PlanResult, Planner, ProjectState, Proposal, Source } from '../shared/types.js';
import { createStore } from './store.js';
import { initialFacts, sources as fixtureSources, contactForVendor } from './fixtures.js';

type Key=keyof Facts;
type Effect='cancel_catering'|'request_quote'|'book_catering'|'cancel_av'|'communicate'|'file'|'fact'|'warning';
type Meta={signature:string;keys:Key[];effect:Effect;changeId?:string;sourceSnapshot?:{id:string;before:string;after:string}};
type Change={id:string;before:FactPatch;after:FactPatch;undone:boolean;title:string;parentId?:string};
type VendorTransition={oldVendor:string;newVendor:string;oldTotalCents:number;depositCents:number;cancellationSent:boolean;cancelConfirmed:boolean;quoteRequested:boolean;quoteReceived:boolean;bookingRequested:boolean;confirmed:boolean;attendance:number;date:string;quoteCents?:number};
type Internal={state:Omit<ProjectState,'projects'|'budget'|'ai'>;plannedFacts:Facts;changes:Change[];meta:Record<string,Meta>;requests:EditRequest[];vendor?:VendorTransition;generation:number};
const fieldLabels:Partial<Record<Key,string>>={attendance:'Guests',venue:'Venue',venueAddress:'Venue address',venueCapacity:'Room capacity',venueCostCents:'Venue cost',venueIncludesAV:'AV included',caterer:'Caterer',cateringPerPersonCents:'Price per guest',cateringDeliveryCents:'Delivery cost',staffCount:'Team members',staffCostEachCents:'Cost per team member',equipmentCostCents:'Equipment cost',budgetLimitCents:'Budget limit',sunkCostCents:'Retained deposit',dietary:'Dietary needs',date:'Event date',time:'Start time',timezone:'Time zone',format:'Event format',notes:'Event notes'};
const now=()=>new Date().toISOString();
const id=()=>randomUUID();
const clone=<T>(v:T):T=>structuredClone(v);
const money=(c:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(c/100);
const changed=(before:Facts,after:Facts)=>(Object.keys(after) as Key[]).filter(k=>before[k]!==after[k]);
const moneyKeys:Key[]=['venueCostCents','cateringPerPersonCents','cateringDeliveryCents','staffCostEachCents','equipmentCostCents','budgetLimitCents','sunkCostCents'];
const numberKeys:Key[]=['attendance','venueCapacity','staffCount',...moneyKeys];
const areaKeys:Record<Area,Key[]>={venue:['venue','venueAddress','venueCapacity','venueCostCents','venueIncludesAV'],guests:['attendance'],catering:['caterer','cateringPerPersonCents','cateringDeliveryCents','cateringStatus','dietary'],budget:['budgetLimitCents'],staff:['staffCount','staffCostEachCents'],equipment:['equipmentCostCents'],brief:['date','time','timezone','format','notes']};
const sourceFor:Record<Area,string[]>={venue:['venue-garden','venue-marriott'],guests:['guests'],catering:['catering-current','catering-cava'],budget:['budget'],staff:['staffing-policy'],equipment:['equipment-contract'],brief:['brief']};

export function cleanPatch(input:FactPatch):FactPatch {
  const out:FactPatch={};
  for(const [raw,value] of Object.entries(input)) {
    if(!(raw in initialFacts))continue;
    const key=raw as Key;
    if(numberKeys.includes(key)){
      if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw new Error(`${key} must be a nonnegative whole number.`);
      if(key==='attendance'&&(value<1||value>100000))throw new Error('Attendance must be between 1 and 100,000.');
      if(value>1_000_000_000)throw new Error(`${key} is outside the supported range.`);
      (out as Record<string,unknown>)[key]=value;
    }else if(key==='venueIncludesAV'){
      if(typeof value!=='boolean')throw new Error('Included AV must be true or false.');out.venueIncludesAV=value;
    }else if(key==='cateringStatus'){
      // Workflow statuses are controlled by durable events, never by model output.
      continue;
    }else{
      if(typeof value!=='string'||value.length>8000)throw new Error(`${key} must be text under 8,000 characters.`);
      if(key==='date'&&(!/^\d{4}-\d{2}-\d{2}$/.test(value)||Number.isNaN(Date.parse(value))))throw new Error('Choose a valid event date.');
      (out as Record<string,unknown>)[key]=value.trim();
    }
  }
  return out;
}

/** Predictable offline interpretation. Live planner remains the source of semantic interpretation when configured. */
export function fallbackPlan(input:{note:string;area:Area;facts:Facts;sources:Source[]}):PlanResult {
  const {note,area}=input; const patch:FactPatch={};const lower=note.toLowerCase();
  if(area==='venue'&&/marriott|marriot/.test(lower))Object.assign(patch,{venue:'Marriott Downtown · Grand Ballroom',venueAddress:'500 Harbor Street, Boston, MA (demo)',venueCapacity:360,venueCostCents:800000,venueIncludesAV:true});
  if(area==='venue'&&/garden hall/.test(lower))Object.assign(patch,{venue:initialFacts.venue,venueAddress:initialFacts.venueAddress,venueCapacity:260,venueCostCents:720000,venueIncludesAV:false});
  if(area==='catering'&&/cava/.test(lower))patch.caterer='CAVA';
  if(area==='catering'&&/vegetarian|vegan|halal|gluten|allerg/.test(lower))patch.dietary=note;
  const attendance=note.match(/(?:attendance|guests?|people|headcount)\D{0,20}(\d{1,5})/i)||note.match(/(\d{1,5})\s*(?:guests?|people|attendees)/i);
  if(attendance&&(area==='guests'||/attendance|headcount/i.test(note)))patch.attendance=Number(attendance[1]);
  if(area==='guests'&&!attendance){const n=note.match(/(?:to|now)\s+(\d{1,5})/i);if(n)patch.attendance=Number(n[1]);}
  if(area==='budget'){const n=note.match(/\$?([\d,]+(?:\.\d{1,2})?)\s*(k)?\b/i);if(n)patch.budgetLimitCents=Math.round(Number(n[1].replaceAll(',',''))*(n[2]?100000:100));}
  if(area==='staff'){const n=note.match(/(\d+)\s*(?:staff|people|servers)/i)||note.match(/(?:to|now)\s*(\d+)/i);if(n)patch.staffCount=Number(n[1]);}
  if(area==='equipment'){if(/cancel|remove|no longer|included/.test(lower))patch.equipmentCostCents=0;else{const n=note.match(/\$([\d,]+(?:\.\d{1,2})?)/);if(n)patch.equipmentCostCents=Math.round(Number(n[1].replaceAll(',',''))*100);}}
  if(area==='brief'){const date=note.match(/\d{4}-\d{2}-\d{2}/);if(date)patch.date=date[0];if(/virtual|online/.test(lower))patch.format='Virtual event';else if(/hybrid/.test(lower))patch.format='Hybrid event';patch.notes=note;}
  return {patch,summary:Object.keys(patch).length?'Updated the plan and checked the affected arrangements.':'The note needs a specific detail before it can change the plan.',questions:Object.keys(patch).length?[]:['Specify a new field value, vendor, or date.'],evidenceIds:sourceFor[area],model:'Deterministic demo'};
}

function budget(s:Internal):ProjectState['budget']{
  const f=s.state.project.facts;const v=s.vendor;const lines:BudgetLine[]=[{label:'Venue',amountCents:f.venueCostCents,status:'planned',detail:f.venue}];
  if(v){
    if(!v.cancelConfirmed)lines.push({label:`${v.oldVendor} commitment`,amountCents:v.oldTotalCents,status:v.cancellationSent?'cancellation requested':'committed',detail:'Retained until cancellation is confirmed; includes the deposit.'});
    if(v.quoteReceived)lines.push({label:`${v.newVendor} catering`,amountCents:v.quoteCents??0,status:v.confirmed?'confirmed':'quoted',detail:v.confirmed?'Booking confirmed by a simulated vendor reply.':'Forecast only; the quote is not a booking.'});
    else lines.push({label:`${v.newVendor} quote`,amountCents:0,status:'awaiting quote',detail:'Cost unknown. The total is incomplete until a quote arrives.'});
  }else lines.push({label:'Catering',amountCents:f.attendance*f.cateringPerPersonCents+f.cateringDeliveryCents,status:f.cateringStatus,detail:`${f.caterer} · ${f.attendance} × ${money(f.cateringPerPersonCents)}`});
  lines.push({label:'Staff',amountCents:f.staffCount*f.staffCostEachCents,status:'planned',detail:`${f.staffCount} × ${money(f.staffCostEachCents)}`},{label:'Equipment',amountCents:f.equipmentCostCents,status:f.equipmentCostCents?'planned':'removed',detail:f.venueIncludesAV?'House AV is included; review any duplicate rental.':'External AV rental.'});
  if(f.sunkCostCents)lines.push({label:'Non-refundable costs',amountCents:f.sunkCostCents,status:'retained',detail:'Includes confirmed non-refundable cancellation deposits.'});
  return {totalCents:lines.reduce((sum,line)=>sum+line.amountCents,0),lines};
}

export function createService(options:{dbPath:string;planner:Planner;aiStatus:()=>AiStatus}){
  const store=createStore(options.dbPath);let ticking=false;
  function seed(name:string,projectId:string=id()):Internal{
    return {state:{project:{id:projectId,name,revision:0,facts:clone(initialFacts),createdAt:now()},proposals:[],activity:[{id:id(),at:now(),title:'Event ready',detail:'The organized demo folder is connected. Edit any planning area to begin.',status:'complete'}],receipts:[],messages:[],sources:clone(fixtureSources),workflow:null,connections:[{name:'Dropbox',mode:'demo',detail:'Organized local fixtures. File writes are simulated.'},{name:'Email',mode:'demo',detail:'Reserved .example addresses. Messages stay in this demo.'},{name:'Invitations',mode:'demo',detail:'Invitation updates are simulated.'}]},plannedFacts:clone(initialFacts),changes:[],meta:{},requests:[],generation:0};
  }
  if(!store.list().length){const s=seed('Christmas dinner');store.save(s.state.project.id,s.state.project.name,s);}
  const load=(projectId?:string)=>{const p=projectId??store.list()[0]?.id;const s=p?store.get<Internal>(p):undefined;if(!s)throw new Error('Event not found.');return s;};
  const save=(s:Internal)=>store.save(s.state.project.id,s.state.project.name,s);
  const output=(s:Internal):ProjectState=>clone({...s.state,projects:store.list(),budget:budget(s),ai:options.aiStatus()});
  const activity=(s:Internal,title:string,detail:string,status:Activity['status']='complete',changeId?:string)=>s.state.activity.unshift({id:id(),at:now(),title,detail,status,...(changeId?{changeId,canUndo:true}:{})});
  function invalidate(s:Internal,keys:Key[]){
    const ids:string[]=[];
    for(const p of s.state.proposals){if(['pending','blocked','approved'].includes(p.status)&&s.meta[p.id]?.keys.some(k=>keys.includes(k))){p.status='stale';ids.push(p.id);}}
    store.cancelActions(s.state.project.id,ids);
  }
  function commit(s:Internal,patch:FactPatch,title:string):string|undefined{
    const f=s.state.project.facts;const checked=cleanPatch(patch);const before:FactPatch={};const after:FactPatch={};
    for(const key of Object.keys(checked) as Key[])if(f[key]!==checked[key]){(before as Record<string,unknown>)[key]=f[key];(after as Record<string,unknown>)[key]=checked[key];}
    const keys=Object.keys(after) as Key[];if(!keys.length)return;
    invalidate(s,keys);Object.assign(f,after);s.state.project.revision++;
    const changeId=id();s.changes.push({id:changeId,before,after,undone:false,title});activity(s,title,keys.map(k=>`${fieldLabels[k]??k}: ${moneyKeys.includes(k)?money(Number(before[k])):String(before[k])} → ${moneyKeys.includes(k)?money(Number(after[k])):String(after[k])}`).join(' · '),'complete',changeId);
    if(keys.includes('caterer')){
      const oldName=String(before.caterer);s.vendor={oldVendor:oldName,newVendor:f.caterer,oldTotalCents:f.attendance*f.cateringPerPersonCents+f.cateringDeliveryCents,depositCents:/shah/i.test(oldName)?60000:0,cancellationSent:false,cancelConfirmed:false,quoteRequested:false,quoteReceived:false,bookingRequested:false,confirmed:false,attendance:f.attendance,date:f.date};
      f.cateringStatus='awaiting_quote';
    }
    if(s.vendor&&keys.some(k=>['attendance','date','dietary'].includes(k))){s.vendor.quoteReceived=false;s.vendor.bookingRequested=false;s.vendor.confirmed=false;s.vendor.quoteRequested=false;s.vendor.attendance=f.attendance;s.vendor.date=f.date;f.cateringStatus='awaiting_quote';}
    return changeId;
  }
  function add(s:Internal,input:Omit<Proposal,'id'|'version'|'createdAt'|'status'>,keys:Key[],effect:Effect,changeId?:string):Proposal{
    const f=s.state.project.facts;const signature=JSON.stringify([effect,input.title,input.recipient,input.patch,keys.map(k=>[k,f[k]])]);
    const previous=s.state.proposals.find(p=>s.meta[p.id]?.signature===signature&&!['stale','withdrawn'].includes(p.status));if(previous)return previous;
    const p:Proposal={...input,id:id(),version:s.state.project.revision,createdAt:now(),status:'pending'};
    s.state.proposals.push(p);s.meta[p.id]={signature,keys,effect,changeId};return p;
  }
  function email(s:Internal,title:string,recipient:string,body:string,area:Area,keys:Key[],effect:Effect='communicate',changeId?:string,dependencies:string[]=[]){
    return add(s,{title,area,description:'Prepared for your approval. Delivery is simulated in this demo.',before:'No update sent',after:'Send the prepared message',costImpactCents:null,kind:'email',evidence:sourceFor[area],dependencies,recipient,subject:`${s.state.project.name}: ${title}`,body},keys,effect,changeId);
  }
  function file(s:Internal,area:Area,keys:Key[],changeId?:string,dependencies:string[]=[]){
    const related:Record<Area,Key[]>={budget:[...moneyKeys,'attendance','staffCount','caterer','cateringStatus'],guests:['attendance','date','time','venue','venueAddress','caterer','dietary'],venue:areaKeys.venue,catering:[...areaKeys.catering,'attendance','date','time','venue'],staff:[...areaKeys.staff,'attendance','date','time','venue'],equipment:[...areaKeys.equipment,'venueIncludesAV','venue','date'],brief:[...areaKeys.brief,'attendance','venue']};
    const canonicalKeys=[...new Set(related[area])].sort();
    const p=add(s,{title:`Update ${area==='brief'?'event brief':area+' details'} in Dropbox`,area,description:'Keep the planning folder consistent with the approved event details.',before:'Previous version in the planning folder',after:'Save the current approved details',costImpactCents:null,kind:'file',evidence:sourceFor[area],dependencies},canonicalKeys,'file',changeId);
    p.dependencies=[...new Set([...p.dependencies,...dependencies])];s.meta[p.id].keys=[...new Set([...s.meta[p.id].keys,...keys])];
    for(const other of s.state.proposals){
      if(other.id!==p.id&&other.kind==='file'&&other.area===area&&other.version===p.version&&['pending','blocked'].includes(other.status)){
        p.dependencies=[...new Set([...p.dependencies,...other.dependencies])];s.meta[p.id].keys=[...new Set([...s.meta[p.id].keys,...(s.meta[other.id]?.keys??[])])];other.status='withdrawn';
      }
    }
    return p;
  }
  function warning(s:Internal,title:string,description:string,area:Area,keys:Key[],changeId?:string){return add(s,{title,area,description,before:'Needs attention',after:'Acknowledge and keep visible in the activity history',costImpactCents:null,kind:'warning',evidence:sourceFor[area],dependencies:[]},keys,'warning',changeId);}
  function invitations(s:Internal,title:string,body:string,keys:Key[],changeId?:string,dependencies:string[]=[]){return add(s,{title,area:'guests',description:'Preview the exact invitation update before approving.',before:'Guests have the previous event details',after:'Update and send the invitation',costImpactCents:null,kind:'invitation',evidence:['guests','brief'],dependencies,recipient:'christmas-guests@northstar.example',subject:s.state.project.name,body},keys,'communicate',changeId);}
  function consequences(s:Internal,before:Facts,changeId?:string){
    const f=s.state.project.facts;const keys=changed(before,f);const has=(list:Key[])=>keys.some(k=>list.includes(k));
    const location=`${f.venue}, ${f.venueAddress}`;const when=`${f.date} at ${f.time} (${f.timezone})`;
    if(has(['attendance'])){
      file(s,'guests',['attendance'],changeId);file(s,'budget',['attendance','cateringPerPersonCents','staffCount'],changeId);
      if(!s.vendor)email(s,'Confirm the new catering headcount',contactForVendor(f.caterer),`Please confirm catering for ${f.attendance} guests on ${when}. Our current rate is ${money(f.cateringPerPersonCents)} per guest. Please reply with any revised pricing or availability.`, 'catering',['attendance','date','caterer'], 'communicate',changeId);
      email(s,'Update staff on the guest count','staff@northstar.example',`The guest count is now ${f.attendance}. The event remains ${when} at ${location}. Please review staffing and service arrangements.`,'staff',['attendance','date','venue'],'communicate',changeId);
    }
    const required=Math.ceil(f.attendance/60);
    if((has(['attendance','staffCount'])||has(['budgetLimitCents']))&&f.staffCount!==required){
      add(s,{title:`Adjust staffing to ${required} people`,area:'staff',description:'The event staffing plan specifies one staff member per 60 guests, rounded up.',before:`${f.staffCount} staff · ${money(f.staffCount*f.staffCostEachCents)}`,after:`${required} staff · ${money(required*f.staffCostEachCents)}`,costImpactCents:(required-f.staffCount)*f.staffCostEachCents,kind:'fact',evidence:['staffing-policy'],dependencies:[],patch:{staffCount:required}},['attendance','staffCount','staffCostEachCents'],'fact',changeId);
    }
    if(has(['attendance','venueCapacity','venue'])&&f.attendance>f.venueCapacity)warning(s,`Venue is ${f.attendance-f.venueCapacity} seats short`,`${f.venue} holds ${f.venueCapacity}; the event now has ${f.attendance} guests. Acknowledge this issue, then edit the venue or headcount before confirming arrangements.`,'venue',['attendance','venueCapacity','venue'],changeId);
    if(has(['venue','venueAddress','venueCostCents','venueIncludesAV','venueCapacity'])){
      file(s,'venue',areaKeys.venue,changeId);file(s,'budget',['venueCostCents','equipmentCostCents'],changeId);
      email(s,'Confirm catering delivery at the new venue',contactForVendor(f.caterer),`The planned venue is now ${location} for ${when}, ${f.attendance} guests. Please confirm delivery access, setup requirements and any price changes.`,'catering',['venue','venueAddress','date','caterer','attendance'],'communicate',changeId);
      email(s,'Update staff on the new venue','staff@northstar.example',`The venue is now ${location}. Please update your arrival and setup plans for ${when}.`,'staff',['venue','venueAddress','date'],'communicate',changeId);
      invitations(s,'Tell guests about the venue change',`The location for ${s.state.project.name} is now ${location}. Date and time: ${when}.`,['venue','venueAddress','date','time'],changeId);
      if(f.venueIncludesAV&&f.equipmentCostCents>0){
        const cancel=email(s,'Cancel the duplicate AV rental','logistics@brightav.example',`The ${f.venue} proposal includes projector, sound and microphones for ${when}. Please cancel the duplicate AV rental under the demo agreement's no-penalty terms and confirm.`, 'equipment',['venue','venueIncludesAV','equipmentCostCents'],'cancel_av',changeId);
        add(s,{title:'Remove the duplicate AV cost',area:'budget',description:'The selected demo venue includes equivalent house AV. The removal waits for the approved cancellation to be processed.',before:money(f.equipmentCostCents),after:money(0),costImpactCents:-f.equipmentCostCents,kind:'fact',evidence:['venue-marriott','equipment-contract'],dependencies:[cancel.id],patch:{equipmentCostCents:0}},['venue','venueIncludesAV','equipmentCostCents'],'fact',changeId);
      }
    }
    if(s.vendor&&!s.vendor.confirmed&&(has(['caterer','attendance','date','dietary'])||!s.vendor.quoteRequested)){
      const v=s.vendor;
      if(!v.cancellationSent&&!v.cancelConfirmed)email(s,`Cancel ${v.oldVendor} catering`,contactForVendor(v.oldVendor),`Please cancel our catering for ${s.state.project.name} on ${when}. Please confirm cancellation, retention of the ${money(v.depositCents)} non-refundable deposit, and release of the remaining ${money(v.oldTotalCents-v.depositCents)} balance.`, 'catering',['caterer','date'],'cancel_catering',changeId);
      if(!v.quoteRequested)email(s,`Request a quote from ${v.newVendor}`,contactForVendor(v.newVendor),`Please quote catering for ${f.attendance} guests on ${when} at ${location}. Dietary requirements: ${f.dietary}. Please include delivery, taxes, fees, availability and menu details. This is an inquiry, not a booking.`, 'catering',['caterer','attendance','date','venue','dietary'],'request_quote',changeId);
      file(s,'catering',['caterer','cateringStatus'],changeId);
    }else if(has(['dietary','cateringPerPersonCents','cateringDeliveryCents'])){
      email(s,'Confirm catering details',contactForVendor(f.caterer),`Please confirm the menu and dietary requirements for ${f.attendance} guests: ${f.dietary}. Please identify any changes to pricing before making commitments.`,'catering',['dietary','caterer','attendance'],'communicate',changeId);file(s,'catering',areaKeys.catering,changeId);
    }
    if(has(['date','time','timezone','format'])){
      email(s,'Confirm venue availability for the updated schedule',/marriott/i.test(f.venue)?'events@marriott-demo.example':'events@gardenhall.example',`Our proposed event schedule is ${when}, format: ${f.format}, ${f.attendance} guests. Please confirm availability, room suitability and any change in fees.`, 'venue',['date','time','format','venue','attendance'],'communicate',changeId);
      if(!s.vendor)email(s,'Confirm catering for the updated schedule',contactForVendor(f.caterer),`Please confirm availability and pricing for ${when}, ${f.attendance} guests, ${f.format}.`, 'catering',['date','time','format','caterer','attendance'],'communicate',changeId);
      email(s,'Update staff on the event schedule','staff@northstar.example',`The event is now planned for ${when}, ${f.format}, at ${location}. Please confirm availability.`,'staff',['date','time','format','venue'],'communicate',changeId);
      invitations(s,'Update the event schedule in invitations',`The event is now planned for ${when}, ${f.format}, at ${location}.`,['date','time','format','venue'],changeId);file(s,'brief',areaKeys.brief,changeId);
      if(/virtual|hybrid/i.test(f.format))warning(s,'Confirm the online event setup','Add the joining link, streaming requirements and remote access details before guests receive a final virtual-event invitation.','equipment',['format'],changeId);
    }else if(has(['notes']))file(s,'brief',['notes'],changeId);
    if(has(['staffCount','staffCostEachCents'])){email(s,'Confirm the staffing arrangement','staff@northstar.example',`The event staffing plan now has ${f.staffCount} people for ${f.attendance} guests on ${when}. Please confirm assignments and coverage.`,'staff',['staffCount','attendance','date'],'communicate',changeId);file(s,'staff',['staffCount','staffCostEachCents'],changeId);}
    if(has(['equipmentCostCents'])){email(s,'Confirm the equipment plan','logistics@brightav.example',`The external equipment budget is now ${money(f.equipmentCostCents)} for ${when} at ${location}. Please confirm the revised equipment scope and costs before making changes.`,'equipment',['equipmentCostCents','venue','date'],'communicate',changeId);file(s,'equipment',['equipmentCostCents','venueIncludesAV'],changeId);}
    if(has([...moneyKeys,'attendance','staffCount']))file(s,'budget',[...moneyKeys,'attendance','staffCount'],changeId);
    const total=budget(s).totalCents;
    if(total>f.budgetLimitCents)warning(s,`Plan is ${money(total-f.budgetLimitCents)} over budget`,`The current known total is ${money(total)} against a ${money(f.budgetLimitCents)} limit. Pending quotes and unconfirmed cancellations remain visible in the budget.`, 'budget',[...moneyKeys,'attendance','staffCount','caterer'],changeId);
    else if(has(['budgetLimitCents']))activity(s,'Budget checked',`${money(total)} planned, ${money(f.budgetLimitCents-total)} remaining.`);
  }
  function refreshWorkflow(s:Internal){
    const waiting=s.vendor&&(!s.vendor.quoteReceived||s.vendor.bookingRequested&&!s.vendor.confirmed||s.vendor.cancellationSent&&!s.vendor.cancelConfirmed);
    const pending=s.state.proposals.filter(p=>p.status==='pending'||p.status==='approved');
    if(!s.state.workflow)s.state.workflow={id:id(),status:'complete',summary:'The event plan is up to date.',stages:[]};
    if(waiting){s.state.workflow.status=pending.length?'review':'waiting';s.state.workflow.summary=!s.vendor!.quoteReceived?'Waiting for the catering quote. You can keep planning.':!s.vendor!.confirmed&&s.vendor!.bookingRequested?'Waiting for booking confirmation.':'Waiting for cancellation confirmation.';}
    else{s.state.workflow.status=pending.length?'review':'complete';s.state.workflow.summary=pending.length?`${pending.length} update${pending.length===1?'':'s'} ready for review.`:'Approved updates are complete.';}
    s.state.workflow.stages=s.state.workflow.stages.filter(stage=>stage.status!=='waiting');
    for(const stage of s.state.workflow.stages)stage.status='done';
    if(waiting)s.state.workflow.stages.push({label:s.state.workflow.summary,status:'waiting'});
  }
  function queuePlan(s:Internal){
    store.supersedePlans(s.state.project.id);s.generation++;
    s.state.workflow={id:id(),status:'planning',summary:'Checking what this change affects…',stages:[{label:'Read the event details',status:'done'},{label:'Understand the change',status:'running'},{label:'Check dependent arrangements',status:'pending'},{label:'Prepare updates for review',status:'pending'}]};
    store.enqueue({id:`plan:${s.state.project.id}:${s.generation}`,projectId:s.state.project.id,revision:s.state.project.revision,kind:'plan',payload:JSON.stringify({generation:s.generation})});
  }
  function execute(s:Internal,p:Proposal){
    if(p.status!=='approved')return;const meta=s.meta[p.id];
    if(p.dependencies.some(dep=>s.state.proposals.find(x=>x.id===dep)?.status!=='applied')){p.status='blocked';return;}
    if(s.state.receipts.some(r=>r.proposalId===p.id)){p.status='applied';return;}
    if(meta.effect==='cancel_catering'&&s.vendor)s.vendor.cancellationSent=true;
    if(meta.effect==='request_quote'&&s.vendor){s.vendor.quoteRequested=true;activity(s,`Waiting for ${s.vendor.newVendor}`, 'The simulated quote request is ready in the outbox. A matching reply will resume planning automatically.','waiting');}
    if(meta.effect==='book_catering'&&s.vendor){s.vendor.bookingRequested=true;s.state.project.facts.cateringStatus='awaiting_confirmation';activity(s,'Waiting for booking confirmation','Final menu and invitation updates stay on hold until the vendor confirms.','waiting');}
    if(p.kind==='email'||p.kind==='invitation')s.state.messages.unshift({id:id(),at:now(),from:p.recipient??'demo@northstar.example',subject:p.subject??p.title,body:p.body??p.description,direction:'outbound',simulated:true});
    if(p.kind==='file'){
      const target=s.state.sources.find(source=>source.area===p.area);if(target){const before=target.content;target.content=`# ${target.title}\nUpdated locally in demo: ${now()}\n${JSON.stringify(p.area==='budget'?{...budget(s),limitCents:s.state.project.facts.budgetLimitCents}:Object.fromEntries(areaKeys[p.area].map(k=>[k,s.state.project.facts[k]])),null,2)}`;meta.sourceSnapshot={id:target.id,before,after:target.content};}
    }
    p.status='applied';s.state.receipts.unshift({id:id(),at:now(),title:p.title,provider:p.kind==='file'?'Dropbox demo':p.kind==='invitation'?'Invitations demo':p.kind==='email'?'Email demo':'Local plan',status:p.kind==='fact'||p.kind==='warning'?'local':'simulated',detail:p.kind==='file'?'Updated the local planning document. No Dropbox API call was made.':p.kind==='email'||p.kind==='invitation'?`Simulated delivery to ${p.recipient}. No external message was sent.`:'Saved in the local event plan.',proposalId:p.id});
    activity(s,p.title,p.kind==='email'||p.kind==='invitation'?'Completed in the demo outbox; no external delivery.':'The approved update is complete.');
    for(const dependent of s.state.proposals)if(dependent.status==='blocked'&&dependent.dependencies.every(dep=>s.state.proposals.find(x=>x.id===dep)?.status==='applied'))dependent.status='pending';
  }
  function getState(projectId?:string){return output(load(projectId));}
  function createProject(name:string){if(!name.trim())throw new Error('Give the event a name.');const s=seed(name.trim().slice(0,160));save(s);return output(s);}
  function edit(projectId:string,request:EditRequest){return store.transaction(()=>{
    if(!(request.area in areaKeys))throw new Error('Unknown planning area.');if((request.note?.length??0)>8000)throw new Error('Keep the note under 8,000 characters.');
    const s=load(projectId);if(!request.note?.trim()&&(!request.patch||!Object.entries(cleanPatch(request.patch)).some(([key,value])=>s.state.project.facts[key as Key]!==value)))return output(s);if(request.patch)commit(s,request.patch,`${request.area[0].toUpperCase()+request.area.slice(1)} updated`);
    s.requests.push(clone(request));queuePlan(s);save(s);return output(s);
  });}
  function decide(projectId:string,proposalId:string,decision:'approve'|'deny'){return store.transaction(()=>{
    const s=load(projectId);const p=s.state.proposals.find(x=>x.id===proposalId);if(!p)throw new Error('Update not found.');
    if(['approved','applied','denied'].includes(p.status))return output(s);
    if(p.status==='stale'||p.status==='withdrawn')throw new Error('This update was replaced by newer event details.');
    if(decision==='deny'){p.status='denied';activity(s,`Declined: ${p.title}`,'This suggestion will stay declined unless its relevant event details change.','denied');for(const dependent of s.state.proposals)if(dependent.dependencies.includes(p.id)&&dependent.status==='pending')dependent.status='blocked';}
    else{
      if(p.dependencies.some(dep=>s.state.proposals.find(x=>x.id===dep)?.status!=='applied'))throw new Error('Approve and complete the prerequisite update first.');
      p.status='approved';
      if(p.kind==='fact'&&p.patch){const before=clone(s.state.project.facts);const changeId=commit(s,p.patch,p.title);const child=s.changes.find(c=>c.id===changeId);if(child)child.parentId=s.meta[p.id]?.changeId;p.status='approved';execute(s,p);consequences(s,before,changeId);s.plannedFacts=clone(s.state.project.facts);}
      else if(p.kind==='warning')execute(s,p);
      else store.enqueue({id:`action:${p.id}`,projectId,revision:s.state.project.revision,kind:'action',payload:JSON.stringify({proposalId:p.id})});
    }
    refreshWorkflow(s);save(s);return output(s);
  });}
  function undo(projectId:string,changeId:string){return store.transaction(()=>{
    const s=load(projectId);const change=s.changes.find(c=>c.id===changeId);if(!change||change.undone)throw new Error('This change is no longer available to undo.');
    const f=s.state.project.facts;const restored:Key[]=[];
    const relatedChangeIds=new Set([changeId]);
    for(const candidate of s.changes)if(candidate.parentId&&relatedChangeIds.has(candidate.parentId)&&!candidate.undone)relatedChangeIds.add(candidate.id);
    const changeChain=s.changes.filter(c=>relatedChangeIds.has(c.id)&&!c.undone).reverse();
    for(const candidate of changeChain)for(const key of Object.keys(candidate.after) as Key[])if(f[key]===candidate.after[key]){(f as unknown as Record<string,unknown>)[key]=candidate.before[key];restored.push(key);}
    if(!restored.length)throw new Error('Newer edits replaced this change. Nothing can safely be restored.');
    for(const candidate of changeChain)candidate.undone=true;s.state.project.revision++;invalidate(s,restored);
    for(const a of s.state.activity)if(a.changeId&&relatedChangeIds.has(a.changeId))a.canUndo=false;
    const related=s.state.proposals.filter(p=>s.meta[p.id]?.changeId&&relatedChangeIds.has(s.meta[p.id].changeId!));
    for(const p of related)if(['pending','blocked','approved','stale'].includes(p.status))p.status='withdrawn';
    store.cancelActions(projectId,related.map(p=>p.id));
    for(const p of [...related].reverse()){
      const snapshot=s.meta[p.id]?.sourceSnapshot;const source=snapshot?s.state.sources.find(source=>source.id===snapshot.id):undefined;
      if(source&&snapshot&&source.content===snapshot.after){source.content=snapshot.before;s.state.receipts.unshift({id:id(),at:now(),title:`Restored ${source.title}`,provider:'Local plan',status:'local',detail:'Restored the earlier local document version. The original update remains in the history.'});}
    }
    const sent=related.filter(p=>s.state.receipts.some(r=>r.proposalId===p.id&&r.status==='simulated')&&(p.kind==='email'||p.kind==='invitation'));
    for(const p of sent)email(s,`Correct the previous update: ${p.title}`,p.recipient??'staff@northstar.example',`Please disregard the previous update. The current event details are ${f.date} at ${f.time}, ${f.venue}, ${f.attendance} guests. We have restored the earlier planning change.`,p.area,restored,'communicate');
    if(restored.includes('caterer')&&s.vendor){if(s.vendor.cancellationSent||s.vendor.bookingRequested)warning(s,'Confirm the restored catering arrangement','The plan was restored locally. Previous cancellation or booking messages still exist; confirm vendor availability before treating the original arrangement as restored.','catering',['caterer']);else s.vendor=undefined;f.cateringStatus=s.vendor?'awaiting_confirmation':'confirmed';}
    activity(s,`Undid: ${change.title}`,`Restored ${restored.length} field${restored.length===1?'':'s'} without overwriting unrelated edits.${sent.length?' Prepared correction messages; prior receipts remain in history.':''}`);
    s.plannedFacts=clone(f);s.requests=[];store.supersedePlans(projectId);s.generation++;refreshWorkflow(s);save(s);return output(s);
  });}
  function inject(projectId:string,kind:'quote'|'confirmation'|'cancellation'|'stale_quote'){return store.transaction(()=>{
    const s=load(projectId);const v=s.vendor;const f=s.state.project.facts;if(!v)throw new Error('Change the caterer and approve a quote request first.');
    if(kind==='quote'||kind==='stale_quote'){
      if(!v.quoteRequested)throw new Error('Approve the quote request and wait for it to be processed first.');
      if(kind==='stale_quote'){
        s.state.messages.unshift({id:id(),at:now(),from:contactForVendor(v.newVendor),subject:'Quote for the previous event details',body:'This simulated reply references a superseded guest count or date. It is kept for audit and does not update the budget.',direction:'inbound',simulated:true});activity(s,'Older quote ignored','The reply did not match the current event details. The current budget is unchanged.','attention');
      }else if(!v.quoteReceived){
        v.quoteCents=f.attendance*2600+24000;v.quoteReceived=true;v.attendance=f.attendance;v.date=f.date;f.cateringPerPersonCents=2600;f.cateringDeliveryCents=24000;f.cateringStatus='quoted';s.state.project.revision++;invalidate(s,['cateringPerPersonCents','cateringDeliveryCents','cateringStatus']);
        s.state.messages.unshift({id:id(),at:now(),from:contactForVendor(v.newVendor),subject:`Quote: ${f.attendance} guests on ${f.date}`,body:`Fictional demo quote: ${f.attendance} × $26 plus $240 delivery = ${money(v.quoteCents)}. The requested menu and dietary requirements are available in this demo. Please reply to request booking; this quote is not a confirmed booking.`,direction:'inbound',simulated:true});
        activity(s,'Quote received; forecast updated',`${v.newVendor}: ${money(v.quoteCents)}. No booking has been made. ${!v.cancelConfirmed?'The old catering commitment remains until cancellation is confirmed.':''}`);
        email(s,`Request booking with ${v.newVendor}`,contactForVendor(v.newVendor),`Please book the quoted catering for ${f.attendance} guests on ${f.date} at ${f.venue}, total ${money(v.quoteCents)} including delivery. Requirements: ${f.dietary}. Please confirm the booking and menu in writing.`,'catering',['caterer','attendance','date','venue','dietary'],'book_catering');
        file(s,'budget',['caterer','cateringPerPersonCents','cateringDeliveryCents','attendance']);
        const total=budget(s).totalCents;if(total>f.budgetLimitCents)warning(s,`Plan is ${money(total-f.budgetLimitCents)} over budget`,`The quote brings the known forecast to ${money(total)}. ${!v.cancelConfirmed?'The original catering commitment remains until cancellation is confirmed.':'Review costs before approving the booking.'}`,'budget',[...moneyKeys,'attendance','staffCount','caterer']);
      }
    }else if(kind==='cancellation'){
      if(!v.cancellationSent)throw new Error('Approve and process the cancellation request first.');
      if(!v.cancelConfirmed){v.cancelConfirmed=true;f.sunkCostCents+=v.depositCents;s.state.project.revision++;invalidate(s,['sunkCostCents']);s.state.messages.unshift({id:id(),at:now(),from:contactForVendor(v.oldVendor),subject:'Cancellation confirmed',body:`Demo cancellation confirmed. The ${money(v.depositCents)} deposit is retained and the remaining ${money(v.oldTotalCents-v.depositCents)} balance is released.`,direction:'inbound',simulated:true});activity(s,'Cancellation confirmed',`${money(v.oldTotalCents-v.depositCents)} released; ${money(v.depositCents)} retained.`);file(s,'budget',['caterer','sunkCostCents']);}
    }else{
      if(!v.bookingRequested||!v.quoteReceived)throw new Error('Approve the quoted booking request before confirming it.');
      if(v.attendance!==f.attendance||v.date!==f.date)throw new Error('This booking uses older event details. Request an updated quote.');
      if(!v.confirmed){v.confirmed=true;f.cateringStatus='confirmed';s.state.project.revision++;invalidate(s,['cateringStatus']);s.state.messages.unshift({id:id(),at:now(),from:contactForVendor(v.newVendor),subject:'Booking confirmed',body:`Demo booking confirmed for ${f.attendance} guests on ${f.date}. Menu and requested dietary requirements confirmed. Total ${money(v.quoteCents??0)}.`,direction:'inbound',simulated:true});activity(s,`${v.newVendor} booking confirmed`,'The matching reply resumed the workflow. Staff and invitation updates are ready to approve.');email(s,'Tell staff about the confirmed meal','staff@northstar.example',`Catering is confirmed with ${v.newVendor} for ${f.attendance} guests on ${f.date}. Requirements: ${f.dietary}. Please use the updated service plan.`,'staff',['caterer','dietary','attendance','date']);invitations(s,'Update the confirmed meal in invitations',`Dinner will be provided by ${v.newVendor}. Dietary arrangements: ${f.dietary}. Event: ${f.date}, ${f.time}, ${f.venue}.`,['caterer','dietary','date','venue']);file(s,'catering',areaKeys.catering);file(s,'budget',['caterer','cateringPerPersonCents','cateringDeliveryCents','sunkCostCents']);}
    }
    s.plannedFacts=clone(f);refreshWorkflow(s);save(s);return output(s);
  });}
  async function tick(){
    if(ticking)return;ticking=true;const job=store.next();
    try{
      if(!job)return;
      if(job.kind==='action'){store.transaction(()=>{const s=load(job.projectId);const {proposalId}=JSON.parse(job.payload);const p=s.state.proposals.find(x=>x.id===proposalId);if(p)execute(s,p);refreshWorkflow(s);save(s);store.finish(job.id);});return;}
      const snapshot=load(job.projectId);const {generation}=JSON.parse(job.payload);if(snapshot.generation!==generation){store.finish(job.id,'superseded');return;}
      const requests=clone(snapshot.requests);const combinedPatch:FactPatch={};let result:PlanResult|undefined;const workingFacts=clone(snapshot.plannedFacts);const insights:NonNullable<PlanResult['insights']>=[];
      for(const request of requests){
        if(request.patch){const patch=cleanPatch(request.patch);Object.assign(combinedPatch,patch);Object.assign(workingFacts,patch);}
        const structuredOnly=!request.note?.trim();
        if(structuredOnly&&!request.patch)continue;
        const note=structuredOnly?`The user already committed these structured fields: ${JSON.stringify(request.patch)}. Keep these values authoritative and return no fact patch. Check their qualitative consequences against the current facts and cited sources; include only additional grounded insights.`:request.note!;
        result=await options.planner({note,area:request.area,facts:workingFacts,sources:snapshot.state.sources});
        if(result.error)throw new Error(result.error);
        insights.push(...(result.insights??[]));
        if(structuredOnly){result={...result,patch:{},questions:[]};continue;}
        const patch=cleanPatch(result.patch);Object.assign(combinedPatch,patch);Object.assign(workingFacts,patch);
      }
      store.transaction(()=>{
        const s=load(job.projectId);if(s.generation!==generation){store.finish(job.id,'superseded');return;}
        const changeId=commit(s,combinedPatch,'Planning details updated')??s.changes.at(-1)?.id;
        consequences(s,s.plannedFacts,changeId);
        for(const insight of insights){
          if(!insight.evidenceIds.length||insight.evidenceIds.some(sourceId=>!s.state.sources.some(source=>source.id===sourceId)))continue;
          const similar=s.state.proposals.some(p=>p.kind==='warning'&&p.area===insight.area&&p.status==='pending'&&(p.title.toLowerCase()===insight.title.toLowerCase()||(/capacity|seats? short/i.test(p.title)&&/capacity|seats?/i.test(insight.title))||(/over budget/i.test(p.title)&&/budget/i.test(insight.title))));
          if(!similar){const p=warning(s,insight.title,insight.detail,insight.area,[...new Set([...areaKeys[insight.area],...changed(s.plannedFacts,s.state.project.facts)])],changeId);p.evidence=insight.evidenceIds;}
        }
        if(result?.questions.length)for(const q of result.questions)warning(s,'A detail needs clarification',q,requests.at(-1)?.area??'brief',areaKeys[requests.at(-1)?.area??'brief'],changeId);
        s.plannedFacts=clone(s.state.project.facts);s.requests=[];
        if(s.state.workflow){s.state.workflow.model=result?.model;s.state.workflow.error=result?.error;}
        refreshWorkflow(s);save(s);store.finish(job.id);
      });
    }catch(error){if(job){const s=load(job.projectId);if(job.kind==='plan'&&s.generation!==JSON.parse(job.payload).generation){store.finish(job.id,'superseded');return;}if(s.state.workflow){s.state.workflow.status='failed';s.state.workflow.error=error instanceof Error?error.message:String(error);s.state.workflow.summary='This update needs attention. Your existing event details are saved.';}activity(s,'Could not finish checking the change',error instanceof Error?error.message:String(error),'attention');save(s);store.finish(job.id,'failed');}}
    finally{ticking=false;}
  }
  function reset(projectId:string){return store.transaction(()=>{const old=load(projectId);store.clearJobs(projectId);const s=seed(old.state.project.name,projectId);s.generation=old.generation+1;save(s);return output(s);});}
  return {getState,createProject,edit,decide,undo,inject,reset,tick,close:()=>store.close()};
}
