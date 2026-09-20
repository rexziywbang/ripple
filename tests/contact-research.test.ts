import { describe, expect, it, vi } from 'vitest';
import { resolveContact } from '../server/contact-research.js';

const cava={name:'CAVA',kind:'catering' as const,address:'22 Brattle Street, Cambridge, MA 02138'};
const shah={name:"Shah's Halal Food — Boston (Cambridge Street)",kind:'catering' as const,address:'106 Cambridge Street, Boston, MA 02114'};
const marriott={name:'Boston Marriott Cambridge',kind:'venue' as const,address:'50 Broadway, Cambridge, MA 02142'};
const dns=async()=>[{address:'8.8.8.8',family:4}];
const page=(html:string)=>new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8'}});
function mockPages(html:string|((url:string)=>string)){const fetcher=vi.fn(async(url:string|URL|Request)=>page(typeof html==='function'?html(String(url)):html)) as unknown as typeof fetch;return {fetch:fetcher,lookup:dns};}

describe('official business contact research',()=>{
  it('extracts the public CAVA knowledgebase article without executing or using unrelated script content',async()=>{
    const article={data:{article:{body:'<p>Catering team for existing orders: <a href="mailto:catering@cava.com">catering@cava.com</a></p>'}}};
    const data=JSON.stringify(article).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
    const result=await resolveContact(cava,mockPages(url=>url.includes('support.')?`<script>const fake="invented@cava.com"</script><script id="initial-data" type="text/plain" data-json="${data}"></script>`:'<form><input name="email"></form>'));
    expect(result.status).toBe('found');expect(result.candidates).toHaveLength(1);expect(result.candidates[0]).toMatchObject({email:'catering@cava.com',confidence:'brand',requiresReview:true,scope:expect.stringContaining('existing catering orders')});expect(result.candidates[0].url).toContain('support.cava.com');expect(result.candidates[0].excerpt).toContain('catering@cava.com');
    expect(result.alternatives.some(item=>item.kind==='contact_form'&&item.value==='https://catering.cava.com/catering/quote')).toBe(true);
  });

  it('keeps Shah’s brand support distinct from its Boston location and deduplicates it across official pages',async()=>{
    const result=await resolveContact(shah,mockPages('<h1>Shah’s Halal Boston</h1><p>106 Cambridge Street, Boston, MA 02114. Call (857) 239-9229.</p><p>Warehouse: support@shahshalalfood.com</p>'));
    expect(result.candidates).toHaveLength(1);expect(result.candidates[0]).toMatchObject({email:'support@shahshalalfood.com',confidence:'brand',scope:expect.stringContaining('not a confirmed Boston branch')});expect(result.entity.address).toBe(shah.address);expect(result.alternatives[0]).toMatchObject({kind:'phone',value:'(857) 239-9229'});
  });

  it('returns the official local phone and inquiry link when the hotel publishes no email',async()=>{
    const result=await resolveContact(marriott,mockPages('<h1>Boston Marriott Cambridge</h1><p>+1 617-494-6600</p><p>50 Broadway, Cambridge, MA 02142</p><a href="/meetings/erfp-schedule-meeting.mi?marshaCode=boscb">Start Your Plan Here</a>'));
    expect(result.status).toBe('alternatives_only');expect(result.candidates).toEqual([]);expect(result.alternatives).toEqual(expect.arrayContaining([expect.objectContaining({kind:'phone',value:'+1 617-494-6600'}),expect.objectContaining({kind:'contact_form',value:'https://www.marriott.com/meetings/erfp-schedule-meeting.mi?marshaCode=boscb'})]));
  });

  it('honors the official HTML base URL and ignores unrelated fragment links',async()=>{
    const result=await resolveContact(cava,mockPages('<base href="/"><a href="catering/quote">Custom Catering Quote</a><a href="#contact">Sandwiches</a>'));
    expect(result.alternatives.some(item=>item.value==='https://catering.cava.com/catering/quote')).toBe(true);expect(result.alternatives.some(item=>item.value.includes('/catering/catering/'))).toBe(false);expect(result.alternatives.some(item=>item.value.endsWith('#contact'))).toBe(false);
  });

  it('finds the hotel header phone when the address footer lists only a fax',async()=>{
    const result=await resolveContact(marriott,mockPages('<h1>Boston Marriott Cambridge +1 617-494-6600</h1>'+ '<p>Meeting room information.</p>'.repeat(100)+'<footer>50 Broadway, Cambridge, MA 02142. Fax: +1 617-494-0036</footer>'));
    expect(result.alternatives.filter(item=>item.kind==='phone').map(item=>item.value)).toEqual(['+1 617-494-6600']);
  });

  it('does not infer a branch from an ambiguous hotel name or mismatched address',async()=>{
    const deps=mockPages('No requests should occur.');expect((await resolveContact({...marriott,name:'Marriott Hotel'},deps)).status).toBe('not_found');expect((await resolveContact({...cava,address:'1 Main Street, Boston, MA'},deps)).status).toBe('identity_mismatch');expect(deps.fetch).not.toHaveBeenCalled();
  });

  it('rejects arbitrary/private host input and does not follow an off-site redirect',async()=>{
    const deps=mockPages('No request should occur.');for(const website of ['http://127.0.0.1:8787/api/state','https://cava.com.evil.invalid/','https://user:pass@cava.com/'])expect((await resolveContact({...cava,website},deps)).status).toBe('identity_mismatch');expect(deps.fetch).not.toHaveBeenCalled();
    const fetcher=vi.fn(async()=>new Response(null,{status:302,headers:{Location:'http://169.254.169.254/latest/meta-data/'}})) as unknown as typeof fetch;
    const result=await resolveContact(marriott,{fetch:fetcher,lookup:dns});expect(result.status).toBe('unavailable');expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('blocks official host resolution to a private address before fetching',async()=>{
    const deps=mockPages('No request should occur.');const result=await resolveContact(marriott,{...deps,lookup:async()=>[{address:'127.0.0.1',family:4}]});expect(result.status).toBe('unavailable');expect(deps.fetch).not.toHaveBeenCalled();
  });

  it('reads actual mailto links while excluding dummy and unrelated legal contacts',async()=>{
    const result=await resolveContact(marriott,mockPages('<a href="mailto:events%40marriott.com?subject=Event">Event team</a><p>privacy@marriott.com jobs@marriott.com sample@example.com logistics@rental.example</p><script>const address="fake@marriott.com";</script>'));
    expect(result.candidates.map(item=>item.email)).toEqual(['events@marriott.com']);expect(result.candidates[0]).toMatchObject({confidence:'location',excerpt:'Event team: events@marriott.com'});
  });

  it('reports unavailable pages without inventing a previously known contact',async()=>{
    const fetcher=vi.fn(async()=>new Response('Blocked',{status:403})) as unknown as typeof fetch;const result=await resolveContact(cava,{fetch:fetcher,lookup:dns});expect(result.status).toBe('unavailable');expect(result.candidates).toEqual([]);expect(result.checkedUrls).toHaveLength(2);
  });

  it('rejects oversized or non-text pages before extracting their contacts',async()=>{
    expect((await resolveContact(marriott,mockPages('x'.repeat(2_000_001)+' events@marriott.com'))).status).toBe('unavailable');
    const fetcher=vi.fn(async()=>new Response('events@marriott.com',{headers:{'Content-Type':'application/octet-stream'}})) as unknown as typeof fetch;expect((await resolveContact(marriott,{fetch:fetcher,lookup:dns})).status).toBe('unavailable');
  });
});
