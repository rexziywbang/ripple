import {execFile} from 'node:child_process';
import path from 'node:path';
import {z} from 'zod';

export type PartifulStatus={status:'connected'|'not_installed'|'not_authenticated'|'unavailable';message:string};
export type PartifulEvent={id:string;name:string;date:string|null;url:string};
export type PartifulEvents=PartifulStatus&{events:PartifulEvent[];hasMore:boolean};
type CommandRunner=(binaryPath:string,args:string[])=>Promise<string>;

const loginMessage='Sign in to Partiful with npm run partiful:login, then refresh the connection.';
const notAuthenticated=():PartifulStatus=>({status:'not_authenticated',message:loginMessage});
const unavailable=(message='Partiful is unavailable right now. Try refreshing the connection.'):PartifulStatus=>({status:'unavailable',message});
const envelope=z.discriminatedUnion('ok',[
  z.object({ok:z.literal(true),data:z.unknown(),meta:z.object({command:z.string(),cliVersion:z.literal('3.0.1'),page:z.object({hasMore:z.boolean()}).optional()})}),
  z.object({ok:z.literal(false),error:z.object({type:z.string()}),meta:z.object({command:z.string(),cliVersion:z.literal('3.0.1')})}),
]);
const doctorData=z.object({healthy:z.boolean(),checks:z.array(z.object({name:z.string(),status:z.enum(['pass','warn','fail'])})).max(50)});
const eventData=z.object({items:z.array(z.object({
  eventId:z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/),
  title:z.string().max(2000).nullable(),start:z.string().max(100).nullable(),
})).max(100)});

// The binary owns its authentication. Only these fixed, non-interactive read
// commands are exposed; its diagnostics and environment secrets never enter JSON.
const runCommand:CommandRunner=(binaryPath,args)=>new Promise((resolve,reject)=>{
  const child=execFile(binaryPath,args,{encoding:'utf8',shell:false,timeout:15000,maxBuffer:512*1024,windowsHide:true,env:{
    PATH:process.env.PATH,HOME:process.env.HOME,XDG_CONFIG_HOME:process.env.XDG_CONFIG_HOME,TMPDIR:process.env.TMPDIR,
  }},(error,stdout)=>{
    if(error){reject(Object.assign(error,{stdout}));return;}resolve(stdout);
  });
  child.stdin?.end();
});

export function createPartifulAdapter(options:{binaryPath?:string;run?:CommandRunner}={}){
  const binaryPath=options.binaryPath??path.resolve('.tools/partiful');
  const run=options.run??runCommand;
  async function invoke(args:string[],command:string):Promise<z.infer<typeof envelope>|PartifulStatus>{
    let stdout:string;let failed=false;
    try{stdout=await run(binaryPath,args);}
    catch(error){
      failed=true;
      const failure=error as {code?:unknown;killed?:boolean;stdout?:unknown};
      if(failure?.code==='ENOENT')return {status:'not_installed',message:'Install the Partiful connection with npm run partiful:setup, then refresh.'};
      if(failure?.code===3)return notAuthenticated();
      if(failure?.killed||failure?.code==='ETIMEDOUT')return unavailable('Partiful took too long to respond. Try again in a moment.');
      if(typeof failure?.stdout!=='string')return unavailable();
      stdout=failure.stdout;
    }
    let result:z.infer<typeof envelope>;
    try{result=envelope.parse(JSON.parse(stdout));}
    catch{return unavailable('The Partiful connection returned an unsupported response. Run npm run partiful:setup, then retry.');}
    if(result.meta.command!==command)return unavailable('The Partiful connection returned an unexpected response. Try reinstalling the connection.');
    if(!result.ok){
      if(result.error.type.startsWith('auth.'))return notAuthenticated();
      if(result.error.type==='permission.denied')return unavailable('This Partiful account does not have access to the requested events.');
      if(result.error.type==='contract.protocol_changed')return unavailable('Partiful changed its response format. The connection needs an update before events can be read.');
      return unavailable();
    }
    if(failed)return unavailable();
    return result;
  }
  async function status():Promise<PartifulStatus>{
    // Unlike auth status, doctor does not refresh or rewrite credentials.
    const response=await invoke(['doctor','--non-interactive'],'doctor');
    if('status' in response)return response;
    if(!response.ok)return unavailable();
    const parsed=doctorData.safeParse(response.data);if(!parsed.success)return unavailable('Partiful could not verify its local connection. Try signing in again.');
    const credentials=parsed.data.checks.find(check=>check.name==='credentials');
    if(credentials&&credentials.status!=='pass')return notAuthenticated();
    if(!parsed.data.healthy||credentials?.status!=='pass')return unavailable();
    return {status:'connected',message:'Partiful credentials are ready. Open events to check your upcoming events.'};
  }
  async function events():Promise<PartifulEvents>{
    const response=await invoke(['events','list','--when','upcoming','--limit','100','--non-interactive'],'events.list');
    if('status' in response)return {...response,events:[],hasMore:false};
    if(!response.ok)return {...unavailable(),events:[],hasMore:false};
    const parsed=eventData.safeParse(response.data);
    if(!parsed.success||!response.meta.page)return {...unavailable('Partiful returned event details this connection cannot read yet.'),events:[],hasMore:false};
    const events=parsed.data.items.map(event=>({id:event.eventId,name:event.title?.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,300)||'Untitled event',date:event.start&&!Number.isNaN(Date.parse(event.start))?event.start:null,url:`https://partiful.com/e/${encodeURIComponent(event.eventId)}`}));
    return {status:'connected',message:response.meta.page.hasMore?'Showing the first 100 upcoming events. More events are available in Partiful.':events.length?'Upcoming events loaded from Partiful.':'No upcoming events were returned by Partiful.',events,hasMore:response.meta.page.hasMore};
  }
  return {status,events};
}
