import { describe, expect, it } from 'vitest';
import { calendarEventLink, calendarQueueCounts } from '../web/src/CalendarConnection';

describe('Calendar settings provenance', () => {
  it('opens only the actual configured Google Calendar origin', () => {
    expect(calendarEventLink(' https://calendar.google.com/calendar/u/0/r/eventedit/event-id ')).toBe('https://calendar.google.com/calendar/u/0/r/eventedit/event-id');
    for (const value of ['https://calendar.google.com.evil.example/event', 'http://calendar.google.com/event', 'https://user@calendar.google.com/event', 'https://calendar.google.com:8443/event', 'not a URL', '']) expect(calendarEventLink(value)).toBeUndefined();
  });
  it('reports only this project’s actual queued and running calendar work', () => {
    const jobs = [
      { projectId: 'event', provider: 'google_calendar', status: 'queued' },
      { projectId: 'event', provider: 'google_calendar', status: 'running' },
      { projectId: 'event', provider: 'google_calendar', status: 'completed' },
      { projectId: 'event', provider: 'google_calendar', status: 'cancelled' },
      { projectId: 'event', provider: 'google_calendar', status: 'failed' },
      { projectId: 'other', provider: 'google_calendar', status: 'queued' },
      { projectId: 'event', provider: 'email', status: 'queued' },
    ];
    expect(calendarQueueCounts(jobs, 'event')).toEqual({ queued: 1, running: 1 });
    expect(calendarQueueCounts(jobs, 'unknown')).toEqual({ queued: 0, running: 0 });
  });
});
