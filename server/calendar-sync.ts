import { createHash } from 'node:crypto';
import type { ProjectState } from '../shared/types.js';
import type { LiveBridge, LiveJob } from './live-bridge.js';

export type CalendarSnapshot = {
  name: string;
  date: string;
  time: string;
  timezone: string;
  venue: string;
  venueAddress: string;
  attendance: number;
};

/** Exact personal-event fields only: no attendees, recipients, or inferred duration. */
export function buildCalendarSnapshot(state: Pick<ProjectState, 'project'>): CalendarSnapshot {
  const { name, facts } = state.project;
  return {
    name, date: facts.date, time: facts.time, timezone: facts.timezone,
    venue: facts.venue, venueAddress: facts.venueAddress, attendance: facts.attendance,
  };
}

/**
 * Stage the current personal calendar update. The caller supplies active projects only.
 * An authenticated browser worker must execute and verify it before recording completion.
 */
export function syncCalendar(state: Pick<ProjectState, 'project'>, bridge: LiveBridge): LiveJob | undefined {
  const projectId = state.project.id;
  const calendarEventUrl = bridge.getConfig(projectId).calendarEventUrl;
  const previous = bridge.listJobs(projectId).filter(job => job.provider === 'google_calendar' && job.action === 'update_event');
  if (!calendarEventUrl) {
    // Disconnecting must not leave an unclaimed update ready for a later executor.
    for (const job of previous) if (job.status === 'queued') bridge.cancel(job.id);
    return undefined;
  }

  const snapshot = buildCalendarSnapshot(state);
  const snapshotHash = createHash('sha256').update(JSON.stringify({ calendarEventUrl, snapshot })).digest('hex');
  const latest = previous.at(-1);
  if (latest?.payload.snapshotHash === snapshotHash && latest.status !== 'cancelled') {
    for (const job of previous) if (job.id !== latest.id && job.status === 'queued') bridge.cancel(job.id);
    // A failed attempt requires reconciliation; polling is not a retry.
    return latest;
  }

  const next = bridge.enqueue({
    projectId, provider: 'google_calendar', action: 'update_event', revision: state.project.revision,
    // The predecessor makes A -> B -> A and reconnecting a cancelled queue new
    // updates while unchanged polls dedupe. Cancelled work was never executed.
    dedupeKey: `calendar:${snapshotHash}:${latest?.id ?? 'initial'}`,
    payload: { calendarEventUrl, snapshot, snapshotHash, personalCalendarOnly: true, notifyGuests: false },
  });
  for (const job of previous) if (job.status === 'queued') bridge.cancel(job.id);
  // Running jobs keep their immutable payload and must be reconciled by their worker.
  return next;
}
