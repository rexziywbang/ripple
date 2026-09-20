import { describe, expect, it } from 'vitest';
import type { Proposal } from '../shared/types';
import { captureReviewDecision, describeReviewGroup, reviewActionDetail, reviewGroups } from '../web/src/ReviewQueue';

function proposal(id: string, overrides: Partial<Proposal> = {}): Proposal {
  return {
    id, title: id, area: 'venue', description: 'Prepared for review', before: 'Previous plan', after: 'Updated plan',
    costImpactCents: null, status: 'pending', kind: 'email', evidence: [], dependencies: [],
    recipient: `${id}@event.example`, subject: `Event update: ${id}`, body: `Exact draft for ${id}.`,
    version: 1, createdAt: '2026-09-19T12:00:00Z', groupId: 'venue-change', groupTitle: 'Venue update',
    ...overrides,
  };
}

describe('review decision bundles', () => {
  it('presents a venue change as one decision across vendors, staff, and invitations', () => {
    const proposals = [
      proposal('venue-contact'),
      proposal('caterer', { area: 'catering' }),
      proposal('staff', { area: 'staff' }),
      proposal('guests', { area: 'guests', kind: 'invitation' }),
    ];
    const groups = reviewGroups(proposals);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ id: 'venue-change', title: 'Venue update', messageCount: 4 });
    expect(groups[0].proposalIds).toEqual(['venue-contact', 'caterer', 'staff', 'guests']);
    expect(groups[0].proposals.map(p => [p.recipient, p.subject, p.body])).toEqual(
      proposals.map(p => [p.recipient, p.subject, p.body]),
    );
  });

  it('keeps separate decisions separate even when they concern the same area', () => {
    const groups = reviewGroups([
      proposal('cancel', { area: 'catering', groupId: 'cancel-old', groupTitle: 'Cancel previous catering' }),
      proposal('book', { area: 'catering', groupId: 'book-new', groupTitle: 'Book replacement catering' }),
    ]);
    expect(groups.map(group => [group.id, group.title, group.proposalIds])).toEqual([
      ['cancel-old', 'Cancel previous catering', ['cancel']],
      ['book-new', 'Book replacement catering', ['book']],
    ]);
  });

  it('uses understandable area groups for older proposals without grouping metadata', () => {
    const groups = reviewGroups([
      proposal('venue', { groupId: undefined, groupTitle: undefined }),
      proposal('catering', { area: 'catering', groupId: undefined, groupTitle: '  ' }),
      proposal('venue-followup', { groupId: undefined, groupTitle: undefined }),
    ]);
    expect(groups.map(group => [group.id, group.title, group.proposalIds])).toEqual([
      ['area:venue', 'Venue update', ['venue', 'venue-followup']],
      ['area:catering', 'Catering change', ['catering']],
    ]);
  });

  it('keeps bookkeeping and passive planning checks out of the approval count', () => {
    const background = [
      proposal('save-budget', { kind: 'file', area: 'budget' }),
      proposal('capacity-warning', { kind: 'warning' }),
      proposal('dietary-warning', { kind: 'warning', area: 'catering' }),
    ];
    expect(reviewGroups(background)).toEqual([]);
    expect(reviewGroups([...background, proposal('notify-staff')])[0].proposalIds).toEqual(['notify-staff']);
  });

  it('never offers already decided, superseded, or blocked actions for approval again', () => {
    const inactiveStatuses: Proposal['status'][] = ['approved', 'applied', 'denied', 'stale', 'blocked', 'withdrawn'];
    const groups = reviewGroups([
      ...inactiveStatuses.map(status => proposal(status, { status })),
      proposal('current'),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].proposalIds).toEqual(['current']);
  });

  it('requires an applied prerequisite, not merely an approval or a missing record', () => {
    const dependent = proposal('remove-rental-cost', {
      kind: 'fact', dependencies: ['cancel-rental'], costImpactCents: -180000,
    });
    expect(reviewGroups([dependent])).toEqual([]);
    for (const status of ['pending', 'approved', 'denied', 'stale', 'withdrawn', 'blocked'] as const) {
      expect(reviewGroups([proposal('cancel-rental', { kind: 'file', status }), dependent]), status).toEqual([]);
    }
    expect(reviewGroups([proposal('cancel-rental', { kind: 'file', status: 'applied' }), dependent])[0].proposalIds)
      .toEqual(['remove-rental-cost']);
  });

  it('holds a dependent action until every prerequisite has completed', () => {
    const first = proposal('first', { kind: 'file', status: 'applied' });
    const second = proposal('second', { kind: 'file', status: 'approved' });
    const dependent = proposal('final-invitations', { kind: 'invitation', dependencies: ['first', 'second'] });
    expect(reviewGroups([first, second, dependent])).toEqual([]);
    expect(reviewGroups([first, { ...second, status: 'applied' }, dependent])[0].proposalIds).toEqual(['final-invitations']);
  });

  it('reports only actionable fact cost changes without counting message metadata or held work', () => {
    const groups = reviewGroups([
      proposal('add-staff', { kind: 'fact', costImpactCents: 30000 }),
      proposal('reduce-rental', { kind: 'fact', costImpactCents: -180000 }),
      proposal('notify-budget-owner', { costImpactCents: 50000 }),
      proposal('held-change', { kind: 'fact', costImpactCents: 99900, dependencies: ['missing'] }),
    ]);
    expect(groups[0].costImpactCents).toBe(-150000);
    expect(groups[0].messageCount).toBe(1);
    expect(groups[0].proposalIds).toEqual(['add-staff', 'reduce-rental', 'notify-budget-owner']);
  });

  it('limits communication approvals to the displayed emails and invitations', () => {
    const groups = reviewGroups([
      proposal('staffing', { kind: 'fact', costImpactCents: 30000 }),
      proposal('vendor-email'),
      proposal('guest-invitation', { kind: 'invitation', area: 'guests' }),
      proposal('held-email', { dependencies: ['missing'] }),
    ], true);
    expect(groups).toHaveLength(1);
    expect(groups[0].proposalIds).toEqual(['vendor-email', 'guest-invitation']);
    expect(groups[0].messageCount).toBe(2);
    expect(groups[0].costImpactCents).toBe(0);
    expect(reviewGroups([proposal('fact-only', { kind: 'fact' })], true)).toEqual([]);
  });

  it('keeps captured approval IDs unchanged when later suggestions arrive', () => {
    const first = Object.freeze(proposal('original'));
    const initial = Object.freeze([first]);
    const captured = reviewGroups(initial)[0];
    const refreshed = reviewGroups([...initial, proposal('arrived-later')])[0];
    expect(captured.proposalIds).toEqual(['original']);
    expect(captured.proposals).toEqual([first]);
    expect(refreshed.proposalIds).toEqual(['original', 'arrived-later']);
    expect(initial).toEqual([first]);
  });

  it('keeps the reviewed recipient and draft token bound while a decision waits behind another save', () => {
    const displayed = { ...proposal('vendor'), approvalToken: 'preview-for-recipient-a-and-original-body' };
    const group = reviewGroups([displayed])[0];
    const clicked = captureReviewDecision(group);

    // A configuration refresh can replace recipient/body/token while an earlier
    // field save is still running. It must not silently authorize that new draft.
    displayed.recipient = 'recipient-b@event.example';
    displayed.body = 'A changed message that was not reviewed.';
    displayed.approvalToken = 'preview-for-recipient-b-and-new-body';
    group.proposalIds.push('new-unreviewed-action');

    expect(clicked).toEqual({
      proposalIds: ['vendor'],
      approvalTokens: { vendor: 'preview-for-recipient-a-and-original-body' },
    });
    expect(captureReviewDecision(reviewGroups([displayed])[0]).approvalTokens.vendor)
      .toBe('preview-for-recipient-b-and-new-body');
  });

  it('does not fabricate preview authorization for untokened local actions or blocked emails', () => {
    const proposals = [
      { ...proposal('live-email'), approvalToken: 'reviewed-live-preview' },
      proposal('local-fact', { kind: 'fact' }),
      { ...proposal('blocked-email', { dependencies: ['missing'] }), approvalToken: 'blocked-preview' },
    ];
    const clicked = captureReviewDecision(reviewGroups(proposals)[0]);
    expect(clicked.proposalIds).toEqual(['live-email', 'local-fact']);
    expect(clicked.approvalTokens).toEqual({ 'live-email': 'reviewed-live-preview' });
  });
});


describe('explicit local fact and message approval', () => {
  const fact = () => proposal('staff-count', { kind: 'fact', area: 'staff', groupId: 'headcount', patch: { staffCount: 6 } });
  const email = () => proposal('staff-email', { area: 'staff', groupId: 'headcount', dependencies: ['staff-count'], batchWithDependencies: true, approvalToken: 'exact-six-staff-draft' });

  it('includes the marked message and its ready local fact in one exact visible decision', () => {
    const groups = reviewGroups([email(), fact()]);
    expect(groups).toHaveLength(1);
    expect(groups[0].proposalIds).toEqual(['staff-email', 'staff-count']);
    expect(captureReviewDecision(groups[0])).toEqual({
      proposalIds: ['staff-email', 'staff-count'], approvalTokens: { 'staff-email': 'exact-six-staff-draft' },
    });
  });

  it('holds the email when the local fact is absent from the communications-only view', () => {
    expect(reviewGroups([fact(), email()], true)).toEqual([]);
    expect(reviewGroups([{ ...fact(), status: 'applied' }, email()], true)[0].proposalIds).toEqual(['staff-email']);
  });

  it('keeps unmarked and differently grouped dependent messages held', () => {
    expect(reviewGroups([fact(), { ...email(), batchWithDependencies: false }])[0].proposalIds).toEqual(['staff-count']);
    expect(reviewGroups([fact(), { ...email(), groupId: 'other-change' }])[0].proposalIds).toEqual(['staff-count']);
    expect(reviewGroups([{ ...fact(), groupId: undefined }, { ...email(), groupId: undefined }])[0].proposalIds).toEqual(['staff-count']);
  });

  it('does not batch external prerequisites, unresolved fact chains, or inactive facts', () => {
    expect(reviewGroups([{ ...fact(), kind: 'email' }, email()])[0].proposalIds).toEqual(['staff-count']);
    expect(reviewGroups([{ ...fact(), dependencies: ['external-cancellation'] }, email()])).toEqual([]);
    for (const status of ['approved', 'denied', 'withdrawn', 'blocked', 'stale'] as const) {
      expect(reviewGroups([{ ...fact(), status }, email()]), status).toEqual([]);
    }
    expect(reviewGroups([email()])).toEqual([]);
  });

  it('requires every extra prerequisite to be complete even when the local fact is ready', () => {
    const other = proposal('booking', { kind: 'email', status: 'approved', groupId: 'other' });
    const message = { ...email(), dependencies: ['staff-count', 'booking'] };
    expect(reviewGroups([fact(), message, other])[0].proposalIds).toEqual(['staff-count']);
    expect(reviewGroups([fact(), message, { ...other, status: 'applied' }])[0].proposalIds).toEqual(['staff-count', 'staff-email']);
  });
});

describe('concrete review presentation', () => {
  it('leads a headcount bundle with the actual staffing decision and its cause', () => {
    const proposals = [
      proposal('catering', { title: 'Confirm Shah Halal can serve 200 guests', groupTitle: 'Guest count changed to 200' }),
      proposal('staff', { kind: 'fact', title: 'Adjust staffing to 4 people', patch: { staffCount: 4 }, groupTitle: 'Guest count changed to 200' }),
    ];
    const group = reviewGroups(proposals)[0];
    expect(describeReviewGroup(group)).toEqual({ title: 'Arrange coverage with 4 staff for 200 guests', cause: 'Guest count changed to 200' });
    expect(group.proposalIds).toEqual(['catering', 'staff']);
    expect(group.proposals).toEqual(proposals);
  });

  it('describes only the included work in the communications view', () => {
    const groups = reviewGroups([
      proposal('staff', { kind: 'fact', patch: { staffCount: 4 }, groupTitle: 'Guest count changed to 200' }),
      proposal('catering', { title: 'Confirm Shah Halal can serve 200 guests', groupTitle: 'Guest count changed to 200' }),
    ], true);
    expect(describeReviewGroup(groups[0]).title).toBe('Confirm Shah Halal can serve 200 guests');
    expect(groups[0].proposalIds).toEqual(['catering']);
  });

  it('uses the captured email subject for staffing context when the old cause is generic', () => {
    const group = reviewGroups([
      proposal('staff', { kind: 'fact', patch: { staffCount: 4 }, groupTitle: 'Staff updated' }),
      proposal('email', { subject: 'Christmas dinner: Staffing for 200 guests', groupTitle: 'Staff updated' }),
    ])[0];
    expect(describeReviewGroup(group)).toEqual({ title: 'Arrange coverage with 4 staff for 200 guests', cause: undefined });
    const conflicting = { ...group, proposals: [...group.proposals, proposal('other', { subject: 'Catering for 300 guests' })] };
    expect(describeReviewGroup(conflicting).title).toBe('Arrange coverage with 4 staff');
  });

  it('replaces edit receipts with a proposed action without claiming it is done', () => {
    for (const groupTitle of ['Staff updated', 'Guests updated', 'Event updated', 'Venue update']) {
      const group = reviewGroups([proposal('staff', { groupTitle, title: 'Request arrival assignments for 4 staff' })])[0];
      expect(describeReviewGroup(group)).toEqual({ title: 'Request arrival assignments for 4 staff', cause: undefined });
    }
  });

  it('preserves a specific group request and a separate venue-change cause', () => {
    expect(describeReviewGroup(reviewGroups([
      proposal('cancel', { groupTitle: 'Cancel previous catering', title: 'Request cancellation confirmation' }),
    ])[0]).title).toBe('Cancel previous catering');
    expect(describeReviewGroup(reviewGroups([
      proposal('guests', { groupTitle: 'Venue changed to Garden Hall', title: 'Send guests the new venue', kind: 'invitation' }),
    ])[0])).toEqual({ title: 'Send guests the new venue', cause: 'Venue changed to Garden Hall' });
  });

  it('does not infer attendance or policy from unrelated or missing context', () => {
    const group = reviewGroups([proposal('staff', {
      kind: 'fact', title: 'Adjust staffing', patch: { staffCount: 4 }, groupTitle: 'Budget changed to $12,000',
    })])[0];
    expect(describeReviewGroup(group)).toEqual({ title: 'Arrange coverage with 4 staff', cause: 'Budget changed to $12,000' });
  });

  it('exposes the concrete request without substituting delivery metadata or altering the exact draft', () => {
    const draft = 'Please confirm catering for 200 guests.\n\nPlease reply with revised pricing and availability.';
    const message = proposal('catering', { body: draft, description: 'Prepared for Gmail delivery.', approvalToken: 'exact-draft-token' });
    const group = reviewGroups([message])[0];
    expect(reviewActionDetail(message)).toBe('Please confirm catering for 200 guests. Please reply with revised pricing and availability.');
    expect(message.body).toBe(draft);
    expect(captureReviewDecision(group)).toEqual({ proposalIds: ['catering'], approvalTokens: { catering: 'exact-draft-token' } });
    expect(reviewActionDetail({ ...message, body: undefined })).toBe('');
  });

  it('keeps longer requests bounded while retaining the full message for approval', () => {
    const body = 'Please confirm the proposed arrangement. '.repeat(20);
    const message = proposal('long', { body });
    expect(reviewActionDetail(message).length).toBeLessThanOrEqual(230);
    expect(reviewActionDetail(message)).toMatch(/…$/);
    expect(message.body).toBe(body);
    expect(reviewActionDetail(proposal('fact', { kind: 'fact', description: 'One staff member per 60 guests, rounded up.' })))
      .toBe('One staff member per 60 guests, rounded up.');
  });

  it('includes operational plans as local deliverables rather than outgoing messages', () => {
    const plan = proposal('arrival-plan', {
      kind: 'plan', title: 'Prepare the guest arrival plan', body: '18:00 — Two staff greet arrivals.\n18:30 — Open dinner seating.',
      groupTitle: 'Event updated', evidence: ['staffing-policy'], recipient: undefined,
    });
    const groups = reviewGroups([plan]);
    expect(groups[0].messageCount).toBe(0);
    expect(groups[0].proposalIds).toEqual(['arrival-plan']);
    expect(describeReviewGroup(groups[0]).title).toBe('Prepare the guest arrival plan');
    expect(reviewGroups([plan], true)).toEqual([]);
    expect(groups[0].proposals[0].body).toBe(plan.body);
  });
});
