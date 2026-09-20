import { describe, expect, it } from 'vitest';
import { buildOperationalPlan, dependentRecordAreas, explicitOperationalPatch } from '../server/dependent-planning.js';
import { initialFacts, sources } from '../server/fixtures.js';
import type { Facts, Source } from '../shared/types.js';

describe('explicit operational fields', () => {
  it.each(['4', '4 staff', 'four staff', 'FOUR', 'we need four staff members', 'please schedule four servers', 'set the staff count to four', 'staffing is now four'])('accepts an absolute staffing instruction: %s', note => {
    expect(explicitOperationalPatch({ area: 'staff', note })).toEqual({ staffCount: 4 });
  });
  it.each(['add 4 staff', 'four more staff', 'maybe four staff', 'four staff at $300 each', 'four staff and move the venue', 'staff cost is 400', 'we spent 400 on staff', 'fourteen or four staff', 'minus four staff'])('does not mistake relative, priced, or compound text for staffing: %s', note => {
    expect(explicitOperationalPatch({ area: 'staff', note })).toBeUndefined();
  });
  it('parses whole-number words from zero through twenty without partial matches', () => {
    const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
    words.forEach((word, staffCount) => expect(explicitOperationalPatch({ area: 'staff', note: `${word} staff` })).toEqual({ staffCount }));
    expect(explicitOperationalPatch({ area: 'staff', note: 'twenty-one staff' })).toBeUndefined();
  });
  it.each([
    ['veg', 'vegetarian'], ['veg halal kosher', 'vegetarian halal kosher'], ['vegetarian, halal, kosher', 'vegetarian, halal, kosher'], ['We need vegetarian, halal and kosher options.', 'vegetarian, halal and kosher options'],
    ['Dietary needs: 20 vegetarian meals, 5 kosher meals, no peanuts', '20 vegetarian meals, 5 kosher meals, no peanuts'],
    ['set dietary needs to kosher', 'kosher'], ['Halal and kosher options are available', 'Halal and kosher options are available'],
    ['We no longer need halal meals', 'We no longer need halal meals'],
  ])('preserves literal food scope and quantities in %s', (note, dietary) => {
    expect(explicitOperationalPatch({ area: 'catering', note })).toEqual({ dietary });
  });
  it.each(['Cancel Shah Halal and contact CAVA', 'We need vegan options and 3 staff', 'We need kosher meals; reduce expenses', 'We need halal food and arrange parking', 'Ask CAVA to provide kosher meals', 'Does the caterer have vegan meals?', 'Maybe kosher options', 'We need vegan options if possible', 'Change guest count to 100, with vegan options', 'The vendor said "halal food is available"'])('keeps compound or unconfirmed dietary requests on the planner path: %s', note => {
    expect(explicitOperationalPatch({ area: 'catering', note })).toBeUndefined();
  });
  it('preserves explicit patches and does not convert equipment scope into a price', () => {
    expect(explicitOperationalPatch({ area: 'staff', note: '4 staff', patch: { staffCount: 5 } })).toBeUndefined();
    expect(explicitOperationalPatch({ area: 'equipment', note: 'We need a microphone and projector.' })).toBeUndefined();
  });
});

describe('related current planning records', () => {
  it('updates service and room records when attendance changes, without duplicates', () => {
    expect(dependentRecordAreas(['attendance', 'dietary'])).toEqual(['guests', 'catering', 'staff', 'venue', 'equipment', 'budget', 'brief']);
  });
  it('separates costs and AV scope from guest notifications', () => {
    expect(dependentRecordAreas(['equipmentCostCents'])).toEqual(['equipment', 'budget', 'venue', 'staff', 'brief']);
    expect(dependentRecordAreas(['venueIncludesAV', 'venueAVPending'])).toEqual(['equipment', 'venue', 'staff', 'budget', 'brief']);
    expect(dependentRecordAreas([])).toEqual([]);
  });
});

describe('a coordinated service plan', () => {
  it('combines staff, dietary service, recorded equipment and actual capacity in one reviewable document', () => {
    const facts = { ...initialFacts, attendance: 300, staffCount: 5, dietary: '20 vegetarian meals, 10 halal meals and 5 kosher meals' };
    const draft = buildOperationalPlan(initialFacts, facts, sources)!;
    expect(draft.title).toBe('Service plan for 300 guests');
    expect(draft.body).toContain('5 staff and 300 guests'); expect(draft.body).toContain(facts.dietary);
    expect(draft.body).toContain('40 seats short'); expect(draft.body).toContain('display or projector, microphone, sound');
    expect(draft.body).toContain('$1,800.00 allowance'); expect(draft.body).not.toMatch(/costs? (?:will|is|are) \$|booking confirmed/i);
    expect(draft.evidence.every(id => sources.some(source => source.id === id))).toBe(true);
    expect(facts.equipmentCostCents).toBe(180000); expect(facts.staffCount).toBe(5);
  });
  it('uses known capacity even while venue price is pending, and does not use an unknown capacity', () => {
    const known = { ...initialFacts, attendance: 300, venueDetailsPending: true, venueCapacityPending: false, venueAVPending: true };
    expect(buildOperationalPlan(initialFacts, known, sources)?.body).toContain('40 seats short');
    const unknown = { ...known, venueCapacityPending: true };
    expect(buildOperationalPlan(initialFacts, unknown, sources)?.body).toContain('Seated capacity at Garden Hall is unconfirmed');
    expect(buildOperationalPlan(initialFacts, unknown, sources)?.body).not.toContain('40 seats short');
  });
  it('does not attach researched AV from a different venue, layout or overridden value', () => {
    const research: Source = { id: 'published-room', title: 'Room equipment', area: 'venue', path: 'Public research', content: 'Room equipment', venueEvidence: { researchId: 'room', name: 'Other Hall', address: 'Elsewhere', eventFormat: 'Seated dinner', checkedAt: '2026-09-20', sourceUrl: 'https://example.org/room', av: { included: true, room: 'Main room', items: ['LED wall'], sourceUrl: 'https://example.org/room', excerpt: 'Included LED wall' } } };
    const facts: Facts = { ...initialFacts, attendance: 300, venueIncludesAV: true, venueAVPending: false, venueCapacityEvidenceId: research.id };
    const wrongRoom = buildOperationalPlan(initialFacts, facts, [...sources, research])!;
    expect(wrongRoom.body).not.toContain('LED wall'); expect(wrongRoom.evidence).not.toContain(research.id);
    research.venueEvidence!.name = facts.venue; research.venueEvidence!.address = facts.venueAddress;
    const correctRoom = buildOperationalPlan(initialFacts, facts, [...sources, research])!;
    expect(correctRoom.body).toContain('LED wall'); expect(correctRoom.evidence).toContain(research.id);
    const manualOverride = buildOperationalPlan(initialFacts, { ...facts, venueIncludesAV: false }, [...sources, research])!;
    expect(manualOverride.body).not.toContain('LED wall');
  });
  it('retains user-supplied availability wording without reclassifying it as a requirement', () => {
    const draft = buildOperationalPlan(initialFacts, { ...initialFacts, dietary: 'Vegetarian and halal options are available' }, sources)!;
    expect(draft.body).toContain('Recorded meal options: Vegetarian and halal options are available');
    expect(draft.body).not.toContain('Requested requirements: Vegetarian and halal');
  });
  it('does not generate work for unchanged facts or cite absent source records', () => {
    expect(buildOperationalPlan(initialFacts, initialFacts, sources)).toBeUndefined();
    expect(buildOperationalPlan(initialFacts, { ...initialFacts, attendance: 300 }, [])).toBeUndefined();
  });
});
