import { afterEach, describe, expect, it } from 'vitest';
import { latestAppliedInvitationSnapshot, syncInvitations, type InvitationSnapshot, type InvitationSyncState } from '../server/invitation-sync.js';
import { createLiveBridge, type LiveBridge } from '../server/live-bridge.js';
import { initialFacts } from '../server/fixtures.js';
import type { Proposal } from '../shared/types.js';

const eviteEventUrl = 'https://www.evite.com/event/test-event';
const partifulEventUrl = 'https://partiful.com/e/test-event';
const approvedSnapshot: InvitationSnapshot = {
  name: 'Approved dinner', date: '2026-12-11', time: '18:00', timezone: 'America/New_York',
  venue: 'Approved venue', venueAddress: 'Approved address', caterer: '', dietary: 'Vegetarian options', format: 'Dinner',
};
const bridges: LiveBridge[] = [];
function setup(both = true) {
  const bridge = createLiveBridge({ dbPath: ':memory:' }); bridges.push(bridge);
  bridge.configure('event', { eviteEventUrl, ...(both ? { partifulEventUrl } : {}) }); return bridge;
}
function proposal(id = 'approved-1', patch: Partial<Proposal> = {}): Proposal {
  return {
    id, kind: 'invitation', status: 'applied', title: 'Update event metadata', area: 'guests', description: '',
    before: '', after: '', costImpactCents: null, evidence: [], dependencies: [], version: 1,
    createdAt: '2026-09-20T04:00:00Z', invitationSnapshot: { ...approvedSnapshot }, ...patch,
  };
}
function state(proposals: Proposal[] = []): InvitationSyncState {
  return { project: { id: 'event', name: 'Unapproved current name', revision: 99, createdAt: '2026-09-20T00:00:00Z', facts: { ...initialFacts } }, proposals };
}
afterEach(() => { for (const bridge of bridges.splice(0)) bridge.close(); });

describe('approved invitation metadata browser queue', () => {
  it('queues nothing on initial configuration or for pending, approved, denied, blocked, stale, or withdrawn proposals', () => {
    const bridge = setup(); expect(syncInvitations(state(), bridge)).toEqual([]);
    for (const status of ['pending', 'approved', 'denied', 'blocked', 'stale', 'withdrawn'] as const) {
      expect(syncInvitations(state([proposal(status, { status })]), bridge)).toEqual([]);
    }
    expect(syncInvitations(state([proposal('email', { kind: 'email' })]), bridge)).toEqual([]);
    expect(bridge.listJobs()).toEqual([]);
  });

  it('copies only the applied snapshot for each configured provider without guest sends or current-facts leakage', () => {
    const bridge = setup();
    const snapshotWithExtra = { ...approvedSnapshot, guestEmails: ['do-not-copy@example.net'] };
    const source = proposal('approved-1', { invitationSnapshot: snapshotWithExtra, recipient: 'do-not-copy@example.net' });
    const current = state([source]); current.project.facts.venue = 'Unapproved venue'; current.project.facts.caterer = 'Unconfirmed caterer';
    const jobs = syncInvitations(current, bridge);
    expect(jobs.map(job => job.provider)).toEqual(['evite', 'partiful']);
    for (const job of jobs) {
      expect(job).toMatchObject({ action: 'update_event', status: 'queued', revision: 1, payload: { snapshot: approvedSnapshot, proposalId: source.id, metadataOnly: true, notifyGuests: false } });
      expect(Object.keys(job.payload.snapshot as object).sort()).toEqual(Object.keys(approvedSnapshot).sort());
      expect(job.receipt).toBeUndefined(); expect(job.workerId).toBeUndefined();
      expect(JSON.stringify(job.payload)).not.toContain('do-not-copy');
      expect(JSON.stringify(job.payload)).not.toContain('Unapproved');
      expect((job.payload.snapshot as InvitationSnapshot).caterer).toBe('');
    }
    source.invitationSnapshot!.venue = 'Mutation after queuing';
    expect((bridge.listJobs()[0].payload.snapshot as InvitationSnapshot).venue).toBe('Approved venue');
  });

  it('selects by creation time and then appended proposal order, returning detached snapshot values', () => {
    const newer = proposal('newer', { createdAt: '2026-09-20T04:02:00Z' });
    const older = proposal('older');
    expect(latestAppliedInvitationSnapshot(state([newer, older]))?.proposalId).toBe('newer');
    const tied = proposal('tie', { createdAt: newer.createdAt, invitationSnapshot: { ...approvedSnapshot, caterer: 'Confirmed in approved snapshot' } });
    const selected = latestAppliedInvitationSnapshot(state([newer, older, tied]))!;
    expect(selected.proposalId).toBe('tie'); expect(selected.snapshot.caterer).toBe('Confirmed in approved snapshot');
    selected.snapshot.venue = 'Detached edit'; expect(tied.invitationSnapshot!.venue).toBe('Approved venue');
  });

  it('does not fall back to older approvals when the newest applied snapshot is missing', () => {
    const bridge = setup(); const old = proposal(); syncInvitations(state([old]), bridge);
    const missing = proposal('missing', { createdAt: '2026-09-20T04:02:00Z', invitationSnapshot: undefined });
    expect(latestAppliedInvitationSnapshot(state([old, missing]))).toBeUndefined();
    expect(syncInvitations(state([old, missing]), bridge)).toEqual([]);
    expect(bridge.listJobs().every(job => job.status === 'cancelled')).toBe(true);
  });

  it('cancels an undone snapshot without falling back to an older approval or a pending correction', () => {
    const bridge = setup(); const old = proposal('older');
    const newest = proposal('newest', { createdAt: '2026-09-20T04:02:00Z' });
    syncInvitations(state([old, newest]), bridge); bridge.claimNext('browser');
    newest.invitationSnapshotRevoked = true;
    const correction = proposal('correction', { status: 'pending', createdAt: '2026-09-20T04:03:00Z' });
    expect(latestAppliedInvitationSnapshot(state([old, newest, correction]))).toBeUndefined();
    expect(syncInvitations(state([old, newest, correction]), bridge)).toEqual([]);
    expect(bridge.listJobs().map(job => job.status)).toEqual(['running', 'cancelled']);
    correction.status = 'applied';
    expect(syncInvitations(state([old, newest, correction]), bridge)).toHaveLength(2);
  });

  it('deduplicates identical approved metadata despite newer current edits or an identical later approval', () => {
    const bridge = setup(); const old = proposal(); const first = syncInvitations(state([old]), bridge);
    const current = state([old, proposal('draft', { status: 'pending', createdAt: '2026-09-20T04:05:00Z', invitationSnapshot: { ...approvedSnapshot, time: '20:00' } })]);
    current.project.name = 'Still not approved';
    expect(syncInvitations(current, bridge).map(job => job.id)).toEqual(first.map(job => job.id));
    const identical = proposal('identical', { createdAt: '2026-09-20T04:06:00Z', version: 8 });
    expect(syncInvitations(state([old, identical]), bridge).map(job => job.id)).toEqual(first.map(job => job.id));
    expect(bridge.listJobs()).toHaveLength(2);
  });

  it('coalesces stale queued metadata and preserves running payloads plus unrelated email work', () => {
    const bridge = setup(); const first = syncInvitations(state([proposal()]), bridge); bridge.claimNext('browser');
    const email = bridge.enqueue({ projectId: 'event', provider: 'email', action: 'send_email', dedupeKey: 'email', revision: 1, payload: { body: 'Separate approved email.' } });
    const next = syncInvitations(state([proposal('newer', { version: 2, invitationSnapshot: { ...approvedSnapshot, venue: 'New approved venue' } })]), bridge);
    expect(bridge.listJobs().find(job => job.id === first[0].id)).toMatchObject({ status: 'running', payload: first[0].payload });
    expect(bridge.listJobs().find(job => job.id === first[1].id)?.status).toBe('cancelled');
    expect(bridge.listJobs().find(job => job.id === email.id)?.status).toBe('queued');
    expect(next.every(job => job.status === 'queued')).toBe(true);
  });

  it('stages approved changes after completion including a later return to an earlier snapshot', () => {
    const bridge = setup(false); const first = syncInvitations(state([proposal()]), bridge)[0]; bridge.claimNext('browser');
    bridge.complete(first.id, { detail: 'Verified private event metadata.', url: eviteEventUrl });
    expect(syncInvitations(state([proposal()]), bridge)[0].id).toBe(first.id);
    const second = syncInvitations(state([proposal('second', { invitationSnapshot: { ...approvedSnapshot, time: '19:00' } })]), bridge)[0]; bridge.claimNext('browser');
    bridge.complete(second.id, { detail: 'Verified updated private event metadata.', url: eviteEventUrl });
    const reverted = syncInvitations(state([proposal('reverted')]), bridge)[0];
    expect(reverted.status).toBe('queued'); expect(reverted.id).not.toBe(first.id);
    expect(reverted.payload.snapshotHash).toBe(first.payload.snapshotHash);
  });

  it('disconnects only that provider and creates fresh queued metadata on cancelled reconnect', () => {
    const bridge = setup(); const current = state([proposal()]); const first = syncInvitations(current, bridge);
    bridge.configure('event', { eviteEventUrl: '' });
    expect(syncInvitations(current, bridge).map(job => job.id)).toEqual([first[1].id]);
    expect(bridge.listJobs().find(job => job.id === first[0].id)?.status).toBe('cancelled');
    bridge.configure('event', { eviteEventUrl }); const resumed = syncInvitations(current, bridge);
    expect(resumed[0].status).toBe('queued'); expect(resumed[0].id).not.toBe(first[0].id);
    expect(resumed[1].id).toBe(first[1].id);
  });

  it('leaves uncertain failed metadata unchanged across polling and reconnect', () => {
    const bridge = setup(false); const current = state([proposal()]); const first = syncInvitations(current, bridge)[0]; bridge.claimNext('browser');
    bridge.fail(first.id, 'Saved state needs verification.');
    expect(syncInvitations(current, bridge)[0].status).toBe('failed');
    bridge.configure('event', { eviteEventUrl: '' }); syncInvitations(current, bridge);
    bridge.configure('event', { eviteEventUrl });
    expect(syncInvitations(current, bridge)[0].id).toBe(first.id); expect(bridge.listJobs()).toHaveLength(1);
  });

  it('treats target changes as new work and never mutates existing invitation-send jobs', () => {
    const bridge = setup(false); const current = state([proposal()]); const first = syncInvitations(current, bridge)[0];
    const send = bridge.enqueue({ projectId: 'event', provider: 'evite', action: 'send_invitation', dedupeKey: 'separate-send', revision: 1, payload: { external: 'separate work' } });
    bridge.configure('event', { eviteEventUrl: 'https://www.evite.com/event/another-private-event' });
    const next = syncInvitations(current, bridge)[0];
    expect(next.id).not.toBe(first.id); expect(next.payload.eventUrl).toContain('another-private-event');
    expect(bridge.listJobs().find(job => job.id === first.id)?.status).toBe('cancelled');
    expect(bridge.listJobs().find(job => job.id === send.id)).toEqual(send);
  });
});
