import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ProjectState } from '../shared/types';
import InlinePlan from '../web/src/InlinePlan';
import ReviewQueue from '../web/src/ReviewQueue';

function state(pending: boolean): ProjectState {
  return {
    project: { id: 'event', name: 'Christmas dinner', revision: 1, createdAt: '2026-09-20T00:00:00Z', facts: {
      attendance: 400, date: '2026-12-11', time: '18:00', timezone: 'America/Detroit', format: 'Dinner',
      venue: 'Boston Marriott Cambridge', venueAddress: '50 Broadway, Cambridge, MA 02142', venueCapacity: 360,
      venueCostCents: 800000, venueIncludesAV: true, venueDetailsPending: pending,
      caterer: 'CAVA', cateringPerPersonCents: 2400, cateringDeliveryCents: 15000, cateringStatus: 'confirmed', dietary: '',
      staffCount: 7, staffCostEachCents: 15000, equipmentCostCents: 0, budgetLimitCents: 3000000, sunkCostCents: 0, notes: '',
    } },
    budget: { totalCents: 1880000, lines: [{ label: 'Venue', amountCents: 800000, status: pending ? 'carried estimate' : 'planned', detail: 'Room planning estimate' }] },
    projects: [], proposals: [], activity: [], receipts: [], messages: [], sources: [], workflow: null, connections: [],
    ai: { mode: 'demo', model: '', fallbackModel: '', estimatedSpendUsd: 0, spendLimitUsd: 8 },
  };
}
const inline = (value: ProjectState) => renderToStaticMarkup(createElement(InlinePlan, { state: value, onSave: async () => true }));
const venueSection = (html: string) => html.match(/<section class="ip-section" aria-label="Venue">([\s\S]*?)<\/section>/)?.[1] ?? '';
const withoutDetails = (html: string) => html.replace(/<details\b[\s\S]*?<\/details>/g, '');

function researchedState(): ProjectState {
  const value = state(true);
  const f = value.project.facts;
  f.venueCapacity = 600;
  f.venueCapacityPending = false;
  f.venueAVPending = true;
  f.venueCapacityEvidenceId = 'current-venue-evidence';
  const sourceUrl = 'https://www.marriott.com/en-us/hotels/boscb-boston-marriott-cambridge/events/';
  value.sources = [{
    id: 'current-venue-evidence', area: 'venue', title: 'Published room capacity', path: sourceUrl, content: 'Grand Ballroom: 600 banquet.',
    venueEvidence: {
      researchId: 'research:marriott', name: f.venue, address: f.venueAddress, eventFormat: f.format,
      checkedAt: '2026-09-20T00:00:00Z', sourceUrl,
      capacity: { guests: 600, room: 'Grand Ballroom', layout: 'banquet', sourceUrl, excerpt: 'Grand Ballroom: 600 banquet.' },
    },
  }];
  return value;
}

describe('venue presentation follows current evidence', () => {
  it('labels the previous room amount and suppresses inherited capacity and AV claims', () => {
    const html = inline(state(true));
    expect(html).toContain('Previous room estimate');
    expect(html).toContain('$8,000');
    expect(html).toContain('Previous allowance · venue AV unconfirmed');
    expect(venueSection(html)).not.toContain('value="360"');
    expect(venueSection(html)).not.toContain('Recorded capacity');
    expect(html).not.toContain('above recorded capacity');
    expect(html).not.toContain('places to spare');
    expect(html).not.toContain('House audio &amp; visual equipment is included');
    expect(html).not.toContain('Included with venue');
  });
  it('does not synthesize capacity warnings using another venue’s stored capacity', () => {
    const render = (pending: boolean) => renderToStaticMarkup(createElement(ReviewQueue, { state: state(pending), busy: null, onDecide: async () => true }));
    expect(render(true)).not.toContain('40 guests over venue capacity');
    expect(render(false)).toContain('40 guests over venue capacity');
  });
  it('keeps unsourced recorded capacity inside Details without implying a researched room', () => {
    const html = inline(state(false));
    const venue = venueSection(html);
    expect(venue).toContain('Recorded capacity');
    expect(venue).toContain('value="360"');
    expect(withoutDetails(venue)).not.toContain('360');
    expect(withoutDetails(venue)).not.toContain('Recorded capacity');
    expect(html).toContain('40 above recorded capacity');
    expect(html).not.toContain('Published room capacity source');
    expect(html).toContain('Included with venue');
    expect(html).not.toContain('Previous room estimate');
  });

  it('shows published capacity with its room, layout and source while pricing is still unknown', () => {
    const value = researchedState();
    const html = inline(value);
    const summary = withoutDetails(venueSection(html));
    expect(summary).toContain('600 banquet · Grand Ballroom');
    expect(summary).toContain('aria-label="Published room capacity source"');
    expect(summary).toContain(`href="${value.sources[0].venueEvidence?.capacity?.sourceUrl}"`);
    expect(html).toContain('Previous room estimate');
    expect(html).not.toContain('above recorded capacity');
    expect(html).not.toContain('Included with venue');
  });

  it('never promotes unreferenced or mismatched historical evidence into the current venue summary', () => {
    for (const mismatch of ['reference', 'name', 'address', 'format', 'capacity'] as const) {
      const value = researchedState();
      const f = value.project.facts;
      if (mismatch === 'reference') f.venueCapacityEvidenceId = 'missing-reference';
      if (mismatch === 'name') f.venue = 'Another venue';
      if (mismatch === 'address') f.venueAddress = 'Another address';
      if (mismatch === 'format') f.format = 'Standing reception';
      if (mismatch === 'capacity') f.venueCapacity = 450;
      const summary = withoutDetails(venueSection(inline(value)));
      expect(summary, mismatch).not.toContain('Grand Ballroom');
      expect(summary, mismatch).not.toContain('Published room capacity source');
    }
  });
});
