import {resolveContact,type ContactRequest,type ContactResult} from './contact-research.js';

/** Contact enrichment stays out of the planner's critical path and costs no model call. */
export function createContactSync(options:{
  requests:(projectId:string)=>ContactRequest[];
  apply:(projectId:string,request:ContactRequest,result:ContactResult)=>unknown;
  resolve?:(request:ContactRequest)=>Promise<ContactResult>;
}){
  const running=new Set<string>();
  async function sync(projectId:string){
    if(running.has(projectId))return;
    running.add(projectId);
    try{await Promise.allSettled(options.requests(projectId).map(async request=>{
      const result=await (options.resolve??resolveContact)(request);
      options.apply(projectId,request,result);
    }));}finally{running.delete(projectId);}
  }
  return {sync};
}
