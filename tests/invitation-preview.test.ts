import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProjectState, Proposal } from '../shared/types';
import InvitationPreview, { selectInvitationPreview } from '../web/src/InvitationPreview';

const project: ProjectState['project'] = {
  id: 'christmas', name: 'Christmas dinner', revision: 5, createdAt: '2026-09-19T12:00:00Z',
  facts: {
    attendance: 90, date: '2026-12-11', time: '18:30', timezone: 'America/Detroit', format: 'Dinner',
    venue: 'New Hotel', venueAddress: '100 New Street', venueCapacity: 120, venueCostCents: 300000, venueIncludesAV: false,
    caterer: 'CAVA', cateringPerPersonCents: 2500, cateringDeliveryCents: 15000, cateringStatus: 'confirmed',
    dietary: 'Vegetarian options', staffCount: 6, staffCostEachCents: 12000, equipmentCostCents: 40000,
    budgetLimitCents: 900000, sunkCostCents: 0, notes: '',
  },
};
const snapshot = (venue: string) => ({
  name: project.name, date: '2026-12-11', time: '18:30', timezone: 'America/Detroit',
  venue, venueAddress: 'Saved venue address', caterer: 'Original catering', dietary: 'Vegetarian options', format: 'Dinner',
});
function invitation(id: string, status: Proposal['status'], version: number, venue: string) {
  return {
    id, title: 'Update guest invitation', area: 'guests', description: 'Prepared guest update',
    before: 'Old location', after: 'New location', costImpactCents: null, kind: 'invitation', status,
    evidence: [], dependencies: [], subject: project.name, body: `Location changed to ${venue}.`,
    recipient: 'guests@example.com', createdAt: `2026-09-19T12:0${version}:00Z`, version,
    invitationSnapshot: snapshot(venue),
  } satisfies Proposal & { invitationSnapshot: ReturnType<typeof snapshot> };
}

describe('guest invitation approval boundary', () => {
  it('keeps the approved location and meal while the plan and pending invitation change', () => {
    const approved = invitation('old', 'applied', 1, 'Original Hall');
    const pending = invitation('new', 'pending', 2, 'New Hotel');
    const selected = selectInvitationPreview({ project, proposals: [pending, approved] });
    expect(selected.snapshot?.venue).toBe('Original Hall');
    expect(selected.snapshot?.caterer).toBe('Original catering');
    expect(selected.draft?.invitationSnapshot?.venue).toBe('New Hotel');
    expect(project.facts.venue).toBe('New Hotel');
  });

  it('switches to the new snapshot at approval, without claiming external delivery', () => {
    const selected = selectInvitationPreview({ project, proposals: [
      invitation('old', 'applied', 1, 'Original Hall'), invitation('new', 'approved', 2, 'New Hotel'),
    ] });
    expect(selected.approved?.id).toBe('new');
    expect(selected.approved?.status).toBe('approved');
    expect(selected.snapshot?.venue).toBe('New Hotel');
    expect(selected.draft).toBeUndefined();
  });

  it('withdraws rejected or superseded drafts without changing the approved invitation', () => {
    for (const status of ['denied', 'withdrawn', 'stale'] as const) {
      const selected = selectInvitationPreview({ project, proposals: [
        invitation('old', 'applied', 1, 'Original Hall'), invitation('new', status, 2, 'New Hotel'),
      ] });
      expect(selected.snapshot?.venue, status).toBe('Original Hall');
      expect(selected.draft, status).toBeUndefined();
    }
  });

  it('selects by revision rather than array order and ignores older pending work', () => {
    const selected = selectInvitationPreview({ project, proposals: [
      invitation('old-pending', 'pending', 1, 'Superseded Hall'),
      invitation('newest', 'applied', 4, 'Current Hall'),
      invitation('older', 'applied', 2, 'Old Hall'),
      { ...invitation('email', 'approved', 5, 'Not an invitation'), kind: 'email' },
    ] });
    expect(selected.approved?.id).toBe('newest');
    expect(selected.draft).toBeUndefined();
  });

  it('never fills historical approved content from mutable current facts when no snapshot exists', () => {
    const { invitationSnapshot: _, ...legacy } = invitation('legacy', 'applied', 1, 'Original Hall');
    const selected = selectInvitationPreview({ project, proposals: [legacy] });
    expect(selected.approved?.body).toBe('Location changed to Original Hall.');
    expect(selected.snapshot).toBeUndefined();
  });

  it('shows the current plan as an unapproved working draft before the first invitation', () => {
    const selected = selectInvitationPreview({ project, proposals: [] });
    expect(selected.approved).toBeUndefined();
    expect(selected.draft).toBeUndefined();
    expect(selected.snapshot?.venue).toBe('New Hotel');
  });

  it('does not present an unconfirmed replacement caterer as the settled meal', () => {
    const selected = selectInvitationPreview({
      project: { ...project, facts: { ...project.facts, cateringStatus: 'awaiting_quote' } }, proposals: [],
    });
    expect(selected.snapshot?.caterer).toBe('');
    expect(selected.approved).toBeUndefined();
  });

  it('keeps a blocked invitation separate from the approved version', () => {
    const selected = selectInvitationPreview({ project, proposals: [
      invitation('approved', 'applied', 1, 'Original Hall'),
      { ...invitation('held', 'blocked', 3, 'Awaiting booking'), dependencies: ['booking'] },
    ] });
    expect(selected.snapshot?.venue).toBe('Original Hall');
    expect(selected.draft?.status).toBe('blocked');
  });

  it('shows the restored working plan after Undo without reviving an earlier approval', () => {
    const revoked = { ...invitation('undone', 'applied', 3, 'Undone Hotel'), invitationSnapshotRevoked: true };
    const selected = selectInvitationPreview({ project, proposals: [
      invitation('old', 'applied', 1, 'Original Hall'), revoked,
      invitation('old-draft', 'pending', 2, 'Superseded Hall'),
    ] });
    expect(selected.approved).toBeUndefined();
    expect(selected.draft).toBeUndefined();
    expect(selected.snapshot?.venue).toBe(project.facts.venue);
    expect(revoked.status).toBe('applied');
    expect(revoked.invitationSnapshot.venue).toBe('Undone Hotel');
  });

  it('shows a correction after Undo as an unapproved draft', () => {
    const selected = selectInvitationPreview({ project, proposals: [
      { ...invitation('undone', 'applied', 2, 'Undone Hotel'), invitationSnapshotRevoked: true },
      invitation('correction', 'pending', 3, 'Restored Hall'),
    ] });
    expect(selected.approved).toBeUndefined();
    expect(selected.draft?.id).toBe('correction');
    expect(selected.snapshot?.venue).toBe('Restored Hall');
  });

  it('requires a newer approval to restore an approved preview after Undo', () => {
    for (const status of ['approved', 'applied'] as const) {
      const selected = selectInvitationPreview({ project, proposals: [
        invitation('new-approval', status, 4, 'Newly Approved Hall'),
        { ...invitation('undone', 'applied', 3, 'Undone Hotel'), invitationSnapshotRevoked: true },
      ] });
      expect(selected.approved?.id).toBe('new-approval');
      expect(selected.snapshot?.venue).toBe('Newly Approved Hall');
      expect(selected.draft).toBeUndefined();
    }
  });

  it('pairs the holiday artwork with approved event details in live HTML', () => {
    const approved = invitation('approved', 'applied', 1, 'Original Hall');
    const markup = renderToStaticMarkup(createElement(InvitationPreview, {
      state: { project, proposals: [approved] },
    }));
    expect(markup).toContain('/invite-art/northstar-holiday.png');
    expect(markup).toContain('Original Hall');
    expect(markup).toContain('Friday, December 11');
    expect(markup).toContain('6:30 PM');
    expect(markup).toContain('Approved version');
    expect(markup).not.toContain('New Hotel');
    expect(markup.indexOf('<img')).toBeLessThan(markup.indexOf('Original Hall'));
    expect(markup).not.toContain('<button');
  });

  it('does not attach the Christmas artwork to a different event', () => {
    const markup = renderToStaticMarkup(createElement(InvitationPreview, {
      state: { project: { ...project, name: 'Annual strategy offsite' }, proposals: [] },
    }));
    expect(markup).not.toContain('/invite-art/');
    expect(markup).toContain('Annual strategy offsite');
    expect(markup).toContain('Working draft');
  });
});
