import { describe, expect, it } from 'vitest';
import { buildPlanEdit } from '../web/src/plan-edit';

describe('ambient venue edit request', () => {
  it('preserves the explicit venue and requests source-backed associated details', () => {
    const patch = { venue: 'Marriott Hotel' };
    const edit = buildPlanEdit('venue', patch);
    expect(edit.patch).toBe(patch);
    expect(edit.note).toContain('"Marriott Hotel"');
    expect(edit.note).toContain('matching proposal');
    expect(edit.note).toContain('keep them unchanged');
    expect(edit.patch).not.toHaveProperty('venueCapacity');
  });
  it('keeps all other field changes literal and does not invoke natural-language enrichment', () => {
    expect(buildPlanEdit('guests', { attendance: 300 })).toEqual({ area: 'guests', patch: { attendance: 300 } });
    expect(buildPlanEdit('venue', { venueCapacity: 400 })).toEqual({ area: 'venue', patch: { venueCapacity: 400 } });
    expect(buildPlanEdit('catering', { caterer: 'CAVA' })).not.toHaveProperty('note');
  });
  it('quotes venue text as a value and skips enrichment for empty edits', () => {
    const name = 'The "Grand" Hall\nAnnex';
    expect(buildPlanEdit('venue', { venue: name }).note).toContain(JSON.stringify(name));
    expect(buildPlanEdit('venue', { venue: ' ' })).not.toHaveProperty('note');
  });
  it('keeps a publicly verified place identity/address out of fixture enrichment', () => {
    const patch = { venue: 'Boston Marriott Cambridge', venueAddress: '50 Broadway, Cambridge, MA 02142' };
    expect(buildPlanEdit('venue', patch)).toEqual({ area: 'venue', patch });
  });

});
