import type { Area, Facts, ProjectState } from '../shared/types.js';

type Field = keyof Facts;
type Budget = ProjectState['budget'];
const schedule: Field[] = ['date', 'time', 'timezone', 'format', 'attendance', 'venue', 'venueAddress'];
const room: Field[] = ['venueCapacity', 'venueCostCents', 'venueDetailsPending', 'venueCapacityPending', 'venueCapacityEvidenceId'];
const food: Field[] = ['caterer', 'cateringStatus', 'dietary', 'cateringPerPersonCents', 'cateringDeliveryCents'];
const team: Field[] = ['staffCount', 'staffCostEachCents'];
const production: Field[] = ['venueIncludesAV', 'venueAVPending', 'venueDetailsPending', 'equipmentCostCents', 'notes'];
const financial: Field[] = ['budgetLimitCents', 'sunkCostCents', 'venueCostCents', 'venueDetailsPending', 'venueCapacityPending', 'venueAVPending', 'venueIncludesAV', 'caterer', 'cateringStatus', 'cateringPerPersonCents', 'cateringDeliveryCents', ...team, 'equipmentCostCents'];
const fields: Record<Area, Field[]> = {
  venue: [...schedule, ...room, ...production, 'caterer', 'cateringStatus', 'dietary', 'staffCount'],
  guests: [...schedule, 'venueCapacity', 'venueDetailsPending', 'venueCapacityPending', 'venueCapacityEvidenceId', 'caterer', 'cateringStatus', 'dietary', 'staffCount', 'notes'],
  catering: [...schedule, ...food, 'staffCount', 'notes'],
  staff: [...schedule, ...team, 'caterer', 'cateringStatus', 'dietary', ...production],
  equipment: [...schedule, ...production, 'staffCount'],
  budget: [...schedule, ...financial],
  brief: [...schedule, ...room, ...food, ...team, ...production, ...financial],
};

/** Working-record dependencies are broader than the fields editable in one section. */
export function planningRecordFields(area: Area): Array<keyof Facts> {
  return [...new Set(fields[area])].sort();
}

const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const plain = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  .replace(/[&<>]/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[value]!)
  .replace(/([\\`*{}\[\]#+|~])/g, '\\$1');
const inline = (value: string) => plain(value).replace(/\r?\n/g, ' ').trim() || 'Not recorded';
const section = (title: string, lines: string[]) => [`## ${title}`, '', ...lines, ''];

function capacityLines(f: Facts) {
  if ((f.venueCapacityPending ?? f.venueDetailsPending ?? false) || f.venueCapacity <= 0) return ['- Room capacity: Not established for this event layout.'];
  return [
    `- Recorded room capacity: ${f.venueCapacity}; expected guests: ${f.attendance}.`,
    ...(f.attendance > f.venueCapacity ? [`- Room check: ${f.attendance - f.venueCapacity} guests above the recorded limit.`] : []),
  ];
}

function venueLines(f: Facts) {
  return [...capacityLines(f), `- Venue amount: ${money(f.venueCostCents)} — ${f.venueDetailsPending ? 'carried planning allowance; current venue quote needed' : 'recorded planning amount'}.`];
}

function avLine(f: Facts) {
  if (f.venueAVPending ?? f.venueDetailsPending ?? false) return '- Venue AV: Inclusions not established.';
  return f.venueIncludesAV ? '- Venue AV: Marked included; match the required equipment to the venue’s recorded scope.' : '- Venue AV: No inclusions recorded.';
}

function mealLines(f: Facts, prices = false) {
  const status = {
    confirmed: 'Marked confirmed in the current plan', quoted: 'Quote recorded; booking not confirmed',
    awaiting_quote: 'Matching quote needed', awaiting_confirmation: 'Booking confirmation pending',
  }[f.cateringStatus];
  const lines = [`- Caterer: ${inline(f.caterer)}.`, `- Catering status: ${status}.`, `- Dietary and service requirements: ${inline(f.dietary)}.`];
  if (prices) lines.push(...(f.cateringStatus === 'awaiting_quote'
    ? ['- Price and delivery: Unknown until a matching quote is recorded.']
    : [`- Recorded rate: ${money(f.cateringPerPersonCents)} per guest.`, `- Recorded delivery: ${money(f.cateringDeliveryCents)}.`, `- Current meal calculation: ${f.attendance} × ${money(f.cateringPerPersonCents)} + ${money(f.cateringDeliveryCents)} = ${money(f.attendance * f.cateringPerPersonCents + f.cateringDeliveryCents)}.`]));
  return lines;
}

function staffingLines(f: Facts, allowance = false) {
  return [`- Staffing: ${f.staffCount} planned for ${f.attendance} guests.`, ...(allowance ? [`- Staffing allowance: ${f.staffCount} × ${money(f.staffCostEachCents)} = ${money(f.staffCount * f.staffCostEachCents)}.`] : [])];
}

function equipmentLines(f: Facts) {
  return [avLine(f), `- Equipment allowance: ${money(f.equipmentCostCents)}; itemized requirements remain in the program notes and equipment sources.`];
}

function noteLines(f: Facts) {
  return f.notes.trim() ? plain(f.notes).split(/\r?\n/).map(line => `> ${line}`) : ['No program or service notes recorded.'];
}

function budgetLines(f: Facts, budget: Budget) {
  const incomplete = !!f.venueDetailsPending || f.cateringStatus === 'awaiting_quote' || budget.lines.some(line => line.status === 'awaiting quote');
  const difference = f.budgetLimitCents - budget.totalCents;
  return [
    `- Budget ceiling: ${money(f.budgetLimitCents)}.`,
    `- Current forecast: ${money(budget.totalCents)}${incomplete ? ' — incomplete; quotes needed' : ''}.`,
    `- ${difference < 0 ? 'Above' : 'Below'} ceiling: ${money(Math.abs(difference))}${incomplete ? ' based on recorded amounts' : ''}.`,
    `- Retained non-refundable costs recorded: ${money(f.sunkCostCents)}.`, '',
    '| Item | Amount | Status | Detail |',
    '| --- | ---: | --- | --- |',
    ...budget.lines.map(line => `| ${inline(line.label)} | ${line.status === 'awaiting quote' ? 'Unknown' : money(line.amountCents)} | ${inline(line.status)} | ${inline(line.detail)} |`),
  ];
}

/** Deterministic working copy, not a contract, delivery receipt, or external write. */
export function renderPlanningRecord(area: Area, facts: Facts, budget: Budget, title: string): string {
  const f = facts;
  const lines = [`# ${inline(title)}`, '',
    `- When: ${inline(f.date)} at ${inline(f.time)} (${inline(f.timezone)}).`,
    `- Format: ${inline(f.format)}.`,
    `- Venue: ${inline(f.venue)} — ${inline(f.venueAddress)}.`,
    `- Expected guests: ${f.attendance}.`, ''];
  switch (area) {
    case 'venue':
      lines.push(...section('Room and equipment', [...venueLines(f), ...equipmentLines(f)]), ...section('Service handoff', [...mealLines(f), ...staffingLines(f)]), ...section('Program and service notes', noteLines(f))); break;
    case 'guests':
      lines.push(...section('Room and service', [...capacityLines(f), ...mealLines(f), ...staffingLines(f)]), ...section('Guest and service notes', noteLines(f))); break;
    case 'catering':
      lines.push(...section('Meal and quote', mealLines(f, true)), ...section('Service coverage', staffingLines(f)), ...section('Service notes', noteLines(f))); break;
    case 'staff':
      lines.push(...section('Coverage', staffingLines(f, true)), ...section('Meal and service', mealLines(f)), ...section('Equipment handoff', equipmentLines(f)), ...section('Program and service notes', noteLines(f))); break;
    case 'equipment':
      lines.push(...section('Equipment and coverage', [...equipmentLines(f), ...staffingLines(f)]), ...section('Program and equipment notes', noteLines(f))); break;
    case 'budget':
      lines.push(...section('Forecast', budgetLines(f, budget))); break;
    case 'brief':
      lines.push(...section('Room', venueLines(f)), ...section('Meal and service', mealLines(f, true)), ...section('Staff and equipment', [...staffingLines(f, true), ...equipmentLines(f)]), ...section('Budget', budgetLines(f, budget)), ...section('Program and service notes', noteLines(f))); break;
  }
  return lines.join('\n');
}
