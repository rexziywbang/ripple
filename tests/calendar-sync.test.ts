import { afterEach, describe, expect, it } from 'vitest';
import { buildCalendarSnapshot, syncCalendar } from '../server/calendar-sync.js';
import { createLiveBridge, type LiveBridge } from '../server/live-bridge.js';
import { initialFacts } from '../server/fixtures.js';
import type { FactPatch, ProjectState } from '../shared/types.js';

const eventUrl = 'https://calendar.google.com/calendar/u/0/r/eventedit/test-event';
const bridges: LiveBridge[] = [];
function setup() { const bridge = createLiveBridge({ dbPath: ':memory:' }); bridges.push(bridge); return bridge; }
function state(revision = 1, patch: FactPatch = {}): Pick<ProjectState, 'project'> {
  return { project: { id: 'calendar-demo', name: 'Dinner', revision, createdAt: '2026-09-20T00:00:00Z', facts: { ...initialFacts, ...patch } } };
}
afterEach(() => { for (const bridge of bridges.splice(0)) bridge.close(); });

describe('personal calendar browser sync queue', () => {
  it('does nothing without a configured calendar target', () => {
    const bridge = setup();
    expect(syncCalendar(state(), bridge)).toBeUndefined();
    expect(bridge.listJobs()).toEqual([]);
    expect(bridge.getConfig('calendar-demo').providers.google_calendar.status).toBe('not_configured');
  });

  it('queues only the exact personal-event fields without claiming or completing them', () => {
    const bridge = setup(); bridge.configure('calendar-demo', { calendarEventUrl: eventUrl });
    const snapshot = buildCalendarSnapshot(state());
    expect(Object.keys(snapshot).sort()).toEqual(['attendance', 'date', 'name', 'time', 'timezone', 'venue', 'venueAddress']);
    const job = syncCalendar(state(), bridge)!;
    expect(job).toMatchObject({ provider: 'google_calendar', action: 'update_event', status: 'queued', payload: { calendarEventUrl: eventUrl, snapshot, personalCalendarOnly: true, notifyGuests: false } });
    expect(job.receipt).toBeUndefined(); expect(job.workerId).toBeUndefined();
    expect(job.payload).not.toHaveProperty('guests'); expect(job.payload).not.toHaveProperty('attendees');
    expect(bridge.getConfig('calendar-demo').providers.google_calendar.status).toBe('configured');
  });

  it('deduplicates unchanged snapshots even when unrelated project revisions advance', () => {
    const bridge = setup(); bridge.configure('calendar-demo', { calendarEventUrl: eventUrl });
    const first = syncCalendar(state(), bridge)!;
    expect(syncCalendar(state(2, { budgetLimitCents: 2000000, caterer: 'Another caterer' }), bridge)?.id).toBe(first.id);
    expect(bridge.listJobs()).toHaveLength(1);
  });

  it('coalesces rapid edits by cancelling only older queued calendar jobs', () => {
    const bridge = setup(); bridge.configure('calendar-demo', { calendarEventUrl: eventUrl });
    const email = bridge.enqueue({ projectId: 'calendar-demo', provider: 'email', action: 'send_email', dedupeKey: 'email', revision: 1, payload: { body: 'Keep this approved message.' } });
    const first = syncCalendar(state(), bridge)!;
    const second = syncCalendar(state(2, { attendance: 300 }), bridge)!;
    const third = syncCalendar(state(3, { attendance: 300, time: '19:00' }), bridge)!;
    const jobs = bridge.listJobs();
    expect(jobs.find(job => job.id === first.id)?.status).toBe('cancelled');
    expect(jobs.find(job => job.id === second.id)?.status).toBe('cancelled');
    expect(jobs.find(job => job.id === third.id)?.status).toBe('queued');
    expect(jobs.find(job => job.id === email.id)?.status).toBe('queued');
  });

  it('preserves running updates and stages a later change without altering their payload', () => {
    const bridge = setup(); bridge.configure('calendar-demo', { calendarEventUrl: eventUrl });
    const first = syncCalendar(state(), bridge)!; bridge.claimNext('active-browser');
    const next = syncCalendar(state(2, { venue: 'New venue', venueAddress: 'New address' }), bridge)!;
    expect(next.id).not.toBe(first.id);
    expect(bridge.listJobs()[0]).toMatchObject({ status: 'running', payload: first.payload });
    expect(bridge.listJobs()[1].status).toBe('queued');
  });

  it('stages changes after completion, including returning to a previous snapshot', () => {
    const bridge = setup(); bridge.configure('calendar-demo', { calendarEventUrl: eventUrl });
    const first = syncCalendar(state(), bridge)!; bridge.claimNext('active-browser');
    bridge.complete(first.id, { detail: 'Verified the personal calendar event.', url: eventUrl });
    expect(syncCalendar(state(), bridge)?.id).toBe(first.id);
    const second = syncCalendar(state(2, { attendance: 300 }), bridge)!; bridge.claimNext('active-browser');
    bridge.complete(second.id, { detail: 'Verified the updated attendance.', url: eventUrl });
    const reverted = syncCalendar(state(3), bridge)!;
    expect(reverted.id).not.toBe(first.id); expect(reverted.status).toBe('queued');
    expect(reverted.payload.snapshotHash).toBe(first.payload.snapshotHash);
    expect(reverted.dedupeKey).not.toBe(first.dedupeKey);
  });

  it('treats changing the target URL as a change and cancels queued work on disconnect', () => {
    const bridge = setup(); bridge.configure('calendar-demo', { calendarEventUrl: eventUrl });
    const first = syncCalendar(state(), bridge)!;
    const newUrl = 'https://calendar.google.com/calendar/u/0/r/eventedit/another-event';
    bridge.configure('calendar-demo', { calendarEventUrl: newUrl });
    const next = syncCalendar(state(), bridge)!;
    expect(next.id).not.toBe(first.id); expect(next.payload.calendarEventUrl).toBe(newUrl);
    bridge.configure('calendar-demo', { calendarEventUrl: '' });
    expect(syncCalendar(state(), bridge)).toBeUndefined();
    expect(bridge.listJobs().every(job => job.status === 'cancelled')).toBe(true);
  });

  it('does not automatically retry a failed unchanged update', () => {
    const bridge = setup(); bridge.configure('calendar-demo', { calendarEventUrl: eventUrl });
    const first = syncCalendar(state(), bridge)!; bridge.fail(first.id, 'Sign-in needed.');
    expect(syncCalendar(state(), bridge)?.status).toBe('failed');
    expect(bridge.listJobs()).toHaveLength(1);
  });

  it('queues a fresh update after reconnecting an unchanged cancelled target', () => {
    const bridge = setup(); bridge.configure('calendar-demo', { calendarEventUrl: eventUrl });
    const first = syncCalendar(state(), bridge)!;
    bridge.configure('calendar-demo', { calendarEventUrl: '' });
    expect(syncCalendar(state(), bridge)).toBeUndefined();
    bridge.configure('calendar-demo', { calendarEventUrl: eventUrl });
    const resumed = syncCalendar(state(), bridge)!;
    expect(resumed.status).toBe('queued');
    expect(resumed.id).not.toBe(first.id);
    expect(resumed.dedupeKey).not.toBe(first.dedupeKey);
    expect(resumed.payload.snapshotHash).toBe(first.payload.snapshotHash);
    expect(syncCalendar(state(), bridge)?.id).toBe(resumed.id);
    expect(bridge.listJobs().map(job => job.status)).toEqual(['cancelled', 'queued']);
  });

  it('does not retry an uncertain failed update even after reconnecting', () => {
    const bridge = setup(); bridge.configure('calendar-demo', { calendarEventUrl: eventUrl });
    const first = syncCalendar(state(), bridge)!; bridge.claimNext('active-browser');
    bridge.fail(first.id, 'The browser closed before the result could be verified.');
    bridge.configure('calendar-demo', { calendarEventUrl: '' }); syncCalendar(state(), bridge);
    bridge.configure('calendar-demo', { calendarEventUrl: eventUrl });
    expect(syncCalendar(state(), bridge)).toMatchObject({ id: first.id, status: 'failed' });
    expect(bridge.listJobs()).toHaveLength(1);
  });
});
