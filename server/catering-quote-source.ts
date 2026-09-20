import type { Facts, Message, Source } from '../shared/types.js';
import { parseVendorQuote, type VendorQuote } from './mail-replies.js';

export type CateringQuoteCandidate = {
  sourceId: string;
  title: string;
  path: string;
  quote: VendorQuote;
  provenance: 'document' | 'received_email';
  simulated: boolean;
  receivedAt?: string;
  externalId?: string;
};
export type CateringQuoteSelection = { kind: 'match'; candidate: CateringQuoteCandidate }
  | { kind: 'none' | 'ambiguous'; reason: string };

type QuoteContext = Pick<Facts, 'caterer' | 'date' | 'attendance'>;
const identity = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[’']/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
// Exact identity, with the existing app's explicit location aliases. No fuzzy brand guessing.
export function quoteVendorIdentity(value: string) {
  const name = identity(value);
  if (['shah halal', 'shahs halal food', 'shahs halal food boston', 'shahs halal food boston cambridge street'].includes(name)) return 'shahs-boston-cambridge-street';
  if (['cava', 'cava harvard square'].includes(name)) return 'cava-harvard-square';
  return name;
}
export function quoteMatchesEvent(quote: VendorQuote, facts: QuoteContext) {
  return quoteVendorIdentity(quote.vendor) === quoteVendorIdentity(facts.caterer)
    && quote.eventDate === facts.date && quote.guestCount === facts.attendance;
}
function documentText(content: string) {
  return content.replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/^\s*[-*]\s+(?=(?:Vendor|Caterer|Company|Event date|Date|Guests|Headcount|Per person|Per guest|Delivery|Quoted total|Total)\s*:)/gim, '');
}
const fictional = (content: string) => /\bfictional\b|\b(?:demo|sample|example|scenario)\s+(?:catering\s+)?(?:quote|quotation|estimate|terms)\b/i.test(content);
const amounts = (quote: VendorQuote) => JSON.stringify([quote.perPersonCents, quote.deliveryCents, quote.totalCents]);

/** Read explicitly imported documents or previously accepted received mail, never outgoing drafts or fixture prose. */
export function selectCateringQuoteSource(input: {
  facts: QuoteContext;
  sources: readonly Source[];
  messages?: readonly Message[];
  acceptedReplyIds?: readonly string[];
  mailMode?: 'rehearsal' | 'live';
}): CateringQuoteSelection {
  const candidates: CateringQuoteCandidate[] = [];
  const rehearsal = input.mailMode === 'rehearsal';
  for (const source of input.sources) {
    if (!source.material) continue;
    const simulated = source.material.provenance === 'fictional_scenario' || fictional(source.content);
    if (simulated && !rehearsal) continue;
    const parsed = parseVendorQuote({ externalId: source.id, body: documentText(source.content), subject: source.title,
      sender: 'imported event document', receivedAt: '2000-01-01T00:00:00.000Z' });
    if (parsed.kind === 'quote' && quoteMatchesEvent(parsed.quote, input.facts)) {
      candidates.push({ sourceId: source.id, title: source.title, path: source.path, quote: parsed.quote, provenance: 'document', simulated });
    }
  }
  const accepted = new Set(input.acceptedReplyIds ?? []);
  for (const message of input.messages ?? []) {
    if (message.direction !== 'inbound' || !message.externalId || !accepted.has(message.externalId)) continue;
    const source = input.sources.find(candidate => candidate.id === `gmail:${message.externalId}`);
    if (!source) continue;
    const simulated = message.simulated || fictional(message.body);
    if (simulated && !rehearsal) continue;
    const parsed = parseVendorQuote({ externalId: message.externalId, body: message.body, subject: message.subject, sender: message.from, receivedAt: message.at });
    if (parsed.kind === 'quote' && quoteMatchesEvent(parsed.quote, input.facts)) {
      candidates.push({ sourceId: source.id, title: source.title, path: source.path, quote: parsed.quote,
        provenance: 'received_email', simulated, receivedAt: message.at, externalId: message.externalId });
    }
  }
  if (!candidates.length) return { kind: 'none', reason: 'No complete quote matches this vendor, date, and guest count.' };
  const received = candidates.filter(candidate => candidate.provenance === 'received_email')
    .sort((a, b) => Date.parse(b.receivedAt!) - Date.parse(a.receivedAt!));
  // Accepted mail was already matched to a delivered request. Its latest quote outranks an older imported document.
  if (received.length) {
    const latest = received.filter(candidate => candidate.receivedAt === received[0].receivedAt);
    if (new Set(latest.map(candidate => amounts(candidate.quote))).size > 1) return { kind: 'ambiguous', reason: 'Conflicting received quotes need review.' };
    return { kind: 'match', candidate: received[0] };
  }
  if (new Set(candidates.map(candidate => amounts(candidate.quote))).size > 1) return { kind: 'ambiguous', reason: 'Conflicting document quotes need review.' };
  return { kind: 'match', candidate: candidates[0] };
}
