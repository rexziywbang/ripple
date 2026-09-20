import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import express from 'express';
import { OAuth2Client, type GenerateAuthUrlOpts } from 'google-auth-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGmailApi, GMAIL_API_WORKER, GMAIL_CALLBACK, gmailRawMessage } from '../server/gmail-api.js';
import { createLiveBridge } from '../server/live-bridge.js';
import { createService, fallbackPlan } from '../server/domain.js';
import type { ProjectState } from '../shared/types.js';

const account = 'ripple-api-test@gmail.com';
const env = { GOOGLE_CLIENT_ID: 'test.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'test-secret' };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks(); });

async function setup(connect = true) {
  const dir = mkdtempSync(join(tmpdir(), 'ripple-gmail-api-'));
  const bridge = createLiveBridge({ dbPath: ':memory:' });
  bridge.configure('event', { emailDelivery: 'live', emailAccount: account, testRecipient: 'rexziyw@gmail.com' });
  const proposal = { id: 'approved-email', kind: 'email', status: 'approved', version: 4, title: 'Quote request', subject: 'Event — quote request', body: 'Please send a quote for 200 guests.' };
  const state = { project: { id: 'event' }, projects: [{ id: 'event' }], proposals: [proposal] } as unknown as ProjectState;
  let domain: ReturnType<typeof createService> | undefined;
  const generated: Array<Record<string, unknown>> = [];
  let clock = Date.now(), identityEmail = account, identityVerified = true, nonceValid = true;
  const official = new OAuth2Client({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, redirectUri: GMAIL_CALLBACK });
  const getToken = vi.fn(async (_input?: unknown) => ({ tokens: { access_token: 'private-access', refresh_token: 'private-refresh', id_token: 'private-id', scope: 'openid email https://www.googleapis.com/auth/gmail.send' } }));
  const verify = vi.fn(async (_input?: unknown) => ({ getPayload: () => ({ sub: 'google-subject', email: identityEmail, email_verified: identityVerified, nonce: nonceValid ? generated.at(-1)?.nonce : 'wrong' }) }));
  const access = vi.fn(async () => ({ token: 'private-access' }));
  const oauthFactory = () => Object.assign(new EventEmitter(), {
    setCredentials: vi.fn(), generateCodeVerifierAsync: () => official.generateCodeVerifierAsync(),
    generateAuthUrl: (options: GenerateAuthUrlOpts) => { generated.push(options); return official.generateAuthUrl(options); },
    getToken, verifyIdToken: verify, getAccessToken: access,
  }) as unknown as OAuth2Client;
  const send = vi.fn(async (_url: string | URL | Request, _options?: RequestInit) => new Response(JSON.stringify({ id: 'gmail_message_123' }), { status: 200 }));
  const reconcile = vi.fn(() => domain?.reconcileBridge());
  const options = { dataDir: dir, bridge, getState: (projectId: string) => domain?.getState(projectId) ?? state, reconcile, env, oauthFactory, fetch: send as typeof fetch, now: () => clock };
  let api = createGmailApi(options);
  const app = express(); app.use('/api/gmail', (req, res, next) => api.router(req, res, next));
  const server = await new Promise<Server>(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing listener');
  const base = `http://127.0.0.1:${address.port}/api/gmail`;
  const start = async () => {
    const response = await fetch(base + '/connect', { method: 'POST', headers: { Origin: 'http://127.0.0.1:5173' } });
    const body = await response.json();
    return { response, body, cookie: response.headers.get('set-cookie')!.split(';')[0], state: new URL(body.url).searchParams.get('state')! };
  };
  const callback = (session: { cookie: string; state: string }, cookie = session.cookie) => fetch(`${base}/callback?code=test-code&state=${session.state}`, { headers: { Cookie: cookie } });
  const enqueue = (payload: Record<string, unknown> = {}, dedupeKey = 'approved-v4') => bridge.enqueue({ projectId: 'event', provider: 'email', action: 'send_email', dedupeKey, revision: 4, payload: { proposalId: proposal.id, account, recipient: 'rexziyw@gmail.com', subject: proposal.subject, body: proposal.body, ...payload } });
  cleanups.push(async () => { api.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); domain?.close(); bridge.close(); for (const name of readdirSync(dir)) unlinkSync(join(dir, name)); rmdirSync(dir); });
  if (connect) expect((await callback(await start())).status).toBe(200);
  return { dir, base, bridge, state, proposal, generated, getToken, verify, access, send, reconcile, start, callback, enqueue,
    get api() { return api; },
    useDomain(service: ReturnType<typeof createService>) { domain = service; },
    restart() { api.close(); api = createGmailApi(options); },
    advance(ms: number) { clock += ms; },
    identity(value: { email?: string; verified?: boolean; nonceValid?: boolean }) { identityEmail = value.email ?? identityEmail; identityVerified = value.verified ?? identityVerified; nonceValid = value.nonceValid ?? nonceValid; },
  };
}

describe('official Gmail API transport', () => {
  it('requests only send and identity scopes with browser-bound single-use state and PKCE', async () => {
    const c = await setup(false); const session = await c.start();
    const url = new URL(session.body.url);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('redirect_uri')).toBe(GMAIL_CALLBACK);
    expect(url.searchParams.get('scope')?.split(' ')).toEqual(['https://www.googleapis.com/auth/gmail.send', 'openid', 'email']);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(session.response.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Lax/);
    expect((await c.callback(session)).status).toBe(200);
    expect(c.getToken).toHaveBeenCalledWith(expect.objectContaining({ codeVerifier: expect.any(String), redirect_uri: GMAIL_CALLBACK }));
    expect(c.verify).toHaveBeenCalledWith({ idToken: 'private-id', audience: env.GOOGLE_CLIENT_ID });
    expect((await c.callback(session)).status).toBe(400);
    expect(c.getToken).toHaveBeenCalledTimes(1);
    expect(c.api.status()).toMatchObject({ configured: true, connected: true, account });
    expect(JSON.stringify(c.api.status())).not.toMatch(/private-|test-secret/);
    expect(statSync(join(c.dir, 'gmail-oauth.json')).mode & 0o777).toBe(0o600);
  });

  it('rejects hostile connect origins, unknown state, wrong browser cookies, and expired state', async () => {
    const c = await setup(false);
    expect((await fetch(c.base + '/connect', { method: 'POST', headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    expect((await c.callback({ state: 'missing', cookie: 'ripple_gmail_oauth=' + 'a'.repeat(64) })).status).toBe(400);
    expect((await c.callback(await c.start(), 'ripple_gmail_oauth=' + 'b'.repeat(64))).status).toBe(400);
    const expired = await c.start(); c.advance(600001);
    expect((await c.callback(expired)).status).toBe(400);
    expect(c.getToken).not.toHaveBeenCalled(); expect(c.api.status().connected).toBe(false);
  });

  it.each([{ verified: false }, { nonceValid: false }])('rejects an unverified OAuth identity %j', async identity => {
    const c = await setup(false); c.identity(identity);
    expect((await c.callback(await c.start())).status).toBe(400);
    expect(c.api.status().connected).toBe(false);
  });

  it.each(['pending', 'denied', 'stale', 'withdrawn'])('does not send a %s proposal', async status => {
    const c = await setup(); c.proposal.status = status; const job = c.enqueue();
    await c.api.tick();
    expect(c.send).not.toHaveBeenCalled(); expect(c.bridge.listJobs()[0]).toMatchObject({ id: job.id, status: 'queued' });
  });

  it('skips wrong account, recipient, revision, archived project, rehearsal, and altered draft', async () => {
    const c = await setup();
    c.enqueue({ account: 'other@gmail.com' }, 'account');
    c.enqueue({ recipient: 'unapproved@gmail.com' }, 'recipient');
    c.enqueue({ body: 'A different email' }, 'body');
    await c.api.tick(); expect(c.send).not.toHaveBeenCalled();
    const valid = c.enqueue({}, 'valid');
    c.state.projects = []; await c.api.tick(); expect(c.send).not.toHaveBeenCalled();
    c.state.projects = [{ id: 'event' }] as ProjectState['projects'];
    c.bridge.configure('event', { emailDelivery: 'rehearsal' }); await c.api.tick(); expect(c.send).not.toHaveBeenCalled();
    c.bridge.configure('event', { emailDelivery: 'live' }); c.proposal.version = 5;
    await c.api.tick(); expect(c.send).not.toHaveBeenCalled();
    expect(c.bridge.listJobs().find(job => job.id === valid.id)?.status).toBe('queued');
  });

  it('claims once, sends exactly once, and records the returned message ID without claiming recipient delivery', async () => {
    const c = await setup(); const job = c.enqueue();
    await Promise.all([c.api.tick(), c.api.tick()]); await c.api.tick(); c.restart(); await c.api.tick();
    expect(c.send).toHaveBeenCalledTimes(1);
    expect(c.send).toHaveBeenCalledWith('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', expect.objectContaining({ method: 'POST', redirect: 'error' }));
    expect(c.bridge.listJobs()[0]).toMatchObject({ id: job.id, status: 'completed', workerId: GMAIL_API_WORKER, receipt: { externalId: 'gmail_message_123', detail: expect.stringContaining('Recipient delivery is not verified') } });
    expect(c.reconcile).toHaveBeenCalled();
    expect(statSync(join(c.dir, 'gmail-send-journal.json')).mode & 0o777).toBe(0o600);
  });

  it('sends a real hydrated approved domain draft and reconciles it as Gmail API exactly once', async () => {
    const c = await setup();
    const service = createService({ dbPath: ':memory:', bridge: c.bridge, mailMode: 'live', planner: async input => fallbackPlan(input), aiStatus: () => ({ mode: 'demo', model: 'fixture', fallbackModel: 'fixture', estimatedSpendUsd: 0, spendLimitUsd: 8 }) });
    c.useDomain(service);
    const projectId = service.getState().project.id;
    c.bridge.configure(projectId, { emailDelivery: 'live', emailAccount: account, testRecipient: 'rexziyw@gmail.com' });
    service.edit(projectId, { area: 'guests', patch: { attendance: 200 } }); await service.tick();
    const draft = service.getState(projectId).proposals.find(proposal => proposal.kind === 'email' && proposal.area === 'catering' && proposal.status === 'pending')!;
    expect(draft.approvalToken).toBeTruthy();
    service.decide(projectId, draft.id, 'approve', draft.approvalToken); await service.tick();
    const queued = c.bridge.listJobs(projectId).find(job => job.payload.proposalId === draft.id)!;
    expect(queued).toMatchObject({ status: 'queued', payload: { account, recipient: 'rexziyw@gmail.com', subject: draft.subject, body: draft.body } });
    expect(service.getState(projectId).receipts.some(receipt => receipt.proposalId === draft.id)).toBe(false);

    await c.api.tick(); await c.api.tick(); service.reconcileBridge();
    expect(c.send).toHaveBeenCalledTimes(1);
    expect(c.bridge.listJobs(projectId).find(job => job.id === queued.id)).toMatchObject({ status: 'completed', workerId: GMAIL_API_WORKER });
    const final = service.getState(projectId);
    expect(final.proposals.find(proposal => proposal.id === draft.id)?.status).toBe('applied');
    expect(final.receipts.filter(receipt => receipt.proposalId === draft.id)).toEqual([expect.objectContaining({ provider: 'Gmail API', externalId: 'gmail_message_123', detail: expect.stringContaining('Recipient delivery is not verified') })]);
    expect(final.messages.filter(message => message.direction === 'outbound' && message.subject === draft.subject)).toEqual([expect.objectContaining({ body: draft.body, simulated: false, from: 'rexziyw@gmail.com' })]);
  });

  it('rechecks approval after token refresh and loses gracefully to the extension claim', async () => {
    const c = await setup(); const job = c.enqueue();
    c.access.mockImplementationOnce(async () => { c.proposal.status = 'stale'; return { token: 'private-access' }; });
    await c.api.tick(); expect(c.send).not.toHaveBeenCalled();
    c.proposal.status = 'approved';
    c.access.mockImplementationOnce(async () => { c.bridge.claimById(job.id, 'ripple-mail-extension'); return { token: 'private-access' }; });
    await c.api.tick(); expect(c.send).not.toHaveBeenCalled();
    expect(c.bridge.listJobs()[0].workerId).toBe('ripple-mail-extension');
  });

  it('never retries a timeout or ambiguous response, including after restart', async () => {
    const c = await setup(); const job = c.enqueue();
    c.send.mockRejectedValueOnce(new DOMException('Timed out', 'TimeoutError'));
    await c.api.tick(); await c.api.tick(); c.restart(); await c.api.tick();
    expect(c.send).toHaveBeenCalledTimes(1);
    expect(c.bridge.listJobs()[0]).toMatchObject({ id: job.id, status: 'failed', error: expect.stringContaining('may have been sent') });
    expect(c.bridge.listJobs()[0].receipt).toBeUndefined(); expect(c.api.status().needsAttention).toBe(true);
  });

  it('recovers the receipt after an accepted send without submitting the message again', async () => {
    const c = await setup(); c.enqueue();
    const complete = vi.spyOn(c.bridge, 'complete'); complete.mockImplementationOnce(() => { throw new Error('Local database temporarily busy'); });
    await c.api.tick(); expect(c.bridge.listJobs()[0].status).toBe('running');
    expect(JSON.parse(readFileSync(join(c.dir, 'gmail-send-journal.json'), 'utf8'))[c.bridge.listJobs()[0].id].phase).toBe('sent');
    c.restart(); await c.api.tick();
    expect(c.send).toHaveBeenCalledTimes(1); expect(c.bridge.listJobs()[0].status).toBe('completed');
  });

  it('marks a crash after claiming as uncertain instead of replaying it', async () => {
    const c = await setup(); const job = c.enqueue(); c.bridge.claimById(job.id, GMAIL_API_WORKER);
    writeFileSync(join(c.dir, 'gmail-send-journal.json'), JSON.stringify({ [job.id]: { jobId: job.id, account, phase: 'sending' } }), { mode: 0o600 });
    c.restart(); await c.api.tick();
    expect(c.send).not.toHaveBeenCalled(); expect(c.bridge.listJobs()[0].status).toBe('failed'); expect(c.api.status().needsAttention).toBe(true);
  });

  it('encodes Unicode safely and rejects any header injection or extra recipient', () => {
    const input = { account, recipient: 'rexziyw@gmail.com', subject: 'Dinner — 東京 🍲 '.repeat(8), body: 'Hello,\nA kosher option is available. 🍲', jobId: 'test-job' };
    const mime = Buffer.from(gmailRawMessage(input), 'base64url').toString('utf8');
    const [headers, body] = mime.split('\r\n\r\n');
    expect(headers).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(headers.split('\r\n').filter(line => line.startsWith('Subject:') || line.startsWith(' ')).every(line => line.length < 80)).toBe(true);
    expect(Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf8')).toBe(input.body.replace(/\n/g, '\r\n'));
    expect(() => gmailRawMessage({ ...input, subject: 'Hello\r\nBcc: evil@gmail.com' })).toThrow();
    expect(() => gmailRawMessage({ ...input, recipient: 'rexziyw@gmail.com,evil@gmail.com' })).toThrow();
  });
});
