import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createService, fallbackPlan } from '../server/domain.js';
import { createLiveBridge } from '../server/live-bridge.js';
import { createRehearsalMail } from '../server/rehearsal-mail.js';
import type { AiStatus } from '../shared/types.js';
const dirs:string[]=[];const services:Array<ReturnType<typeof createService>>=[];const bridges:Array<ReturnType<typeof createLiveBridge>>=[];
const aiStatus=():AiStatus=>({mode:'demo',model:'fixture',fallbackModel:'fixture',estimatedSpendUsd:0,spendLimitUsd:8});
function setup(mailMode:'live'|'rehearsal'='rehearsal'){
  const dataDir=mkdtempSync(join(tmpdir(),'ripple-rehearsal-domain-'));dirs.push(dataDir);
  const bridge=createLiveBridge({dbPath:':memory:'});bridges.push(bridge);
  const options={dbPath:join(dataDir,'event.sqlite'),planner:async(input:Parameters<typeof fallbackPlan>[0])=>fallbackPlan(input),aiStatus,bridge,mailMode};
  const api=createService(options);services.push(api);const projectId=api.getState().project.id;
  bridge.configure(projectId,{emailAccount:'rehearsal-test@gmail.com',testRecipient:'rehearsal-test@gmail.com'});
  return {dataDir,bridge,api,projectId,options};
}
async function prepare(ctx:ReturnType<typeof setup>){ctx.api.edit(ctx.projectId,{area:'catering',patch:{caterer:'CAVA'}});await ctx.api.tick();return ctx.api.getState(ctx.projectId).proposals.filter(p=>p.status==='pending'&&p.kind==='email'&&(/^Request a quote/.test(p.title)||/^Cancel .+ catering$/.test(p.title)));}
const scheduler=(ctx:ReturnType<typeof setup>)=>createRehearsalMail({dataDir:ctx.dataDir,getProjectIds:()=>ctx.api.getState().projects.map(p=>p.id),getState:ctx.api.getState,inject:ctx.api.inject,canInject:ctx.api.canInjectRehearsalReply});
afterEach(()=>{vi.useRealTimers();for(const service of services.splice(0)){try{service.close();}catch{}}for(const bridge of bridges.splice(0))bridge.close();for(const dir of dirs.splice(0)){for(const file of readdirSync(dir))unlinkSync(join(dir,file));rmdirSync(dir);}});
describe('rehearsal mail integrated with the event engine',()=>{
  it('approval immediately records planned-address delivery in the demo, even with Gmail configured',async()=>{
    const ctx=setup();const request=(await prepare(ctx)).find(p=>p.title.startsWith('Request a quote'))!;
    const state=ctx.api.decide(ctx.projectId,request.id,'approve',request.approvalToken);
    expect(state.proposals.find(p=>p.id===request.id)?.status).toBe('applied');
    expect(state.receipts.find(r=>r.proposalId===request.id)?.status).toBe('simulated');
    expect(state.messages.find(m=>m.direction==='outbound')).toMatchObject({from:request.recipient,simulated:true});
    expect(ctx.bridge.listJobs().filter(job=>job.provider==='email')).toHaveLength(0);
  });
  it('migrates an approved unclaimed Gmail job into simulated delivery without claiming or sending it',async()=>{
    const ctx=setup('live');const request=(await prepare(ctx)).find(p=>p.title.startsWith('Request a quote'))!;
    ctx.api.decide(ctx.projectId,request.id,'approve',request.approvalToken);await ctx.api.tick();
    expect(ctx.bridge.listJobs()[0].status).toBe('queued');ctx.api.close();
    const rehearsal=createService({...ctx.options,mailMode:'rehearsal'});services.push(rehearsal);rehearsal.reconcileBridge();
    const state=rehearsal.getState(ctx.projectId);
    expect(ctx.bridge.listJobs()[0]).toMatchObject({status:'cancelled'});expect(ctx.bridge.listJobs()[0].workerId).toBeUndefined();
    expect(state.receipts.find(r=>r.proposalId===request.id)?.status).toBe('simulated');
    expect(state.messages.find(m=>m.direction==='outbound')?.from).toBe(request.originalRecipient);
    expect(state.messages.some(m=>m.simulated===false)).toBe(false);
  });
  it('withdraws a scheduled response when the event changes before the vendor replies',async()=>{
    vi.useFakeTimers();const ctx=setup();const request=(await prepare(ctx)).find(p=>p.title.startsWith('Request a quote'))!;
    ctx.api.decide(ctx.projectId,request.id,'approve',request.approvalToken);
    expect(ctx.api.canInjectRehearsalReply(ctx.projectId,request.id,'quote')).toBe(true);
    const worker=scheduler(ctx);worker.tick();ctx.api.edit(ctx.projectId,{area:'guests',patch:{attendance:300}});await ctx.api.tick();
    expect(ctx.api.canInjectRehearsalReply(ctx.projectId,request.id,'quote')).toBe(false);
    vi.setSystemTime(Date.now()+7000);expect(worker.tick().replied).toBe(0);
    expect(ctx.api.getState().project.facts.cateringStatus).toBe('awaiting_quote');
  });
  it('automatically resumes quote, cancellation and booking stages with delayed local replies',async()=>{
    vi.useFakeTimers();const ctx=setup();const requests=await prepare(ctx);const started=Date.now();
    for(const request of requests)ctx.api.decide(ctx.projectId,request.id,'approve',request.approvalToken);
    const worker=scheduler(ctx);expect(worker.tick().scheduled).toBe(2);
    vi.setSystemTime(started+6000);expect(worker.tick().replied).toBe(1);expect(ctx.api.getState().project.facts.cateringStatus).toBe('quoted');
    const booking=ctx.api.getState().proposals.find(p=>p.status==='pending'&&p.title==='Request booking with CAVA')!;
    ctx.api.decide(ctx.projectId,booking.id,'approve',booking.approvalToken);worker.tick();
    vi.setSystemTime(started+8000);expect(worker.tick().replied).toBe(1);
    vi.setSystemTime(started+12000);expect(worker.tick().replied).toBe(1);
    const state=ctx.api.getState();expect(state.project.facts.cateringStatus).toBe('confirmed');
    expect(state.messages.filter(m=>m.direction==='inbound')).toHaveLength(3);
    expect(state.messages.every(m=>m.simulated)).toBe(true);
    expect(ctx.bridge.listJobs().filter(job=>job.provider==='email')).toHaveLength(0);
    expect(worker.tick().replied).toBe(0);
  });
});
