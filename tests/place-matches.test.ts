import { describe, expect, it } from 'vitest';
import { placeSelectionPatch } from '../web/src/PlaceMatches';
import { buildPlanEdit } from '../web/src/plan-edit';

const place = { id: 'marriott-cambridge', name: 'Boston Marriott Cambridge', address: '50 Broadway, Cambridge, MA 02142', sourceUrl: 'https://www.marriott.com/' };
describe('nearby place selection', () => {
  it('saves canonical venue identity and address without deriving unverified terms', () => {
    const patch = placeSelectionPatch('venue', place);
    expect(patch).toEqual({ venue: place.name, venueAddress: place.address, venueResearchId: place.id });
    expect(buildPlanEdit('venue', patch)).not.toHaveProperty('note');
    expect(patch).not.toHaveProperty('venueCostCents');
    expect(patch).not.toHaveProperty('venueCapacity');
  });
  it('changes only the known caterer name, preserving quote and price workflow', () => {
    expect(placeSelectionPatch('catering', { ...place, name: "Shah's Halal Food" })).toEqual({ caterer: "Shah's Halal Food" });
  });
  it('passes only a lookup ID rather than trusting client-side venue terms', () => {
    const patch = placeSelectionPatch('venue', { ...place, capacity: { guests: 99999 }, av: { included: true } } as typeof place);
    expect(patch).toEqual({ venue: place.name, venueAddress: place.address, venueResearchId: place.id });
    expect(patch).not.toHaveProperty('venueCapacity');
    expect(patch).not.toHaveProperty('venueIncludesAV');
  });
});
