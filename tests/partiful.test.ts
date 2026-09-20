import {describe,expect,it,vi} from 'vitest';
import {createPartifulAdapter} from '../server/partiful.js';

const success=(command:string,data:unknown,page?:{hasMore:boolean})=>JSON.stringify({ok:true,data,meta:{command,cliVersion:'3.0.1',...(page?{page}:{})}});
describe('read-only Partiful adapter',()=>{
  it('uses local doctor status and returns actionable missing-login or installation states',async()=>{
    const run=vi.fn().mockResolvedValue(success('doctor',{healthy:false,checks:[{name:'credentials',status:'fail'}]}));
    const adapter=createPartifulAdapter({binaryPath:'/pinned/partiful',run});
    expect(await adapter.status()).toMatchObject({status:'not_authenticated',message:expect.stringContaining('partiful:login')});
    expect(run).toHaveBeenCalledWith('/pinned/partiful',['doctor','--non-interactive']);
    run.mockRejectedValueOnce({code:'ENOENT',message:'private diagnostic'});
    expect(await adapter.status()).toMatchObject({status:'not_installed',message:expect.stringContaining('partiful:setup')});
  });

  it('reports credentials ready without returning CLI diagnostics or account details',async()=>{
    const adapter=createPartifulAdapter({run:async()=>success('doctor',{healthy:true,checks:[{name:'credentials',status:'pass',message:'private account detail'}],token:'private-token'})});
    const result=await adapter.status();expect(result.status).toBe('connected');expect(result.message).toContain('credentials are ready');expect(JSON.stringify(result)).not.toContain('private');
  });

  it('lists one bounded upcoming page and projects only event fields with safe Partiful links',async()=>{
    const run=vi.fn().mockResolvedValue(success('events.list',{items:[{eventId:'event_123',title:'Holiday dinner',start:'2026-12-11T18:00:00-05:00',contacts:['private'],url:'https://untrusted.test'},{eventId:'event_456',title:null,start:null}]},{hasMore:true}));
    const result=await createPartifulAdapter({run}).events();
    expect(run.mock.calls[0][1]).toEqual(['events','list','--when','upcoming','--limit','100','--non-interactive']);
    expect(result).toMatchObject({status:'connected',hasMore:true,events:[{id:'event_123',name:'Holiday dinner',date:'2026-12-11T18:00:00-05:00',url:'https://partiful.com/e/event_123'},{id:'event_456',name:'Untitled event',date:null,url:'https://partiful.com/e/event_456'}]});
    expect(JSON.stringify(result)).not.toContain('private');expect(JSON.stringify(result)).not.toContain('untrusted');
  });

  it('returns no invented events when authentication is missing, the command times out, or the protocol changed',async()=>{
    const run=vi.fn().mockRejectedValueOnce({code:3,stdout:'private token'}).mockRejectedValueOnce({killed:true,stdout:'private token'}).mockResolvedValueOnce(JSON.stringify({ok:false,error:{type:'contract.protocol_changed',message:'private token'},meta:{command:'events.list',cliVersion:'3.0.1'}}));
    const adapter=createPartifulAdapter({run});
    const missing=await adapter.events();expect(missing.status).toBe('not_authenticated');expect(missing.events).toEqual([]);
    const timeout=await adapter.events();expect(timeout.status).toBe('unavailable');expect(timeout.message).toContain('too long');expect(timeout.events).toEqual([]);
    const drift=await adapter.events();expect(drift.status).toBe('unavailable');expect(drift.message).toContain('response format');expect(drift.events).toEqual([]);
    expect(JSON.stringify([missing,timeout,drift])).not.toContain('private token');
  });

  it('rejects malformed items and never interprets a failed process as successful',async()=>{
    const valid=success('events.list',{items:[]},{hasMore:false});
    const run=vi.fn().mockResolvedValueOnce(success('events.list',{items:[{eventId:'../../evil',title:'Event',start:null}]},{hasMore:false})).mockRejectedValueOnce({code:8,stdout:valid}).mockResolvedValueOnce('not JSON');
    const adapter=createPartifulAdapter({run});
    for(let attempt=0;attempt<3;attempt++)expect(await adapter.events()).toMatchObject({status:'unavailable',events:[],hasMore:false});
  });
});
