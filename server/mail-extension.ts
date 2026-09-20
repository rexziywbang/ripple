import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { z } from 'zod';
import type { ProjectState } from '../shared/types.js';
import type { LiveBridge, LiveJob } from './live-bridge.js';
import { gmailThreadKey, observedReplySchema, validateObservedReply, type MonitoredMailMessage } from './mail-reply-monitor.js';
import { createEviteWorkerRouter } from './evite-worker.js';

export const MAIL_EXTENSION_WORKER = 'ripple-mail-extension';
type Options = { bridge: LiveBridge; dataDir: string; getState: (projectId: string) => ProjectState; reconcile: () => void; ingestReply?: (projectId: string, message: MonitoredMailMessage) => unknown };
const accountSchema = z.string().trim().email().max(320);
const workerSchema = z.object({ workerId: z.literal(MAIL_EXTENSION_WORKER), account: accountSchema });
const localOrigin = (value: string) => /^http:\/\/(?:127\.0\.0\.1|localhost):(?:5173|8787)$/.test(value);
const extensionOrigin = (value: string) => /^chrome-extension:\/\/[a-p]{32}$/.test(value);
const normalize = (value: unknown) => typeof value === 'string' ? value.trim().toLowerCase() : '';

/** Token stays in ignored local data and is never emitted to application logs. */
export function loadMailExtensionToken(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const tokenPath = join(dataDir, 'mail-extension-token');
  if (!existsSync(tokenPath)) writeFileSync(tokenPath, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  chmodSync(tokenPath, 0o600);
  const token = readFileSync(tokenPath, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Local mail-worker pairing configuration is invalid.');
  return token;
}

/** Mount before the general origin guard; this router performs its own host, origin, and token checks. */
export function createMailExtensionRouter({ bridge, dataDir, getState, reconcile, ingestReply }: Options): express.Router {
  const token = loadMailExtensionToken(dataDir);
  const router = express.Router();
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!['127.0.0.1', 'localhost', '::1'].includes(req.hostname)) return res.status(403).json({ error: 'Loopback access only.' });
    const origin = req.get('origin');
    const pairing = req.path === '/pairing' && req.method === 'GET';
    if (pairing) {
      if ((origin && !localOrigin(origin)) || req.get('sec-fetch-site') === 'cross-site') return res.status(403).json({ error: 'Open pairing from the local Ripple workspace.' });
      if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
      return next();
    }
    if (origin && !extensionOrigin(origin) && !localOrigin(origin)) return res.status(403).json({ error: 'Untrusted mail-worker origin.' });
    if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type'); return res.sendStatus(204);
    }
    const supplied = req.get('authorization')?.replace(/^Bearer /, '') ?? '';
    if (!/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) return res.status(401).json({ error: 'Pair the mail extension with Ripple first.' });
    next();
  });
  router.use(express.json({ limit: '64kb' }));
  router.use('/evite', createEviteWorkerRouter(bridge, getState));
  router.get('/pairing', (_req, res) => res.json({ token, workerId: MAIL_EXTENSION_WORKER, apiBase: 'http://127.0.0.1:8787/api/mail-worker', selfInboxOnly: false, demoRecipient: 'rexziyw@gmail.com' }));

  function assertMail(job: LiveJob | undefined, account: string, owned = false): LiveJob {
    if (!job || job.provider !== 'email' || job.action !== 'send_email') throw new Error('No approved email job was found.');
    const recipient = normalize(job.payload.recipient);
    const config = bridge.getConfig(job.projectId);
    const approvedDemoTarget = recipient === 'rexziyw@gmail.com' && normalize(config.testRecipient) === recipient && normalize(config.emailAccount) === normalize(account);
    if (normalize(job.payload.account) !== normalize(account) || (recipient !== normalize(account) && !approvedDemoTarget)) throw new Error('The demo worker sends only to your own inbox or the configured demo recipient.');
    if (owned && job.workerId !== MAIL_EXTENSION_WORKER) throw new Error('This email belongs to another worker.');
    if (typeof job.payload.subject !== 'string' || typeof job.payload.body !== 'string' || !job.payload.subject || !job.payload.body) throw new Error('The approved email payload is incomplete.');
    return job;
  }
  function currentApproval(job: LiveJob): boolean {
    const proposal = getState(job.projectId).proposals.find(value => value.id === job.payload.proposalId);
    return proposal?.kind === 'email' && proposal.status === 'approved' && proposal.version === job.revision;
  }
  const findJob = (id: string) => bridge.listJobs().find(job => job.id === id);
  router.post('/status', (req, res) => {
    workerSchema.strict().parse(req.body);
    res.json({ ready: true, selfInboxOnly: false, demoRecipient: 'rexziyw@gmail.com', workerId: MAIL_EXTENSION_WORKER, replyMonitoring: !!ingestReply });
  });
  router.post('/reply-targets', (req, res) => {
    const { account } = workerSchema.strict().parse(req.body);
    if (!ingestReply) return res.json([]);
    const jobs = bridge.listJobs().filter(job => job.provider === 'email' && job.action === 'send_email' && job.status === 'completed' && job.receipt && normalize(job.payload.account) === normalize(account));
    const targets = jobs.flatMap(job => {
      const state = getState(job.projectId);
      if (!state.projects.some(project => project.id === job.projectId) || typeof job.payload.subject !== 'string' || typeof job.payload.body !== 'string' || typeof job.payload.recipient !== 'string') return [];
      return [{ jobId: job.id, subject: job.payload.subject, body: job.payload.body, account, expectedSender: job.payload.recipient,
        completedAt: job.receipt!.completedAt, claimedAt: job.claimedAt || job.createdAt,
        ...(gmailThreadKey(job.receipt?.url) ? { threadUrl: job.receipt!.url } : {}),
        capturedExternalIds: state.messages.filter(message => message.direction === 'inbound' && message.externalId).map(message => message.externalId) }];
    });
    res.json(targets.reverse().slice(0, 50));
  });
  router.post('/jobs/:id/replies', (req, res) => {
    if (!ingestReply) return res.status(503).json({ error: 'Reply monitoring is not connected to this workspace.' });
    const input = workerSchema.extend(observedReplySchema.shape).strict().parse(req.body);
    const job = findJob(req.params.id);
    if (!job) throw new Error('Unknown delivered email job.');
    if (!getState(job.projectId).projects.some(project => project.id === job.projectId)) throw new Error('Archived events are not monitored.');
    const message = validateObservedReply(job, input.account, { message: input.message, provenance: input.provenance });
    ingestReply(job.projectId, message);
    res.json({ captured: true, externalId: message.externalId });
  });
  router.post('/claim', (req, res) => {
    const { account } = workerSchema.strict().parse(req.body); reconcile();
    const next = bridge.listJobs().find(job => job.provider === 'email' && job.status === 'queued');
    if (!next) return res.json(null);
    assertMail(next, account);
    if (!currentApproval(next)) return res.status(409).json({ error: 'The queued email is no longer approved. Refresh the event review.' });
    res.json(bridge.claimNext(MAIL_EXTENSION_WORKER, 'email') ?? null);
  });
  router.post('/jobs/:id/before-send', (req, res) => {
    const { account } = workerSchema.strict().parse(req.body); reconcile();
    const job = assertMail(findJob(req.params.id), account, true);
    if (job.status !== 'running' || !currentApproval(job)) return res.status(409).json({ error: 'The approved message changed before sending. Nothing should be sent.' });
    res.json({ allowed: true, jobId: job.id });
  });
  router.post('/jobs/:id/complete', (req, res) => {
    const input = workerSchema.extend({ detail: z.string().min(1).max(2000), url: z.string().url().max(2000).optional(), externalId: z.string().max(500).optional(), verification: z.object({ method: z.literal('gmail_sent_confirmation'), subject: z.string(), recipient: accountSchema }).strict() }).strict().parse(req.body);
    const job = assertMail(findJob(req.params.id), input.account, true);
    if (input.verification.subject !== job.payload.subject || normalize(input.verification.recipient) !== normalize(job.payload.recipient)) throw new Error('The observed send does not match the approved message.');
    const completed = bridge.complete(job.id, { detail: input.detail, ...(input.url ? { url: input.url } : {}), ...(input.externalId ? { externalId: input.externalId } : {}) });
    reconcile(); res.json(completed);
  });
  router.post('/jobs/:id/fail', (req, res) => {
    const input = workerSchema.extend({ error: z.string().min(1).max(2000) }).strict().parse(req.body);
    const job = assertMail(findJob(req.params.id), input.account, true);
    const failed = bridge.fail(job.id, input.error); reconcile(); res.json(failed);
  });
  router.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const detail = error instanceof z.ZodError ? 'Invalid mail-worker request.' : error instanceof Error ? error.message : 'The mail-worker request failed.';
    res.status(400).json({ error: detail.slice(0,400) });
  });
  return router;
}
