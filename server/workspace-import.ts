import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Facts, Source } from '../shared/types.js';
import { initialFacts, sources as fixtureSources } from './fixtures.js';
import { prepareDropboxMaterials, type MaterialInput } from './dropbox-materials.js';

export const workspaceImportSchema = z.object({ name: z.string().trim().min(1).max(160).optional(), files: z.array(z.object({ path: z.string().min(1).max(240), content: z.string().max(100000) }).strict()).max(30).default([]), demo: z.boolean().default(false) }).strict();
export type WorkspaceImport = { name: string; facts: Facts; sources: Source[]; demoPlanning: boolean };
const integers = new Set(['attendance', 'venueCapacity', 'venueCostCents', 'cateringPerPersonCents', 'cateringDeliveryCents', 'staffCount', 'staffCostEachCents', 'equipmentCostCents', 'budgetLimitCents', 'sunkCostCents']);
const strings = new Set(['date', 'time', 'timezone', 'format', 'venue', 'venueAddress', 'caterer', 'dietary', 'notes']);
const emptyFacts: Facts = { attendance: 0, date: '', time: '', timezone: 'America/New_York', format: '', venue: '', venueAddress: '', venueCapacity: 0, venueCostCents: 0, venueIncludesAV: false, venueDetailsPending: true, venueCapacityPending: true, venueAVPending: true, caterer: '', cateringPerPersonCents: 0, cateringDeliveryCents: 0, cateringStatus: 'awaiting_quote', dietary: '', staffCount: 0, staffCostEachCents: 0, equipmentCostCents: 0, budgetLimitCents: 0, sunkCostCents: 0, notes: '' };

function suppliedFacts(value: unknown): Partial<Facts> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (integers.has(key)) {
      if (!Number.isSafeInteger(item) || Number(item) < 0 || Number(item) > (key === 'attendance' ? 100000 : 1000000000)) throw new Error(`Invalid imported ${key}.`);
      output[key] = item;
    } else if (strings.has(key)) {
      if (typeof item !== 'string' || item.length > 8000) throw new Error(`Invalid imported ${key}.`);
      if (key === 'date' && item && (!/^\d{4}-\d{2}-\d{2}$/.test(item) || new Date(item).toISOString().slice(0, 10) !== item)) throw new Error('Use an ISO event date in the planning document.');
      if (key === 'time' && item && !/^([01]\d|2[0-3]):[0-5]\d$/.test(item)) throw new Error('Use a 24-hour event time in the planning document.');
      output[key] = item.trim();
    } else if (key === 'venueIncludesAV') {
      if (typeof item !== 'boolean') throw new Error('Imported AV inclusion must be true or false.');
      output[key] = item;
    }
  }
  return output;
}
function labelFacts(content: string): Partial<Facts> {
  const result: Record<string, unknown> = {};
  const labels: Record<string, keyof Facts> = { attendance: 'attendance', guests: 'attendance', date: 'date', time: 'time', timezone: 'timezone', format: 'format', venue: 'venue', address: 'venueAddress', 'venue address': 'venueAddress', capacity: 'venueCapacity', caterer: 'caterer', dietary: 'dietary', staff: 'staffCount', notes: 'notes', budget: 'budgetLimitCents', 'budget limit': 'budgetLimitCents', 'venue cost': 'venueCostCents', 'price per guest': 'cateringPerPersonCents', 'delivery cost': 'cateringDeliveryCents', 'staff rate': 'staffCostEachCents', 'equipment allowance': 'equipmentCostCents' };
  for (const line of content.split('\n')) {
    const match = line.match(/^\s*(?:[-*]\s*)?([a-z ]+):\s*(.+?)\s*$/i); if (!match) continue;
    const key = labels[match[1].toLowerCase()]; if (!key) continue;
    const raw = match[2].trim();
    if (integers.has(key)) {
      if (!/^\$?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(raw)) continue;
      const number = Number(raw.replace(/[$,]/g, '')); result[key] = key.endsWith('Cents') ? Math.round(number * 100) : number;
    } else result[key] = raw;
  }
  return suppliedFacts(result);
}
function demoMaterials(): MaterialInput[] {
  const folder = fileURLToPath(new URL('../fixtures/demo-event-folder/', import.meta.url));
  const files: MaterialInput[] = [];
  const read = (relative = '') => {
    for (const entry of readdirSync(path.join(folder, relative), { withFileTypes: true })) {
      const filename = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) read(filename);
      else if (entry.isFile() && /\.(md|txt|csv|json)$/i.test(entry.name)) files.push({ path: filename, content: readFileSync(path.join(folder, filename), 'utf8') });
    }
  };
  read(); return files;
}
/** Documents are data. Only explicit fields are extracted; their instructions are never executed. */
export function parseWorkspaceImport(raw: unknown): WorkspaceImport {
  const input = workspaceImportSchema.parse(raw);
  const files = input.files.length ? input.files : input.demo ? demoMaterials() : [];
  const materials = prepareDropboxMaterials(files, input.demo && !input.files.length ? 'fictional_scenario' : 'user_selected');
  let inferredName: string | undefined;
  let explicit: Partial<Facts> = {};
  for (const file of files) {
    if (/\.json$/i.test(file.path)) {
      let parsed: unknown; try { parsed = JSON.parse(file.content); } catch { throw new Error(`${file.path} contains invalid JSON.`); }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const object = parsed as Record<string, unknown>;
        if (typeof object.name === 'string' && object.name.trim()) inferredName = object.name.trim().slice(0, 160);
        explicit = { ...explicit, ...suppliedFacts(object.facts ?? object) };
      }
    } else explicit = { ...explicit, ...labelFacts(file.content) };
  }
  const facts = { ...structuredClone(input.demo ? initialFacts : emptyFacts), ...explicit };
  if ('venue' in explicit || 'venueAddress' in explicit || !input.demo) {
    facts.venueDetailsPending = !('venueCostCents' in explicit); facts.venueCapacityPending = !('venueCapacity' in explicit); facts.venueAVPending = !('venueIncludesAV' in explicit);
  }
  const firstHeading = files.find(file => /brief|event/i.test(file.path))?.content.match(/^#\s+([^\n]+)/m)?.[1]?.replace(/\s*[·—].*$/, '').trim();
  const baseline = input.demo ? structuredClone(fixtureSources).map(source => {
    if(source.id === 'brief') source.content = `# Event brief\n${facts.attendance} guests on ${facts.date} at ${facts.time}, ${facts.timezone}. ${facts.format}. ${facts.notes}`;
    if(source.id === 'guests') source.content = `# Guest details\n${facts.attendance} guests. ${facts.date}, ${facts.time}. ${facts.venue}. Update event-page metadata only; do not notify guests.`;
    if(source.id === 'catering-current') source.content = `# Current catering agreement · fictional scenario\n${facts.caterer}: ${facts.attendance} meals at $${facts.cateringPerPersonCents/100}, total $${facts.attendance*facts.cateringPerPersonCents/100}. Contact: catering@shahhalal.example. A $600 deposit is included. No actual booking is established.`;
    if(source.id === 'staffing-policy') source.content = `# Staffing · fictional event policy\nOne staff member per 60 guests rounded up; currently ${facts.staffCount} staff at $${facts.staffCostEachCents/100} each. Contact: staff@northstar.example.`;
    if(source.id === 'budget') source.content = `# Event budget\nVenue $${facts.venueCostCents/100}; catering $${facts.attendance*facts.cateringPerPersonCents/100}; staff $${facts.staffCount*facts.staffCostEachCents/100}; equipment $${facts.equipmentCostCents/100}. Ceiling $${facts.budgetLimitCents/100}. Fictional scenario assumptions.`;
    return source;
  }).filter(source => source.id !== 'venue-marriott') : [];
  return { name: input.name || inferredName || (input.demo ? 'Christmas dinner' : firstHeading?.slice(0, 160)) || 'Untitled event', facts, sources: [...baseline, ...materials], demoPlanning: input.demo };
}
