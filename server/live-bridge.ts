import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type LiveProvider = 'email' | 'dropbox' | 'google_calendar' | 'partiful' | 'evite';
export type LiveAction = 'send_email' | 'update_file' | 'update_event' | 'send_invitation';
export type LiveJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type LiveBridgeConfigInput = {
  emailDelivery?: 'live' | 'rehearsal';
  emailAccount?: string;
  testRecipient?: string;
  dropboxFolderUrl?: string;
  calendarEventUrl?: string;
  partifulEventUrl?: string;
  eviteEventUrl?: string;
};
export type LiveBridgeConfig = LiveBridgeConfigInput & {
  projectId: string;
  providers: Record<LiveProvider, { status: 'configured' | 'not_configured' }>;
  updatedAt?: string;
};
export type LiveJobInput = {
  projectId: string;
  provider: LiveProvider;
  action: LiveAction;
  dedupeKey: string;
  payload: Record<string, unknown>;
  revision: number;
};
export type LiveReceiptInput = { externalId?: string; url?: string; detail: string };
export type LiveReceipt = LiveReceiptInput & { completedAt: string };
export type LiveJob = LiveJobInput & {
  id: string;
  status: LiveJobStatus;
  createdAt: string;
  updatedAt: string;
  workerId?: string;
  claimedAt?: string;
  receipt?: LiveReceipt;
  error?: string;
};

const providers: LiveProvider[] = ['email', 'dropbox', 'google_calendar', 'partiful', 'evite'];
const actions: Record<LiveProvider, LiveAction[]> = {
  email: ['send_email'],
  dropbox: ['update_file'],
  google_calendar: ['update_event'],
  partiful: ['update_event', 'send_invitation'],
  evite: ['update_event', 'send_invitation'],
};
const urlHosts: Record<LiveProvider, string[]> = {
  email: ['mail.google.com'],
  dropbox: ['dropbox.com', 'www.dropbox.com'],
  google_calendar: ['calendar.google.com'],
  partiful: ['partiful.com', 'www.partiful.com'],
  evite: ['evite.com', 'www.evite.com', 'evite.me', 'www.evite.me'],
};
const configFields = ['emailAccount', 'testRecipient', 'dropboxFolderUrl', 'calendarEventUrl', 'partifulEventUrl', 'eviteEventUrl', 'emailDelivery'] as const;
const urlFields = {
  dropboxFolderUrl: 'dropbox', calendarEventUrl: 'google_calendar',
  partifulEventUrl: 'partiful', eviteEventUrl: 'evite',
} as const;

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function providerUrl(value: unknown, provider: LiveProvider): string {
  const text = requiredText(value, `${provider} URL`);
  let url: URL;
  try { url = new URL(text); } catch { throw new Error(`Invalid ${provider} URL`); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !urlHosts[provider].includes(url.hostname)) {
    throw new Error(`Use an HTTPS ${provider} URL on ${urlHosts[provider].join(' or ')}`);
  }
  return url.href;
}

function emailAddress(value: unknown, label: string): string {
  const text = requiredText(value, label);
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(text)) throw new Error(`Invalid ${label}`);
  return text;
}

/** Local work queue only. An authenticated external worker must perform and verify each action. */
export function createLiveBridge({ dbPath }: { dbPath: string }) {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    const fd = openSync(dbPath, 'a', 0o600);
    closeSync(fd);
    chmodSync(dbPath, 0o600);
  }
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS live_bridge_config (project_id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS live_bridge_jobs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, provider TEXT NOT NULL, dedupe_key TEXT NOT NULL,
      status TEXT NOT NULL, data TEXT NOT NULL,
      UNIQUE(project_id, provider, dedupe_key)
    );
    CREATE INDEX IF NOT EXISTS live_bridge_jobs_status ON live_bridge_jobs(status);`);
  if (dbPath !== ':memory:') {
    for (const suffix of ['-wal', '-shm']) if (existsSync(dbPath + suffix)) chmodSync(dbPath + suffix, 0o600);
  }
  let closed = false;

  function transaction<T>(fn: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function readJob(id: string): LiveJob {
    const row = db.prepare('SELECT data FROM live_bridge_jobs WHERE id=?').get(id) as { data: string } | undefined;
    if (!row) throw new Error(`Unknown live job: ${id}`);
    return JSON.parse(row.data) as LiveJob;
  }
  function saveJob(job: LiveJob): LiveJob {
    db.prepare('UPDATE live_bridge_jobs SET status=?,data=? WHERE id=?').run(job.status, JSON.stringify(job), job.id);
    return structuredClone(job);
  }
  function configResult(projectId: string, value: LiveBridgeConfigInput & { updatedAt?: string }): LiveBridgeConfig {
    const configured: Record<LiveProvider, boolean> = {
      email: !!value.emailAccount, dropbox: !!value.dropboxFolderUrl, google_calendar: !!value.calendarEventUrl,
      partiful: !!value.partifulEventUrl, evite: !!value.eviteEventUrl,
    };
    return { projectId, ...value, providers: Object.fromEntries(providers.map(provider => [provider, {
      status: configured[provider] ? 'configured' : 'not_configured',
    }])) as LiveBridgeConfig['providers'] };
  }
  function getConfig(projectId: string): LiveBridgeConfig {
    projectId = requiredText(projectId, 'projectId');
    const row = db.prepare('SELECT data FROM live_bridge_config WHERE project_id=?').get(projectId) as { data: string } | undefined;
    return configResult(projectId, row ? JSON.parse(row.data) : {});
  }

  return {
    configure(projectId: string, patch: LiveBridgeConfigInput): LiveBridgeConfig {
      projectId = requiredText(projectId, 'projectId');
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Configuration must be an object');
      for (const key of Object.keys(patch)) if (!configFields.includes(key as typeof configFields[number])) throw new Error(`Unknown configuration field: ${key}`);
      return transaction(() => {
        const current = getConfig(projectId);
        const next: LiveBridgeConfigInput & { updatedAt?: string } = {};
        for (const key of configFields) if (current[key] !== undefined) Object.assign(next, { [key]: current[key] });
        for (const key of configFields) {
          if (patch[key] === undefined) continue;
          if (key === 'emailDelivery') {
            if (patch[key] !== 'live' && patch[key] !== 'rehearsal') throw new Error('Choose live or rehearsal email delivery.');
            next.emailDelivery = patch[key]; continue;
          }
          if (typeof patch[key] === 'string' && patch[key]!.trim() === '') { delete next[key]; continue; }
          next[key] = key === 'emailAccount' || key === 'testRecipient'
            ? emailAddress(patch[key], key) : providerUrl(patch[key], urlFields[key]);
        }
        next.updatedAt = new Date().toISOString();
        db.prepare('INSERT INTO live_bridge_config(project_id,data) VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET data=excluded.data').run(projectId, JSON.stringify(next));
        return configResult(projectId, next);
      });
    },
    getConfig,
    enqueue(input: LiveJobInput): LiveJob {
      const projectId = requiredText(input.projectId, 'projectId');
      const dedupeKey = requiredText(input.dedupeKey, 'dedupeKey');
      if (!providers.includes(input.provider) || !actions[input.provider].includes(input.action)) throw new Error('Unsupported provider/action');
      if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw new Error('revision must be a non-negative integer');
      if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) throw new Error('payload must be an object');
      // Persist a detached JSON payload; configuration contains addresses/URLs, never provider credentials.
      const payload = JSON.parse(JSON.stringify(input.payload)) as Record<string, unknown>;
      return transaction(() => {
        const row = db.prepare('SELECT data FROM live_bridge_jobs WHERE project_id=? AND provider=? AND dedupe_key=?').get(projectId, input.provider, dedupeKey) as { data: string } | undefined;
        if (row) {
          const original = JSON.parse(row.data) as LiveJob;
          if (original.action !== input.action) throw new Error('dedupeKey already belongs to a different action');
          const mutable = input.action === 'update_event' || input.action === 'update_file';
          if (mutable && original.status === 'queued' && input.revision > original.revision) {
            original.payload = payload;
            original.revision = input.revision;
            original.updatedAt = new Date().toISOString();
            return saveJob(original);
          }
          return original;
        }
        const now = new Date().toISOString();
        const job: LiveJob = { id: randomUUID(), projectId, provider: input.provider, action: input.action, dedupeKey,
          payload, revision: input.revision, status: 'queued', createdAt: now, updatedAt: now };
        db.prepare('INSERT INTO live_bridge_jobs(id,project_id,provider,dedupe_key,status,data) VALUES(?,?,?,?,?,?)').run(job.id, projectId, job.provider, dedupeKey, job.status, JSON.stringify(job));
        return job;
      });
    },
    listJobs(projectId?: string): LiveJob[] {
      const rows = (projectId === undefined
        ? db.prepare('SELECT data FROM live_bridge_jobs ORDER BY rowid').all()
        : db.prepare('SELECT data FROM live_bridge_jobs WHERE project_id=? ORDER BY rowid').all(requiredText(projectId, 'projectId'))) as Array<{ data: string }>;
      return rows.map(row => JSON.parse(row.data) as LiveJob);
    },
    claimById(jobId: string, workerId: string): LiveJob | undefined {
      jobId = requiredText(jobId, 'jobId'); workerId = requiredText(workerId, 'workerId');
      return transaction(() => {
        const row = db.prepare("SELECT data FROM live_bridge_jobs WHERE id=? AND status='queued'").get(jobId) as { data: string } | undefined;
        if (!row) return undefined;
        const job = JSON.parse(row.data) as LiveJob;
        job.status = 'running'; job.workerId = workerId; job.claimedAt = job.updatedAt = new Date().toISOString();
        return saveJob(job);
      });
    },
    claimNext(workerId: string, provider?: LiveProvider): LiveJob | undefined {
      workerId = requiredText(workerId, 'workerId');
      if (provider !== undefined && !providers.includes(provider)) throw new Error('Unsupported provider');
      return transaction(() => {
        const row = (provider === undefined
          ? db.prepare("SELECT data FROM live_bridge_jobs WHERE status='queued' ORDER BY rowid LIMIT 1").get()
          : db.prepare("SELECT data FROM live_bridge_jobs WHERE status='queued' AND provider=? ORDER BY rowid LIMIT 1").get(provider)) as { data: string } | undefined;
        if (!row) return undefined;
        const job = JSON.parse(row.data) as LiveJob;
        job.status = 'running'; job.workerId = workerId;
        job.claimedAt = job.updatedAt = new Date().toISOString();
        return saveJob(job);
      });
    },
    complete(jobId: string, receipt: LiveReceiptInput): LiveJob {
      return transaction(() => {
        const job = readJob(jobId);
        if (job.status === 'completed') return job;
        if (job.status !== 'running') throw new Error(`Cannot complete a ${job.status} job; claim it before execution`);
        const detail = requiredText(receipt?.detail, 'Receipt detail');
        const externalId = receipt.externalId === undefined ? undefined : requiredText(receipt.externalId, 'externalId');
        const url = receipt.url === undefined ? undefined : providerUrl(receipt.url, job.provider);
        const now = new Date().toISOString();
        job.status = 'completed'; job.updatedAt = now;
        job.receipt = { detail, completedAt: now, ...(externalId ? { externalId } : {}), ...(url ? { url } : {}) };
        return saveJob(job);
      });
    },
    fail(jobId: string, error: string | Error): LiveJob {
      return transaction(() => {
        const job = readJob(jobId);
        if (job.status === 'failed') return job;
        if (job.status !== 'queued' && job.status !== 'running') throw new Error(`Cannot fail a ${job.status} job`);
        job.error = requiredText(error instanceof Error ? error.message : error, 'Failure detail');
        job.status = 'failed'; job.updatedAt = new Date().toISOString();
        return saveJob(job);
      });
    },
    cancel(jobId: string): LiveJob {
      return transaction(() => {
        const job = readJob(jobId);
        if (job.status === 'cancelled') return job;
        if (job.status !== 'queued') throw new Error(`Cannot cancel a ${job.status} job; running actions require worker reconciliation`);
        job.status = 'cancelled'; job.updatedAt = new Date().toISOString();
        return saveJob(job);
      });
    },
    close() { if (!closed) { db.close(); closed = true; } },
  };
}

export type LiveBridge = ReturnType<typeof createLiveBridge>;
