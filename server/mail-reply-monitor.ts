import { z } from 'zod';
import type { LiveJob } from './live-bridge.js';
import type { CapturedMailMessage } from './mail-replies.js';

const email = z.string().trim().email().max(320);
const timestamp = z.string().datetime({ offset: true });
const messageId = z.string().min(1).max(500);
const gmailUrl = z.string().url().max(2000).refine(value => {
  const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'mail.google.com' && !url.username && !url.password && !url.port;
}, 'Use the observed Gmail thread URL.');
export const observedReplySchema = z.object({
  message: z.object({ externalId: messageId, body: z.string().min(1).max(16000), subject: z.string().max(1000), sender: email, receivedAt: timestamp, url: gmailUrl }).strict(),
  provenance: z.object({
    method: z.literal('gmail_visible_thread'), observedAt: timestamp, browserTimezone: z.string().min(1).max(100),
    threadSubject: z.string().min(1).max(1000), threadUrl: gmailUrl, threadId: z.string().min(1).max(500),
    subjectSource: z.literal('gmail_thread_heading'), receivedAtLabel: z.string().min(1).max(200),
    messageIndex: z.number().int().min(0), recipientAddresses: z.array(email).min(1).max(20),
    outbound: z.object({ externalId: messageId, sender: email, recipientAddresses: z.array(email).min(1).max(20), body: z.string().min(1).max(16000), receivedAt: timestamp, receivedAtLabel: z.string().min(1).max(200), messageIndex: z.number().int().min(0) }).strict()
  }).strict()
}).strict();
export type ObservedReply = z.infer<typeof observedReplySchema>;
export type MonitoredMailMessage = CapturedMailMessage & { url: string; browserProvenance: ObservedReply['provenance'] };
export const mailSubjectKey = (value: string) => value.replace(/^(?:\s*re\s*:\s*)+/i, '').trim().replace(/\s+/g,' ').toLowerCase();
const bodyKey = (value: string) => value.replace(/\r\n?/g,'\n').replace(/\u00a0/g,' ').trim();
const address = (value: string) => value.trim().toLowerCase();
export function gmailThreadKey(value?: string): string | undefined {
  if (!value) return;
  try { const url = new URL(value); const parts = url.hash.slice(1).split('/'); const key = parts.at(-1); return url.hostname === 'mail.google.com' && parts.length > 1 && key && /^[A-Za-z0-9_-]{12,}$/.test(key) ? key : undefined; } catch { return; }
}

/** The visible outbound anchor makes a self-addressed reply distinguishable from its sent echo. */
export function validateObservedReply(job: LiveJob, account: string, capture: ObservedReply): MonitoredMailMessage {
  if (job.provider !== 'email' || job.action !== 'send_email' || job.status !== 'completed' || !job.receipt) throw new Error('Only delivered Ripple emails can be monitored.');
  const payload = job.payload; const { message, provenance } = capture; const anchor = provenance.outbound;
  if (typeof payload.account !== 'string' || typeof payload.recipient !== 'string' || typeof payload.subject !== 'string' || typeof payload.body !== 'string') throw new Error('The delivered email is incomplete.');
  const recipient = payload.recipient;
  if (address(payload.account) !== address(account) || address(message.sender) !== address(payload.recipient)) throw new Error('Reply account or sender does not match the delivered email.');
  if (mailSubjectKey(message.subject) !== mailSubjectKey(payload.subject) || mailSubjectKey(provenance.threadSubject) !== mailSubjectKey(payload.subject)) throw new Error('The observed thread subject does not match the delivered email.');
  if (message.url !== provenance.threadUrl || !gmailThreadKey(message.url)) throw new Error('A specific observed Gmail thread is required.');
  const expectedThread = gmailThreadKey(job.receipt.url);
  if (expectedThread && expectedThread !== gmailThreadKey(message.url)) throw new Error('The reply belongs to a different Gmail thread.');
  if (address(anchor.sender) !== address(account) || !anchor.recipientAddresses.some(value => address(value) === address(recipient)) || bodyKey(anchor.body) !== bodyKey(payload.body)) throw new Error('The visible original message does not match the approved outbound email.');
  if (message.externalId === anchor.externalId || provenance.messageIndex <= anchor.messageIndex || bodyKey(message.body) === bodyKey(payload.body)) throw new Error('The outbound message or its echo is not a new reply.');
  if (!provenance.recipientAddresses.some(value => address(value) === address(account))) throw new Error('The reply was not addressed to the paired account.');
  const received = Date.parse(message.receivedAt), sent = Date.parse(anchor.receivedAt), completed = Date.parse(job.receipt.completedAt), claimed = Date.parse(job.claimedAt || job.createdAt), observed = Date.parse(provenance.observedAt);
  // Gmail displays minute precision; the later distinct message index disambiguates same-minute replies.
  if (sent < claimed - 60000 || sent > completed + 60000 || received < sent || received + 60000 < completed || received > observed + 60000 || observed > Date.now() + 60000) throw new Error('The captured reply is older than the tracked send or has an invalid observation time.');
  return { ...message, browserProvenance: provenance };
}
