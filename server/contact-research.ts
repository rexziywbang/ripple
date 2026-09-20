import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { searchPlaces, type PlaceCandidate, type PlaceKind } from './places.js';

export type ContactRequest = {name:string;address?:string;kind:PlaceKind;website?:string};
export type ContactCandidate = {name:string;email:string;url:string;excerpt:string;confidence:'location'|'brand';requiresReview:true;scope:string};
export type ContactAlternative = {kind:'phone'|'contact_form';value:string;url:string;excerpt:string};
export type ContactResult = {status:'found'|'alternatives_only'|'not_found'|'identity_mismatch'|'unavailable';entity:{name:string;address:string;kind:PlaceKind};candidates:ContactCandidate[];alternatives:ContactAlternative[];checkedUrls:string[];checkedAt:string;message:string};
type Dependencies = {fetch?:typeof globalThis.fetch;lookup?:(hostname:string)=>Promise<Array<{address:string;family:number}>>};
type Profile = {pages:string[];hosts:string[];emailScope:string;confidence:'location'|'brand'};

const profiles:Record<string,Profile>={
  'cava-harvard-square':{pages:['https://support.cava.com/en_us/who-do-i-contact-for-questions-regarding-my-catering-order-ByY1FWskC','https://catering.cava.com/catering/quote'],hosts:['cava.com','www.cava.com','support.cava.com','catering.cava.com'],confidence:'brand',emailScope:'CAVA brand catering team; the source describes help with existing catering orders. Harvard Square fulfillment and new-event availability are not confirmed.'},
  'shahs-halal-cambridge-street-boston':{pages:['https://www.shahshalalfood.com/boston-ma/','https://www.shahshalalfood.com/contact-us/'],hosts:['shahshalalfood.com','www.shahshalalfood.com'],confidence:'brand',emailScope:'Shah’s general brand support at its New York office, not a confirmed Boston branch or catering sales inbox.'},
  'boston-marriott-cambridge':{pages:['https://www.marriott.com/en-us/hotels/boscb-boston-marriott-cambridge/events/'],hosts:['www.marriott.com','marriott.com'],confidence:'location',emailScope:'Contact published on the exact Boston Marriott Cambridge event page.'},
  'courtyard-boston-cambridge':{pages:['https://www.marriott.com/en-us/hotels/boscy-courtyard-boston-cambridge/events/'],hosts:['www.marriott.com','marriott.com'],confidence:'location',emailScope:'Contact published on the exact Courtyard by Marriott Boston Cambridge event page.'},
  'charles-hotel-cambridge':{pages:['https://www.charleshotel.com/'],hosts:['www.charleshotel.com','charleshotel.com'],confidence:'brand',emailScope:'Contact published on The Charles Hotel’s official website; confirm the event-planning department.'},
  'hyatt-regency-cambridge':{pages:['https://www.hyatt.com/hyatt-regency/en-US/bosrc-hyatt-regency-boston-cambridge/hotel-info'],hosts:['www.hyatt.com','hyatt.com'],confidence:'location',emailScope:'Contact published on the exact Hyatt Regency Boston / Cambridge page; confirm event-planning scope.'},
};
const aliases:Record<string,string[]>={
  'cava-harvard-square':['cava','cava harvard square'],
  'shahs-halal-cambridge-street-boston':['shah halal','shahs halal','shahs halal food','shahs halal food boston','shahs halal food boston cambridge street'],
};
const normalize=(value:string)=>value.normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[’']/g,'').replace(/[^a-z0-9]+/g,' ').trim();
const normalizeAddress=(value:string)=>normalize(value).replace(/\bst\b/g,'street').replace(/\bmassachusetts\b/g,'ma').replace(/\b\d{5}(?: \d{4})?\b/g,'').trim();
const emailPattern=/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function publicAddress(value:string):boolean{
  const address=value.toLowerCase();if(isIP(address)===4){const [a,b]=address.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===100&&b>=64&&b<=127)||(a===198&&(b===18||b===19)));}
  if(isIP(address)===6)return address!=='::'&&address!=='::1'&&!/^f[cd]|^fe[89ab]|^ff|^::ffff:/i.test(address);
  return false;
}
function allowedUrl(value:string,profile:Profile):URL{
  const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443')||!profile.hosts.includes(url.hostname))throw new Error('Only this business’s known official HTTPS hosts are allowed.');return url;
}
async function readPage(url:string,profile:Profile,deps:Dependencies):Promise<{url:string;html:string}>{
  let current=allowedUrl(url,profile);const fetcher=deps.fetch??globalThis.fetch;const resolve=deps.lookup??(hostname=>lookup(hostname,{all:true}));
  for(let redirect=0;redirect<=2;redirect++){
    const addresses=await resolve(current.hostname);if(!addresses.length||addresses.some(item=>!publicAddress(item.address)))throw new Error('Official host did not resolve to public addresses.');
    const response=await fetcher(current.href,{redirect:'manual',signal:AbortSignal.timeout(8000),headers:{Accept:'text/html,application/xhtml+xml,text/plain','User-Agent':'Ripple-ContactResearch/1.0'}});
    if(response.status>=300&&response.status<400){const target=response.headers.get('location');await response.body?.cancel();if(!target)throw new Error('Missing redirect destination.');current=allowedUrl(new URL(target,current).href,profile);continue;}
    if(!response.ok){await response.body?.cancel();throw new Error(`Official page returned HTTP ${response.status}.`);}
    if(!/^(?:text\/html|application\/xhtml\+xml|text\/plain)(?:;|$)/i.test(response.headers.get('content-type')??'')){await response.body?.cancel();throw new Error('Official page was not readable HTML or text.');}
    const reader=response.body?.getReader();if(!reader)throw new Error('Official page had no body.');const chunks:Uint8Array[]=[];let size=0;
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2_000_000){await reader.cancel();throw new Error('Official page exceeded the bounded page size.');}chunks.push(value);}
    return {url:current.href,html:Buffer.concat(chunks).toString('utf8')};
  }
  throw new Error('Official page redirected too many times.');
}
function decode(value:string):string{
  return value.replace(/&#(x[0-9a-f]+|\d+);/gi,(_,code:string)=>{const n=code[0].toLowerCase()==='x'?parseInt(code.slice(1),16):Number(code);return n>0&&n<=0x10ffff?String.fromCodePoint(n):'';}).replace(/&(quot|apos|amp|lt|gt|nbsp);/gi,(_,name:string)=>({quot:'"',apos:"'",amp:'&',lt:'<',gt:'>',nbsp:' '}[name.toLowerCase()]??''));
}
function visibleHtml(html:string,url:string):string{
  let article='';
  // CAVA's public knowledgebase stores its rendered article in non-executable
  // initial JSON. Parse only that article body; never execute page scripts.
  if(new URL(url).hostname==='support.cava.com'){
    const data=/<script\b[^>]*\bid=["']initial-data["'][^>]*\bdata-json="([^"]*)"[^>]*>/i.exec(html);
    if(data)try{const parsed=JSON.parse(decode(data[1]));if(typeof parsed?.data?.article?.body==='string')article=parsed.data.article.body;}catch{}
  }
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi,' ')+article;
}
const plainText=(html:string)=>decode(html.replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim();
const excerpt=(text:string,position:number)=>text.slice(Math.max(0,position-90),Math.min(text.length,position+150)).trim();

function extract(page:{url:string;html:string},place:PlaceCandidate,profile:Profile):{candidates:ContactCandidate[];alternatives:ContactAlternative[]}{
  const html=visibleHtml(page.html,page.url);const text=plainText(html);const candidates:ContactCandidate[]=[];const alternatives:ContactAlternative[]=[];
  const addEmail=(email:string,evidence:string)=>{if(!/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(email)||/@(?:[^@]*\.example|example\.(?:com|org|net))$/i.test(email)||/^(?:privacy|legal|abuse|jobs?|careers?|press|franchise|noreply|no-reply|security|webmaster|bostoncambridgesecurity)(?:[+._-]|@)/i.test(email))return;if(!candidates.some(item=>item.email.toLowerCase()===email.toLowerCase()))candidates.push({name:place.name,email,url:page.url,excerpt:evidence,confidence:profile.confidence,requiresReview:true,scope:profile.emailScope});};
  for(const match of text.matchAll(emailPattern))addEmail(match[0],excerpt(text,match.index!));
  const street=place.address.split(',')[0];const position=text.toLowerCase().indexOf(street.toLowerCase());
  const localWindow=position>=0?text.slice(Math.max(0,position-300),position+650):text;
  const phones=(window:string)=>{for(const match of window.matchAll(/(?:\+1[ .-]?)?(?:\([2-9]\d{2}\)|[2-9]\d{2})[ .-]?\d{3}[ .-]?\d{4}\b/g)){
    if(/fax\s*:\s*$/i.test(window.slice(Math.max(0,match.index!-15),match.index!)))continue;
    const value=match[0];if(!alternatives.some(item=>item.kind==='phone'&&item.value.replace(/\D/g,'')===value.replace(/\D/g,'')))alternatives.push({kind:'phone',value,url:page.url,excerpt:excerpt(window,match.index!)});
    if(alternatives.length>=2)break;
  }};
  phones(localWindow);if(!alternatives.length&&localWindow!==text)phones(text);
  let base=page.url;const baseMatch=/<base\b[^>]*href\s*=\s*["']([^"']+)["']/i.exec(html);if(baseMatch)try{base=allowedUrl(new URL(decode(baseMatch[1]),page.url).href,profile).href;}catch{}
  for(const match of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)){
    const label=plainText(match[2]);const href=decode(match[1]);if(/^mailto:/i.test(href)){try{addEmail(decodeURIComponent(href.slice(7).split('?')[0]),`${label||'Published email link'}: ${decodeURIComponent(href.slice(7).split('?')[0])}`);}catch{}continue;}if(!/contact|inquir|request.*(?:quote|proposal)|start.*plan|catering.*quote/i.test(label))continue;
    try{const target=allowedUrl(new URL(href,base).href,profile);if(!/privacy|careers?|franchise|feedback|login|sign-in|\/hc\/en-us\/requests\/new/i.test(target.pathname))alternatives.push({kind:'contact_form',value:target.href,url:page.url,excerpt:label||'Official contact page'});}catch{}
  }
  if(/<form\b/i.test(html)&&/contact|quote|event-profile|rfp/i.test(new URL(page.url).pathname))alternatives.push({kind:'contact_form',value:page.url,url:page.url,excerpt:'Official contact or event inquiry form.'});
  return {candidates,alternatives};
}

/** Public website research only. This resolves contacts; it never sends a message. */
export async function resolveContact(input:ContactRequest,deps:Dependencies={}):Promise<ContactResult>{
  if(!input||typeof input.name!=='string'||!input.name.trim()||input.name.length>200||!['venue','catering'].includes(input.kind)||(input.address?.length??0)>500||(input.website?.length??0)>2000)throw new Error('Provide a business name, venue/catering kind, and optional address or official website.');
  const name=normalize(input.name);const places=searchPlaces({query:'',kind:input.kind}).results;
  const place=places.find(item=>normalize(item.name)===name||aliases[item.id]?.includes(name));
  const result:ContactResult={status:'not_found',entity:{name:input.name,address:input.address??'',kind:input.kind},candidates:[],alternatives:[],checkedUrls:[],checkedAt:new Date().toISOString(),message:'No exact business identity in the verified Cambridge-area directory. Select a specific location before researching its contact.'};
  if(!place)return result;
  const profile=profiles[place.id];if(!profile)return result;result.entity={name:place.name,address:place.address,kind:input.kind};
  if(input.address&&normalizeAddress(input.address)!==normalizeAddress(place.address)){result.status='identity_mismatch';result.message='The supplied address does not match this verified location. No pages were fetched.';return result;}
  if(input.website)try{allowedUrl(input.website,profile);}catch{result.status='identity_mismatch';result.message='The supplied website is not a known official host for this business. No pages were fetched.';return result;}
  const pages=await Promise.allSettled(profile.pages.map(url=>readPage(url,profile,deps)));let successful=0;
  for(let i=0;i<pages.length;i++){const page=pages[i];result.checkedUrls.push(profile.pages[i]);if(page.status!=='fulfilled')continue;successful++;const found=extract(page.value,place,profile);for(const candidate of found.candidates)if(!result.candidates.some(item=>item.email.toLowerCase()===candidate.email.toLowerCase()))result.candidates.push(candidate);for(const alternative of found.alternatives)if(!result.alternatives.some(item=>item.kind===alternative.kind&&item.value===alternative.value))result.alternatives.push(alternative);}
  result.candidates=result.candidates.slice(0,3);result.alternatives=result.alternatives.slice(0,5);
  result.status=result.candidates.length?'found':result.alternatives.length?'alternatives_only':successful?'not_found':'unavailable';
  result.message=result.candidates.length?'Found public contact evidence. Review the recipient and its stated scope before sending; branch fulfillment is not assumed.':result.alternatives.length?'No suitable public email was found. The official page provides these contact routes instead.':successful?'No suitable public contact was found on the checked official pages. No email address was guessed.':'The official pages could not be read right now. No cached or invented contact was substituted.';
  return result;
}
