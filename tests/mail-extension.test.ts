import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { mkdtempSync, readdirSync, statSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectState } from '../shared/types.js';
import { createLiveBridge } from '../server/live-bridge.js';
import { createMailExtensionRouter, loadMailExtensionToken, MAIL_EXTENSION_WORKER } from '../server/mail-extension.js';
import { writeGuestInvitation } from '../shared/invitation-copy.js';

const cleanups: (() => Promise<void>)[] = [];
const account = 'ripple-worker-test@gmail.com';
const extensionOrigin = `chrome-extension://${'a'.repeat(32)}`;
async function setup(sendingEnabled?: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'ripple-mail-worker-'));
  const bridge = createLiveBridge({ dbPath: ':memory:' });
  const proposal = { id: 'approved-email', kind: 'email', status: 'approved', version: 4 };
  const state = { proposals: [proposal] } as unknown as ProjectState;
  const app = express(); let reconciliations = 0;
  app.use('/api/mail-worker', createMailExtensionRouter({ bridge, dataDir: dir, getState: () => state, reconcile: () => { reconciliations++; }, sendingEnabled }));
  const server = await new Promise<Server>(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing test listener');
  const base = `http://127.0.0.1:${address.port}/api/mail-worker`;
  const token = loadMailExtensionToken(dir);
  const post = (path: string, payload: object = {}, headers: Record<string,string> = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, Origin: extensionOrigin, ...headers }, body: JSON.stringify({ workerId: MAIL_EXTENSION_WORKER, account, ...payload }) });
  const enqueue = (payload: object = {}) => bridge.enqueue({ projectId: 'event', provider: 'email', action: 'send_email', dedupeKey: 'approved-v4', revision: 4, payload: { proposalId: proposal.id, account, recipient: account, subject: 'Catering quote request', body: 'Please send a quote for our event.', ...payload } });
  cleanups.push(async () => { await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())); bridge.close(); for (const file of readdirSync(dir)) unlinkSync(join(dir,file)); rmdirSync(dir); });
  return { dir, base, token, bridge, state, proposal, post, enqueue, get reconciliations() { return reconciliations; } };
}
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

describe('paired local Gmail worker', () => {
  it('persists a private pairing token and keeps it off untrusted origins', async () => {
    const ctx = await setup();
    expect(loadMailExtensionToken(ctx.dir)).toBe(ctx.token);
    expect(statSync(join(ctx.dir,'mail-extension-token')).mode & 0o777).toBe(0o600);
    expect((await fetch(ctx.base+'/pairing', { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    expect((await fetch(ctx.base+'/pairing', { headers: { Origin: extensionOrigin } })).status).toBe(403);
    expect((await fetch(ctx.base+'/pairing', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
    const local = await fetch(ctx.base+'/pairing', { headers: { Origin: 'http://127.0.0.1:5173' } });
    expect(await local.json()).toMatchObject({ token: ctx.token, selfInboxOnly: false, demoRecipient: 'rexziyw@gmail.com' });
  });
  it('requires the capability token and rejects hostile origins and malformed tokens', async () => {
    const ctx = await setup(); ctx.enqueue();
    expect((await ctx.post('/claim', {}, { Authorization: '' })).status).toBe(401);
    expect((await ctx.post('/claim', {}, { Authorization: `Bearer ${'x'.repeat(64)}` })).status).toBe(401);
    expect((await ctx.post('/claim', {}, { Origin: 'https://mail.google.com' })).status).toBe(403);
    expect(ctx.bridge.listJobs()[0].status).toBe('queued');
  });
  it('claims only approved email and never reclaims a running job', async () => {
    const ctx = await setup();
    const calendar = ctx.bridge.enqueue({ projectId: 'event', provider: 'google_calendar', action: 'update_event', dedupeKey: 'calendar', revision: 1, payload: { name: 'Event' } });
    const email = ctx.enqueue();
    const response = await ctx.post('/claim'); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: email.id, status: 'running', workerId: MAIL_EXTENSION_WORKER });
    expect(await (await ctx.post('/claim')).json()).toBeNull();
    expect(ctx.bridge.claimNext('manual-calendar')?.id).toBe(calendar.id);
  });
  it('rejects another Gmail account or outside recipients before claiming', async () => {
    const ctx = await setup(); ctx.enqueue({ recipient: 'vendor@realcompany.com' });
    expect((await ctx.post('/claim')).status).toBe(400);
    expect((await ctx.post('/claim', { account: 'other@gmail.com' })).status).toBe(400);
    expect(ctx.bridge.listJobs()[0].status).toBe('queued');
  });
  it('allows the approved demo recipient only when configured for the same sending account', async () => {
    const ctx = await setup();
    ctx.enqueue({ recipient: 'rexziyw@gmail.com' });
    expect((await ctx.post('/claim')).status).toBe(400);
    ctx.bridge.configure('event', { emailAccount: account, testRecipient: 'rexziyw@gmail.com' });
    expect((await ctx.post('/claim')).status).toBe(200);
  });
  it('rechecks the exact approval immediately before sending', async () => {
    const ctx = await setup(); const job = ctx.enqueue(); await ctx.post('/claim');
    expect(await (await ctx.post(`/jobs/${job.id}/before-send`)).json()).toMatchObject({ allowed: true });
    ctx.proposal.status = 'stale';
    expect((await ctx.post(`/jobs/${job.id}/before-send`)).status).toBe(409);
    expect(ctx.bridge.listJobs()[0].receipt).toBeUndefined();
    expect(ctx.reconciliations).toBe(3);
  });
  it('requires matching visible confirmation and stores an idempotent receipt', async () => {
    const ctx = await setup(); const job = ctx.enqueue(); await ctx.post('/claim');
    const evidence = { detail: 'A new Gmail Message sent confirmation appeared.', url: 'https://mail.google.com/mail/u/0/#sent', verification: { method: 'gmail_sent_confirmation', subject: 'Catering quote request', recipient: account } };
    expect((await ctx.post(`/jobs/${job.id}/complete`, { ...evidence, verification: { ...evidence.verification, subject: 'Wrong subject' } })).status).toBe(400);
    expect(ctx.bridge.listJobs()[0].status).toBe('running');
    expect((await ctx.post(`/jobs/${job.id}/complete`, evidence)).status).toBe(200);
    expect((await ctx.post(`/jobs/${job.id}/complete`, evidence)).status).toBe(200);
    expect(ctx.bridge.listJobs()[0].status).toBe('completed');
  });
  it('cannot complete unknown jobs or jobs owned by another worker', async () => {
    const ctx = await setup(); const job = ctx.enqueue(); ctx.bridge.claimNext('codex-manual');
    expect((await ctx.post(`/jobs/${job.id}/before-send`)).status).toBe(400);
    expect((await ctx.post('/jobs/missing/fail', { error: 'No confirmation.' })).status).toBe(400);
    expect(ctx.bridge.listJobs()[0].status).toBe('running');
  });
  it('records uncertain outcomes without retrying them', async () => {
    const ctx = await setup(); const job = ctx.enqueue(); await ctx.post('/claim');
    expect((await ctx.post(`/jobs/${job.id}/fail`, { error: 'Send was clicked but no confirmation was observed. Check Sent before any retry.' })).status).toBe(200);
    expect(ctx.bridge.listJobs()[0]).toMatchObject({ status: 'failed' });
    expect(ctx.bridge.listJobs()[0].receipt).toBeUndefined();
    expect(await (await ctx.post('/claim')).json()).toBeNull();
  });

  it('leaves approved email queued when extension sending is disabled', async () => {
    const ctx = await setup(false); const job = ctx.enqueue();
    expect(await (await ctx.post('/status')).json()).toMatchObject({ ready: true, sendingEnabled: false, sendingProvider: 'gmail_api' });
    expect(await (await ctx.post('/claim')).json()).toBeNull();
    expect(ctx.bridge.listJobs()[0]).toMatchObject({ id: job.id, status: 'queued' });
    expect(ctx.bridge.listJobs()[0].workerId).toBeUndefined();
    expect(ctx.reconciliations).toBe(0);
  });

  it('blocks the final send check but still records an already attempted send', async () => {
    const ctx = await setup(false); const job = ctx.enqueue();
    ctx.bridge.claimById(job.id, MAIL_EXTENSION_WORKER);
    const response = await ctx.post(`/jobs/${job.id}/before-send`);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('Gmail API') });
    expect(ctx.bridge.listJobs()[0].status).toBe('running');
    const evidence = { detail: 'Gmail confirmed the earlier send.', verification: { method: 'gmail_sent_confirmation', subject: 'Catering quote request', recipient: account } };
    expect((await ctx.post(`/jobs/${job.id}/complete`, evidence)).status).toBe(200);
    expect(ctx.bridge.listJobs()[0].status).toBe('completed');
  });

  it('keeps approved Evite metadata claims available when email sending is disabled', async () => {
    const ctx = await setup(false);
    const eventUrl = 'https://www.evite.com/invitation/Approved123/preview';
    const snapshot = { name: 'Dinner', date: '2026-12-11', time: '18:00', timezone: 'America/New_York', venue: 'Cambridge room', venueAddress: '1 Main Street', caterer: '', dietary: '', format: 'Seated dinner' };
    ctx.bridge.configure('event', { emailDelivery: 'live', eviteEventUrl: eventUrl });
    ctx.state.projects = [{ id: 'event' }] as ProjectState['projects'];
    ctx.state.proposals.push({ id: 'invitation', kind: 'invitation', status: 'applied', version: 4, createdAt: '2026-09-20T10:00:00Z', invitationSnapshot: snapshot } as ProjectState['proposals'][number]);
    const job = ctx.bridge.enqueue({ projectId: 'event', provider: 'evite', action: 'update_event', dedupeKey: 'approved-invitation', revision: 4, payload: { eventUrl, snapshot, proposalId: 'invitation', description: writeGuestInvitation(snapshot), metadataOnly: true, notifyGuests: false } });
    const response = await fetch(ctx.base + '/evite/claim', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}`, Origin: extensionOrigin }, body: JSON.stringify({ workerId: 'ripple-evite-extension', eventUrl }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: job.id, status: 'running', workerId: 'ripple-evite-extension' });
  });
});
