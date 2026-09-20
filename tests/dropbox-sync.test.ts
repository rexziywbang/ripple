import { afterEach, describe, expect, it } from 'vitest';
import { buildDropboxContent, syncDropbox, type DropboxPlanState } from '../server/dropbox-sync.js';
import { createLiveBridge, type LiveBridge } from '../server/live-bridge.js';
import { initialFacts } from '../server/fixtures.js';
import type { FactPatch } from '../shared/types.js';

const folderUrl = 'https://www.dropbox.com/home/Ripple-test-event';
const bridges: LiveBridge[] = [];
function setup() { const bridge = createLiveBridge({ dbPath: ':memory:' }); bridges.push(bridge); return bridge; }
function state(revision = 1, patch: FactPatch = {}): DropboxPlanState {
  return {
    project: { id: 'dropbox-demo', name: 'Dinner', revision, createdAt: '2026-09-20T00:00:00Z', facts: { ...initialFacts, ...patch } },
    budget: { totalCents: 1596000, lines: [{ label: 'Venue', amountCents: 720000, status: 'planned', detail: 'Garden Hall' }, { label: 'Catering', amountCents: 576000, status: 'confirmed', detail: '240 guests' }] },
  };
}
afterEach(() => { for (const bridge of bridges.splice(0)) bridge.close(); });

describe('Dropbox event plan browser queue', () => {
  it('exports planning facts and budget without unrelated private state', () => {
    const input = { ...state(), emailDelivery: { account: 'private-account@example.net' }, messages: [{ body: 'private-message-canary' }], sources: [{ content: 'private-source-canary' }], ai: { secret: 'private-key-canary' } };
    const content = buildDropboxContent(input);
    for (const text of ['# Dinner', '2026-12-11', '18:00 (America/New_York)', 'Expected guests: 240', 'Garden Hall', 'Seated capacity: 260', 'USD 7200.00', 'Shah Halal', 'Confirmed in the current plan', 'USD 24.00', 'Staff: 4 people', 'USD 1800.00', 'USD 15960.00']) expect(content).toContain(text);
    for (const text of ['private-account', 'private-message-canary', 'private-source-canary', 'private-key-canary']) expect(content).not.toContain(text);
    expect(buildDropboxContent(state(2))).toBe(content);
  });

  it('labels pending venue facts and catering quotes without claiming stale terms', () => {
    const input = state(2, { venue: 'Boston Marriott Cambridge', venueDetailsPending: true, venueIncludesAV: true, caterer: 'CAVA', cateringStatus: 'awaiting_quote' });
    input.budget.lines.push({ label: 'CAVA quote', amountCents: 0, status: 'awaiting quote', detail: 'Cost unknown' });
    const content = buildDropboxContent(input);
    expect(content).toContain('Seated capacity: Needs confirmation');
    expect(content).toContain('not a quote for this venue');
    expect(content).toContain('Included AV: Needs confirmation');
    expect(content).toContain('Price per guest: Unknown');
    expect(content).toContain('| CAVA quote | Unknown | awaiting quote |');
    expect(content).toContain('Current forecast: USD 15960.00 — incomplete');
    expect(content).not.toContain('USD 24.00');
  });

  it('keeps user text from injecting report headings or table columns', () => {
    const input = state(1, { notes: '# Fabricated approval\n<script>data</script>' });
    input.budget.lines[0].detail = 'One | two\n# forged';
    const content = buildDropboxContent(input);
    expect(content).toContain('> \\# Fabricated approval');
    expect(content).toContain('&lt;script&gt;data&lt;/script&gt;');
    expect(content).toContain('One \\| two \\# forged');
  });

  it('exports matching researched capacity and AV independently while room pricing remains pending',()=>{
    const input=state(2,{venue:'Research venue',venueAddress:'10 Main Street',venueDetailsPending:true,venueCapacityPending:false,venueAVPending:false,venueCapacity:120,venueIncludesAV:true,venueCapacityEvidenceId:'venue-research:one'});
    input.sources=[{id:'venue-research:one',content:'Published room details',venueEvidence:{researchId:'one',name:'Research venue',address:'10 Main Street',eventFormat:input.project.facts.format,checkedAt:'2026-09-20',sourceUrl:'https://venue.example.org/events',capacity:{guests:120,room:'Ballroom',layout:'banquet',sourceUrl:'https://venue.example.org/events',excerpt:'Ballroom banquet capacity: 120'},av:{included:true,room:'Ballroom',items:['Microphone','Projector'],sourceUrl:'https://venue.example.org/events',excerpt:'Microphone and projector included.'}}}];
    const content=buildDropboxContent(input);expect(content).toContain('Seated capacity: 120 — Ballroom (banquet)');expect(content).toContain('Included AV: Ballroom — Microphone, Projector');expect(content).toContain('https://venue.example.org/events');expect(content).toContain('not a quote for this venue');
    input.sources[0].venueEvidence!.name='Different venue';const mismatched=buildDropboxContent(input);expect(mismatched).toContain('Seated capacity: Needs confirmation');expect(mismatched).toContain('Included AV: Needs confirmation');expect(mismatched).not.toContain('https://venue.example.org/events');
  });

  it('does nothing without a folder and only queues when configured', () => {
    const bridge = setup(); expect(syncDropbox(state(), bridge)).toBeUndefined();
    expect(bridge.listJobs()).toEqual([]);
    bridge.configure('dropbox-demo', { dropboxFolderUrl: folderUrl });
    const job = syncDropbox(state(), bridge)!;
    expect(job).toMatchObject({ provider: 'dropbox', action: 'update_file', status: 'queued', payload: { folderUrl, fileName: 'Ripple event plan.md', content: buildDropboxContent(state()) } });
    expect(job.receipt).toBeUndefined(); expect(job.workerId).toBeUndefined();
    expect(bridge.getConfig('dropbox-demo').providers.dropbox.status).toBe('configured');
  });

  it('deduplicates unchanged content and coalesces changed queued snapshots', () => {
    const bridge = setup(); bridge.configure('dropbox-demo', { dropboxFolderUrl: folderUrl });
    const other = bridge.enqueue({ projectId: 'dropbox-demo', provider: 'email', action: 'send_email', dedupeKey: 'email', revision: 1, payload: { body: 'Keep this message.' } });
    const first = syncDropbox(state(), bridge)!;
    expect(syncDropbox(state(2), bridge)?.id).toBe(first.id);
    const second = syncDropbox(state(3, { attendance: 300 }), bridge)!;
    expect(second.id).not.toBe(first.id);
    expect(bridge.listJobs().find(job => job.id === first.id)?.status).toBe('cancelled');
    expect(bridge.listJobs().find(job => job.id === other.id)?.status).toBe('queued');
    expect(bridge.listJobs().filter(job => job.provider === 'dropbox' && job.status === 'queued')).toHaveLength(1);
  });

  it('preserves running payloads while a newer report is staged', () => {
    const bridge = setup(); bridge.configure('dropbox-demo', { dropboxFolderUrl: folderUrl });
    const first = syncDropbox(state(), bridge)!; bridge.claimNext('browser');
    const next = syncDropbox(state(2, { notes: 'Updated agenda.' }), bridge)!;
    expect(bridge.listJobs()[0]).toMatchObject({ status: 'running', payload: first.payload });
    expect(next.status).toBe('queued');
    expect(next.payload.content).toContain('Updated agenda');
  });

  it('queues a new version after completion and permits a later content reversal', () => {
    const bridge = setup(); bridge.configure('dropbox-demo', { dropboxFolderUrl: folderUrl });
    const first = syncDropbox(state(), bridge)!; bridge.claimNext('browser');
    bridge.complete(first.id, { detail: 'Verified the uploaded report.', url: folderUrl });
    expect(syncDropbox(state(2), bridge)?.id).toBe(first.id);
    const second = syncDropbox(state(3, { notes: 'Updated agenda.' }), bridge)!; bridge.claimNext('browser');
    bridge.complete(second.id, { detail: 'Verified the replacement report.', url: folderUrl });
    const reverted = syncDropbox(state(4), bridge)!;
    expect(reverted.status).toBe('queued'); expect(reverted.id).not.toBe(first.id);
    expect(reverted.payload.contentHash).toBe(first.payload.contentHash);
  });

  it('detects budget-only changes and changing the configured folder', () => {
    const bridge = setup(); bridge.configure('dropbox-demo', { dropboxFolderUrl: folderUrl });
    const first = syncDropbox(state(), bridge)!;
    const revised = state(); revised.budget.totalCents = 1600000;
    const second = syncDropbox(revised, bridge)!; expect(second.id).not.toBe(first.id);
    bridge.configure('dropbox-demo', { dropboxFolderUrl: 'https://www.dropbox.com/home/Another-event' });
    const moved = syncDropbox(revised, bridge)!;
    expect(moved.id).not.toBe(second.id); expect(moved.payload.fileName).toBe(first.payload.fileName);
  });

  it('cancels on disconnect and queues fresh unchanged content after reconnect', () => {
    const bridge = setup(); bridge.configure('dropbox-demo', { dropboxFolderUrl: folderUrl });
    const first = syncDropbox(state(), bridge)!;
    bridge.configure('dropbox-demo', { dropboxFolderUrl: '' }); expect(syncDropbox(state(), bridge)).toBeUndefined();
    bridge.configure('dropbox-demo', { dropboxFolderUrl: folderUrl });
    const next = syncDropbox(state(), bridge)!;
    expect(next.status).toBe('queued'); expect(next.id).not.toBe(first.id);
    expect(syncDropbox(state(), bridge)?.id).toBe(next.id);
    expect(bridge.listJobs()[0].status).toBe('cancelled');
  });

  it('leaves uncertain failed work for reconciliation even across reconnect', () => {
    const bridge = setup(); bridge.configure('dropbox-demo', { dropboxFolderUrl: folderUrl });
    const first = syncDropbox(state(), bridge)!; bridge.claimNext('browser'); bridge.fail(first.id, 'Upload result needs verification.');
    expect(syncDropbox(state(), bridge)?.status).toBe('failed');
    bridge.configure('dropbox-demo', { dropboxFolderUrl: '' }); syncDropbox(state(), bridge);
    bridge.configure('dropbox-demo', { dropboxFolderUrl: folderUrl });
    expect(syncDropbox(state(), bridge)?.id).toBe(first.id); expect(bridge.listJobs()).toHaveLength(1);
  });
});
