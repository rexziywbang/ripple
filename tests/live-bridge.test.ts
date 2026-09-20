import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, statSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLiveBridge, type LiveBridge, type LiveJobInput } from '../server/live-bridge.js';

const bridges: LiveBridge[] = [];
const dirs: string[] = [];
function setup(dbPath = ':memory:') { const bridge = createLiveBridge({ dbPath }); bridges.push(bridge); return bridge; }
function diskPath() { const dir = mkdtempSync(join(tmpdir(), 'ripple-live-bridge-')); dirs.push(dir); return join(dir, 'bridge.sqlite'); }
function job(patch: Partial<LiveJobInput> = {}): LiveJobInput {
  return { projectId: 'event-one', provider: 'email', action: 'send_email', dedupeKey: 'notify-v1', revision: 1,
    payload: { to: 'guest@example.com', subject: 'New event time', body: 'Starts at 7.' }, ...patch };
}
afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.close();
  for (const dir of dirs.splice(0)) { for (const file of readdirSync(dir)) unlinkSync(join(dir, file)); rmdirSync(dir); }
});

describe('local live-action bridge', () => {
  it('persists config, queued work and explicit receipts with private database permissions', () => {
    const path = diskPath(); let bridge = setup(path);
    expect(bridge.getConfig('event-one').providers.email.status).toBe('not_configured');
    const config = bridge.configure('event-one', { emailAccount: 'matthewvijayasegar10@gmail.com', testRecipient: 'guest@example.com', partifulEventUrl: 'https://partiful.com/e/demo' });
    expect(config.providers.email.status).toBe('configured');
    expect(config.providers.partiful.status).toBe('configured');
    expect(config.providers.evite.status).toBe('not_configured');
    const first = bridge.enqueue(job()); const second = bridge.enqueue(job({ dedupeKey: 'notify-v2', revision: 2 }));
    expect(first.receipt).toBeUndefined();
    expect(bridge.claimNext('codex-session')?.id).toBe(first.id);
    bridge.complete(first.id, { externalId: 'message-one', url: 'https://mail.google.com/mail/u/0/#sent/message-one', detail: 'Verified message in Sent.' });
    bridge.close(); bridge = setup(path);
    expect(bridge.getConfig('event-one').emailAccount).toBe('matthewvijayasegar10@gmail.com');
    const completed = bridge.listJobs()[0];
    expect(completed.status).toBe('completed'); expect(completed.receipt?.externalId).toBe('message-one');
    expect(bridge.claimNext('new-session')?.id).toBe(second.id);
    for (const file of readdirSync(join(path, '..'))) expect(statSync(join(path, '..', file)).mode & 0o777).toBe(0o600);
  });

  it('never reclaims running work across workers or restarts and never fabricates completion', () => {
    const path = diskPath(); const first = setup(path); const second = setup(path);
    const queued = first.enqueue(job());
    expect(first.claimNext('worker-one')).toMatchObject({ id: queued.id, status: 'running', workerId: 'worker-one' });
    expect(second.claimNext('worker-two')).toBeUndefined();
    first.close(); second.close(); const reopened = setup(path);
    expect(reopened.claimNext('worker-three')).toBeUndefined();
    expect(reopened.listJobs()[0]).toMatchObject({ status: 'running', workerId: 'worker-one' });
    expect(reopened.listJobs()[0].receipt).toBeUndefined();
    expect(() => reopened.cancel(queued.id)).toThrow('reconciliation');
    const failed = reopened.fail(queued.id, 'Session interrupted; external result has not been verified.');
    expect(failed.status).toBe('failed'); expect(failed.receipt).toBeUndefined();
  });

  it('deduplicates sends immutably, including after completion, without crossing project boundaries', () => {
    const bridge = setup(); const first = bridge.enqueue(job());
    expect(bridge.enqueue(job({ revision: 2, payload: { body: 'Changed email' } }))).toEqual(first);
    bridge.claimNext('session'); const completed = bridge.complete(first.id, { detail: 'Verified sent.' });
    expect(bridge.enqueue(job({ revision: 3 }))).toEqual(completed);
    expect(bridge.complete(first.id, { detail: 'A repeated callback' })).toEqual(completed);
    const other = bridge.enqueue(job({ projectId: 'event-two' }));
    expect(other.id).not.toBe(first.id); expect(bridge.listJobs('event-two')).toHaveLength(1);
    const invite = bridge.enqueue(job({ provider: 'partiful', action: 'send_invitation', dedupeKey: 'invite' }));
    expect(bridge.enqueue(job({ provider: 'partiful', action: 'send_invitation', dedupeKey: 'invite', revision: 2, payload: { message: 'Different' } }))).toEqual(invite);
  });

  it('coalesces newer queued file/event updates and protects claimed payloads from late edits', () => {
    const bridge = setup();
    for (const provider of ['dropbox', 'google_calendar', 'partiful', 'evite'] as const) {
      const action = provider === 'dropbox' ? 'update_file' : 'update_event';
      const initial = bridge.enqueue(job({ provider, action, dedupeKey: 'target', payload: { title: 'Old' } }));
      const updated = bridge.enqueue(job({ provider, action, dedupeKey: 'target', revision: 3, payload: { title: 'Latest' } }));
      expect(updated).toMatchObject({ id: initial.id, revision: 3, payload: { title: 'Latest' }, status: 'queued' });
      expect(bridge.enqueue(job({ provider, action, dedupeKey: 'target', revision: 2, payload: { title: 'Stale' } }))).toEqual(updated);
      const claimed = bridge.claimNext('session'); expect(claimed?.id).toBe(initial.id);
      expect(bridge.enqueue(job({ provider, action, dedupeKey: 'target', revision: 4, payload: { title: 'Too late' } }))).toEqual(claimed);
    }
  });

  it('validates provider URLs and keeps configuration updates atomic', () => {
    const bridge = setup();
    bridge.configure('event-one', { emailAccount: 'host@example.com' });
    for (const url of ['javascript:alert(1)', 'file:///tmp/event', 'http://partiful.com/e/demo', 'https://partiful.com.evil.test/e/demo', 'https://user:password@partiful.com/e/demo', 'https://partiful.com:444/e/demo', 'https://evite.com/event/demo']) {
      expect(() => bridge.configure('event-one', { emailAccount: 'changed@example.com', partifulEventUrl: url })).toThrow();
      expect(bridge.getConfig('event-one').emailAccount).toBe('host@example.com');
    }
    expect(() => bridge.configure('event-one', { testRecipient: 'not-an-email' })).toThrow('Invalid');
    expect(() => bridge.configure('event-one', { apiKey: 'secret' } as never)).toThrow('Unknown configuration field');
    const configured = bridge.configure('event-one', { dropboxFolderUrl: 'https://www.dropbox.com/home/Ripple', calendarEventUrl: 'https://calendar.google.com/calendar/u/0/r/eventedit/demo', eviteEventUrl: 'https://evite.me/demo' });
    expect(configured.providers.dropbox.status).toBe('configured');
    expect(bridge.configure('event-one', { eviteEventUrl: '' }).providers.evite.status).toBe('not_configured');
  });

  it('requires a real claimed job and valid explicit evidence for completion', () => {
    const bridge = setup(); const queued = bridge.enqueue(job());
    expect(() => bridge.complete('missing', { detail: 'Sent' })).toThrow('Unknown live job');
    expect(() => bridge.complete(queued.id, { detail: 'Sent' })).toThrow('claim');
    bridge.claimNext('session');
    expect(() => bridge.complete(queued.id, { detail: ' ' })).toThrow('Receipt detail');
    expect(() => bridge.complete(queued.id, { detail: 'Sent', url: 'https://evil.test/receipt' })).toThrow('HTTPS');
    expect(bridge.listJobs()[0].status).toBe('running');
    expect(bridge.listJobs()[0].receipt).toBeUndefined();
    expect(bridge.complete(queued.id, { detail: 'Verified in provider UI.' }).status).toBe('completed');
    expect(() => bridge.fail(queued.id, 'error')).toThrow('completed');
    expect(() => bridge.cancel(queued.id)).toThrow('completed');
  });

  it('cancels only queued work, persists failure details, and skips terminal jobs when claiming', () => {
    const bridge = setup(); const cancelled = bridge.enqueue(job());
    expect(bridge.cancel(cancelled.id).status).toBe('cancelled');
    expect(bridge.cancel(cancelled.id).receipt).toBeUndefined();
    const failed = bridge.enqueue(job({ dedupeKey: 'failed' }));
    expect(bridge.fail(failed.id, new Error('Sign-in required.'))).toMatchObject({ status: 'failed', error: 'Sign-in required.' });
    expect(() => bridge.complete(cancelled.id, { detail: 'Sent' })).toThrow('cancelled');
    expect(() => bridge.complete(failed.id, { detail: 'Sent' })).toThrow('failed');
    expect(bridge.claimNext('session')).toBeUndefined();
    expect(() => bridge.cancel('missing')).toThrow('Unknown live job');
    expect(() => bridge.fail('missing', 'error')).toThrow('Unknown live job');
    expect(() => bridge.enqueue(job({ provider: 'email', action: 'update_file' }))).toThrow('Unsupported');
  });
});
