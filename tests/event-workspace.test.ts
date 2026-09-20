import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import EventWorkspace, { captureBatchReview, ComponentDetailField, EventReviewDeck, hasRemainingReviewWork, updatedPlanningFiles, venueSearchQuery, visibleReviewItems, visibleReviewSlides } from '../web/src/EventWorkspace';
import WorkspaceHome, { readPlanningFiles } from '../web/src/WorkspaceHome';
import { initialFacts } from '../server/fixtures';
import type { ProjectState, Proposal } from '../shared/types';

const proposal = (changes: Partial<Proposal>): Proposal => ({
  id: 'vendor', title: 'Tell the caterer about the new venue', area: 'venue', kind: 'email',
  description: 'Keep the delivery team in the loop.', before: '', after: '', costImpactCents: null,
  status: 'pending', evidence: [], dependencies: [], version: 1, createdAt: '2026-09-20T00:00:00Z',
  recipient: 'rexziyw@gmail.com', subject: 'Christmas dinner — new venue', body: 'Dinner is now at Boston Marriott Cambridge.',
  ...changes,
});
const state = (proposals: Proposal[] = []): ProjectState => ({
  project: { id: 'event', name: 'Christmas dinner', revision: 1, facts: initialFacts, createdAt: '2026-09-20T00:00:00Z' },
  proposals, projects: [{ id: 'event', name: 'Christmas dinner' }], sources: [], messages: [], activity: [], receipts: [],
  workflow: null, budget: { totalCents: 1596000, lines: [] }, connections: [], ai: { mode: 'demo', model: '', fallbackModel: '', estimatedSpendUsd: 0, spendLimitUsd: 0 },
});

describe('component planning flow', () => {
  it('extracts the named destination without losing typo-tolerant input', () => {
    expect(venueSearchQuery('venue has changed to marriot')).toBe('marriot');
    expect(venueSearchQuery('The venue has now changed to Boston Marriott Cambridge.')).toBe('Boston Marriott Cambridge');
    expect(venueSearchQuery('Please move the event to an ice rink')).toBe('an ice rink');
    expect(venueSearchQuery('Charles Hotel')).toBe('Charles Hotel');
  });

  it('keeps dependency-blocked external actions out of individual review', () => {
    const items = visibleReviewItems(state([
      proposal({ id: 'ready' }),
      proposal({ id: 'not-ready', dependencies: ['booking-pending'] }),
      proposal({ id: 'obsolete', status: 'stale' }),
      proposal({ id: 'document', kind: 'file' }),
      proposal({ id: 'warning', kind: 'warning' }),
    ]));
    expect(items.map(item => item.id)).toEqual(['ready']);
  });

  it('shows one exact editable email with Send email rather than approving everything', () => {
    const html = renderToStaticMarkup(createElement(EventWorkspace, { state: state([proposal({ draftToken: 'token' }), proposal({ id: 'later', title: 'A different decision', kind: 'fact' })]), busy: false, mode: 'review', onSave: async () => true, onDecide: async () => true, onPlanCardAction: async () => state(), onAcceptAll: async () => true, emailDrafts: {}, setEmailDrafts: () => {}, onDetails: () => {}, onEdit: () => {} }));
    expect(html).toContain('rexziyw@gmail.com');
    expect(html).toContain('Dinner is now at Boston Marriott Cambridge.');
    expect(html).toContain('aria-label="Email subject"');
    expect(html).toContain('aria-label="Email message"');
    expect(html).toContain('Send email');
    expect(html).toContain('Deny');
    expect(html).not.toContain('Accept all');
    expect(html).toContain('Summary');
    expect(html).not.toContain('A different decision');
    expect(html).not.toContain('readOnly');
    expect(html).not.toContain('Recipient not provided');
  });

  it('reviews each pending operating-plan section alongside facts and invitations', () => {
    const plan = proposal({ id: 'plan', kind: 'plan', planCards: [
      { id: 'setup', title: 'Setup', body: 'Arrive at five.', status: 'pending', revision: 1, revisionToken: 'setup-token' },
      { id: 'service', title: 'Service', body: 'Dinner at six.', status: 'pending', revision: 1, revisionToken: 'service-token' },
      { id: 'old', title: 'Already approved', body: 'Keep this.', status: 'approved', revision: 2, revisionToken: 'old-token' },
    ] });
    const slides = visibleReviewSlides(state([proposal({ id: 'fact', kind: 'fact' }), proposal({ id: 'invite', kind: 'invitation' }), plan]));
    expect(slides.map(slide => slide.key)).toEqual(['plan:setup', 'plan:service', 'fact', 'invite']);
  });

  it('opens demo review on a concise batch summary while keeping individual review available', () => {
    const plan = proposal({ id: 'plan', title: 'Update the operating plan', kind: 'plan', planCards: [
      { id: 'setup', title: 'Setup', body: 'Arrive at five.', status: 'pending', revision: 1, revisionToken: 'setup-token' },
      { id: 'service', title: 'Service', body: 'Dinner at six.', status: 'pending', revision: 1, revisionToken: 'service-token' },
    ] });
    const input = state([proposal({ draftToken: 'draft' }), proposal({ id: 'rental', title: 'Remove the AV rental', kind: 'fact', before: '$1,800', after: '$0' }), plan,
      proposal({ id: 'later', title: 'Do not approve this yet', dependencies: ['not-applied'] })]);
    const html = renderToStaticMarkup(createElement(EventReviewDeck, { state: input, busy: false, reviewOverview: true, onAcceptAll: async () => true, onDecide: async () => true, onPlanCardAction: async () => state(), emailDrafts: { vendor: { subject: 'Updated venue instructions', body: 'Delivery is at Marriott.', draftToken: 'draft' } }, setEmailDrafts: () => {}, onBack: () => {}, onChangeArea: () => {} }));
    expect(html).toContain('3 changes');
    expect(html).toContain('Accept all');
    expect(html).toContain('Review individually');
    expect(html).toContain('Remove the AV rental');
    expect(html).toContain('Setup · Service');
    expect(html).toContain('rexziyw@gmail.com · Updated venue instructions');
    expect(html).not.toContain('Do not approve this yet');
    expect(html).not.toContain('aria-label="Email message"');
  });

  it('binds Accept all to only the visible proposals, edited drafts, and pending card versions', () => {
    const plan = proposal({ id: 'plan', kind: 'plan', planCards: [
      { id: 'setup', title: 'Setup', body: 'Arrive at five.', status: 'pending', revision: 1, revisionToken: 'setup-token' },
      { id: 'old', title: 'Already approved', body: 'Keep this.', status: 'approved', revision: 2, revisionToken: 'old-token' },
    ] });
    const input = state([proposal({ draftToken: 'draft-token', approvalToken: 'approval-token' }), plan, proposal({ id: 'blocked', status: 'blocked' }), proposal({ id: 'file', kind: 'file', status: 'applied' })]);
    const batch = captureBatchReview(input, { vendor: { subject: 'My exact subject', body: 'My exact message.', draftToken: 'draft-token' } });
    expect(batch.revision).toBe(input.project.revision);
    expect(batch.proposals.map(item => item.id)).toEqual(['plan', 'vendor']);
    expect(batch.planCardTokens).toEqual({ plan: { setup: 'setup-token' } });
    expect(batch.drafts).toEqual([{ proposalId: 'vendor', subject: 'My exact subject', body: 'My exact message.', draftToken: 'draft-token' }]);
    input.proposals[0].body = 'A later draft';
    expect(batch.proposals.find(item => item.id === 'vendor')?.body).toBe('Dinner is now at Boston Marriott Cambridge.');
    expect(() => captureBatchReview(input, { vendor: { subject: 'Edited', body: 'Changed', draftToken: 'stale-token' } })).toThrow('changed while you were editing');
  });

  it('blocks batch approval when an edited email no longer matches its reviewed version', () => {
    const html = renderToStaticMarkup(createElement(EventReviewDeck, { state: state([proposal({ draftToken: 'latest' })]), busy: false, reviewOverview: true, onAcceptAll: async () => true, onDecide: async () => true, onPlanCardAction: async () => state(), emailDrafts: { vendor: { subject: 'Edited subject', body: 'Edited message', draftToken: 'old' } }, setEmailDrafts: () => {}, onBack: () => {}, onChangeArea: () => {} }));
    expect(html).toContain('An edited email has changed.');
    expect(html).toMatch(/<button class="primary" type="button" disabled=""[^>]*>/);
    expect(html).toContain('Accept all');
  });

  it('does not let a single email approve its pending staffing prerequisite implicitly', () => {
    const prerequisite = proposal({ id: 'staff', kind: 'fact', area: 'staff', groupId: 'staff-update', patch: { staffCount: 4 } });
    const email = proposal({ id: 'mail', area: 'staff', dependencies: ['staff'], groupId: 'staff-update', batchWithDependencies: true });
    expect(visibleReviewSlides(state([email, prerequisite])).map(slide => slide.key)).toEqual(['staff']);
    expect(visibleReviewSlides(state([email, { ...prerequisite, status: 'applied' }])).map(slide => slide.key)).toEqual(['mail']);
  });

  it('keeps review open until an approved prerequisite releases the next slide', () => {
    const prerequisite = proposal({ id: 'mail', status: 'approved' });
    const followup = proposal({ id: 'invite', kind: 'invitation', status: 'blocked', dependencies: ['mail'] });
    const waiting = state([prerequisite, followup]);
    expect(visibleReviewSlides(waiting)).toEqual([]);
    expect(hasRemainingReviewWork(waiting)).toBe(true);
    const html = renderToStaticMarkup(createElement(EventReviewDeck, { state: waiting, busy: false, onDecide: async () => true, onPlanCardAction: async () => state(), emailDrafts: {}, setEmailDrafts: () => {}, onBack: () => {}, onChangeArea: () => {} }));
    expect(html).toContain('Your next decision will appear here.');
    expect(html).not.toContain('Nothing else to review');
    expect(visibleReviewSlides(state([{ ...prerequisite, status: 'applied' }, { ...followup, status: 'pending' }])).map(slide => slide.key)).toEqual(['invite']);
    expect(hasRemainingReviewWork(state([{ ...prerequisite, status: 'denied' }, followup]))).toBe(false);
    expect(hasRemainingReviewWork(state([{ ...prerequisite, status: 'applied' }, { ...followup, status: 'applied' }]))).toBe(false);
  });

  it('shows a normal number control for direct staffing changes', () => {
    const html = renderToStaticMarkup(createElement(ComponentDetailField, { label: 'Team members', value: '4', kind: 'integer', disabled: false, onSave: async () => true }));
    expect(html).toContain('Team members');
    expect(html).toContain('type="number"');
    expect(html).toContain('step="1"');
    expect(html).toContain('value="4"');
  });

  it('keeps edited email text visible and blocks Send email when its preview token changes', () => {
    const html = renderToStaticMarkup(createElement(EventReviewDeck, { state: state([proposal({ draftToken: 'new-token' })]), busy: false, onDecide: async () => true, onPlanCardAction: async () => state(), emailDrafts: { vendor: { subject: 'My edited subject', body: 'My reviewed message.', draftToken: 'old-token' } }, setEmailDrafts: () => {}, onBack: () => {}, onChangeArea: () => {} }));
    expect(html).toContain('My edited subject');
    expect(html).toContain('My reviewed message.');
    expect(html).toContain('This email changed while you were editing.');
    expect(html).toMatch(/<button class="primary" type="button" disabled=""[^>]*>/);
  });

  it('lists a changed file only when an applied proposal has a receipt and an actual source', () => {
    const input = state([proposal({ id: 'file-staff', kind: 'file', status: 'applied', area: 'staff' })]);
    input.sources = [{ id: 'record:staff', title: 'Staff plan', area: 'staff', path: '/Dinner/Staff plan.md', content: 'Four staff cover arrival and dinner.' }];
    expect(updatedPlanningFiles(input)).toEqual([]);
    input.receipts = [{ id: 'receipt', at: '2026-09-20T00:00:00Z', title: 'Staff plan updated', status: 'local', provider: 'Local plan', detail: 'Saved locally.', proposalId: 'file-staff' }];
    expect(updatedPlanningFiles(input).map(file => file.title)).toEqual(['Staff plan']);
    input.proposals[0].status = 'withdrawn';
    expect(updatedPlanningFiles(input)).toEqual([]);
  });

  it('starts the demo homepage empty without exposing or changing older projects', () => {
    const html = renderToStaticMarkup(createElement(WorkspaceHome, { workspace: { projects: [{ id: 'private', name: 'Other event' }], connections: {} }, demo: true, busy: false, onImport: async () => {}, onOpen: () => {}, onNew: () => {}, onRefresh: async () => ({ projects: [], connections: {} }) }));
    expect(html).toContain('Your events');
    expect(html).toContain('Connect Dropbox');
    expect(html).not.toContain('Other event');
    expect(html).not.toContain('Connected');
  });

  it('reads selected planning documents and preserves the folder structure', async () => {
    const selected = [{ name: 'brief.md', webkitRelativePath: 'Dinner/01 Brief/brief.md', size: 10, text: async () => '# Dinner' }, { name: '.DS_Store', size: 10, text: async () => 'ignored' }] as unknown as File[];
    expect(await readPlanningFiles(selected)).toEqual([{ path: 'Dinner/01 Brief/brief.md', content: '# Dinner' }]);
  });

  it('does not submit an empty folder import when uploaded files are unreadable', async () => {
    const selected = [{ name: 'photo.png', size: 10, text: async () => 'not a document' }] as unknown as File[];
    await expect(readPlanningFiles(selected)).rejects.toThrow('planning documents');
  });
});
