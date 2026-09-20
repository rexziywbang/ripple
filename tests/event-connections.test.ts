import { describe, expect, it } from 'vitest';
import { connectionRows } from '../web/src/EventConnections';

describe('event connection overview', () => {
  it('makes rehearsal email ready without claiming a linked account or delivery', () => {
    const rows = connectionRows({ mailMode: 'rehearsal' });
    expect(rows.find(row => row.id === 'email')).toMatchObject({ status: 'Ready locally', url: undefined });
    expect(rows.filter(row => row.status === 'Linked')).toHaveLength(0);
  });
  it('uses only configured saved destinations for external links', () => {
    const rows = connectionRows({ mailMode: 'live', calendarEventUrl: 'https://calendar.google.com/calendar/event?eid=existing', providers: { google_calendar: { status: 'configured' } } });
    expect(rows.find(row => row.id === 'google_calendar')).toMatchObject({ status: 'Linked', url: 'https://calendar.google.com/calendar/event?eid=existing' });
    expect(rows.find(row => row.id === 'email')?.status).toBe('Not linked');
  });
  it('requires a saved destination or account as well as configured status', () => {
    const rows = connectionRows({ providers: { email: { status: 'configured' }, dropbox: { status: 'configured' } } });
    expect(rows.find(row => row.id === 'email')).toMatchObject({ status: 'Not linked', url: undefined });
    expect(rows.find(row => row.id === 'dropbox')).toMatchObject({ status: 'Not linked', url: undefined });
    expect(connectionRows({ emailAccount: 'planner@example.com', providers: { email: { status: 'configured' } } }).find(row => row.id === 'email')).toMatchObject({ status: 'Linked', url: undefined });
    expect(connectionRows({ dropboxFolderUrl: 'https://www.dropbox.com/home/Event' }).find(row => row.id === 'dropbox')?.status).toBe('Not linked');
  });
  it('does not open malformed or unrelated stored links', () => {
    for (const url of ['javascript:alert(1)', 'https://evil.example/event', 'https://partiful.com.evil.example/event', 'https://secret@partiful.com/event', 'http://partiful.com/event']) {
      const row = connectionRows({ partifulEventUrl: url, providers: { partiful: { status: 'configured' } } }).find(row => row.id === 'partiful');
      expect(row?.url).toBeUndefined();
      expect(row?.status).toBe('Not linked');
    }
  });
});
