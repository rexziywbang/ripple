import { describe, expect, it } from 'vitest';
import { invitationEventLink, invitationQueueCounts, invitationSyncFeedback } from '../web/src/InvitationConnections';

describe('invitation platform links', () => {
  it('preserves real provider links and accepts Evite short links', () => {
    expect(invitationEventLink('evite', 'https://www.evite.com/event/event-id/')).toBe('https://www.evite.com/event/event-id/');
    expect(invitationEventLink('evite', 'https://evite.me/short-id')).toBe('https://evite.me/short-id');
    expect(invitationEventLink('partiful', ' https://partiful.com/e/event-id ')).toBe('https://partiful.com/e/event-id');
  });
  it('does not accept another provider, credential-bearing URLs, or lookalike domains', () => {
    for (const value of ['https://evite.com/event', 'https://partiful.com.evil.example/e/id', 'https://user@partiful.com/e/id', 'http://partiful.com/e/id', 'https://partiful.com:8443/e/id', '']) expect(invitationEventLink('partiful', value)).toBeUndefined();
    expect(invitationEventLink('evite', 'https://partiful.com/e/id')).toBeUndefined();
  });
  it('shows only current project detail-update jobs, not invitation sends or other integrations', () => {
    const job = { projectId: 'event', provider: 'partiful', action: 'update_event', status: 'queued' };
    const jobs = [job, { ...job, status: 'running' }, { ...job, status: 'completed' }, { ...job, action: 'send_invitation' }, { ...job, provider: 'evite' }, { ...job, projectId: 'other' }];
    expect(invitationQueueCounts(jobs, 'event', 'partiful')).toEqual({ queued: 1, running: 1 });
    expect(invitationQueueCounts(jobs, 'event', 'evite')).toEqual({ queued: 1, running: 0 });
  });
});


describe('invitation sync outcome selection', () => {
  const base = { projectId: 'event', provider: 'partiful', action: 'update_event', revision: 1, createdAt: '2026-09-20T00:00:00Z', status: 'failed', error: 'The event editor could not be opened.' };
  it('keeps failures provider-specific and retires them when newer detail work exists', () => {
    expect(invitationSyncFeedback([base], 'event', 'partiful').failure).toBe(base.error);
    expect(invitationSyncFeedback([base], 'event', 'evite').failure).toBeUndefined();
    expect(invitationSyncFeedback([base, { ...base, createdAt: '2026-09-20T00:01:00Z', revision: 2, status: 'queued' }], 'event', 'partiful').failure).toBeUndefined();
    expect(invitationSyncFeedback([{ ...base, action: 'send_invitation' }], 'event', 'partiful').failure).toBeUndefined();
  });
  it('shows only verified completed detail receipts, even when newer work is still queued', () => {
    const receipt = { completedAt: '2026-09-20T00:02:00Z', detail: 'Verified event details.', url: 'https://partiful.com/e/id' };
    const finished = { ...base, status: 'completed', receipt };
    const next = { ...base, createdAt: '2026-09-20T00:03:00Z', revision: 2, status: 'queued' };
    expect(invitationSyncFeedback([finished, next], 'event', 'partiful')).toEqual({ failure: undefined, receipt });
    expect(invitationSyncFeedback([{ ...finished, receipt: undefined }], 'event', 'partiful').receipt).toBeUndefined();
    expect(invitationSyncFeedback([{ ...finished, receipt: { ...receipt, completedAt: 'invalid' } }], 'event', 'partiful').receipt).toBeUndefined();
  });
});
