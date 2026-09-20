export {};
const base='http://127.0.0.1:8787';
async function request(route:string,method='GET',body?:unknown){const r=await fetch(base+route,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw new Error(data.error);return data;}
async function settled(projectId:string,predicate:(s:any)=>boolean){for(let i=0;i<100;i++){const s=await request('/api/state?projectId='+projectId);if(s.workflow?.status==='failed')throw new Error(s.workflow.error);if(predicate(s))return s;await new Promise(resolve=>setTimeout(resolve,300));}throw new Error('Timed out waiting for persisted work');}
function check(ok:unknown,message:string){if(!ok)throw new Error(message);console.log('PASS '+message);}
const state=await request('/api/projects','POST',{name:'Workflow validation'});const id=state.project.id;
await request('/api/projects/'+id,'PATCH',{area:'catering',patch:{caterer:'CAVA'}});
let s=await settled(id,s=>s.workflow?.status!=='planning');
check(s.project.facts.caterer==='CAVA','ordinary caterer edit completed with Astra');
for(const title of ['Cancel Shah Halal catering','Request a quote from CAVA']){
 const p=s.proposals.find((p:any)=>p.status==='pending'&&p.title===title);
 if(!p)throw new Error('Missing proposal: '+title+'; got '+s.proposals.map((p:any)=>p.title).join(', '));
 await request(`/api/projects/${id}/proposals/${p.id}/approve`,'POST');
}
s=await settled(id,s=>s.receipts.filter((r:any)=>r.status==='simulated').length>=2);
check(s.project.facts.cateringStatus==='awaiting_quote','approved messages lead to durable quote wait');
await request(`/api/projects/${id}/demo`,'POST',{type:'cancellation'});
s=await request(`/api/projects/${id}/demo`,'POST',{type:'quote'});
check(s.budget.totalCents===1728000,'quote resumes forecast to $17,280 with deposit retained');
check(s.project.facts.cateringStatus==='quoted','quote is not a confirmed booking');
const p=s.proposals.find((p:any)=>p.status==='pending'&&p.title==='Request booking with CAVA');
await request(`/api/projects/${id}/proposals/${p.id}/approve`,'POST');
s=await settled(id,s=>s.project.facts.cateringStatus==='awaiting_confirmation');
s=await request(`/api/projects/${id}/demo`,'POST',{type:'confirmation'});
check(s.project.facts.cateringStatus==='confirmed','booking requires the later confirmation event');
check(s.proposals.some((p:any)=>p.status==='pending'&&p.title==='Tell staff about the confirmed meal'),'staff update appears only after confirmation');
const count=s.messages.length;await request(`/api/projects/${id}/demo`,'POST',{type:'confirmation'});s=await request('/api/state?projectId='+id);
check(s.messages.length===count,'duplicate confirmation does not duplicate messages');
const before=s.budget.totalCents;s=await request(`/api/projects/${id}/demo`,'POST',{type:'stale_quote'});
check(s.budget.totalCents===before,'older quote cannot overwrite the current budget');
console.log(JSON.stringify({projectId:id,model:s.ai.model,estimatedSpendUsd:s.ai.estimatedSpendUsd,receipts:s.receipts.length,summary:'API journey complete'},null,2));
