import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { ProjectState, Proposal } from '../shared/types.js';

export type RehearsalReplyKind = 'quote' | 'cancellation' | 'confirmation';
const entrySchema = z.object({ projectId:z.string(),proposalId:z.string(),receiptId:z.string(),kind:z.enum(['quote','cancellation','confirmation']),dueAt:z.number().finite(),status:z.enum(['scheduled','done','skipped','failed']),error:z.string().optional() });
type Entry = z.infer<typeof entrySchema>;
type Options = {
  dataDir:string;
  getProjectIds:()=>string[];
  getState:(projectId:string)=>ProjectState;
  inject:(projectId:string,kind:RehearsalReplyKind)=>unknown;
  /** Domain checks the exact original fact signature, vendor transition and simulated delivery mode. */
  canInject:(projectId:string,proposalId:string,kind:RehearsalReplyKind)=>boolean;
  now?:()=>number;
};
const delays:Record<RehearsalReplyKind,number>={quote:6000,cancellation:8000,confirmation:6000};
function kindFor(proposal:Proposal):RehearsalReplyKind|undefined {
  if(proposal.kind!=='email'||proposal.status!=='applied')return;
  if(/^Request a quote from .+$/.test(proposal.title))return 'quote';
  if(/^Cancel .+ catering$/.test(proposal.title))return 'cancellation';
  if(/^Request booking with .+$/.test(proposal.title))return 'confirmation';
}
function eligibleReceipt(state:ProjectState,entry:Pick<Entry,'proposalId'|'receiptId'|'kind'>):boolean {
  const proposal=state.proposals.find(value=>value.id===entry.proposalId);
  const receipt=state.receipts.find(value=>value.id===entry.receiptId&&value.proposalId===entry.proposalId&&value.status==='simulated');
  if(!proposal||!receipt||kindFor(proposal)!==entry.kind)return false;
  // A delivery receipt alone is not sufficient: require the corresponding local-only outbound.
  return state.messages.some(message=>message.simulated===true&&message.direction==='outbound'
    &&message.from===proposal.recipient&&message.subject===(proposal.subject??proposal.title)
    &&message.body===(proposal.body??proposal.description)&&Math.abs(Date.parse(message.at)-Date.parse(receipt.at))<=1000);
}

/** Local fictional vendor responses only. This helper never claims or completes live bridge jobs. */
export function createRehearsalMail({dataDir,getProjectIds,getState,inject,canInject,now=Date.now}:Options) {
  mkdirSync(dataDir,{recursive:true,mode:0o700});
  const path=join(dataDir,'rehearsal-mail.json');
  const stored=existsSync(path)?z.object({version:z.literal(1),entries:z.record(z.string(),entrySchema)}).parse(JSON.parse(readFileSync(path,'utf8'))):{version:1 as const,entries:{} as Record<string,Entry>};
  if(existsSync(path))chmodSync(path,0o600);
  const entries=stored.entries;
  const persist=()=>{const temporary=`${path}.${process.pid}.tmp`;writeFileSync(temporary,JSON.stringify({version:1,entries},null,2),{mode:0o600});chmodSync(temporary,0o600);renameSync(temporary,path);};
  let ticking=false;
  return {
    tick(){
      const result={scheduled:0,replied:0,skipped:0,failed:0};
      if(ticking)return result;ticking=true;
      try{
        const active=new Set(getProjectIds());
        for(const projectId of active){
          const state=getState(projectId);
          for(const receipt of state.receipts){
            if(receipt.status!=='simulated'||!receipt.proposalId)continue;
            const proposal=state.proposals.find(value=>value.id===receipt.proposalId);if(!proposal)continue;
            const kind=kindFor(proposal);if(!kind)continue;
            const key=`${projectId}:${receipt.id}`;if(entries[key])continue;
            const dueAt=Date.parse(receipt.at)+delays[kind];if(!Number.isFinite(dueAt))continue;
            const entry:Entry={projectId,proposalId:proposal.id,receiptId:receipt.id,kind,dueAt,status:'scheduled'};
            if(!eligibleReceipt(state,entry)||!canInject(projectId,proposal.id,kind))continue;
            entries[key]=entry;result.scheduled++;
          }
        }
        if(result.scheduled)persist();
        for(const entry of Object.values(entries)){
          if(entry.status!=='scheduled'||entry.dueAt>now())continue;
          if(!active.has(entry.projectId)||!eligibleReceipt(getState(entry.projectId),entry)||!canInject(entry.projectId,entry.proposalId,entry.kind)){
            entry.status='skipped';result.skipped++;persist();continue;
          }
          try{
            // inject is transactional and idempotent; after a crash the domain guard must reject an already-applied reply.
            inject(entry.projectId,entry.kind);entry.status='done';result.replied++;
          }catch(error){entry.status='failed';entry.error=(error instanceof Error?error.message:'Staged reply failed.').slice(0,300);result.failed++;}
          persist();
        }
        return result;
      }finally{ticking=false;}
    },
    list:()=>structuredClone(Object.values(entries))
  };
}
