import { describe, expect, it } from 'vitest';
import { observedReplySchema, validateObservedReply, type ObservedReply } from '../server/mail-reply-monitor.js';
import type { LiveJob } from '../server/live-bridge.js';
// @ts-expect-error The unpacked extension ships plain JavaScript without a bundler.
import { buildReplyCaptures, createReplyMonitor } from '../extensions/ripple-mail/reply-monitor.js';

const account = 'ripple-monitor-test@gmail.com';
function fixture() {
  const now = Math.floor(Date.now()/60000)*60000;
  const iso = (delta: number) => new Date(now+delta).toISOString();
  const url = 'https://mail.google.com/mail/u/0/#inbox/KtbxLzExampleTrackedThread';
  const job: LiveJob = { id:'job-one', projectId:'project-one', provider:'email', action:'send_email', revision:1,dedupeKey:'quote-one', status:'completed', createdAt:iso(-130000),claimedAt:iso(-130000),updatedAt:iso(-110000),payload:{account,recipient:account,subject:'Dinner: Request a quote',body:'Please quote catering for 200 people.'},receipt:{completedAt:iso(-110000),url,detail:'Gmail confirmed sending.'} };
  const capture: ObservedReply = { message:{externalId:'#msg-reply',body:'Vendor: CAVA\nTotal: USD 6000.00',subject:'Dinner: Request a quote',sender:account,receivedAt:iso(-60000),url},provenance:{method:'gmail_visible_thread',observedAt:iso(0),browserTimezone:'America/Detroit',threadSubject:'Dinner: Request a quote',threadUrl:url,threadId:'#thread-tracked',subjectSource:'gmail_thread_heading',receivedAtLabel:'Sep 20, 2026, 1:00 AM',messageIndex:1,recipientAddresses:[account],outbound:{externalId:'#msg-original',sender:account,recipientAddresses:[account],body:'Please quote catering for 200 people.',receivedAt:iso(-120000),receivedAtLabel:'Sep 20, 2026, 12:59 AM',messageIndex:0}} };
  const target = { jobId:job.id,subject:job.payload.subject,body:job.payload.body,account,expectedSender:account,completedAt:job.receipt!.completedAt,claimedAt:job.claimedAt,capturedExternalIds:[] };
  const thread = { subject:capture.message.subject,url,threadId:capture.provenance.threadId,browserTimezone:'America/Detroit',messages:[{...capture.provenance.outbound},{...capture.message,recipientAddresses:[account],receivedAtLabel:capture.provenance.receivedAtLabel,messageIndex:1}] };
  return { job, capture, target, thread, now };
}

describe('tracked visible Gmail reply validation', () => {
  it('retains raw body, visible subject, dates, sender and thread provenance', () => {
    const {job,capture}=fixture(); const parsed=observedReplySchema.parse(capture);
    expect(validateObservedReply(job,account,parsed)).toMatchObject({...capture.message,browserProvenance:capture.provenance});
  });
  it('requires delivered work and the expected paired account and sender', () => {
    const {job,capture}=fixture();
    expect(()=>validateObservedReply({...job,status:'queued'},account,capture)).toThrow('delivered');
    expect(()=>validateObservedReply(job,'other@gmail.com',capture)).toThrow('account');
    expect(()=>validateObservedReply(job,account,{...capture,message:{...capture.message,sender:'stranger@gmail.com'}})).toThrow('sender');
  });
  it('rejects the outbound echo even when sending to the same account', () => {
    const {job,capture}=fixture();
    expect(()=>validateObservedReply(job,account,{...capture,message:{...capture.message,externalId:capture.provenance.outbound.externalId}})).toThrow('echo');
    expect(()=>validateObservedReply(job,account,{...capture,message:{...capture.message,body:String(job.payload.body)}})).toThrow('echo');
    expect(()=>validateObservedReply(job,account,{...capture,provenance:{...capture.provenance,messageIndex:0}})).toThrow('echo');
  });
  it('requires a matching outbound body and exact tracked subject/thread', () => {
    const {job,capture}=fixture();
    expect(()=>validateObservedReply(job,account,{...capture,message:{...capture.message,subject:'Unrelated mail'}})).toThrow('subject');
    const url='https://mail.google.com/mail/u/0/#inbox/KtbxOtherUnrelatedThread';
    expect(()=>validateObservedReply(job,account,{...capture,message:{...capture.message,url},provenance:{...capture.provenance,threadUrl:url}})).toThrow('different Gmail thread');
    expect(()=>validateObservedReply(job,account,{...capture,provenance:{...capture.provenance,outbound:{...capture.provenance.outbound,body:'Unrelated original'}}})).toThrow('original message');
  });
  it('rejects older replies and missing paired-recipient evidence', () => {
    const {job,capture}=fixture();
    expect(()=>validateObservedReply(job,account,{...capture,message:{...capture.message,receivedAt:job.createdAt}})).toThrow('older');
    expect(()=>validateObservedReply(job,account,{...capture,provenance:{...capture.provenance,recipientAddresses:['someone@gmail.com']}})).toThrow('addressed');
    expect(()=>observedReplySchema.parse({...capture,message:{...capture.message,url:'https://evil.example/thread'}})).toThrow();
  });
  it('accepts a later distinct same-minute reply without inventing seconds', () => {
    const {job,capture}=fixture(); capture.message.receivedAt=capture.provenance.outbound.receivedAt;
    expect(validateObservedReply(job,account,capture).receivedAt).toBe(capture.provenance.outbound.receivedAt);
  });
});

describe('extension reply monitoring', () => {
  it('selects only later replies and deduplicates already captured message IDs', () => {
    const {target,thread,now}=fixture();
    expect(buildReplyCaptures(target,thread,[],new Date(now).toISOString())).toHaveLength(1);
    expect(buildReplyCaptures(target,thread,['#msg-reply'],new Date(now).toISOString())).toHaveLength(0);
    expect(buildReplyCaptures({...target,capturedExternalIds:['#msg-reply']},thread,[],new Date(now).toISOString())).toHaveLength(0);
  });
  it('ignores a thread without the original outbound anchor or with ambiguous anchors', () => {
    const {target,thread,now}=fixture();
    expect(buildReplyCaptures(target,{...thread,messages:thread.messages.slice(1)},[],new Date(now).toISOString())).toEqual([]);
    expect(buildReplyCaptures(target,{...thread,messages:[...thread.messages,thread.messages[0]]},[],new Date(now).toISOString())).toEqual([]);
  });
  it('persists capture IDs only after server acknowledgement and does not capture twice', async () => {
    const {target,thread,now}=fixture(); let clock=now;
    const state:Record<string,any>={token:'a'.repeat(64),account,tabId:7,enabled:true};const posts:string[]=[];
    const monitor=createReplyMonitor({read:async()=>structuredClone(state),write:async(patch:Record<string,unknown>)=>Object.assign(state,patch),now:()=>clock,
      post:async(_config:unknown,path:string)=>{posts.push(path);return path==='/reply-targets'?[target]:{captured:true,externalId:'#msg-reply'};},
      tabMessage:async(_tab:number,message:{type:string})=>message.type==='ripple:ready'?{ready:true,account}:thread});
    await monitor(); expect(state.capturedReplyIds).toEqual(['#msg-reply']);clock+=16000;await monitor();
    expect(posts.filter(path=>path.endsWith('/replies'))).toHaveLength(1);
  });
  it('does not inspect Gmail while sending or paused', async () => {
    for(const state of [{enabled:false},{enabled:true,inFlight:{phase:'sending'}}]){
      let calls=0;const monitor=createReplyMonitor({read:async()=>({token:'a'.repeat(64),account,tabId:7,...state}),write:async()=>{},post:async()=>{calls++;},tabMessage:async()=>{calls++;}});
      await monitor();expect(calls).toBe(0);
    }
  });
});
