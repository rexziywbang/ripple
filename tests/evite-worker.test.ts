import express from 'express';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectState, Proposal } from '../shared/types.js';
import { createLiveBridge, type LiveJob } from '../server/live-bridge.js';
import { syncInvitations } from '../server/invitation-sync.js';
import { createEviteWorkerRouter, EVITE_WORKER, eviteInvitationId } from '../server/evite-worker.js';

const eventUrl = 'https://www.evite.com/invitation/abc123/preview';
const snapshot = { name: 'Winter dinner', date: '2026-12-11', time: '18:00', timezone: 'America/New_York', venue: 'River Hall', venueAddress: '20 River Street', caterer: '', dietary: 'Vegetarian options are available', format: 'Dinner' };
const cleanups: (() => Promise<void>)[] = [];
async function setup() {
  const bridge = createLiveBridge({ dbPath: ':memory:' });
  bridge.configure('event', { eviteEventUrl: eventUrl.replace('/preview', '/customize'), emailDelivery: 'live' });
  const proposal = { id: 'approved', kind: 'invitation', status: 'applied', version: 1, createdAt: '2026-09-20T12:00:00Z', invitationSnapshot: { ...snapshot } } as Proposal;
  const state = { project: { id: 'event' }, projects: [{ id: 'event' }], proposals: [proposal] } as unknown as ProjectState;
  const app = express(); app.use(express.json()); app.use(createEviteWorkerRouter(bridge, () => state));
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(400).json({ error: error.message }); });
  const server = await new Promise<Server>(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
  const post = (path: string, patch: Record<string, unknown> = {}) => fetch(`http://127.0.0.1:${address.port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workerId: EVITE_WORKER, eventUrl, ...patch }) });
  const queue = () => syncInvitations(state, bridge)[0];
  const evidence = (job: LiveJob) => ({ title: snapshot.name, location: `${snapshot.venue} ${snapshot.venueAddress} Location`, description: job.payload.description, reloaded: true });
  cleanups.push(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); bridge.close(); });
  return { bridge, proposal, state, post, queue, evidence };
}
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

describe('approved Evite metadata worker', () => {
  it('recognizes only secure Evite invitation identities', () => {
    expect(eviteInvitationId(eventUrl + '?source=editor#review')).toBe('abc123');
    for (const url of ['http://www.evite.com/invitation/abc123/preview', 'https://evil.example/invitation/abc123/preview', 'https://www.evite.com.evil.example/invitation/abc123/preview', 'https://user:password@www.evite.com/invitation/abc123/preview', 'https://www.evite.com:8080/invitation/abc123/preview', 'https://www.evite.com/invitation/abc123/guests']) expect(eviteInvitationId(url)).toBeUndefined();
  });

  it('claims only current applied metadata for the configured event and never reclaims it', async () => {
    const ctx = await setup();
    const unrelated = ctx.bridge.enqueue({ projectId: 'event', provider: 'google_calendar', action: 'update_event', dedupeKey: 'calendar', revision: 1, payload: {} });
    const job = ctx.queue();
    expect(await (await ctx.post('/claim', { eventUrl: eventUrl.replace('abc123', 'other') })).json()).toBeNull();
    expect(await (await ctx.post('/claim', { eventUrl: eventUrl.replace('/preview', '/send') })).json()).toBeNull();
    expect(await (await ctx.post('/claim')).json()).toMatchObject({ id: job.id, workerId: EVITE_WORKER, status: 'running' });
    expect(await (await ctx.post('/claim')).json()).toBeNull();
    expect(ctx.bridge.listJobs().find(value => value.id === unrelated.id)?.status).toBe('queued');
  });

  it('does not claim malformed metadata, injected copy, or notification jobs', async () => {
    const ctx = await setup(); const valid = ctx.queue(); ctx.bridge.cancel(valid.id);
    for (const [index, patch] of [{ description: 'Unapproved replacement' }, { notifyGuests: true }, { metadataOnly: false }, { snapshot: { ...snapshot, venue: '' } }, { snapshot: { ...snapshot, guestEmails: ['private@example.test'] } }].entries()) {
      ctx.bridge.enqueue({ projectId: 'event', provider: 'evite', action: 'update_event', revision: 1, dedupeKey: `bad-${index}`, payload: { ...valid.payload, ...patch } });
    }
    expect(await (await ctx.post('/claim')).json()).toBeNull();
    expect(ctx.bridge.listJobs().every(job => !job.receipt)).toBe(true);
  });

  it('rechecks revoked approval before save and before a completion receipt', async () => {
    const ctx = await setup(); const job = ctx.queue(); await ctx.post('/claim');
    expect((await ctx.post(`/jobs/${job.id}/before-save`)).status).toBe(200);
    ctx.proposal.invitationSnapshotRevoked = true;
    expect((await ctx.post(`/jobs/${job.id}/before-save`)).status).toBe(409);
    expect((await ctx.post(`/jobs/${job.id}/complete`, ctx.evidence(job))).status).toBe(400);
    expect(ctx.bridge.listJobs()[0]).toMatchObject({ status: 'running' });
    expect(ctx.bridge.listJobs()[0].receipt).toBeUndefined();
  });

  it('rejects wrong or unreloaded field evidence without claiming dates or delivery', async () => {
    const ctx = await setup(); const job = ctx.queue(); await ctx.post('/claim'); const evidence = ctx.evidence(job);
    for (const patch of [{ title: 'Another event' }, { location: 'Not River Hall' }, { location: 'River Hallway' }, { description: 'Unsaved text' }, { reloaded: false }, { eventUrl: eventUrl.replace('/preview', '/send') }, { workerId: 'different-worker' }]) {
      expect((await ctx.post(`/jobs/${job.id}/complete`, { ...evidence, ...patch })).status).toBe(400);
      expect(ctx.bridge.listJobs()[0].receipt).toBeUndefined();
    }
    expect((await ctx.post(`/jobs/${job.id}/complete`, evidence)).status).toBe(200);
    const first = ctx.bridge.listJobs()[0];
    expect(first.receipt?.detail).toBe('Reloaded Evite and verified the saved event title, venue, and description.');
    expect((await ctx.post(`/jobs/${job.id}/complete`, evidence)).status).toBe(200);
    expect(ctx.bridge.listJobs()[0].receipt).toEqual(first.receipt);
  });

  it('cannot complete unknown, failed, cancelled, or foreign-worker jobs', async () => {
    const ctx = await setup(); const job = ctx.queue(); const evidence = ctx.evidence(job);
    expect((await ctx.post('/jobs/missing/complete', evidence)).status).toBe(400);
    expect((await ctx.post(`/jobs/${job.id}/complete`, evidence)).status).toBe(400);
    ctx.bridge.claimById(job.id, 'other-worker');
    expect((await ctx.post(`/jobs/${job.id}/complete`, evidence)).status).toBe(400);
    expect(ctx.bridge.listJobs()[0].receipt).toBeUndefined();
    for (const status of ['cancelled', 'failed'] as const) {
      const other = await setup(); const blocked = other.queue();
      if (status === 'cancelled') other.bridge.cancel(blocked.id);
      else { other.bridge.claimById(blocked.id, EVITE_WORKER); other.bridge.fail(blocked.id, 'Uncertain save'); }
      expect((await other.post(`/jobs/${blocked.id}/complete`, other.evidence(blocked))).status).toBe(400);
      expect(other.bridge.listJobs()[0].receipt).toBeUndefined();
    }
  });

  it('stops when the project is archived, disconnected, or switched to rehearsal', async () => {
    const ctx = await setup(); ctx.queue();
    ctx.bridge.configure('event', { emailDelivery: 'rehearsal' });
    expect(await (await ctx.post('/claim')).json()).toBeNull();
    ctx.bridge.configure('event', { emailDelivery: 'live', eviteEventUrl: '' });
    expect(await (await ctx.post('/claim')).json()).toBeNull();
    ctx.bridge.configure('event', { eviteEventUrl: eventUrl }); ctx.state.projects = [];
    expect(await (await ctx.post('/claim')).json()).toBeNull();
  });
});
