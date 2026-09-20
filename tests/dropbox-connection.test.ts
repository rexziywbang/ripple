import { describe, expect, it } from 'vitest';
import { dropboxFolderLink, dropboxFolderName, dropboxQueueCounts, dropboxSyncFeedback, manifestDownloadLink, readPlanningFiles, type PlanningFileInput } from '../web/src/DropboxConnection';

describe('Dropbox settings provenance', () => {
  it('opens only configured Dropbox origins and preserves private/shared folder paths', () => {
    expect(dropboxFolderLink(' https://www.dropbox.com/home/Ripple ')).toBe('https://www.dropbox.com/home/Ripple');
    expect(dropboxFolderLink('https://dropbox.com/scl/fo/folder-id?rlkey=share-token')).toBe('https://dropbox.com/scl/fo/folder-id?rlkey=share-token');
    for (const value of ['https://www.dropbox.com.evil.example/folder', 'http://www.dropbox.com/home/Ripple', 'https://user@dropbox.com/home/Ripple', 'https://dropbox.com:8443/home', 'javascript:alert(1)', '']) expect(dropboxFolderLink(value)).toBeUndefined();
  });
  it('counts only current project Dropbox jobs and never labels completed local work as queued', () => {
    const jobs = [
      { projectId: 'event', provider: 'dropbox', status: 'queued' },
      { projectId: 'event', provider: 'dropbox', status: 'running' },
      { projectId: 'event', provider: 'dropbox', status: 'completed' },
      { projectId: 'event', provider: 'dropbox', status: 'failed' },
      { projectId: 'event', provider: 'dropbox', status: 'cancelled' },
      { projectId: 'other', provider: 'dropbox', status: 'queued' },
      { projectId: 'event', provider: 'email', status: 'queued' },
      { projectId: 'event', provider: 'google_calendar', status: 'running' },
    ];
    expect(dropboxQueueCounts(jobs, 'event')).toEqual({ queued: 1, running: 1 });
    expect(dropboxQueueCounts(jobs, 'unknown')).toEqual({ queued: 0, running: 0 });
  });
  it('uses the saved folder name without presenting shared-link tokens as a folder name', () => {
    expect(dropboxFolderName('https://www.dropbox.com/home/Ripple%20-%20Christmas%20dinner')).toBe('Ripple - Christmas dinner');
    expect(dropboxFolderName('https://www.dropbox.com/scl/fo/opaque-token?rlkey=secret', 'Christmas dinner')).toBe('Christmas dinner');
    expect(dropboxFolderName('https://evil.example/home/Event')).toBe('Event folder');
  });
  it('limits manifest downloads to the current project and exact returned file', () => {
    const file = { id: 'file-1', path: 'Leadership brief.md', source: 'current_plan', status: 'staged', downloadUrl: '/api/projects/event/dropbox-files/file-1' };
    expect(manifestDownloadLink(file, 'event')).toBe(file.downloadUrl);
    expect(manifestDownloadLink(file, 'other')).toBeUndefined();
    expect(manifestDownloadLink({ ...file, downloadUrl: 'https://evil.example/file' }, 'event')).toBeUndefined();
  });
});

describe('selected planning file import', () => {
  function file(name: string, content = 'Event notes', overrides: Partial<PlanningFileInput> = {}): PlanningFileInput {
    return { name, size: new TextEncoder().encode(content).length, webkitRelativePath: '', text: async () => content, ...overrides };
  }
  it('preserves the selected folder paths and exact text while skipping unsupported files', async () => {
    expect(await readPlanningFiles([
      file('brief.md', '# Dinner\n90 guests', { webkitRelativePath: 'Event/brief.md' }),
      file('budget.CSV', 'line,cost\nVenue,500'),
      file('photo.png', 'image'),
    ])).toEqual({ files: [{ path: 'Event/brief.md', content: '# Dinner\n90 guests' }, { path: 'budget.CSV', content: 'line,cost\nVenue,500' }], skipped: 1 });
  });
  it('rejects an empty supported selection and files that contain binary nulls', async () => {
    await expect(readPlanningFiles([file('photo.png')])).rejects.toThrow('Markdown, text, CSV, or JSON');
    await expect(readPlanningFiles([file('notes.txt', 'text\u0000binary')])).rejects.toThrow('not a readable text file');
  });
  it('enforces count and byte limits before reading files', async () => {
    let reads = 0;
    const read = async () => { reads++; return 'text'; };
    await expect(readPlanningFiles(Array.from({ length: 31 }, (_, index) => file(`${index}.md`, '', { text: read })))).rejects.toThrow('up to 30');
    await expect(readPlanningFiles([file('large.txt', '', { size: 100_001, text: read })])).rejects.toThrow('100 KB');
    await expect(readPlanningFiles(Array.from({ length: 6 }, (_, index) => file(`${index}.md`, '', { size: 90_000, text: read })))).rejects.toThrow('500 KB');
    expect(reads).toBe(0);
  });
  it('allows the same basename in distinct folders but rejects duplicate import paths', async () => {
    const first = file('notes.md', 'one', { webkitRelativePath: 'Event/Venue/notes.md' });
    const second = file('notes.md', 'two', { webkitRelativePath: 'Event/Catering/notes.md' });
    expect((await readPlanningFiles([first, second])).files).toHaveLength(2);
    await expect(readPlanningFiles([first, { ...second, webkitRelativePath: first.webkitRelativePath }])).rejects.toThrow('same path');
  });
});


describe('Dropbox sync outcome selection', () => {
  const base = { projectId: 'event', provider: 'dropbox', action: 'update_file', revision: 1, createdAt: '2026-09-20T00:00:00Z', status: 'failed', error: 'Upload was blocked by Dropbox.' };
  it('shows a bounded real failure until newer work supersedes it', () => {
    expect(dropboxSyncFeedback([base], 'event').failure).toBe(base.error);
    expect(dropboxSyncFeedback([{ ...base, error: 'x'.repeat(300) }], 'event').failure).toHaveLength(178);
    for (const status of ['queued', 'running', 'cancelled']) {
      expect(dropboxSyncFeedback([base, { ...base, createdAt: '2026-09-20T00:01:00Z', revision: 2, status }], 'event').failure).toBeUndefined();
    }
  });
  it('requires a completion receipt and ignores unrelated jobs', () => {
    const receipt = { completedAt: '2026-09-20T00:02:00Z', detail: 'Verified report in folder.', url: 'https://www.dropbox.com/home/Ripple' };
    expect(dropboxSyncFeedback([{ ...base, status: 'completed' }], 'event').receipt).toBeUndefined();
    expect(dropboxSyncFeedback([{ ...base, status: 'completed', receipt }], 'event')).toEqual({ failure: undefined, receipt });
    expect(dropboxSyncFeedback([{ ...base, projectId: 'other' }, { ...base, provider: 'email' }], 'event').failure).toBeUndefined();
  });
});
