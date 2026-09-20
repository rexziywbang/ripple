import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createService,fallbackPlan} from '../server/domain.js';
import {createLiveBridge} from '../server/live-bridge.js';
import {buildDropboxDocuments,buildLeadershipBrief,stageDropboxWorkspace,syncDropboxWorkspace} from '../server/dropbox-staging.js';
import {prepareDropboxMaterials} from '../server/dropbox-materials.js';
import type {Proposal} from '../shared/types.js';

const services:Array<ReturnType<typeof createService>>=[];const bridges:Array<ReturnType<typeof createLiveBridge>>=[];
function setup(){const planner=vi.fn(async input=>fallbackPlan(input));const api=createService({dbPath:':memory:',planner,aiStatus:()=>({mode:'demo',model:'test',fallbackModel:'test',estimatedSpendUsd:0,spendLimitUsd:6})});services.push(api);const bridge=createLiveBridge({dbPath:':memory:'});bridges.push(bridge);const rootDir=mkdtempSync(path.join(tmpdir(),'ripple-dropbox-'));return {api,bridge,rootDir,id:api.getState().project.id,planner};}
afterEach(()=>{services.splice(0).forEach(api=>api.close());bridges.splice(0).forEach(bridge=>bridge.close());});
const materials=[{path:'Brief/Event brief.md',content:'# Event brief\n\nDoors open at 18:00. Require a quiet awards segment.'}];
describe('Dropbox planning workspace',()=>{
 it('imports explicit documents without altering event values or triggering a model call, and is idempotent',async()=>{
  const {api,id,planner}=setup();const before=api.getState();const imported=api.importDropboxMaterials(id,materials,'fictional_scenario');
  expect(imported.project.facts).toEqual(before.project.facts);expect(imported.project.revision).toBe(before.project.revision+1);
  expect(imported.sources.find(source=>source.material)).toMatchObject({content:materials[0].content,material:{path:materials[0].path,provenance:'fictional_scenario'}});
  expect(api.importDropboxMaterials(id,materials,'fictional_scenario')).toEqual(imported);await api.tick();expect(planner).not.toHaveBeenCalled();
  api.edit(id,{area:'brief',patch:{notes:'Check awards timing'}});await api.tick();expect(planner.mock.calls.at(-1)?.[0].sources.some((source:{content:string})=>source.content===materials[0].content)).toBe(true);
 });
 it('rejects traversal, hidden files, oversized totals, and duplicate paths before any import',()=>{
  const {api,id}=setup();const before=api.getState();
  for(const bad of ['../private.md','/private.md','Folder/../private.md','.env','Folder\\file.md'])expect(()=>api.importDropboxMaterials(id,[...materials,{path:bad,content:'secret'}])).toThrow();
  expect(()=>prepareDropboxMaterials([{path:'a.md',content:'x'.repeat(100001)}])).toThrow();
  expect(()=>prepareDropboxMaterials(Array.from({length:6},(_,i)=>({path:`${i}.md`,content:'x'.repeat(90000)})))).toThrow();
  expect(()=>prepareDropboxMaterials([{path:'A.md',content:'a'},{path:'a.md',content:'b'}])).toThrow();expect(api.getState()).toEqual(before);
 });
 it('consolidates generated details in two documents while retaining selected reference materials',()=>{
  const {api,id,rootDir}=setup();const state=api.importDropboxMaterials(id,materials);state.sources.push({id:'approved-plan:approved',title:'Awards timing',area:'brief',path:'plan',content:'# Quiet awards\nKeep buffet closed for the speech.'},{id:'private',title:'Unrelated',area:'brief',path:'private',content:'private-source-canary'});
  state.messages.push({id:'mail',at:'2026-09-20T00:00:00Z',from:'private-person@example.net',subject:'Timing confirmed',body:'private-message-canary',simulated:false,direction:'inbound'});
  state.proposals.push({id:'unapproved',kind:'plan',status:'pending',title:'Do not export',body:'unapproved-canary'} as Proposal);
  const manifest=stageDropboxWorkspace(state,{rootDir});const all=manifest.files.map(file=>readFileSync(file.absolutePath,'utf8')).join('\n');
  expect(all).toContain('Doors open at 18:00');expect(all).toContain('Keep buffet closed');expect(all).toContain('| Venue |');
  for(const canary of ['private-source-canary','private-message-canary','private-person@example.net','unapproved-canary','Timing confirmed'])expect(all).not.toContain(canary);
  expect(manifest.files.filter(file=>file.source!=='imported_material').map(file=>file.path)).toEqual(['Ripple event plan.md','Leadership brief.md']);
  expect(manifest.files.every(file=>file.status==='staged')).toBe(true);expect(manifest.remoteVerifiedCount).toBe(0);
  const later=structuredClone(state);later.project.revision++;expect(stageDropboxWorkspace(later,{rootDir})).toEqual(manifest);
 });
 it('retains immutable staged bytes after later edits and stages artwork as a binary file',()=>{
  const {api,rootDir}=setup();const artwork=path.join(rootDir,'input.png');writeFileSync(artwork,Buffer.from([137,80,78,71,0,255]));const options={rootDir,artwork:{path:artwork,fileName:'Invitation.png'}};
  const before=stageDropboxWorkspace(api.getState(),options);const state=api.getState();state.project.facts.attendance=10;const after=stageDropboxWorkspace(state,options);
  expect(after.bundleHash).not.toBe(before.bundleHash);expect(readFileSync(before.files[0].absolutePath,'utf8')).toContain('Expected guests: 240');expect(readFileSync(after.files[0].absolutePath,'utf8')).toContain('Expected guests: 10');
  expect(readFileSync(after.files.find(file=>file.source==='artwork')!.absolutePath)).toEqual(readFileSync(artwork));
 });
 it('coalesces each changed file independently and leaves running uploads immutable',()=>{
  const {api,bridge,rootDir,id}=setup();api.importDropboxMaterials(id,materials);bridge.configure(id,{dropboxFolderUrl:'https://www.dropbox.com/home/Event'});const first=syncDropboxWorkspace(api.getState(),bridge,{rootDir});const running=bridge.claimNext('browser','dropbox')!;
  const state=api.getState();state.project.facts.attendance=10;const second=syncDropboxWorkspace(state,bridge,{rootDir});
  expect(bridge.listJobs(id).find(job=>job.id===running.id)).toMatchObject({status:'running',payload:running.payload});
  expect(second.files[0].jobId).not.toBe(first.files[0].jobId);expect(second.files.find(file=>file.source==='imported_material')!.jobId).toBe(first.files.find(file=>file.source==='imported_material')!.jobId);
  expect(syncDropboxWorkspace(state,bridge,{rootDir}).files.map(file=>file.jobId)).toEqual(second.files.map(file=>file.jobId));
  expect(second.remoteVerifiedCount).toBe(0);
 });
 it('reconciles delivery status without retrying uncertain failures and handles disconnect/reconnect',()=>{
  const {api,bridge,rootDir,id}=setup();bridge.configure(id,{dropboxFolderUrl:'https://www.dropbox.com/home/Event'});const first=syncDropboxWorkspace(api.getState(),bridge,{rootDir});const failed=bridge.claimNext('browser','dropbox')!;bridge.fail(failed.id,'Verify upload before retry.');
  expect(syncDropboxWorkspace(api.getState(),bridge,{rootDir}).files[0]).toMatchObject({jobId:failed.id,status:'failed'});
  bridge.configure(id,{dropboxFolderUrl:''});syncDropboxWorkspace(api.getState(),bridge,{rootDir});expect(bridge.listJobs(id).filter(job=>job.status==='queued')).toHaveLength(0);
  bridge.configure(id,{dropboxFolderUrl:'https://www.dropbox.com/home/Event'});const next=syncDropboxWorkspace(api.getState(),bridge,{rootDir});expect(next.files[0].jobId).toBe(failed.id);expect(next.files[1].jobId).not.toBe(first.files[1].jobId);
 });
 it('removes withdrawn plan content from the current report',()=>{
  const {api}=setup();const state=api.getState();state.sources.push({id:'approved-plan:one',title:'Service',path:'plan',area:'brief',content:'# Old plan'});
  const before=buildDropboxDocuments(state)[0];state.sources.at(-1)!.content='';const after=buildDropboxDocuments(state)[0];
  expect(after.path).toBe(before.path);expect(before.content).toContain('Old plan');expect(after.content).not.toContain('Old plan');
 });
 it('exports only the latest applied unrevoked invitation, never current unapproved event edits',()=>{
  const {api}=setup();const state=api.getState();const snapshot={name:'Dinner',date:'2026-12-11',time:'18:00',timezone:'America/New_York',venue:'Approved room',venueAddress:'1 Main St',caterer:'',dietary:'Vegetarian',format:'Dinner'};
  state.proposals.push({id:'invitation',kind:'invitation',status:'applied',invitationSnapshot:snapshot} as Proposal);state.project.facts.venue='Unapproved room';
  const invitationSection=String(buildDropboxDocuments(state)[0].content).split('## Invitation status')[1];expect(invitationSection).toContain('Approved room');expect(invitationSection).not.toContain('Unapproved room');
  state.proposals[0].invitationSnapshotRevoked=true;expect(buildDropboxDocuments(state)[0].content).toContain('No current approved invitation');
 });
 it('writes a concise leadership brief from current values and material unresolved decisions',()=>{
  const {api}=setup();const state=api.getState();state.project.facts.attendance=10;state.project.facts.venueDetailsPending=true;state.project.facts.cateringStatus='awaiting_quote';state.project.facts.caterer='CAVA';state.project.facts.budgetLimitCents=1500000;
  const content=buildLeadershipBrief(state);expect(content).toContain('10 guests');expect(content).toContain('$960 over budget');expect(content).toContain('complete catering quote from CAVA');expect(content).toContain('not a final commitment');expect(content.split(/\s+/).length).toBeLessThan(220);
 });
});
