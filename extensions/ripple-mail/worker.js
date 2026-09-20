import { API_BASE, WORKER_ID, createMailRunner } from './runner.js';
import { createReplyMonitor } from './reply-monitor.js';
import { createEviteRunner } from './evite-runner.js';

// Gmail content scripts can message this worker but cannot read the pairing capability.
const storageReady = chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
const read = async () => { await storageReady; return chrome.storage.local.get(null); };
const write = async patch => { await storageReady; await chrome.storage.local.set(patch); };
const post = async (config, path, body) => {
  const response = await fetch(API_BASE + path, { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` }, body: JSON.stringify({ workerId: WORKER_ID, ...body }), signal: AbortSignal.timeout(10000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Ripple is unavailable.');
  return result;
};
const runner = createMailRunner({ read, write, post, tabMessage: (tabId, message) => chrome.tabs.sendMessage(tabId, message) });
const monitor = createReplyMonitor({ read, write, post, tabMessage: (tabId, message) => chrome.tabs.sendMessage(tabId, message) });
const evite = createEviteRunner({ read, write, post, tabMessage: (tabId, message) => chrome.tabs.sendMessage(tabId, message), navigate: (tabId, url) => chrome.tabs.update(tabId, { url }) });
let pumping = false;
async function pump() { if (pumping) return; pumping = true; try { await runner.run(); await monitor(); } finally { pumping = false; } }
const gmailSender = sender => sender.id === chrome.runtime.id && Number.isInteger(sender.tab?.id) && /^https:\/\/mail\.google\.com\/mail\//.test(sender.url || '');
const popupSender = sender => sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('popup.html');
const eviteSender = sender => sender.id === chrome.runtime.id && Number.isInteger(sender.tab?.id) && /^https:\/\/(?:www\.)?evite\.com\/invitation\//.test(sender.url || '');

async function handle(message, sender) {
  if (!message || typeof message.type !== 'string') throw new Error('Invalid extension message.');
  if (eviteSender(sender) && message.type === 'ripple:evite-heartbeat') { void evite(sender.tab.id, sender.url); return { ok: true }; }
  if (eviteSender(sender) && message.type === 'ripple:evite-before-save') {
    const config = await read();
    if (!config.enabled || config.eviteFlight?.tabId !== sender.tab.id || config.eviteFlight?.job?.id !== message.jobId) throw new Error('This invitation is not the current approved update.');
    return post(config, `/evite/jobs/${message.jobId}/before-save`, { workerId: 'ripple-evite-extension', eventUrl: sender.url });
  }
  if (gmailSender(sender) && message.type === 'ripple:heartbeat') {
    const config = await read(); if (sender.tab.id === config.tabId) void pump(); return { ok: true };
  }
  if (gmailSender(sender) && message.type === 'ripple:before-send') return runner.beforeSend(sender.tab.id, message.jobId);
  if (!popupSender(sender)) throw new Error('Untrusted extension message.');
  if (message.type === 'ripple:status') {
    const config = await read();
    return { paired: !!config.token, enabled: !!config.enabled, account: config.account, tabId: config.tabId, status: config.status || 'Pair with local Ripple to begin.', replyStatus: config.replyStatus, lastReplyAt: config.lastReplyAt, inFlight: config.inFlight ? { jobId: config.inFlight.job?.id, phase: config.inFlight.phase, error: config.inFlight.error } : null, lastResult: config.lastResult };
  }
  if (message.type === 'ripple:pair') {
    const config = await read();
    if (config.inFlight) throw new Error('Resolve the interrupted email in Ripple before pairing again.');
    if (!/^[a-f0-9]{64}$/.test(message.token || '') || !Number.isInteger(message.tabId)) throw new Error('Enter the local pairing token and select a Gmail tab.');
    const ready = await chrome.tabs.sendMessage(message.tabId, { type: 'ripple:ready' });
    if (!ready?.ready || !ready.account) throw new Error(ready?.reason || 'Reload the Gmail tab after installation and close its drafts.');
    await post({ token: message.token }, '/status', { account: ready.account });
    await write({ token: message.token, tabId: message.tabId, account: ready.account, enabled: true, status: 'Paired. Approved messages will go to your inbox or the configured demo recipient.' });
    void pump(); return { ok: true };
  }
  if (message.type === 'ripple:pause') { await write({ enabled: false, status: 'Paused. Pending approvals will stay queued.' }); return { ok: true }; }
  if (message.type === 'ripple:resume') {
    const config = await read(); if (!config.token || config.inFlight) throw new Error('Pair first, or reconcile the interrupted email before resuming.');
    await write({ enabled: true }); void pump(); return { ok: true };
  }
  if (message.type === 'ripple:check') { void pump(); return { ok: true }; }
  throw new Error('Unsupported extension message.');
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  handle(message, sender).then(reply, error => reply({ error: error instanceof Error ? error.message : 'Mail worker error.' })); return true;
});
async function ensureAlarm() { if (!await chrome.alarms.get('ripple-mail')) await chrome.alarms.create('ripple-mail', { periodInMinutes: 0.5 }); }
chrome.runtime.onInstalled.addListener(() => { void ensureAlarm(); });
chrome.runtime.onStartup.addListener(() => { void ensureAlarm(); });
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'ripple-mail') void pump(); });
void ensureAlarm();
