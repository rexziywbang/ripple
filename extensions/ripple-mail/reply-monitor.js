const subjectKey = value => value.replace(/^(?:\s*re\s*:\s*)+/i,'').trim().replace(/\s+/g,' ').toLowerCase();
const bodyKey = value => value.replace(/\r\n?/g,'\n').replace(/\u00a0/g,' ').trim();
const address = value => String(value || '').trim().toLowerCase();

/** Select only later distinct messages after a verified copy of our delivered outbound message. */
export function buildReplyCaptures(target, thread, seenIds = [], observedAt = new Date().toISOString()) {
  if (!thread || subjectKey(thread.subject || '') !== subjectKey(target.subject) || !Array.isArray(thread.messages)) return [];
  const claimed = Date.parse(target.claimedAt), completed = Date.parse(target.completedAt);
  const anchors = thread.messages.filter(message => address(message.sender) === address(target.account)
    && message.recipientAddresses?.some(value => address(value) === address(target.expectedSender))
    && bodyKey(message.body || '') === bodyKey(target.body)
    && Date.parse(message.receivedAt) >= claimed - 60000 && Date.parse(message.receivedAt) <= completed + 60000);
  if (anchors.length !== 1) return [];
  const anchor = anchors[0]; const seen = new Set([...seenIds, ...(target.capturedExternalIds || [])]);
  return thread.messages.filter(message => !seen.has(message.externalId) && message.externalId !== anchor.externalId
    && message.messageIndex > anchor.messageIndex && Date.parse(message.receivedAt) >= Date.parse(anchor.receivedAt)
    && Date.parse(message.receivedAt) + 60000 >= completed && Date.parse(message.receivedAt) <= Date.parse(observedAt) + 60000
    && address(message.sender) === address(target.expectedSender)
    && message.recipientAddresses?.some(value => address(value) === address(target.account))
    && bodyKey(message.body || '') !== bodyKey(target.body)).map(message => ({
      message: { externalId: message.externalId, subject: thread.subject, body: message.body, sender: message.sender, receivedAt: message.receivedAt, url: thread.url },
      provenance: { method: 'gmail_visible_thread', observedAt, browserTimezone: thread.browserTimezone, threadSubject: thread.subject, threadUrl: thread.url, threadId: thread.threadId,
        subjectSource: 'gmail_thread_heading', receivedAtLabel: message.receivedAtLabel, messageIndex: message.messageIndex, recipientAddresses: message.recipientAddresses,
        outbound: { externalId: anchor.externalId, sender: anchor.sender, recipientAddresses: anchor.recipientAddresses, body: anchor.body, receivedAt: anchor.receivedAt, receivedAtLabel: anchor.receivedAtLabel, messageIndex: anchor.messageIndex } }
    }));
}

export function createReplyMonitor({ read, write, post, tabMessage, now = () => Date.now() }) {
  let busy = false;
  return async function monitor() {
    if (busy) return; busy = true;
    try {
      const config = await read();
      if (!config.enabled || !config.token || config.inFlight || !Number.isInteger(config.tabId) || now() - (config.lastReplyCheckAt || 0) < 15000) return;
      const ready = await tabMessage(config.tabId, { type: 'ripple:ready' });
      if (!ready?.ready || address(ready.account) !== address(config.account)) return;
      const targets = await post(config, '/reply-targets', { account: config.account });
      await write({ lastReplyCheckAt: now() });
      if (!targets.length) { await write({ replyStatus: 'No delivered Ripple emails to monitor yet.' }); return; }
      const index = (config.replyCursor || 0) % targets.length; const target = targets[index];
      await write({ replyCursor: (index + 1) % targets.length });
      const thread = await tabMessage(config.tabId, { type: 'ripple:scan-replies', target });
      if (thread?.error) { await write({ replyStatus: thread.error }); return; }
      const seen = config.capturedReplyIds || [];
      const captures = buildReplyCaptures(target, thread, seen, new Date(now()).toISOString());
      for (const capture of captures) {
        const result = await post(config, `/jobs/${encodeURIComponent(target.jobId)}/replies`, { account: config.account, ...capture });
        if (result?.captured === true && result.externalId === capture.message.externalId) {
          seen.push(capture.message.externalId);
          await write({ capturedReplyIds: Array.from(new Set(seen)).slice(-2000), lastReplyAt: new Date(now()).toISOString() });
        }
      }
      await write({ replyStatus: captures.length ? `Captured ${captures.length} matching ${captures.length === 1 ? 'reply' : 'replies'} for Ripple review.` : 'Watching delivered Ripple email threads for new replies.' });
    } catch (error) {
      await write({ replyStatus: `Reply monitor waiting: ${error instanceof Error ? error.message : 'Gmail unavailable'}` });
    } finally { busy = false; }
  };
}
