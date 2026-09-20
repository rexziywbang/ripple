import {createHash} from 'node:crypto';
import type {PlanCard,Planner,Proposal} from '../shared/types.js';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function cardToken(card:Omit<PlanCard,'revisionToken'>){return hash([card.id,card.revision,card.title,card.body,card.status]);}
export function updateCard(card:PlanCard,patch:Partial<Pick<PlanCard,'title'|'body'|'status'>>):PlanCard{
  const next={...card,...patch,revision:card.revision+1};return {...next,revisionToken:cardToken(next)};
}

/** Legacy text is preserved verbatim inside its sections; no model call is needed. */
export function planCards(proposal:Pick<Proposal,'id'|'title'|'body'|'status'|'planCards'>):PlanCard[]{
  if(proposal.planCards?.length)return proposal.planCards;
  const text=(proposal.body??'').trim();if(!text)return [];
  let sections:Array<{title:string;body:string}>=[];
  const lines=text.split('\n');let title='Before you begin';let body:string[]=[];
  const push=()=>{if(body.join('\n').trim())sections.push({title,body:body.join('\n').trim()});body=[];};
  for(const line of lines){const heading=line.match(/^##\s+(.+?)\s*#*$/);if(heading){push();title=heading[1].trim();}else body.push(line);}
  push();
  if(sections.length===1){
    const blocks=text.split(/\n\s*\n|\n(?=\d+[.)]\s)/).map(block=>block.trim()).filter(Boolean);
    if(blocks.length>1)sections=blocks.map((block,index)=>({title:index===0?'Context and assumptions':`Step ${index}`,body:block}));
    else sections=[{title:proposal.title,body:text}];
  }
  // Old long documents keep every section, even if they predate the 4–6-card prompt.
  return sections.map((section,index)=>{const card={id:hash([proposal.id,index]).slice(0,24),...section,status:proposal.status==='applied'?'approved' as const:proposal.status==='denied'?'denied' as const:'pending' as const,revision:1};return {...card,revisionToken:cardToken(card)};});
}
export function cardsMarkdown(cards:PlanCard[],approvedOnly=false){return cards.filter(card=>!approvedOnly||card.status==='approved').map(card=>`## ${card.title}\n\n${card.body}`).join('\n\n');}

export async function rewriteCard(planner:Planner,input:Parameters<Planner>[0],card:PlanCard,cards:PlanCard[],instruction:string){
  const request=instruction.trim();if(!request||request.length>1200)throw new Error('Describe the card change in 1–1,200 characters.');
  const result=await planner({...input,structuredOnly:true,note:`Rewrite only the selected operating-plan card. User request: ${request}`,cardRewrite:{instruction:request,card:{title:card.title,body:card.body},otherCards:cards.filter(other=>other.id!==card.id).map(({title,body,status})=>({title,body,status}))}});
  if(result.error)throw new Error(result.error);
  const action=result.actions?.[0];
  if(result.actions?.length!==1||action?.kind!=='plan'||Object.keys(result.patch).length||action.subject!==null||action.recipient!==null||!action.body.trim()||action.body.length>1800||!action.evidenceIds.length||action.evidenceIds.some(id=>!input.sources.some(source=>source.id===id)))throw new Error('The card could not be rewritten safely. The existing draft is unchanged.');
  return {title:action.title.trim(),body:action.body.trim(),evidenceIds:action.evidenceIds};
}

export async function polishCards(planner:Planner,input:Parameters<Planner>[0],proposal:Proposal){
  const result=await planner({...input,structuredOnly:true,note:'Rewrite this pending plan into concise, natural decision cards. Use practical action-led titles and direct organizer language. Remove planning-basis, fixture, document-reconciliation, and internal-process commentary. Keep the useful event decisions and necessary real-world caveats.',planPolish:{title:proposal.title,body:proposal.body??''},existingDecisions:input.existingDecisions?.filter(decision=>decision!==proposal)});
  if(result.error)throw new Error(result.error);
  const action=result.actions?.[0];
  if(result.actions?.length!==1||action?.kind!=='plan'||Object.keys(result.patch).length||action.subject!==null||action.recipient!==null||!action.evidenceIds.length||action.evidenceIds.some(id=>!input.sources.some(source=>source.id===id)))throw new Error('The plan could not be rewritten safely. The existing draft is unchanged.');
  const previous=planCards(proposal);const cards=planCards({...proposal,title:action.title,body:action.body,planCards:undefined}).map(card=>{const old=previous.find(item=>item.id===card.id);return old?updateCard(old,{title:card.title,body:card.body}):card;});
  if(cards.length<4||cards.length>6||cards.some(card=>card.body.split(/\s+/).length>90)||action.reason.length>240)throw new Error('The revised plan needs four to six concise cards and a short description. The existing draft is unchanged.');
  return {...action,cards};
}
