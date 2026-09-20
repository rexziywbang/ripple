import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import {existsSync,mkdirSync} from 'node:fs';
import {z} from 'zod';
import {createService} from './domain.js';
import {createPlanner} from './planner.js';

const dataDir=path.resolve(process.env.RIPPLE_DATA_DIR||'data');
const port=Number(process.env.PORT||8787);
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT must be an integer from 1 to 65535.');
const allowedOrigins=new Set([5173,port].flatMap(value=>[`http://127.0.0.1:${value}`,`http://localhost:${value}`]));
mkdirSync(dataDir,{recursive:true});
const planner=createPlanner({dbPath:path.join(dataDir,'ai.sqlite')});
const service=createService({dbPath:path.join(dataDir,'ripple.sqlite'),planner:planner.plan,aiStatus:planner.status});
const app=express();
app.disable('x-powered-by');
app.use((req,res,next)=>{
  if(!['127.0.0.1','localhost','::1'].includes(req.hostname))return res.status(403).json({error:'Local demo access only.'});
  if(!['GET','HEAD','OPTIONS'].includes(req.method)){
    const origin=req.headers.origin;
    if(origin&&!allowedOrigins.has(origin))return res.status(403).json({error:'This request must come from the Ripple workspace.'});
  }
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');next();
});
app.use(express.json({limit:'32kb'}));
const nonnegative=z.number().int().min(0).max(1_000_000_000);
const patch=z.object({
 attendance:z.number().int().min(1).max(100000),date:z.string().max(10),time:z.string().max(20),timezone:z.string().max(80),format:z.string().max(100),
 venue:z.string().max(300),venueAddress:z.string().max(500),venueCapacity:nonnegative,venueCostCents:nonnegative,venueIncludesAV:z.boolean(),
 caterer:z.string().max(160),cateringPerPersonCents:nonnegative,cateringDeliveryCents:nonnegative, dietary:z.string().max(8000),
 staffCount:nonnegative,staffCostEachCents:nonnegative,equipmentCostCents:nonnegative,budgetLimitCents:nonnegative,notes:z.string().max(8000)
}).partial().strict();
const editSchema=z.object({area:z.enum(['venue','guests','catering','budget','staff','equipment','brief']),patch:patch.optional(),note:z.string().trim().min(1).max(4000).optional()}).strict().refine(v=>v.note||Object.keys(v.patch??{}).length,'Enter a change to save.');
app.get('/api/health',(_req,res)=>res.json({ok:true,app:'Ripple',ai:planner.status()}));
app.get('/api/state',(req,res)=>res.json(service.getState(typeof req.query.projectId==='string'?req.query.projectId:undefined)));
app.post('/api/projects',(req,res)=>res.status(201).json(service.createProject(z.object({name:z.string().trim().min(1).max(160)}).parse(req.body).name)));
app.patch('/api/projects/:id',(req,res)=>res.json(service.edit(req.params.id,editSchema.parse(req.body))));
app.post('/api/projects/:id/proposals/:proposalId/:decision',(req,res)=>res.json(service.decide(req.params.id,req.params.proposalId,z.enum(['approve','deny']).parse(req.params.decision))));
app.post('/api/projects/:id/undo/:changeId',(req,res)=>res.json(service.undo(req.params.id,req.params.changeId)));
app.post('/api/projects/:id/demo',(req,res)=>res.json(service.inject(req.params.id,z.object({type:z.enum(['quote','confirmation','cancellation','stale_quote'])}).parse(req.body).type)));
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
const timer=setInterval(()=>{service.tick().catch(()=>console.error('A background job failed; review the workspace activity.'));},400);
let stopping=false;
function stop(){if(stopping)return;stopping=true;clearInterval(timer);server.close(()=>{service.close();planner.close?.();process.exit(0);});}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
