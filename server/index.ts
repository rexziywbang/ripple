import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import {existsSync,mkdirSync} from 'node:fs';
import {z} from 'zod';
import {createService} from './domain.js';
import {createPlanner} from './planner.js';
import {createLiveBridge} from './live-bridge.js';
import {createPartifulAdapter} from './partiful.js';
import {capacityFitsEvent} from './places.js';
import {searchVenueIndex,warmVenueIndex} from './venue-index.js';
import {syncCalendar} from './calendar-sync.js';
import {buildDropboxContent} from './dropbox-sync.js';
import {syncDropboxWorkspace,stageDropboxWorkspace} from './dropbox-staging.js';
import {syncInvitations} from './invitation-sync.js';
import {createMailExtensionRouter} from './mail-extension.js';
import {createContactSync} from './contact-sync.js';
import {createRehearsalMail} from './rehearsal-mail.js';
import {createPlaceResearch} from './place-research.js';
import {resolveVenueEdit} from './venue-research-selection.js';
import {parseWorkspaceImport} from './workspace-import.js';

const dataDir=path.resolve(process.env.RIPPLE_DATA_DIR||'data');
const port=Number(process.env.PORT||8787);
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT must be an integer from 1 to 65535.');
const allowedOrigins=new Set([5173,port].flatMap(value=>[`http://127.0.0.1:${value}`,`http://localhost:${value}`]));
mkdirSync(dataDir,{recursive:true});
const planner=createPlanner({dbPath:path.join(dataDir,'ai.sqlite')});
const bridge=createLiveBridge({dbPath:path.join(dataDir,'live-bridge.sqlite')});
const partiful=createPartifulAdapter();
const mailMode=process.env.RIPPLE_MAIL_MODE==='live'?'live':'rehearsal';
const service=createService({dbPath:path.join(dataDir,'ripple.sqlite'),planner:planner.plan,aiStatus:planner.status,planningDelayMs:1200,bridge,mailMode});
const contacts=createContactSync({requests:service.contactRequests,apply:service.applyContactResearch});
const placeResearch=createPlaceResearch({dbPath:path.join(dataDir,'ai.sqlite'),cachePath:path.join(dataDir,'place-research.json')});
const rehearsalMail=createRehearsalMail({dataDir,getProjectIds:()=>service.getState().projects.map(p=>p.id),getState:service.getState,inject:service.inject,canInject:service.canInjectRehearsalReply});
void warmVenueIndex().catch(error=>console.warn('Local venue index warming failed:',error instanceof Error?error.message:'unavailable'));
const app=express();
app.disable('x-powered-by');
app.use('/api/mail-worker',createMailExtensionRouter({bridge,dataDir,getState:service.getState,reconcile:service.reconcileBridge,ingestReply:service.ingestReply}));
app.use((req,res,next)=>{
  if(!['127.0.0.1','localhost','::1'].includes(req.hostname))return res.status(403).json({error:'Local demo access only.'});
  if(!['GET','HEAD','OPTIONS'].includes(req.method)){
    const origin=req.headers.origin;
    if(origin&&!allowedOrigins.has(origin))return res.status(403).json({error:'This request must come from the Ripple workspace.'});
  }
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');next();
});
app.use('/api/projects/:id/dropbox-materials',express.json({limit:'600kb'}));
app.use('/api/workspace/import',express.json({limit:'600kb'}));
app.use(express.json({limit:'32kb'}));
const nonnegative=z.number().int().min(0).max(1_000_000_000);
const patch=z.object({
 attendance:z.number().int().min(1).max(100000),date:z.string().max(10),time:z.string().max(20),timezone:z.string().max(80),format:z.string().max(100),
 venue:z.string().max(300),venueAddress:z.string().max(500),venueCapacity:nonnegative,venueCostCents:nonnegative,venueIncludesAV:z.boolean(),venueResearchId:z.string().trim().min(1).max(160),
 caterer:z.string().max(160),cateringPerPersonCents:nonnegative,cateringDeliveryCents:nonnegative, dietary:z.string().max(8000),
 staffCount:nonnegative,staffCostEachCents:nonnegative,equipmentCostCents:nonnegative,budgetLimitCents:nonnegative,notes:z.string().max(8000)
}).partial().strict();
const editSchema=z.object({area:z.enum(['venue','guests','catering','budget','staff','equipment','brief']),patch:patch.optional(),note:z.string().trim().min(1).max(4000).optional()}).strict().refine(v=>v.note||Object.keys(v.patch??{}).length,'Enter a change to save.');
app.get('/api/health',(_req,res)=>res.json({ok:true,app:'Ripple',ai:planner.status()}));
app.get('/api/partiful/status',async(_req,res)=>res.json(await partiful.status()));
app.get('/api/partiful/events',async(_req,res)=>res.json(await partiful.events()));
app.get('/api/places',async(req,res)=>{
 const input=z.object({query:z.string().max(160).default(''),kind:z.enum(['venue','catering']),projectId:z.string().optional()}).parse(req.query);
 const state=service.getState(input.projectId);
 const result=input.kind==='venue' ? await searchVenueIndex(input.query) : await placeResearch.search({...input,facts:state.project.facts});
 res.json({...result,results:result.results.map(place=>input.kind==='venue'&&place.capacity&&!capacityFitsEvent(place.capacity,state.project.facts)?{...place,capacity:null}:place)});
});
app.get('/api/state',(req,res)=>res.json(service.getState(typeof req.query.projectId==='string'?req.query.projectId:undefined)));
const integrationConfig=(projectId:string)=>{
 const config=bridge.getConfig(projectId);
 config.providers.email.status=config.emailAccount&&config.testRecipient&&!/@[^@]*\.example$/i.test(config.emailAccount)&&!/@[^@]*\.example$/i.test(config.testRecipient)?'configured':'not_configured';
 return {...config,mailMode:config.emailDelivery??mailMode};
};
const workspaceConnections=()=>{
 const configs=service.getState().projects.map(project=>bridge.getConfig(project.id));
 const fields=['emailAccount','dropboxFolderUrl','calendarEventUrl','eviteEventUrl','partifulEventUrl'] as const;
 const config=configs.sort((a,b)=>fields.filter(field=>b[field]).length-fields.filter(field=>a[field]).length)[0];
 if(!config)return {};
 const {emailAccount,testRecipient,dropboxFolderUrl,calendarEventUrl,eviteEventUrl,partifulEventUrl}=config;
 return {emailAccount,testRecipient,dropboxFolderUrl,calendarEventUrl,eviteEventUrl,partifulEventUrl};
};
app.get('/api/workspace',(_req,res)=>res.json({projects:service.getState().projects,connections:workspaceConnections()}));
app.post('/api/workspace/import',(req,res)=>{
 const input=parseWorkspaceImport(req.body);const connections=workspaceConnections();
 const imported=service.createImportedProject(input);
 bridge.configure(imported.project.id,{...connections,testRecipient:input.demoPlanning?'rexziyw@gmail.com':connections.testRecipient,...(input.demoPlanning?{emailDelivery:'live' as const}:{})});
 syncProjectIntegrations(imported.project.id);res.status(201).json(service.getState(imported.project.id));
});
app.get('/api/projects/:id/integrations',(req,res)=>{service.getState(req.params.id);res.json(integrationConfig(req.params.id));});
app.get('/api/projects/:id/dropbox-export',(req,res)=>{
 const content=buildDropboxContent(service.getState(req.params.id));
 res.attachment('Ripple event plan.md').type('text/markdown').send(content);
});
const dropboxOptions=(state:ReturnType<typeof service.getState>)=>({rootDir:path.join(dataDir,'dropbox-staging'),...(/^Christmas dinner$/i.test(state.project.name)?{artwork:{path:path.resolve('web/public/invite-art/northstar-holiday.png'),fileName:'Northstar holiday invitation.png'}}:{})});
app.get('/api/projects/:id/dropbox-manifest',(req,res)=>{const state=service.getState(req.params.id);res.json(syncDropboxWorkspace(state,bridge,dropboxOptions(state)));});
app.get('/api/projects/:id/dropbox-files/:fileId',(req,res)=>{
 const state=service.getState(req.params.id);const manifest=stageDropboxWorkspace(state,dropboxOptions(state));const file=manifest.files.find(file=>file.id===req.params.fileId);
 if(!file)return res.status(404).json({error:'This file version is no longer current. Refresh the event documents.'});
 res.attachment(path.basename(file.path)).type(file.mimeType).sendFile(file.absolutePath);
});
app.post('/api/projects/:id/dropbox-materials',(req,res)=>{
 const input=z.object({files:z.array(z.object({path:z.string().min(1).max(240),content:z.string().max(100000)}).strict()).min(1).max(30),provenance:z.enum(['user_selected','fictional_scenario']).optional()}).strict().parse(req.body);
 const state=service.importDropboxMaterials(req.params.id,input.files,input.provenance);syncDropboxWorkspace(state,bridge,dropboxOptions(state));res.json(state);
});
app.put('/api/projects/:id/integrations',(req,res)=>{
 service.getState(req.params.id);
 const address=z.string().trim().max(320).refine(value=>!value||!/@[^@]*\.example$/i.test(value),'Use a real email address, not a .example fixture address.');
 const input=z.object({emailAccount:address.optional(),testRecipient:address.optional(),emailDelivery:z.enum(['live','rehearsal']).optional(),calendarEventUrl:z.string().trim().max(2000).optional(),dropboxFolderUrl:z.string().trim().max(2000).optional(),eviteEventUrl:z.string().trim().max(2000).optional(),partifulEventUrl:z.string().trim().max(2000).optional()}).strict().parse(req.body);
 bridge.configure(req.params.id,input);syncProjectIntegrations(req.params.id);res.json(integrationConfig(req.params.id));
});
app.get('/api/bridge/jobs',(req,res)=>{
 const projectId=typeof req.query.projectId==='string'?req.query.projectId:undefined;
 if(projectId)service.getState(projectId);res.json(bridge.listJobs(projectId));
});
app.post('/api/bridge/claim',(req,res)=>{
 const {workerId}=z.object({workerId:z.string().trim().min(1).max(120)}).strict().parse(req.body);
 service.reconcileBridge();syncActiveIntegrations();res.json(bridge.claimNext(workerId)??null);
});
app.post('/api/bridge/jobs/:id/complete',(req,res)=>{
 const input=z.object({externalId:z.string().min(1).max(500).optional(),url:z.string().url().max(2000).optional(),detail:z.string().trim().min(1).max(2000)}).strict().parse(req.body);
 const job=bridge.complete(req.params.id,input);service.reconcileBridge();res.json(job);
});
app.post('/api/bridge/jobs/:id/fail',(req,res)=>{
 const {error}=z.object({error:z.string().trim().min(1).max(2000)}).strict().parse(req.body);
 const job=bridge.fail(req.params.id,error);service.reconcileBridge();res.json(job);
});
app.post('/api/projects',(req,res)=>res.status(201).json(service.createProject(z.object({name:z.string().trim().min(1).max(160)}).parse(req.body).name)));
app.post('/api/projects/:id/archive',(req,res)=>{
 const {archived}=z.object({archived:z.boolean().default(true)}).strict().parse(req.body??{});
 res.json(service.archiveProject(req.params.id,archived));
});
app.patch('/api/projects/:id',(req,res)=>{
 const request=editSchema.parse(req.body);
 const resolved=resolveVenueEdit(request,service.getState(req.params.id).project.facts,placeResearch.resolveVenueSelection);
 res.json(service.edit(req.params.id,resolved));
});
app.post('/api/projects/:id/retry',(req,res)=>res.json(service.retryPlanning(req.params.id)));
app.post('/api/projects/:id/reconsider',(req,res)=>res.json(service.reconsider(req.params.id)));
app.post('/api/projects/:id/refresh-review',(req,res)=>res.json(service.refreshReview(req.params.id)));
app.patch('/api/projects/:id/proposals/:proposalId/draft',(req,res)=>{
 const input=z.object({subject:z.string().trim().min(1).max(300),body:z.string().trim().min(1).max(12000),draftToken:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(req.body);
 res.json(service.editDraft(req.params.id,req.params.proposalId,input));
});
app.post('/api/projects/:id/proposals/:proposalId/polish',async(req,res)=>res.json(await service.polishPlan(req.params.id,req.params.proposalId)));
app.post('/api/projects/:id/proposals/:proposalId/cards/:cardId/rewrite',async(req,res)=>{
 const input=z.object({instruction:z.string().trim().min(1).max(1200),revisionToken:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(req.body);
 res.json(await service.rewritePlanCard(req.params.id,req.params.proposalId,req.params.cardId,input));
});
app.post('/api/projects/:id/proposals/:proposalId/cards/:cardId/:decision',(req,res)=>{
 const {revisionToken}=z.object({revisionToken:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(req.body);
 res.json(service.decideCard(req.params.id,req.params.proposalId,req.params.cardId,z.enum(['approve','deny']).parse(req.params.decision),revisionToken));
});
app.post('/api/projects/:id/proposals/:proposalId/:decision',(req,res)=>{
 const {approvalToken}=z.object({approvalToken:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict().parse(req.body??{});
 res.json(service.decide(req.params.id,req.params.proposalId,z.enum(['approve','deny']).parse(req.params.decision),approvalToken));
});
app.post('/api/projects/:id/decisions',(req,res)=>{
 const input=z.object({proposalIds:z.array(z.string().min(1)).min(1).max(100),decision:z.enum(['approve','deny']),approvalTokens:z.record(z.string(),z.string().regex(/^[a-f0-9]{64}$/)).optional()}).strict().parse(req.body);
 res.json(service.decideMany(req.params.id,input.proposalIds,input.decision,input.approvalTokens));
});
app.post('/api/projects/:id/accept-all',(req,res)=>{
 const input=z.object({revision:z.number().int().nonnegative(),proposalIds:z.array(z.string().min(1)).min(1).max(100),approvalTokens:z.record(z.string(),z.string().regex(/^[a-f0-9]{64}$/)).optional(),planCardTokens:z.record(z.string(),z.record(z.string(),z.string().regex(/^[a-f0-9]{64}$/))).optional()}).strict().parse(req.body);
 const state=service.acceptAll(req.params.id,input);syncProjectIntegrations(req.params.id);res.json(state);
});
app.post('/api/projects/:id/undo/:changeId',(req,res)=>res.json(service.undo(req.params.id,req.params.changeId)));
app.post('/api/projects/:id/demo',(req,res)=>res.json(service.inject(req.params.id,z.object({type:z.enum(['quote','confirmation','cancellation','stale_quote'])}).parse(req.body).type)));
app.post('/api/projects/:id/mail-replies',(req,res)=>{
 const gmailUrl=z.string().url().max(2000).refine(value=>{const url=new URL(value);return url.protocol==='https:'&&url.hostname==='mail.google.com'&&!url.username&&!url.password;},'Use a Gmail message URL.');
 const {reprocess,...message}=z.object({externalId:z.string().trim().min(1).max(500),body:z.string().min(1).max(16000),subject:z.string().max(1000),sender:z.string().trim().min(1).max(500),receivedAt:z.string().datetime({offset:true}),url:gmailUrl.optional(),reprocess:z.boolean().optional()}).strict().parse(req.body);
 res.json(service.ingestReply(req.params.id,message,{reprocess}));
});
app.post('/api/projects/:id/reset',(req,res)=>res.json(service.reset(req.params.id)));
if(existsSync('dist/index.html')){
 app.use(express.static(path.resolve('dist')));
 app.get('/{*splat}',(_req,res)=>res.sendFile(path.resolve('dist/index.html')));
}
app.use((err:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
 const message=err instanceof z.ZodError?err.issues.map(e=>e.message).join('; '):err instanceof Error?err.message:'The request could not be completed.';
 res.status(400).json({error:message.replace(/sk-[A-Za-z0-9_-]+/g,'[redacted]').slice(0,500)});
});
const server=app.listen(port,'127.0.0.1',()=>console.log(`Ripple API ready at http://127.0.0.1:${port}`));
function syncProjectIntegrations(projectId:string){const state=service.getState(projectId);syncCalendar(state,bridge);syncDropboxWorkspace(state,bridge,dropboxOptions(state));syncInvitations(state,bridge);void contacts.sync(projectId);}
function syncActiveIntegrations(){for(const project of service.getState().projects)syncProjectIntegrations(project.id);}
const timer=setInterval(()=>{service.tick().then(()=>{if(mailMode==='rehearsal')rehearsalMail.tick();syncActiveIntegrations();}).catch(()=>console.error('A background job failed; review the workspace activity.'));},400);
let stopping=false;
function stop(){if(stopping)return;stopping=true;clearInterval(timer);server.close(()=>{service.close();planner.close?.();placeResearch.close();bridge.close();process.exit(0);});}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
