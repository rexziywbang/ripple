import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Facts, ProjectState, Proposal } from '../shared/types';
import ReviewQueue from '../web/src/ReviewQueue';

function render(facts: Partial<Facts> = {}, proposals: Proposal[] = []) {
  const state = {
    project: { facts: { attendance: 100, venueCapacity: 80, budgetLimitCents: 100000, ...facts } },
    budget: { totalCents: 50000 }, proposals, sources: [],
  } as unknown as ProjectState;
  return renderToStaticMarkup(createElement(ReviewQueue, { state, busy: null, onDecide: async () => true }));
}

describe('compact review constraints', () => {
  it('keeps a known capacity shortfall visible while venue pricing is unconfirmed', () => {
    expect(render({ venueDetailsPending: true, venueCapacityPending: false })).toContain('20 guests over venue capacity');
  });
  it('does not treat unknown capacity as zero seats or borrow a previous venue capacity', () => {
    expect(render({ venueCapacity: 0 })).not.toContain('over venue capacity');
    expect(render({ venueCapacityPending: true })).not.toContain('over venue capacity');
    expect(render({ venueDetailsPending: true })).not.toContain('over venue capacity');
  });
  it('removes waiting and generic check panels without exposing dependent actions for approval', () => {
    const base: Proposal = {
      id: 'held', area: 'guests', kind: 'invitation', status: 'pending', title: 'Send guests a booking confirmation',
      description: 'Wait for the booking.', before: '', after: '', costImpactCents: null, dependencies: ['unconfirmed-booking'],
      evidence: [], version: 1, createdAt: '2026-09-20T00:00:00Z',
    };
    const html = render({ venueCapacity: 200 }, [base, { ...base, id: 'warning', kind: 'warning', dependencies: [], title: 'Check something later' }]);
    expect(html).toContain('No decisions needed');
    for (const hidden of ['Approve', 'Send guests a booking confirmation', 'related action', 'Planning checks', 'Check something later']) {
      expect(html).not.toContain(hidden);
    }
  });
  it('previews a quiet invitation update without asking for a recipient', () => {
    const proposal: Proposal = {
      id: 'description', area: 'guests', kind: 'invitation', status: 'pending',
      title: 'Update the invitation details', description: '', before: '', after: '',
      costImpactCents: null, dependencies: [], evidence: [], version: 1,
      createdAt: '2026-09-20T00:00:00Z', invitationNotifyGuests: false,
      subject: 'Christmas dinner', body: 'Kosher options are available.',
    };
    const html = render({ venueCapacity: 200 }, [proposal]);
    expect(html).toContain('Event description · no guest email');
    expect(html).toContain('Preview invitation');
    expect(html).not.toContain('Recipient not provided');
    expect(html).not.toContain('<dt>To</dt>');
  });
});
