import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import express from 'express';
import { CodeChallengeMethod, OAuth2Client, type Credentials } from 'google-auth-library';
import type { ProjectState } from '../shared/types.js';
import type { LiveBridge, LiveJob } from './live-bridge.js';

export const GMAIL_API_WORKER = 'ripple-gmail-api';
export const GMAIL_CALLBACK = 'http://127.0.0.1:8787/api/gmail/callback';
const SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const COOKIE = 'ripple_gmail_oauth';
const normalize = (value: unknown) => typeof value === 'string' ? value.trim().toLowerCase() : '';
const validEmail = (value: unknown): value is string => typeof value === 'string' && value.length <= 254 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(value) && !/\.example$/i.test(value);
const localOrigin = (value: string) => /^http:\/\/(?:127\.0\.0\.1|localhost):(?:5173|8787)$/.test(value);
type Connection = { account: string; subject: string; clientId: string; tokens: Credentials };
type SendEntry = { jobId: string; account: string; phase: 'sending' | 'sent' | 'recorded' | 'uncertain'; messageId?: string; error?: string };
export type GmailApiStatus = { configured: boolean; connected: boolean; account?: string; busy: boolean; needsAttention: boolean; error?: string };
export type GmailApiOptions = {
  dataDir: string; bridge: LiveBridge; getState: (projectId: string) => ProjectState; reconcile: () => void;
  env?: Record<string, string | undefined>;
  /** Injectable I/O for offline tests; production uses Google's official client and native fetch. */
  oauthFactory?: () => OAuth2Client; fetch?: typeof fetch; now?: () => number;
};

function privateJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path); chmodSync(path, 0o600);
  const directory = openSync(dirname(path), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

/** Plain-text MIME with encoded Unicode headers/body; caller cannot inject other recipients. */
export function gmailRawMessage(input: { account: string; recipient: string; subject: string; body: string; jobId: string }): string {
  if (!validEmail(input.account) || !validEmail(input.recipient) || /[\r\n\u0000-\u001f\u007f]/.test(input.subject) || !input.subject.trim() || input.subject.length > 1000 || !input.body.trim() || input.body.length > 32000 || !/^[A-Za-z0-9-]+$/.test(input.jobId)) throw new Error('The approved email has invalid headers or content.');
  const chunks: string[] = []; let chunk = '';
  for (const character of input.subject) {
    if (Buffer.byteLength(chunk + character, 'utf8') > 42) { chunks.push(chunk); chunk = ''; }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  const subject = chunks.map(value => `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`).join('\r\n ');
  const body = Buffer.from(input.body.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '';
  return Buffer.from([
    `From: ${input.account}`, `To: ${input.recipient}`, `Subject: ${subject}`,
    `Message-ID: <ripple-${input.jobId}@localhost>`, 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', body, '',
  ].join('\r\n'), 'utf8').toString('base64url');
}

export function createGmailApi(options: GmailApiOptions) {
  const { bridge, getState, reconcile } = options;
  const env = options.env ?? process.env, now = options.now ?? Date.now;
  const clientId = env.GOOGLE_CLIENT_ID?.trim(), clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  const configured = !!clientId && !!clientSecret;
  const credentialsPath = join(options.dataDir, 'gmail-oauth.json');
  const journalPath = join(options.dataDir, 'gmail-send-journal.json');
  const request = options.fetch ?? fetch;
  let connection: Connection | undefined, client: OAuth2Client | undefined;
  let journal: Record<string, SendEntry> = {}, busy = false, closed = false, storageBlocked = false;
  let error: string | undefined, activeRequest: AbortController | undefined;
  const attempts = new Map<string, { binding: string; verifier: string; nonce: string; expires: number; client: OAuth2Client }>();
  const freshClient = () => options.oauthFactory?.() ?? new OAuth2Client({ clientId, clientSecret, redirectUri: GMAIL_CALLBACK, transporterOptions: { timeout: 10000, retry: false } });
  const persistJournal = () => privateJson(journalPath, journal);
  function install(value: Connection, oauth: OAuth2Client) {
    connection = value; client = oauth; oauth.setCredentials(value.tokens);
    oauth.on('tokens', tokens => {
      if (closed || client !== oauth || !connection) return;
      connection.tokens = { ...connection.tokens, ...tokens };
      try { privateJson(credentialsPath, connection); }
      catch { storageBlocked = true; error = 'Google credentials could not be saved securely.'; }
    });
  }
  try {
    if (existsSync(credentialsPath)) {
      chmodSync(credentialsPath, 0o600);
      const saved = JSON.parse(readFileSync(credentialsPath, 'utf8')) as Connection;
      if (configured && saved.clientId === clientId && validEmail(saved.account) && typeof saved.subject === 'string' && saved.subject && saved.tokens && (typeof saved.tokens.refresh_token === 'string' || typeof saved.tokens.access_token === 'string')) install(saved, freshClient());
    }
    if (existsSync(journalPath)) {
      chmodSync(journalPath, 0o600); journal = JSON.parse(readFileSync(journalPath, 'utf8'));
      if (!journal || typeof journal !== 'object' || Array.isArray(journal) || Object.entries(journal).some(([id, entry]) => entry?.jobId !== id || !['sending', 'sent', 'recorded', 'uncertain'].includes(entry?.phase))) throw new Error('Invalid journal');
    }
  } catch { storageBlocked = true; error = 'Local Gmail state needs attention. No messages will be sent.'; }

  function status(): GmailApiStatus {
    return { configured, connected: !!connection && !!client && !storageBlocked, ...(connection ? { account: connection.account } : {}), busy,
      needsAttention: storageBlocked || Object.values(journal).some(entry => entry.phase === 'uncertain' || !busy && entry.phase === 'sending'), ...(error ? { error } : {}) };
  }
  function eligible(job: LiveJob, account: string) {
    if (job.provider !== 'email' || job.action !== 'send_email') return false;
    const config = bridge.getConfig(job.projectId);
    let state: ProjectState;
    try { state = getState(job.projectId); } catch { return false; }
    const proposal = state.proposals.find(value => value.id === job.payload.proposalId);
    const recipient = normalize(job.payload.recipient);
    return state.projects.some(value => value.id === job.projectId) && config.emailDelivery === 'live' &&
      normalize(config.emailAccount) === account && normalize(job.payload.account) === account &&
      (recipient === account || recipient === 'rexziyw@gmail.com' && normalize(config.testRecipient) === recipient) &&
      proposal?.kind === 'email' && proposal.status === 'approved' && proposal.version === job.revision &&
      job.payload.subject === (proposal.subject ?? proposal.title) && job.payload.body === (proposal.body ?? proposal.description);
  }
  function settle(entry: SendEntry) {
    const job = bridge.listJobs().find(value => value.id === entry.jobId);
    if (!job || job.workerId !== GMAIL_API_WORKER) return;
    if (entry.phase === 'sent' && entry.messageId) {
      bridge.complete(job.id, { externalId: entry.messageId, detail: 'Gmail API accepted the approved email for sending and returned a message ID. Recipient delivery is not verified.' });
      reconcile(); entry.phase = 'recorded'; persistJournal(); error = undefined;
    } else if (entry.phase === 'uncertain' && job.status === 'running') {
      bridge.fail(job.id, entry.error ?? 'Gmail send outcome is unknown. Check Sent before any retry.'); reconcile();
    }
  }
  async function tick() {
    if (busy || closed || storageBlocked) return;
    busy = true;
    try {
      // An abandoned claim or submitted request must never be replayed on restart.
      for (const job of bridge.listJobs()) if (job.workerId === GMAIL_API_WORKER && job.status === 'running' && !journal[job.id]) {
        journal[job.id] = { jobId: job.id, account: normalize(job.payload.account), phase: 'uncertain', error: 'Gmail worker was interrupted. No automatic retry; check Sent before retrying.' }; persistJournal();
      }
      for (const entry of Object.values(journal)) {
        if (entry.phase === 'sending') { entry.phase = 'uncertain'; entry.error = 'Gmail send was interrupted; its outcome is unknown. Check Sent before any retry.'; persistJournal(); }
        settle(entry);
      }
      if (Object.values(journal).some(entry => entry.phase === 'uncertain') || !connection || !client || !configured) return;
      reconcile();
      const candidate = bridge.listJobs().find(job => job.status === 'queued' && !journal[job.id] && eligible(job, connection!.account));
      if (!candidate) return;
      const account = connection.account;
      const raw = gmailRawMessage({ account, recipient: String(candidate.payload.recipient), subject: String(candidate.payload.subject), body: String(candidate.payload.body), jobId: candidate.id });
      const access = await client.getAccessToken();
      if (!access.token || closed || storageBlocked || connection?.account !== account) return;
      reconcile();
      if (!eligible(candidate, account)) return;
      const job = bridge.claimById(candidate.id, GMAIL_API_WORKER);
      if (!job) return; // The browser worker may have won this exact claim.
      if (!eligible(job, account)) { bridge.fail(job.id, 'The approval changed before sending. Nothing was sent.'); reconcile(); return; }
      const entry: SendEntry = { jobId: job.id, account, phase: 'sending' };
      journal[job.id] = entry; persistJournal();
      activeRequest = new AbortController();
      try {
        // Native fetch performs one request. No library retry or token-refresh replay wraps this send.
        const response = await request('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
          method: 'POST', headers: { Authorization: `Bearer ${access.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ raw }), redirect: 'error', signal: AbortSignal.any([activeRequest.signal, AbortSignal.timeout(15000)]),
        });
        if (!response.ok) throw new Error('Gmail did not confirm sending.');
        const result = await response.json() as { id?: unknown };
        if (typeof result.id !== 'string' || !/^[A-Za-z0-9_-]{1,500}$/.test(result.id)) throw new Error('Gmail returned no message ID.');
        entry.phase = 'sent'; entry.messageId = result.id; persistJournal();
        settle(entry); error = undefined;
      } catch {
        if (entry.phase === 'sending') {
          entry.phase = 'uncertain'; entry.error = 'Gmail did not return a verified send result. The message may have been sent. Check Sent before any retry.';
          persistJournal(); settle(entry);
        }
        error = entry.phase === 'sent' ? 'Gmail accepted the message. Its local receipt will be recorded on the next check.' : 'Gmail sending needs attention. Check Sent before any retry.';
      } finally { activeRequest = undefined; }
    } catch { error = 'Gmail connection or local receipt needs attention. No send will be retried automatically.'; }
    finally { busy = false; }
  }

  const router = express.Router();
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!['127.0.0.1', 'localhost', '::1'].includes(req.hostname)) return res.status(403).json({ error: 'Local access only.' });
    if (req.method !== 'GET' && ((req.get('origin') && !localOrigin(req.get('origin')!)) || req.get('sec-fetch-site') === 'cross-site')) return res.status(403).json({ error: 'Connect from the local Ripple workspace.' });
    next();
  });
  router.get('/status', (_req, res) => res.json(status()));
  router.post('/connect', async (_req, res) => {
    if (!configured) return res.status(503).json({ error: 'Google OAuth client configuration is required.' });
    try {
      for (const [state, attempt] of attempts) if (attempt.expires < now()) attempts.delete(state);
      if (attempts.size >= 10) return res.status(429).json({ error: 'Finish the current Google connection before starting another.' });
      const oauth = freshClient(); const codes = await oauth.generateCodeVerifierAsync();
      const state = randomBytes(32).toString('hex'), binding = randomBytes(32).toString('hex'), nonce = randomBytes(32).toString('hex');
      attempts.set(state, { binding, verifier: codes.codeVerifier, nonce, expires: now() + 600000, client: oauth });
      res.cookie(COOKIE, binding, { httpOnly: true, sameSite: 'lax', path: '/api/gmail/callback', maxAge: 600000 });
      res.json({ url: oauth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: [SEND_SCOPE, 'openid', 'email'], state, nonce, code_challenge_method: CodeChallengeMethod.S256, code_challenge: codes.codeChallenge }) });
    } catch { res.status(500).json({ error: 'Google connection could not be started.' }); }
  });
  router.get('/callback', async (req, res) => {
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const attempt = attempts.get(state); attempts.delete(state);
    const binding = req.get('cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? '';
    res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'lax', path: '/api/gmail/callback' });
    if (!attempt || attempt.expires < now() || !/^[a-f0-9]{64}$/.test(binding) || !timingSafeEqual(Buffer.from(binding), Buffer.from(attempt.binding))) return res.status(400).type('text').send('Google connection expired or did not match this browser. Start again from Ripple.');
    if (typeof req.query.code !== 'string' || req.query.code.length > 4000 || req.query.error) return res.status(400).type('text').send('Google permission was not completed. Nothing was sent.');
    try {
      const { tokens } = await attempt.client.getToken({ code: req.query.code, codeVerifier: attempt.verifier, redirect_uri: GMAIL_CALLBACK });
      if (!tokens.id_token || !tokens.access_token || !tokens.scope?.split(' ').includes(SEND_SCOPE)) throw new Error('Missing permission');
      const ticket = await attempt.client.verifyIdToken({ idToken: tokens.id_token, audience: clientId });
      const identity = ticket.getPayload();
      if (identity?.email_verified !== true || !validEmail(identity.email) || !identity.sub || (identity as unknown as { nonce?: string }).nonce !== attempt.nonce) throw new Error('Unverified identity');
      const account = normalize(identity.email);
      const refresh = tokens.refresh_token ?? (connection?.subject === identity.sub ? connection.tokens.refresh_token : undefined);
      if (!refresh) throw new Error('Offline permission required');
      const value: Connection = { account, subject: identity.sub, clientId: clientId!, tokens: { ...tokens, refresh_token: refresh } };
      privateJson(credentialsPath, value); install(value, attempt.client); error = undefined;
      res.type('html').send('<!doctype html><meta charset="utf-8"><title>Gmail connected</title><p>Gmail is connected. Ripple can send emails you approve.</p><p><a href="http://127.0.0.1:5173/">Return to Ripple</a></p>');
    } catch { res.status(400).type('text').send('Google connection could not be verified. Start again from Ripple; no message was sent.'); }
  });
  return { status, router, tick, close() { closed = true; attempts.clear(); activeRequest?.abort(); client?.removeAllListeners('tokens'); } };
}
