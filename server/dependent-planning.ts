import type { Area, EditRequest, FactPatch, Facts, Source } from '../shared/types.js';
import { parseDietaryNote } from './planning-notes.js';
import { planningRecordFields } from './planning-records.js';

type Field = keyof Facts;
const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const inline = (value: string) => value.replace(/\s+/g, ' ').trim();
const capacityPending = (facts: Facts) => facts.venueCapacityPending ?? facts.venueDetailsPending ?? false;
const avPending = (facts: Facts) => facts.venueAVPending ?? facts.venueDetailsPending ?? false;
const staffingNumbers = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];

/** Complete field-setting statements only; compound tasks retain their AI path. */
export function explicitOperationalPatch(request: EditRequest): FactPatch | undefined {
  if (Object.keys(request.patch ?? {}).length || !request.note?.trim()) return;
  const text = request.note.trim();
  if (request.area === 'staff') {
    const count = `(\\d+|${staffingNumbers.join('|')})`;
    const match = text.match(new RegExp(`^${count}$`, 'i'))
      ?? text.match(new RegExp(`^(?:(?:we (?:now )?(?:need|have|require)|please (?:use|schedule)|use|schedule)\\s+)?${count}\\s+(?:staff(?: members?)?|servers?|people)[.!]?$`, 'i'))
      ?? text.match(new RegExp(`^(?:please\\s+)?(?:(?:set|change|update)\\s+)?(?:the\\s+)?(?:staff(?:ing)?(?: count)?|team size)\\s+(?:(?:is now|is|to|now|will be)\\s+)?${count}[.!]?$`, 'i'));
    if (match) return { staffCount: /^\d+$/.test(match[1]) ? Number(match[1]) : staffingNumbers.indexOf(match[1].toLowerCase()) };
  }
  if (request.area === 'catering' || request.area === 'guests') {
    // Do not discard a vendor switch, message request, price, headcount change,
    // or quoted/tentative statement merely because one clause mentions food.
    let normalized = text.replace(/\bveg\b/gi, 'vegetarian').replace(/^(?:please\s+)?(?:set|change|update)\s+(?:the\s+)?dietary(?:\s+(?:needs|requirements|restrictions))?\s+(?:to\s+)?/i, 'Dietary needs: ');
    const food = '(?:vegetarian|vegan|halal|kosher|pescatarian|gluten[- ]free|dairy[- ]free|nut[- ]free)';
    if (new RegExp(`^${food}(?:(?:\\s*[,/&]\\s*|\\s+(?:(?:and|or)\\s+)?)${food})*[.!]?$`, 'i').test(normalized)) normalized = `Dietary needs: ${normalized}`;
    if (/[?"“”]/.test(text) || /\b(?:cancel|contact|switch|replace|book|email|ask|tell|send|invite|reserve|purchase|hire|arrange|schedule|move|reduce|increase|pay|spend|invoice|expenses|parking|equipment|change|set|update|vendor|caterer|restaurant|venue|staff|servers?|budget|price|cost|quote|said|maybe|might|if|attendance|headcount)\b|\$/i.test(normalized)) return;
    if (normalized.split(/\s*(?:;|\n|[.!](?=\s|$))\s*/).filter(Boolean).some(clause => parseDietaryNote(clause) === undefined)) return;
    const dietary = parseDietaryNote(normalized);
    if (dietary !== undefined) return { dietary };
  }
}

/** These are current working documents, never evidence that a supplier agreed. */
export function dependentRecordAreas(changed: readonly Field[]): Area[] {
  const areas = new Set<Area>();
  const add = (...values: Area[]) => values.forEach(value => areas.add(value));
  for (const field of changed) {
    if (field === 'attendance') add('guests', 'catering', 'staff', 'venue', 'equipment', 'budget');
    if (['dietary', 'caterer', 'cateringStatus'].includes(field)) add('catering', 'staff', 'guests');
    if (['staffCount', 'staffCostEachCents'].includes(field)) add('staff', 'budget');
    if (['venue', 'venueAddress', 'venueCapacity', 'venueCapacityPending', 'venueCapacityEvidenceId'].includes(field)) add('venue', 'staff', 'equipment');
    if (['venueIncludesAV', 'venueAVPending', 'equipmentCostCents'].includes(field)) add('equipment');
    if (['date', 'time', 'timezone', 'format'].includes(field)) add('brief', 'venue', 'catering', 'staff', 'equipment', 'guests');
    if (field === 'notes') add('brief', 'equipment');
    if (['venueCostCents', 'cateringPerPersonCents', 'cateringDeliveryCents', 'equipmentCostCents', 'budgetLimitCents', 'sunkCostCents'].includes(field)) add('budget');
  }
  // Keep every existing record's rendered dependencies consistent as well.
  for (const area of ['venue', 'guests', 'catering', 'staff', 'equipment', 'budget', 'brief'] as Area[]) {
    if (planningRecordFields(area).some(field => changed.includes(field))) areas.add(area);
  }
  return [...areas];
}

function venueEvidence(facts: Facts, sources: Source[]) {
  const source = sources.find(source => source.id === facts.venueCapacityEvidenceId);
  const evidence = source?.venueEvidence;
  return evidence?.name === facts.venue && evidence.address === facts.venueAddress && evidence.eventFormat === facts.format ? { source: source!, evidence } : undefined;
}

function equipmentScope(facts: Facts, sources: Source[]) {
  const evidence = sources.filter(source => source.area === 'equipment' && source.content.trim());
  const context = [facts.notes, ...evidence.map(source => source.content)].join('\n');
  const items: string[] = [];
  if (/\b(?:display|projector|slides|screen)\b/i.test(context)) items.push('display or projector');
  if (/\b(?:microphones?|mics?)\b/i.test(context)) items.push('microphone');
  if (/\b(?:audio|sound|speakers?)\b/i.test(context)) items.push('sound');
  return { items, evidence };
}

export type OperationalPlanDraft = {
  title: string; area: Area; description: string; body: string; evidence: string[]; keys: Field[];
};

/** A small proposed service document, not a booking, staff assignment, or quote. */
export function buildOperationalPlan(before: Facts, facts: Facts, sources: Source[]): OperationalPlanDraft | undefined {
  const changed = (Object.keys(facts) as Field[]).filter(key => facts[key] !== before[key]);
  const has = (...fields: Field[]) => fields.some(field => changed.includes(field));
  const sections: string[] = [];
  const evidence = new Set<string>();
  const cite = (...areas: Area[]) => sources.filter(source => areas.includes(source.area) && source.content.trim()).forEach(source => evidence.add(source.id));
  if (has('attendance', 'staffCount', 'dietary', 'caterer')) {
    sections.push(`## Assign service roles\nPlan around ${facts.staffCount} staff and ${facts.attendance} guests. Assign arrival, meal handoff and room support; stagger tasks when one person covers multiple roles.`);
    cite('staff', 'brief');
  }
  if (facts.dietary.trim() && has('attendance', 'dietary', 'caterer', 'staffCount')) {
    const label = /\bavailable\b/i.test(facts.dietary) && !/\b(?:need|require|must)\b/i.test(facts.dietary) ? 'Recorded meal options' : 'Requested requirements';
    sections.push(`## Confirm meal handoff\n${label}: ${inline(facts.dietary)}. Get the dish and label list from ${inline(facts.caterer) || 'the caterer'}, including required handling or certification, for the service lead.`);
    cite('catering', 'guests');
  }
  if (has('attendance', 'venue', 'venueAddress', 'venueIncludesAV', 'venueAVPending', 'equipmentCostCents', 'notes', 'staffCount')) {
    const scope = equipmentScope(facts, sources);
    const known = venueEvidence(facts, sources);
    const included = known?.evidence.av?.included === facts.venueIncludesAV ? known.evidence.av : undefined;
    const requirements = scope.items.length ? `Test the ${scope.items.join(', ')} before guests arrive.` : 'Define the equipment list from the event program.';
    const availability = avPending(facts) ? 'Confirm the venue’s included equipment.' : facts.venueIncludesAV ? included?.items.length ? `Compare the published ${included.items.map(inline).join(', ')} with these requirements.` : 'Compare the included house AV with these requirements.' : 'Get an itemized quote for equipment the venue does not include.';
    const allowance = facts.equipmentCostCents ? `Retain the ${money(facts.equipmentCostCents)} allowance until costs or cancellation terms are confirmed.` : 'Confirm any new rental cost before adding it.';
    sections.push(`## Check equipment\n${requirements} ${availability} ${allowance}`);
    scope.evidence.forEach(source => evidence.add(source.id));
    if (known && included && !avPending(facts)) evidence.add(known.source.id);
    cite('brief');
  }
  if (has('attendance', 'venue', 'venueAddress', 'venueCapacity', 'venueCapacityPending', 'venueCapacityEvidenceId', 'format')) {
    const known = !capacityPending(facts) && facts.venueCapacity > 0;
    const room = known ? facts.attendance > facts.venueCapacity
      ? `${inline(facts.venue)} is ${facts.attendance - facts.venueCapacity} seats short for ${facts.attendance} guests. Request a room or layout that fits before confirming the venue.`
      : `${facts.attendance} guests fit within the recorded ${facts.venueCapacity}-person layout. Confirm date availability, access and space for meal service.`
      : `Seated capacity at ${inline(facts.venue) || 'the venue'} is unconfirmed. Request a seated layout for ${facts.attendance} guests, including space for meal service.`;
    sections.push(`## Check the guest layout\n${room}`);
    const researched = venueEvidence(facts, sources);
    if (researched && known && researched.evidence.capacity?.guests === facts.venueCapacity) evidence.add(researched.source.id);
    cite('brief');
  }
  if (!sections.length || !evidence.size) return;
  return {
    title: `Service plan for ${facts.attendance} guests`, area: has('dietary', 'caterer') ? 'catering' : has('equipmentCostCents', 'venueIncludesAV', 'venueAVPending', 'notes') ? 'equipment' : 'staff',
    description: 'Coordinate service, meal requirements and the room setup.', body: sections.join('\n\n'), evidence: [...evidence],
    keys: ['attendance', 'staffCount', 'dietary', 'caterer', 'venue', 'venueAddress', 'venueCapacity', 'venueCapacityPending', 'venueCapacityEvidenceId', 'venueIncludesAV', 'venueAVPending', 'equipmentCostCents', 'notes', 'format'],
  };
}
