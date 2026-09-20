import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Area, Source } from '../shared/types.js';

export type MaterialInput={path:string;content:string};
export type MaterialProvenance='user_selected'|'fictional_scenario';
export const materialHash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');

export function safeMaterialPath(value:string):string {
  if(typeof value!=='string'||value.length>240||/[\u0000-\u001f\\]/.test(value)||path.posix.isAbsolute(value))throw new Error('Use a relative document path under 240 characters.');
  const parts=value.split('/');
  if(parts.some(part=>!part.trim()||part==='.'||part==='..'||part.startsWith('.')))throw new Error('Document paths cannot contain hidden or parent folders.');
  return parts.join('/');
}

/** Only explicit user-selected documents enter the event's source set. No disk crawling. */
export function prepareDropboxMaterials(files:MaterialInput[],provenance:MaterialProvenance='user_selected'):Source[] {
  if(!Array.isArray(files)||files.length<1||files.length>30)throw new Error('Choose 1 to 30 planning documents.');
  if(!['user_selected','fictional_scenario'].includes(provenance))throw new Error('Unknown document provenance.');
  let bytes=0;const paths=new Set<string>();
  return files.map(file=>{
    const relative=safeMaterialPath(file.path);
    if(!/\.(md|txt|csv|json)$/i.test(relative))throw new Error('Import Markdown, text, CSV, or JSON planning documents.');
    if(typeof file.content!=='string'||file.content.includes('\0'))throw new Error('Planning documents must contain plain text.');
    const size=Buffer.byteLength(file.content);bytes+=size;
    if(size>100_000||bytes>500_000)throw new Error('Use files up to 100 KB each and 500 KB total.');
    if(paths.has(relative.toLowerCase()))throw new Error('Each document must have a unique path.');paths.add(relative.toLowerCase());
    const area:Area=/budget|cost|financ/i.test(relative)?'budget':/venue|room|location/i.test(relative)?'venue':/cater|food|menu|vendor/i.test(relative)?'catering':/guest|invite|rsvp/i.test(relative)?'guests':/staff|team/i.test(relative)?'staff':/equipment|audio|\bav\b/i.test(relative)?'equipment':'brief';
    const title=file.content.match(/^#\s+(.+)$/m)?.[1]?.trim().slice(0,200)||path.posix.basename(relative);
    return {id:`material:${materialHash(relative.toLowerCase()).slice(0,24)}`,title,area,path:`Event materials/${relative}`,content:file.content,material:{path:relative,provenance,contentHash:materialHash(file.content)}};
  });
}
