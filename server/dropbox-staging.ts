import { mkdirSync, readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import type { ProjectState } from '../shared/types.js';
import type { LiveBridge, LiveJob } from './live-bridge.js';
import { buildDropboxContent, DROPBOX_PLAN_FILE_NAME } from './dropbox-sync.js';
import { materialHash, safeMaterialPath } from './dropbox-materials.js';

export type DropboxDocument={path:string;content:string|Buffer;mimeType:string;source:'current_plan'|'imported_material'|'approved_plan'|'communication_metadata'|'invitation'|'artwork'};
export type DropboxManifestFile={id:string;path:string;absolutePath:string;sha256:string;bytes:number;mimeType:string;source:DropboxDocument['source'];downloadUrl:string;status:'staged'|LiveJob['status'];jobId?:string};
export type DropboxManifest={projectId:string;projectName:string;bundleHash:string;directory:string;folderUrl?:string;files:DropboxManifestFile[];remoteVerifiedCount:number};
export type DropboxStageOptions={rootDir:string;artwork?:{path:string;fileName:string}};
const text=(value:string)=>value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'');
const sentence=(value:string)=>text(value).replace(/[\r\n]+/g,' ').trim();
const money=(cents:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(cents/100);

export function buildLeadershipBrief(state:ProjectState):string {
  const f=state.project.facts;const difference=state.budget.totalCents-f.budgetLimitCents;
  const decisions=state.proposals.filter(p=>['pending','blocked'].includes(p.status)&&p.kind!=='file');
  const priorities=[...new Set([
    ...(f.venueDetailsPending?[`Confirm the room price and availability with ${sentence(f.venue)}.`]:[]),
    ...((f.venueCapacityPending??f.venueDetailsPending)?['Confirm seated capacity for the selected room.']:f.venueCapacity<f.attendance?[`Resolve the room shortfall: ${f.attendance} guests against ${f.venueCapacity} seats.`]:[]),
    ...(f.cateringStatus==='awaiting_quote'?[`Obtain a complete catering quote from ${sentence(f.caterer)} before treating the forecast as final.`]:f.cateringStatus!=='confirmed'?[`Confirm the catering booking with ${sentence(f.caterer)}.`]:[]),
    ...(difference>0?[`Close the ${money(difference)} gap against the approved budget.`]:[]),
    ...decisions.map(p=>sentence(p.title)).filter(title=>!/update .*details|dropbox|record|local|demo/i.test(title)),
  ])].slice(0,5);
  return [`# ${sentence(state.project.name)} — leadership brief`,'',
    `The event is planned for ${f.date} at ${f.time} (${f.timezone}) for ${f.attendance} guests.`,
    `Venue: ${sentence(f.venue)}${f.venueAddress?` — ${sentence(f.venueAddress)}`:''}.`,
    `Meal: ${sentence(f.caterer)} (${f.cateringStatus==='confirmed'?'confirmed in the plan':f.cateringStatus==='awaiting_quote'?'quote pending':f.cateringStatus==='quoted'?'quote received; booking pending':'booking confirmation pending'}). Dietary needs: ${sentence(f.dietary)||'None recorded'}.`,'',
    '## Budget','',`Forecast: **${money(state.budget.totalCents)}** against **${money(f.budgetLimitCents)}** available — ${difference>0?`${money(difference)} over budget`:`${money(-difference)} remaining`}.`,
    ...(f.venueDetailsPending||state.budget.lines.some(line=>line.status==='awaiting quote')?['The forecast includes carried estimates or pending quotes and is not a final commitment.']:[]),'',
    '## Decisions and next steps','',...(priorities.length?priorities.map(priority=>`- ${priority}`):['No unresolved planning decisions are currently recorded. Continue checking supplier confirmations and guest responses.']),'',
    'The itemized budget, approved operating plans, and invitation status are in Ripple event plan.md.',''].join('\n');
}

export function buildDropboxDocuments(state:ProjectState,artwork?:DropboxStageOptions['artwork']):DropboxDocument[] {
  const documents:DropboxDocument[]=[{path:DROPBOX_PLAN_FILE_NAME,content:buildDropboxContent(state),mimeType:'text/markdown',source:'current_plan'}];
  documents.push({path:'Leadership brief.md',content:buildLeadershipBrief(state),mimeType:'text/markdown',source:'current_plan'});
  for(const source of state.sources){
    if(source.material){
      documents.push({path:`01 Planning materials/${safeMaterialPath(source.material.path)}`,content:source.content,mimeType:/\.csv$/i.test(source.material.path)?'text/csv':/\.json$/i.test(source.material.path)?'application/json':/\.md$/i.test(source.material.path)?'text/markdown':'text/plain',source:'imported_material'});
    }
  }
  if(artwork&&existsSync(artwork.path))documents.push({path:`07 Invitations/${safeMaterialPath(artwork.fileName)}`,content:readFileSync(artwork.path),mimeType:'image/png',source:'artwork'});
  const seen=new Set<string>();for(const document of documents){safeMaterialPath(document.path);if(seen.has(document.path.toLowerCase()))throw new Error('Export document names must be unique.');seen.add(document.path.toLowerCase());}
  return documents;
}

/** Immutable local versions let the browser upload exactly the queued bytes, even after later edits. */
export function stageDropboxWorkspace(state:ProjectState,options:DropboxStageOptions):DropboxManifest {
  const documents=buildDropboxDocuments(state,options.artwork);
  const hashes=documents.map(document=>({path:document.path,sha256:materialHash(document.content)}));
  const bundleHash=materialHash(JSON.stringify(hashes));
  const projectSegment=materialHash(state.project.id).slice(0,24);
  const directory=path.resolve(options.rootDir,projectSegment,bundleHash);
  const files=documents.map((document,index):DropboxManifestFile=>{
    const absolutePath=path.join(directory,document.path);const sha256=hashes[index].sha256;
    if(!existsSync(absolutePath)){mkdirSync(path.dirname(absolutePath),{recursive:true});const temporary=`${absolutePath}.pending`;writeFileSync(temporary,document.content,{mode:0o600});renameSync(temporary,absolutePath);}
    const id=materialHash(`${document.path}:${sha256}`).slice(0,32);
    return {id,path:document.path,absolutePath,sha256,bytes:Buffer.byteLength(document.content),mimeType:document.mimeType,source:document.source,downloadUrl:`/api/projects/${encodeURIComponent(state.project.id)}/dropbox-files/${id}`,status:'staged'};
  });
  const manifest:DropboxManifest={projectId:state.project.id,projectName:state.project.name,bundleHash,directory,files,remoteVerifiedCount:0};
  const manifestPath=path.join(directory,'manifest.json');if(!existsSync(manifestPath))writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
  return manifest;
}

export function syncDropboxWorkspace(state:ProjectState,bridge:LiveBridge,options:DropboxStageOptions):DropboxManifest {
  const manifest=stageDropboxWorkspace(state,options);const folderUrl=bridge.getConfig(state.project.id).dropboxFolderUrl;
  const previous=bridge.listJobs(state.project.id).filter(job=>job.provider==='dropbox'&&job.action==='update_file');
  manifest.folderUrl=folderUrl;
  if(!folderUrl){for(const job of previous)if(job.status==='queued')bridge.cancel(job.id);return manifest;}
  const activePaths=new Set(manifest.files.map(file=>file.path));
  for(const job of previous)if(job.status==='queued'&&!activePaths.has(String(job.payload.relativePath??job.payload.fileName)))bridge.cancel(job.id);
  for(const file of manifest.files){
    const history=previous.filter(job=>(job.payload.relativePath??job.payload.fileName)===file.path);
    const latest=history.at(-1);const contentHash=materialHash(JSON.stringify({folderUrl,path:file.path,sha256:file.sha256}));
    const job=latest?.payload.contentHash===contentHash&&latest.status!=='cancelled'?latest:bridge.enqueue({projectId:state.project.id,provider:'dropbox',action:'update_file',revision:state.project.revision,dedupeKey:`dropbox-file:${contentHash}:${latest?.id??'initial'}`,payload:{folderUrl,fileName:path.posix.basename(file.path),relativePath:file.path,localPath:file.absolutePath,mimeType:file.mimeType,sha256:file.sha256,contentHash,...(file.mimeType.startsWith('text/')||file.mimeType==='application/json'?{content:readFileSync(file.absolutePath,'utf8')}:{})}});
    for(const prior of history)if(prior.id!==job.id&&prior.status==='queued')bridge.cancel(prior.id);
    file.status=job.status;file.jobId=job.id;
  }
  manifest.remoteVerifiedCount=manifest.files.filter(file=>file.status==='completed').length;
  return manifest;
}
