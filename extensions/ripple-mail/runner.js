export const WORKER_ID = 'ripple-mail-extension';
export const API_BASE = 'http://127.0.0.1:8787/api/mail-worker';
export const normalizeAccount = value => typeof value === 'string' ? value.trim().toLowerCase() : '';

export function validateJob(job, account) {
  if (!job || job.provider !== 'email' || job.action !== 'send_email' || job.status !== 'running' || job.workerId !== WORKER_ID || typeof job.id !== 'string') throw new Error('Ripple returned an invalid email job.');
  const payload = job.payload;
  if (!payload || normalizeAccount(payload.account) !== normalizeAccount(account) || ![normalizeAccount(account), 'rexziyw@gmail.com'].includes(normalizeAccount(payload.recipient))) throw new Error('This worker sends only to the visible account or the approved demo recipient.');
  if (typeof payload.subject !== 'string' || !payload.subject.trim() || /[\r\n]/.test(payload.subject) || typeof payload.body !== 'string' || !payload.body.trim()) throw new Error('The approved email is incomplete.');
  return job;
}

/** Dependencies isolate the durable send state machine from browser APIs for testing. */
export function createMailRunner({ read, write, post, tabMessage }) {
  let busy = false;
  async function settle(config, flight) {
    const endpoint = flight.receipt ? 'complete' : 'fail';
    const result = await post(config, `/jobs/${encodeURIComponent(flight.job.id)}/${endpoint}`, {
      account: flight.account, ...(flight.receipt || { error: flight.error })
    });
    await write({ inFlight: null, status: flight.receipt ? 'Gmail confirmed the approved email was sent.' : flight.error, lastResult: { jobId: flight.job.id, status: result.status, at: new Date().toISOString() }, ...(flight.error ? { enabled: false } : {}) });
  }
  return {
    async run() {
      if (busy) return;
      busy = true;
      try {
        const config = await read();
        if (!config.token) return;
        if (config.inFlight) {
          if (config.inFlight.receipt || config.inFlight.error) await settle(config, config.inFlight);
          else await write({ status: 'An interrupted email needs reconciliation. Check Gmail Sent and the Ripple job before continuing.', enabled: false });
          return;
        }
        if (!config.enabled || !Number.isInteger(config.tabId)) return;
        const ready = await tabMessage(config.tabId, { type: 'ripple:ready' });
        if (!ready?.ready || normalizeAccount(ready.account) !== normalizeAccount(config.account)) {
          await write({ status: ready?.reason || 'Open the paired Gmail account and close any draft in the worker tab.' }); return;
        }
        // Persist before the HTTP claim as even a lost claim response must never cause a blind replay.
        await write({ inFlight: { phase: 'claiming', account: config.account, tabId: config.tabId }, status: 'Checking approved email…' });
        const job = await post(config, '/claim', { account: config.account });
        if (!job) { await write({ inFlight: null, status: 'Ready — waiting for an approved email.' }); return; }
        validateJob(job, config.account);
        const flight = { phase: 'claimed', job, account: config.account, tabId: config.tabId };
        await write({ inFlight: flight, status: 'Preparing the approved email in Gmail…' });
        const result = await tabMessage(config.tabId, { type: 'ripple:send', job });
        const latest = await read();
        if (result?.sent === true && result.verification?.method === 'gmail_sent_confirmation' && result.verification.subject === job.payload.subject && normalizeAccount(result.verification.recipient) === normalizeAccount(job.payload.recipient)) {
          const receipt = { detail: result.detail, url: result.url, verification: result.verification };
          const confirmed = { ...flight, phase: 'confirmed', receipt };
          await write({ inFlight: confirmed, status: 'Gmail confirmed sending; recording the receipt…' });
          await settle(config, confirmed);
        } else {
          const uncertain = latest.inFlight?.phase === 'sending' || result?.clicked === true;
          const error = `${uncertain ? 'Send may have occurred. Check Gmail Sent before any retry. ' : 'Nothing was sent by Ripple. '}${result?.error || 'Gmail did not return a matching confirmation.'}`;
          const failed = { ...flight, phase: 'failed', error };
          await write({ inFlight: failed, enabled: false, status: error });
          await settle(config, failed);
        }
      } catch (error) {
        const current = await read();
        await write({ status: current.inFlight ? 'Email paused: outcome needs reconciliation or receipt retry. Open Ripple Mail for details.' : `Mail worker waiting: ${error instanceof Error ? error.message : 'connection unavailable'}`, ...(current.inFlight && !current.inFlight.receipt && !current.inFlight.error ? { enabled: false } : {}) });
      } finally { busy = false; }
    },
    async beforeSend(tabId, jobId) {
      const config = await read(); const flight = config.inFlight;
      if (!config.enabled || !flight || flight.phase !== 'claimed' || flight.tabId !== tabId || flight.job?.id !== jobId) throw new Error('This message is not the active approved email.');
      const approved = await post(config, `/jobs/${encodeURIComponent(jobId)}/before-send`, { account: flight.account });
      if (approved?.allowed !== true || approved.jobId !== jobId) throw new Error('The email is no longer approved.');
      await write({ inFlight: { ...flight, phase: 'sending' }, status: 'Sending the approved email in Gmail…' });
      return { allowed: true };
    }
  };
}
