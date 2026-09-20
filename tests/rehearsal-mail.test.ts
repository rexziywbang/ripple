import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProjectState, Proposal } from '../shared/types.js';
import { createRehearsalMail, type RehearsalReplyKind } from '../server/rehearsal-mail.js';

const dirs:string[]=[];
afterEach(()=>{for(const dir of dirs.splice(0)){for(const file of readdirSync(dir))unlinkSync(join(dir,file));rmdirSync(dir);}});
function setup(kind:RehearsalReplyKind='quote'){
  const dataDir=mkdtempSync(join(tmpdir(),'ripple-rehearsal-'));dirs.push(dataDir);
  const at=Date.now();let clock=at;let current=true;let active=true;let throwReply=false;
  const title=kind==='quote'?'Request a quote from CAVA':kind==='cancellation'?'Cancel Shah Halal catering':'Request booking with CAVA';
  const proposal={id:'proposal-one',title,kind:'email',status:'applied',recipient:'catering@cava.example',subject:'Dinner: '+title,body:'Reviewed email body.',createdAt:new Date(at).toISOString(),version:1} as Proposal;
  const state={project:{id:'event-one'},projects:[{id:'event-one',name:'Dinner'}],proposals:[proposal],receipts:[{id:'receipt-one',at:new Date(at).toISOString(),proposalId:proposal.id,status:'simulated'}],messages:[{id:'outbound-one',at:new Date(at).toISOString(),from:proposal.recipient,subject:proposal.subject,body:proposal.body,direction:'outbound',simulated:true}]} as unknown as ProjectState;
  const replies:Array<{projectId:string;kind:RehearsalReplyKind}>=[];
  const options={dataDir,getProjectIds:()=>active?['event-one']:[],getState:()=>state,canInject:()=>current,inject:(projectId:string,replyKind:RehearsalReplyKind)=>{if(throwReply)throw new Error('Staged vendor state changed.');replies.push({projectId,kind:replyKind});},now:()=>clock};
  return {dataDir,state,replies,options,worker:createRehearsalMail(options),advance:(ms:number)=>{clock+=ms;},setCurrent:(value:boolean)=>{current=value;},archive:()=>{active=false;},fail:()=>{throwReply=true;}};
}
describe('automatic fictional vendor reply scheduler',()=>{
  it('responds to a processed simulated quote after six seconds, once',()=>{
    const ctx=setup();expect(ctx.worker.tick()).toMatchObject({scheduled:1,replied:0});
    ctx.advance(5999);expect(ctx.worker.tick().replied).toBe(0);ctx.advance(1);
    expect(ctx.worker.tick().replied).toBe(1);ctx.worker.tick();expect(ctx.replies).toEqual([{projectId:'event-one',kind:'quote'}]);
  });
  it.each([['cancellation',8000],['confirmation',6000]] as const)('schedules %s using its expected delay', (kind,delay)=>{
    const ctx=setup(kind);ctx.worker.tick();ctx.advance(delay-1);ctx.worker.tick();expect(ctx.replies).toHaveLength(0);
    ctx.advance(1);expect(ctx.worker.tick().replied).toBe(1);expect(ctx.replies[0].kind).toBe(kind);
  });
  it('never responds to live deliveries, unsent drafts, or invitations',()=>{
    const live=setup();live.state.receipts[0].status='delivered';live.advance(20000);live.worker.tick();expect(live.replies).toHaveLength(0);
    const echo=setup();echo.state.messages[0].simulated=false;echo.advance(20000);echo.worker.tick();expect(echo.replies).toHaveLength(0);
    const draft=setup();draft.state.proposals[0].status='pending';draft.advance(20000);draft.worker.tick();expect(draft.replies).toHaveLength(0);
    const invitation=setup();invitation.state.proposals[0].kind='invitation';invitation.advance(20000);invitation.worker.tick();expect(invitation.replies).toHaveLength(0);
  });
  it('persists deadlines privately and does not replay a completed reply after restart',()=>{
    const ctx=setup();ctx.worker.tick();ctx.advance(6000);const restarted=createRehearsalMail(ctx.options);
    expect(statSync(join(ctx.dataDir,'rehearsal-mail.json')).mode&0o777).toBe(0o600);
    expect(restarted.tick().replied).toBe(1);const reopened=createRehearsalMail(ctx.options);reopened.tick();expect(ctx.replies).toHaveLength(1);
    expect(reopened.list()[0].status).toBe('done');
  });
  it('rechecks the domain fact signature and skips a superseded vendor request',()=>{
    const ctx=setup();ctx.worker.tick();ctx.setCurrent(false);ctx.advance(6000);
    expect(ctx.worker.tick()).toMatchObject({skipped:1,replied:0});expect(ctx.replies).toHaveLength(0);expect(ctx.worker.list()[0].status).toBe('skipped');
  });
  it('does not respond after an event is archived or its simulated outbound is removed',()=>{
    const archived=setup();archived.worker.tick();archived.archive();archived.advance(6000);expect(archived.worker.tick().skipped).toBe(1);
    const removed=setup();removed.worker.tick();removed.state.messages=[];removed.advance(6000);expect(removed.worker.tick().skipped).toBe(1);
    expect([...archived.replies,...removed.replies]).toHaveLength(0);
  });
  it('records an injection error without repeatedly generating responses',()=>{
    const ctx=setup();ctx.worker.tick();ctx.fail();ctx.advance(6000);expect(ctx.worker.tick().failed).toBe(1);
    expect(ctx.worker.list()[0]).toMatchObject({status:'failed',error:'Staged vendor state changed.'});
    expect(ctx.worker.tick().failed).toBe(0);expect(ctx.replies).toHaveLength(0);
  });
});
