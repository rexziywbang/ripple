import { describe, expect, it, vi } from 'vitest';
import type { ProjectState, Proposal } from '../shared/types';
import { captureEmailDrafts, emailDraftChanged, prepareEditedReview } from '../web/src/review-drafts';

const proposal = (id: string, overrides: Partial<Proposal> = {}): Proposal => ({
  id, title: 'Confirm catering coverage', area: 'catering', description: 'For the revised guest count.',
  before: 'Previous details', after: 'Prepared request', kind: 'email', status: 'pending',
  costImpactCents: null, evidence: [], dependencies: [], version: 2, createdAt: '2026-09-20T12:00:00Z',
  groupId: 'headcount', recipient: 'vendor@example.com', subject: 'Catering coverage', body: 'Please confirm 200 guests.',
  draftToken: `draft-${id}`, approvalToken: `approve-${id}`, ...overrides,
});
const state = (proposals: Proposal[], projectId = 'event') => ({ project: { id: projectId }, proposals }) as ProjectState;
const edit = (p: Proposal) => ({ proposalId: p.id, subject: 'My subject', body: 'My exact edited message.', draftToken: p.draftToken! });
const saved = (p: Proposal) => ({ ...p, subject: 'My subject', body: 'My exact edited message.', draftToken: `saved-${p.id}`, approvalToken: `saved-approval-${p.id}` });

describe('email editing before approval', () => {
  it('captures only changed email drafts and preserves intentional message line breaks', () => {
    const message = proposal('email');
    const draft = { subject: ' My subject ', body: 'First paragraph.\n\nSecond paragraph.\n', draftToken: message.draftToken! };
    expect(captureEmailDrafts([message], { email: draft })).toEqual([
      { proposalId: 'email', subject: 'My subject', body: 'First paragraph.\n\nSecond paragraph.', draftToken: message.draftToken },
    ]);
    expect(emailDraftChanged(message, { subject: message.subject!, body: message.body!, draftToken: 'older-token' })).toBe(false);
    expect(captureEmailDrafts([message], {})).toEqual([]);
    expect(captureEmailDrafts([{ ...message, kind: 'invitation' }], { email: draft })).toEqual([]);
  });

  it('rejects stale local edits and invalid or oversized text before saving', () => {
    const message = proposal('email');
    expect(() => captureEmailDrafts([message], { email: { subject: 'Edited', body: 'Text', draftToken: 'stale' } })).toThrow('changed while');
    for (const change of [
      { subject: ' ' }, { subject: 'a'.repeat(301) }, { subject: 'One\r\nInjected: two' },
      { body: ' ' }, { body: 'x'.repeat(12001) },
    ]) {
      expect(() => captureEmailDrafts([message], { email: { subject: 'Subject', body: 'Body', draftToken: message.draftToken!, ...change } })).toThrow();
    }
  });

  it('saves in order, then returns fresh tokens for only the originally reviewed IDs', async () => {
    const first = proposal('first'); const second = proposal('second');
    const saveDraft = vi.fn().mockResolvedValueOnce(state([saved(first), second, proposal('new-action')]))
      .mockResolvedValueOnce(state([saved(first), saved(second), proposal('new-action')]));
    const result = await prepareEditedReview('event', { proposals: [first, second], drafts: [edit(first), edit(second)] }, {
      readState: async () => state([first, second]), saveDraft,
    });
    expect(saveDraft.mock.calls).toEqual([
      ['first', { subject: 'My subject', body: 'My exact edited message.', draftToken: first.draftToken }],
      ['second', { subject: 'My subject', body: 'My exact edited message.', draftToken: second.draftToken }],
    ]);
    expect(result).toEqual({ proposalIds: ['first', 'second'], approvalTokens: { first: 'saved-approval-first', second: 'saved-approval-second' } });
    expect(first.body).toBe('Please confirm 200 guests.');
  });

  it('rejects changed recipients, plan versions, payloads, or routing before the first save', async () => {
    const message = proposal('email');
    for (const change of [
      { recipient: 'someone-else@example.com' }, { version: 3 }, { body: 'Different request' },
      { approvalToken: 'different-account' }, { draftToken: 'changed-draft' },
      { groupId: 'other-group' }, { status: 'approved' as const }, { dependencies: ['new-dependency'] },
    ]) {
      const saveDraft = vi.fn();
      await expect(prepareEditedReview('event', { proposals: [message], drafts: [edit(message)] }, {
        readState: async () => state([{ ...message, ...change }]), saveDraft,
      })).rejects.toThrow('changed');
      expect(saveDraft).not.toHaveBeenCalled();
    }
  });

  it('does not reauthorize another message that changes during a draft save', async () => {
    const first = proposal('first'); const second = proposal('second');
    await expect(prepareEditedReview('event', { proposals: [first, second], drafts: [edit(first)] }, {
      readState: async () => state([first, second]),
      saveDraft: async () => state([saved(first), { ...second, approvalToken: 'changed-account' }]),
    })).rejects.toThrow('changed');
  });

  it('rejects a changed group after save, including missing work or a server-altered message', async () => {
    const message = proposal('email'); const fact = proposal('staff', { kind: 'fact', patch: { staffCount: 4 }, draftToken: undefined, approvalToken: undefined });
    for (const returned of [
      state([saved(message)]), state([saved(message), { ...fact, patch: { staffCount: 5 } }]),
      state([{ ...saved(message), body: 'Not what was reviewed' }, fact]),
      state([{ ...saved(message), version: 3 }, fact]), state([saved(message), fact], 'another-event'),
    ]) {
      await expect(prepareEditedReview('event', { proposals: [message, fact], drafts: [edit(message)] }, {
        readState: async () => state([message, fact]), saveDraft: async () => returned,
      })).rejects.toThrow('changed');
    }
  });

  it('stops approval if a later save fails, even when an earlier draft was saved', async () => {
    const first = proposal('first'); const second = proposal('second');
    const saveDraft = vi.fn().mockResolvedValueOnce(state([saved(first), second])).mockRejectedValueOnce(new Error('Stale second draft'));
    const approve = vi.fn();
    await expect(prepareEditedReview('event', { proposals: [first, second], drafts: [edit(first), edit(second)] }, {
      readState: async () => state([first, second]), saveDraft,
    }).then(approve)).rejects.toThrow('Stale second draft');
    expect(approve).not.toHaveBeenCalled();
    expect(saveDraft).toHaveBeenCalledTimes(2);
  });

  it('rejects edits outside the captured set and duplicate edits without contacting the server', async () => {
    const message = proposal('email');
    for (const drafts of [[edit(proposal('not-reviewed'))], [edit(message), edit(message)]]) {
      const readState = vi.fn();
      await expect(prepareEditedReview('event', { proposals: [message], drafts }, { readState, saveDraft: vi.fn() })).rejects.toThrow('changed');
      expect(readState).not.toHaveBeenCalled();
    }
  });

  it('verifies operational plans without treating them as editable outgoing email', async () => {
    const plan = proposal('plan', { kind: 'plan', body: '18:00 — Two staff cover arrival.', draftToken: undefined, approvalToken: undefined });
    const saveDraft = vi.fn();
    const result = await prepareEditedReview('event', { proposals: [plan], drafts: [] }, {
      readState: async () => state([plan]), saveDraft,
    });
    expect(result).toEqual({ proposalIds: ['plan'], approvalTokens: {} });
    expect(saveDraft).not.toHaveBeenCalled();
    await expect(prepareEditedReview('event', { proposals: [plan], drafts: [] }, {
      readState: async () => state([{ ...plan, body: 'Unreviewed new plan' }]), saveDraft,
    })).rejects.toThrow('changed');
  });
});
