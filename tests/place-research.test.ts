import {describe,it,expect,vi} from 'vitest';
import {createPlaceResearch,placeOutputFailure,researchEvidence} from '../server/place-research.js';
import {initialFacts} from '../server/fixtures.js';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {VENUE_CATALOG} from '../server/venue-catalog.js';
const source='https://www.mass.gov/locations/simulated-test-rink';
const output={summary:'A skating venue nearby.',results:[{name:'Test Rink',address:'1 Test Street, Cambridge, MA',locality:'Cambridge',sourceUrl:source,website:source,reason:'Ice skating could work before dinner.',caveat:'Private hire and dining space need confirming.',capacity:null,av:null,roomLimit:null}]};
const reply=(result:unknown=output)=>({finalOutput:result,runContext:{usage:{inputTokens:100,outputTokens:100}},rawResponses:[{providerData:{output:[{type:'web_search_call',action:{sources:[{url:source}]}}]}}]});
describe('semantic place research',()=>{
 it('honors the shared disabled spending guard while still recording token and web-search usage',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ripple-place-cap-'));const dbPath=join(dir,'usage.sqlite');const execute=vi.fn(async()=>reply());
  const capped=createPlaceResearch({apiKey:'test',dbPath,spendLimitUsd:0,spendCapEnabled:true,execute});
  const uncapped=createPlaceResearch({apiKey:'test',dbPath,spendLimitUsd:0,spendCapEnabled:false,execute});
  try{
   expect((await capped.search({query:'ice rink',kind:'venue'})).message).toContain('local AI budget');expect(execute).not.toHaveBeenCalled();
   expect((await uncapped.search({query:'ice rink',kind:'venue'})).mode).toBe('ai_research');expect(execute).toHaveBeenCalledTimes(1);
   const db=new DatabaseSync(dbPath,{readOnly:true});try{expect(db.prepare('SELECT state,charged_micro_usd FROM ai_usage').all()).toEqual([{state:'complete',charged_micro_usd:16000}]);}finally{db.close();}
  }finally{capped.close();uncapped.close();rmSync(dir,{recursive:true});}
 });
 it('resolves every local catalog venue beyond autocomplete limits without accepting caterers as venues',()=>{
  const execute=vi.fn(async()=>reply());const research=createPlaceResearch({apiKey:'test',dbPath:':memory:',execute});
  try{for(const place of VENUE_CATALOG)expect(research.resolveVenueSelection(place.id,initialFacts)).toMatchObject({id:place.id,name:place.name,address:place.address,sourceUrl:place.sourceUrl});expect(research.resolveVenueSelection('cava-harvard-square',initialFacts)).toBeUndefined();expect(execute).not.toHaveBeenCalled();}finally{research.close();}
 });
 it('retains sourced banquet capacity and explicitly included AV for server-owned selection',async()=>{
  const capacity={guests:120,room:'Dining Room',layout:'banquet',sourceUrl:source,excerpt:'Dining Room banquet capacity: 120 guests.'};const av={included:true,room:'Dining Room',items:['Microphone','Speakers'],sourceUrl:source,excerpt:'Microphone and speakers are included in the Dining Room rental.'};
  const research=createPlaceResearch({apiKey:'test',dbPath:':memory:',execute:async()=>reply({...output,results:[{...output.results[0],capacity,av}]})});
  try{const result=await research.search({query:'ice rink with dinner',kind:'venue',facts:initialFacts});expect(result.results[0]).toMatchObject({capacity,av});expect(research.resolveVenueSelection(result.results[0].id,initialFacts)).toMatchObject({capacity,av});expect(research.resolveVenueSelection('invented-id',initialFacts)).toBeUndefined();expect(research.resolveVenueSelection(result.results[0].id,{...initialFacts,format:'Standing reception'})?.capacity).toBeNull();}finally{research.close();}
 });
 it('does not turn standing capacity or merely available AV into dinner facts',async()=>{
  const capacity={guests:500,room:'Arena',layout:'reception',sourceUrl:source,excerpt:'Arena reception capacity: 500 guests.'};const av={included:true,room:'Arena',items:['Projector'],sourceUrl:source,excerpt:'Projector and audiovisual services are available on request.'};
  const research=createPlaceResearch({apiKey:'test',dbPath:':memory:',execute:async()=>reply({...output,results:[{...output.results[0],capacity,av}]})});
  try{const result=await research.search({query:'ice rink',kind:'venue',facts:initialFacts});expect(result.results[0]).toMatchObject({capacity:null,av:null});}finally{research.close();}
 });
 it('discards capacity and AV that cite a URL absent from the actual web evidence',async()=>{
  const capacity={guests:120,room:'Dining Room',layout:'banquet',sourceUrl:'https://invented.example/capacity',excerpt:'Dining Room: 120 banquet guests.'};const av={included:true,room:'Dining Room',items:['Microphone'],sourceUrl:'https://invented.example/av',excerpt:'Microphone included in rental.'};
  const research=createPlaceResearch({apiKey:'test',dbPath:':memory:',execute:async()=>reply({...output,results:[{...output.results[0],capacity,av}]})});try{expect((await research.search({query:'ice rink',kind:'venue',facts:initialFacts})).results[0]).toMatchObject({capacity:null,av:null});}finally{research.close();}
 });
 it('resolves published Marriott banquet capacity without a paid call, but never invents Garden Hall facts',async()=>{
  const execute=vi.fn(async()=>reply());const research=createPlaceResearch({apiKey:'test',dbPath:':memory:',execute});
  try{const result=await research.search({query:'Marriot',kind:'venue',facts:initialFacts});const marriott=result.results.find(place=>place.id==='boston-marriott-cambridge')!;expect(marriott.capacity).toMatchObject({guests:600,room:'Grand Ballroom',layout:'banquet',sourceUrl:'https://www.marriott.com/en-us/hotels/boscb-boston-marriott-cambridge/events/'});expect(research.resolveVenueSelection(marriott.id,initialFacts)?.capacity).toEqual(marriott.capacity);expect(research.resolveVenueSelection('Garden Hall',initialFacts)).toBeUndefined();expect(execute).not.toHaveBeenCalled();}finally{research.close();}
 });
 it('backfills an old Warrior cache with actual inclusions and a room limit, without claiming seated capacity',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ripple-room-cache-'));const cachePath=join(dir,'cache.json');let research=createPlaceResearch({apiKey:'test',dbPath:':memory:',cachePath,execute:async()=>reply()});
  try{await research.search({query:'ice rink',kind:'venue',facts:initialFacts});research.close();const cache=JSON.parse(readFileSync(cachePath,'utf8'));const entry=Object.values(cache)[0] as any;const old=entry.result.results[0];Object.assign(old,{name:'Warrior Ice Arena',address:'90 Guest Street, Boston, MA 02135',sourceUrl:'https://www.warrioricearena.com/private-special-events/private-events/'});delete old.capacity;delete old.av;delete old.roomLimit;writeFileSync(cachePath,JSON.stringify(cache));const execute=vi.fn(async()=>reply());research=createPlaceResearch({apiKey:'test',dbPath:':memory:',cachePath,execute});const place=(await research.search({query:'ice rink',kind:'venue',facts:initialFacts})).results[0];expect(place.capacity).toBeNull();expect(place.roomLimit).toMatchObject({guests:197,room:'Standard Event Room'});expect(place.av).toMatchObject({included:true,room:'Standard Event Room'});expect(research.resolveVenueSelection(old.id,initialFacts)).toMatchObject({capacity:null,roomLimit:{guests:197},av:{included:true}});expect(execute).not.toHaveBeenCalled();}finally{research.close();rmSync(dir,{recursive:true});}
 });
 it('retains completed SDK usage and safe schema diagnostics when invalid output has no state',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ripple-place-'));const dbPath=join(dir,'usage.sqlite');
  const research=createPlaceResearch({apiKey:'test',dbPath,execute:async(_agent,_input,options)=>{
   const attempted={...output,results:[{...output.results[0],name:undefined,caveat:'private-response-secret'}]};
   options.errorHandlers.invalidFinalOutput({context:{usage:{inputTokens:100,outputTokens:100}},runData:{rawResponses:[{providerData:{output:[{type:'web_search_call',action:{sources:[{url:source}]}},{type:'message',content:[{type:'output_text',text:JSON.stringify(attempted)}]}]}}]}} as any);
   throw new Error('Invalid output type: final assistant output did not match the expected schema.');
  }});
  try{
   expect((await research.search({query:'ice rink',kind:'venue'})).mode).toBe('unavailable');const db=new DatabaseSync(dbPath);const row=db.prepare('SELECT state,charged_micro_usd,failure,metadata FROM ai_usage').get() as any;db.close();
   expect(row.state).toBe('failed_known_usage');expect(row.charged_micro_usd).toBe(16000);expect(row.failure).toBe('validation');const metadata=JSON.parse(row.metadata);expect(metadata.toolCalls.web_search).toBe(1);expect(metadata.validationFailure).toContain('results.0.name');expect(metadata.validationFailure).toContain('invalid_type');expect(row.metadata).not.toContain('private-response-secret');
  }finally{research.close();rmSync(dir,{recursive:true});}
 });
 it('extracts sources and citations from actual Responses envelopes and never logs incomplete JSON',()=>{
  const evidence=researchEvidence([{providerData:{output:[{type:'web_search_call',action:{url:'https://official.test/room#details',sources:[{url:'https://official.test/food?utm_source=test'}]}},{type:'message',content:[{type:'output_text',annotations:[{type:'url_citation',url:'https://official.test/events'}]}]}]}}]);
  expect(evidence.calls).toBe(1);expect([...evidence.urls]).toEqual(['https://official.test/room','https://official.test/food','https://official.test/events']);expect(placeOutputFailure('{"private":"sk-test-secret')).toBe('The final output was not complete valid JSON.');
 });
 it('keeps specific named matches instant but researches a category with event context',async()=>{
  const execute=vi.fn(async()=>reply());const research=createPlaceResearch({apiKey:'test',dbPath:':memory:',execute});
  expect((await research.search({query:'Marriot',kind:'venue'})).mode).toBe('verified_directory');expect(execute).not.toHaveBeenCalled();
  const result=await research.search({query:'ice rink',kind:'venue',facts:initialFacts});
  expect(result.mode).toBe('ai_research');expect(result.results[0].reason).toContain('skating');expect(execute.mock.calls[0]).toBeDefined();research.close();
 });
 it('does not present uncited model-invented URLs as researched matches',async()=>{
  const research=createPlaceResearch({apiKey:'test',dbPath:':memory:',execute:async()=>reply({...output,results:[{...output.results[0],sourceUrl:'https://invented.example/rink'}]})});
  expect((await research.search({query:'ice rink',kind:'venue'})).results).toEqual([]);research.close();
 });
 it('uses the cited source when the separate website was not returned by search',async()=>{
  const research=createPlaceResearch({apiKey:'test',dbPath:':memory:',execute:async()=>reply({...output,results:[{...output.results[0],website:'https://invented.example/booking'}]})});const result=await research.search({query:'ice rink',kind:'venue'});expect(result.results[0].website).toBe(source);research.close();
 });
 it('keeps a grounded result when a useful reason exceeds the presentation target',async()=>{
  const reason='This venue has a documented rink suitable for the requested activity. '.repeat(6);const caveat='Confirm private hire, guest capacity, catering access, and the date directly with the operator. '.repeat(4);
  const research=createPlaceResearch({apiKey:'test',dbPath:':memory:',execute:async()=>reply({...output,results:[{...output.results[0],reason,caveat}]})});const result=await research.search({query:'ice rink',kind:'venue'});expect(result.mode).toBe('ai_research');expect(result.results[0]).toMatchObject({reason:reason.trim(),caveat:caveat.trim()});research.close();
 });
 it('renders fresh Markdown citations as plain prose while retaining source links',async()=>{
  const research=createPlaceResearch({apiKey:'test',dbPath:':memory:',execute:async()=>reply({...output,summary:`Try [ice skating](${source}).`,results:[{...output.results[0],reason:`An **indoor rink** nearby ([Mass.gov](${source})).`,caveat:`Confirm private hire [1](${source}). citeturn0search1`}]})});
  try{const result=await research.search({query:'ice rink',kind:'venue'});expect(result.message).toBe('Try ice skating.');expect(result.results[0]).toMatchObject({reason:'An indoor rink nearby.',caveat:'Confirm private hire.',sourceUrl:source,website:source});}finally{research.close();}
 });
 it('cleans older on-disk cached descriptions without another model call',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'ripple-place-cache-'));const cachePath=join(dir,'cache.json');let research=createPlaceResearch({apiKey:'test',dbPath:':memory:',cachePath,execute:async()=>reply()});
  try{await research.search({query:'ice rink',kind:'venue'});research.close();const cache=JSON.parse(readFileSync(cachePath,'utf8'));const entry=Object.values(cache)[0] as any;entry.result.message=`A nearby [rink](${source}).`;entry.result.results[0].reason=`Skating before dinner ([Source](${source})).`;entry.result.results[0].caveat=`Ask about [private hire](${source}).`;writeFileSync(cachePath,JSON.stringify(cache));const execute=vi.fn(async()=>reply());research=createPlaceResearch({apiKey:'test',dbPath:':memory:',cachePath,execute});const result=await research.search({query:'ice rink',kind:'venue'});expect(execute).not.toHaveBeenCalled();expect(result.message).toBe('A nearby rink.');expect(result.results[0]).toMatchObject({reason:'Skating before dinner.',caveat:'Ask about private hire.',sourceUrl:source,website:source});}finally{research.close();rmSync(dir,{recursive:true});}
 });
 it('deduplicates simultaneous research and caches the exact event context',async()=>{
  const execute=vi.fn(async()=>reply());const research=createPlaceResearch({apiKey:'test',dbPath:':memory:',execute});
  const input={query:'ice rink',kind:'venue' as const,facts:initialFacts};
  await Promise.all([research.search(input),research.search(input)]);await research.search(input);expect(execute).toHaveBeenCalledTimes(1);
  await research.search({...input,facts:{...initialFacts,attendance:100}});expect(execute).toHaveBeenCalledTimes(2);research.close();
 });
 it('returns an honest unavailable state without an API key',async()=>{
  const research=createPlaceResearch({apiKey:'',dbPath:':memory:'});const result=await research.search({query:'ice rink',kind:'venue'});
  expect(result).toMatchObject({query:'ice rink',mode:'unavailable'});expect(result.results.map(place=>place.id)).toEqual(['mit-johnson-athletic-center','simoni-skating-rink']);expect(result.message).toMatch(/unavailable/i);research.close();
 });
});
