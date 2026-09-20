import { describe, expect, it } from 'vitest';
import type { Area, Facts, ProjectState } from '../shared/types.js';
import { initialFacts } from '../server/fixtures.js';
import { planningRecordFields, renderPlanningRecord } from '../server/planning-records.js';

const facts: Facts = { ...initialFacts, venue: 'River Hall', venueAddress: '20 River Street, Cambridge, MA', attendance: 100, dietary: 'Kosher options are available', staffCount: 2, notes: 'Awards at 19:00. Two handheld microphones, a presentation screen, and a quiet food-service route.' };
const budget: ProjectState['budget'] = { totalCents: 1450000, lines: [
  { label: 'Previous catering commitment', amountCents: 576000, status: 'cancellation requested', detail: 'Retained until cancellation is confirmed; deposit included.' },
  { label: 'New catering quote', amountCents: 0, status: 'awaiting quote', detail: 'Price not known.' },
  { label: 'Staff', amountCents: 60000, status: 'planned', detail: 'Two planned staff.' },
] };
const render = (area: Area, patch: Partial<Facts> = {}) => renderPlanningRecord(area, { ...facts, ...patch }, budget, `Current ${area} plan`);

describe('dependent working planning records', () => {
  it('gives staff the current headcount, meal needs, schedule, location, and equipment handoff', () => {
    const text = render('staff');
    for (const detail of ['Expected guests: 100', '2 planned for 100 guests', 'Kosher options are available', '2026-12-11 at 18:00 (America/New_York)', '20 River Street, Cambridge, MA', '2 × $300.00 = $600.00', 'Two handheld microphones', 'Equipment allowance: $1,800.00']) expect(text).toContain(detail);
    expect(text).not.toContain('240 guests');
    expect(text).not.toContain('Updated locally in demo');
    expect(text).not.toContain('Staff assigned');
    expect(planningRecordFields('staff')).toEqual(expect.arrayContaining(['attendance', 'dietary', 'caterer', 'cateringStatus', 'venueAddress', 'timezone', 'notes', 'equipmentCostCents']));
  });

  it('updates guest planning with room limits, food, and staffing without treating recorded capacity as a booking', () => {
    const text = render('guests', { attendance: 310 });
    expect(text).toContain('Recorded room capacity: 260; expected guests: 310');
    expect(text).toContain('50 guests above the recorded limit');
    expect(text).toContain('Caterer: Shah Halal'); expect(text).toContain('2 planned for 310 guests');
    expect(text).toContain('Kosher options are available');
    expect(text).not.toMatch(/venue booked|invitations sent|room confirmed/i);
  });

  it('hides inherited capacity, AV, and prices when the selected arrangement is unresolved', () => {
    const pending = { venue: 'New venue', venueDetailsPending: true, venueCapacityPending: true, venueAVPending: true, venueCapacity: 999, venueIncludesAV: true, cateringStatus: 'awaiting_quote' as const, cateringPerPersonCents: 12345 };
    const text = render('brief', pending);
    expect(text).toContain('Room capacity: Not established'); expect(text).not.toContain('999');
    expect(text).toContain('Venue AV: Inclusions not established'); expect(text).not.toContain('Venue AV: Marked included');
    expect(text).toContain('carried planning allowance; current venue quote needed');
    expect(text).toContain('Price and delivery: Unknown'); expect(text).not.toContain('$123.45');
    const researched = render('brief', { ...pending, venueCapacityPending: false, venueAVPending: false });
    expect(researched).toContain('Recorded room capacity: 999'); expect(researched).toContain('Venue AV: Marked included');
    expect(researched).toContain('current venue quote needed');
  });

  it('preserves dietary requirement versus availability wording instead of inventing suitable meals', () => {
    const text = render('catering', { dietary: 'Kosher options are required', cateringStatus: 'quoted' });
    expect(text).toContain('Kosher options are required'); expect(text).not.toContain('Kosher options are available');
    expect(text).toContain('Quote recorded; booking not confirmed');
    expect(text).toContain('100 × $24.00 + $0.00 = $2,400.00');
    expect(planningRecordFields('catering')).toEqual(expect.arrayContaining(['attendance', 'date', 'time', 'timezone', 'venueAddress', 'dietary', 'staffCount']));
  });

  it('keeps the complete equipment request from notes alongside the allowance without inventing an itemized quote', () => {
    const text = render('equipment');
    expect(text).toContain('Two handheld microphones, a presentation screen, and a quiet food-service route.');
    expect(text).toContain('Equipment allowance: $1,800.00');
    expect(text).not.toMatch(/microphones: \$|screen: \$|rental confirmed/i);
    expect(planningRecordFields('equipment')).toEqual(expect.arrayContaining(['notes', 'format', 'venueIncludesAV', 'venueAVPending', 'attendance', 'staffCount']));
  });

  it('preserves authoritative budget totals, retained commitments, and unknown quote amounts', () => {
    const text = render('budget');
    expect(text).toContain('Current forecast: $14,500.00 — incomplete; quotes needed');
    expect(text).toContain('| Previous catering commitment | $5,760.00 | cancellation requested |');
    expect(text).toContain('| New catering quote | Unknown | awaiting quote |');
    expect(text).not.toContain('| New catering quote | $0.00');
    expect(text).toContain('Below ceiling: $3,500.00 based on recorded amounts');
    expect(text).not.toContain('Current forecast: $2,400.00');
  });

  it('puts meal, equipment, staff, budget, and program context in the event brief without timestamps or mutations', () => {
    const original = structuredClone({ facts, budget });
    const first = render('brief'); const second = render('brief');
    for (const heading of ['## Room', '## Meal and service', '## Staff and equipment', '## Budget', '## Program and service notes']) expect(first).toContain(heading);
    expect(first).toBe(second); expect({ facts, budget }).toEqual(original);
    const fields = planningRecordFields('brief'); fields.splice(0);
    expect(planningRecordFields('brief')).toEqual(expect.arrayContaining(['caterer', 'dietary', 'equipmentCostCents', 'notes', 'staffCount', 'budgetLimitCents']));
  });

  it('tracks every fact read by a renderer so downstream changes cannot silently escape invalidation', () => {
    for (const area of ['venue', 'guests', 'catering', 'budget', 'staff', 'equipment', 'brief'] as const) {
      const read = new Set<keyof Facts>();
      const observed = new Proxy(facts, { get(target, key, receiver) { if (key in target) read.add(key as keyof Facts); return Reflect.get(target, key, receiver); } });
      renderPlanningRecord(area, observed, budget, 'Working plan');
      expect([...read].filter(key => !planningRecordFields(area).includes(key)), area).toEqual([]);
      expect(new Set(planningRecordFields(area)).size).toBe(planningRecordFields(area).length);
    }
  });

  it('keeps entered notes and budget text from injecting headings, HTML, or table columns', () => {
    const text = renderPlanningRecord('brief', { ...facts, notes: '# Approved booking\n<script>send()</script>' }, { totalCents: 1, lines: [{ label: 'One | two', amountCents: 1, status: 'recorded', detail: 'Text\n# New section' }] }, '# Working record');
    expect(text).toContain('> \\# Approved booking'); expect(text).toContain('&lt;script&gt;send()&lt;/script&gt;');
    expect(text).toContain('| One \\| two | $0.01 | recorded | Text \\# New section |');
    expect(text).toContain('# \\# Working record');
  });
});
