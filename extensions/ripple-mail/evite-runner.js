export const EVITE_WORKER = 'ripple-evite-extension';
function invitation(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !['evite.com', 'www.evite.com'].includes(parsed.hostname)) return;
    const match = /^\/invitation\/([A-Za-z0-9]+)\/(preview|customize|details|send)\/?$/.exec(parsed.pathname);
    if (match) return { id: match[1], page: match[2], previewUrl: `${parsed.origin}/invitation/${match[1]}/preview` };
  } catch { /* Not an Evite invitation page. */ }
}

/** Persist the save before invoking the editor; reload verification is separate. */
export function createEviteRunner({ read, write, post, tabMessage, navigate }) {
  let busy = false;
  return async function run(tabId, eventUrl) {
    if (busy) return; busy = true;
    try {
      const config = await read();
      if (!config.token || !config.enabled) return;
      const current = invitation(eventUrl);
      if (!current) return;
      const saved = config.eviteFlight;
      if (saved && saved.tabId !== tabId) return;
      if (saved && current.id !== invitation(saved.job.payload.eventUrl)?.id) return;
      if (saved?.phase === 'awaiting-save' && current.page === 'send') {
        await write({ eviteFlight: { ...saved, phase: 'verify' }, eviteStatus: 'Checking the saved invitation…' });
        await navigate(tabId, current.previewUrl);
        return;
      }
      if (saved?.phase === 'verify') {
        // The phase survives a worker restart between persisting and navigation.
        if (current.page !== 'preview') { await navigate(tabId, current.previewUrl); return; }
        const evidence = await tabMessage(tabId, { type: 'ripple:evite-verify', job: saved.job });
        if (!evidence?.verified) return;
        await post(config, `/evite/jobs/${saved.job.id}/complete`, { workerId: EVITE_WORKER, eventUrl, ...evidence.fields, reloaded: true });
        await write({ eviteFlight: null, eviteStatus: 'Evite updated and verified.' });
        return;
      }
      if (saved) return; // Uncertain saves need inspection, never a blind replay.
      if (current.page !== 'preview') return;
      const job = await post(config, '/evite/claim', { workerId: EVITE_WORKER, eventUrl });
      if (!job) return;
      await write({ eviteFlight: { phase: 'saving', tabId, job }, eviteStatus: 'Updating the invitation…' });
      const approved = await post(config, `/evite/jobs/${job.id}/before-save`, { workerId: EVITE_WORKER, eventUrl });
      if (!approved.allowed) throw new Error('Invitation approval changed.');
      // Finish can unload the content script before its response reaches the worker.
      // Persist uncertainty first; a later heartbeat can verify without replaying edits.
      await write({ eviteFlight: { phase: 'awaiting-save', tabId, job }, eviteStatus: 'Waiting for Evite to finish saving…' });
      const result = await tabMessage(tabId, { type: 'ripple:evite-save', job });
      if (!result?.saveStarted) {
        const error = result?.error || 'Evite save could not be verified.';
        await post(config, `/evite/jobs/${job.id}/fail`, { workerId: EVITE_WORKER, eventUrl, error }).catch(() => {});
        await write({ eviteFlight: { phase: 'paused', tabId, job, error }, eviteStatus: error });
      }
    } catch (error) {
      const config = await read();
      const message = error instanceof Error ? error.message : 'Evite update needs another look.';
      await write({ eviteStatus: message });
      if (config.eviteFlight?.phase === 'saving') {
        await post(config, `/evite/jobs/${config.eviteFlight.job.id}/fail`, { workerId: EVITE_WORKER, eventUrl, error: message }).catch(() => {});
        await write({ eviteFlight: { ...config.eviteFlight, phase: 'paused', error: message } });
      }
    } finally { busy = false; }
  };
}
