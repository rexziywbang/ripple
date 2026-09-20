export type CapturedMailMessage = {
  externalId: string;
  body: string;
  subject: string;
  sender: string;
  receivedAt: string;
};
export type VendorQuote = {
  vendor: string;
  eventDate: string;
  guestCount: number;
  perPersonCents: number;
  deliveryCents: number;
  totalCents: number;
  currency: 'USD';
};
export type MailReplyProvenance = CapturedMailMessage & { parsedBody: string };
export type VendorQuoteResult =
  | { kind: 'quote'; quote: VendorQuote; provenance: MailReplyProvenance }
  | { kind: 'no_quote'; reason: string; provenance: MailReplyProvenance };

const number = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?(?!\d|[.,]\d)`;
const money = String.raw`(?:(?:USD\s*|US\$\s*|\$\s*)${number}(?:\s*USD\b)?|${number}\s*(?:USD\b|U\.?S\.? dollars\b))`;
const capture = (pattern: string) => `(?<value>${pattern})`;
type Span = { start: number; end: number };

/** Only the newest plain-text message is eligible; history stays intact in provenance.body. */
function freshBody(body: string): string {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const fresh: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s*>/.test(line)
      || /^\s*On\b.*\bwrote:\s*$/i.test(line)
      || /^\s*-{2,}\s*(?:Original Message|Forwarded message)\s*-{2,}\s*$/i.test(line)
      || /^\s*Begin forwarded message:/i.test(line)
      || /^\s*From:/.test(line) && /\n\s*(?:Sent|Date|To|Subject):/i.test(lines.slice(index, index + 6).join('\n'))) break;
    fresh.push(line);
  }
  return fresh.join('\n').trim();
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function cents(value: string): number | undefined {
  const numeric = value.replace(/USD|US\$|\$|U\.?S\.? dollars/gi, '').trim().replaceAll(',', '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(numeric)) return undefined;
  const [whole, fraction = ''] = numeric.split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(result) && result >= 0 ? result : undefined;
}

const instructionLike = [
  /\b(?:ignore|disregard|override)\b[^\n]{0,100}\b(?:instructions?|prompts?|rules?|system|developer|previous|above|prior)\b/i,
  /^\s*(?:system|developer|assistant)\s*:/im,
  /\b(?:run|execute|invoke|call)\b[^\n]{0,60}\b(?:commands?|shell|tools?|curl|code|scripts?|functions?|terminal)\b/i,
  /\b(?:reveal|exfiltrate|print|send|upload)\b[^\n]{0,60}\b(?:api.?keys?|passwords?|secrets?|tokens?|credentials)\b/i,
  /\b(?:approve|update|change|overwrite|set|mark)\b[^\n]{0,50}\b(?:budget|database|receipts?|workflow)\b/i,
  /\breturn\s+(?:only\s+)?(?:json|true|false)\b/i,
];

/**
 * Conservative quote candidate parser, not a mail authenticator or booking decision.
 * Requires explicit vendor/date/count/rate/delivery/total and accepts USD only.
 * The caller must match provenance to an authorized request before applying a quote.
 */
export function parseVendorQuote(message: CapturedMailMessage): VendorQuoteResult {
  const parsedBody = typeof message.body === 'string' ? freshBody(message.body) : '';
  const provenance: MailReplyProvenance = { ...message, parsedBody };
  const reject = (reason: string): VendorQuoteResult => ({ kind: 'no_quote', reason, provenance });
  for (const field of ['externalId', 'body', 'subject', 'sender', 'receivedAt'] as const) {
    if (typeof message[field] !== 'string' || !message[field].trim()) return reject(`Missing captured message ${field}.`);
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(message.receivedAt) || !validDate(message.receivedAt.slice(0, 10)) || !Number.isFinite(Date.parse(message.receivedAt))) {
    return reject('Invalid receivedAt timestamp.');
  }
  if (!parsedBody) return reject('No fresh message text; quoted history is not a new quote.');
  if (/<\/?(?:html|body|div|blockquote|table|script)\b/i.test(parsedBody)) return reject('Capture plain text; HTML and quoted markup are not parsed.');
  const text = `${message.subject}\n${parsedBody}`;
  if (instructionLike.some(pattern => pattern.test(text))) return reject('Instruction-like content requires manual review; only quote data is parsed.');
  if (!/\b(?:quote|quotation|estimate)\b/i.test(text)) return reject('The message does not explicitly identify a quote or estimate.');
  if (/\b(?:quote|quotation|estimate)\s+request\b|\bplease\s+(?:provide\s+(?:a\s+)?)?(?:quote|estimate)\b/i.test(text)) return reject('A quote request is not a vendor quote.');
  if (/[^$\P{Sc}]/u.test(parsedBody) || /\b(?:EUR|GBP|CAD|AUD|NZD|SGD|HKD|JPY|CNY|RMB|INR|CHF|BTC|ETH|USDT)\b/i.test(parsedBody)) {
    return reject('Unsupported or mixed currency; only explicit USD amounts or US dollar signs are supported.');
  }
  const currencyLabels = [...parsedBody.matchAll(/^\s*currency\s*:\s*(.+)$/gim)];
  if (currencyLabels.some(match => !/^(?:USD|U\.?S\.? dollars)\s*$/i.test(match[1]))) return reject('Unrecognized currency label.');
  if (/(?:[-−]\s*(?:USD|US\$|\$)|(?:USD|US\$|\$)\s*[-−])\s*\d/i.test(parsedBody)) return reject('Negative monetary amounts require manual review.');

  const monetarySpans: Span[] = [];
  function collect<T extends string | number>(source: string, patterns: string[], parse: (value: string) => T | undefined, monetary = false): { value?: T; error?: string } {
    const values: T[] = [];
    for (const pattern of patterns) {
      // Quote fields are line-local: a price must not attach to the next line's label.
      const linePattern = pattern.replaceAll(String.raw`\s`, '[\\t ]');
      for (const match of source.matchAll(new RegExp(linePattern, 'gimu'))) {
        const value = parse(match.groups!.value);
        if (value === undefined) return { error: 'invalid' };
        values.push(value);
        if (monetary) monetarySpans.push({ start: match.index!, end: match.index! + match[0].length });
      }
    }
    const unique = [...new Set(values)];
    return unique.length > 1 ? { error: 'conflicting' } : { value: unique[0] };
  }
  const parseVendor = (value: string): string | undefined => {
    const trimmed = value.trim();
    return trimmed.length > 0 && trimmed.length <= 160 && !/[\r\n<>$]/.test(trimmed) ? trimmed : undefined;
  };
  const labeledVendor = collect(parsedBody, [
    String.raw`^\s*(?:vendor|caterer|company)\s*:\s*${capture('[^\\n]+')}\s*$`,
  ], parseVendor);
  // Explicit body labels take precedence over generic titles such as "Sample quote".
  const vendor = labeledVendor.value !== undefined || labeledVendor.error ? labeledVendor : collect(text.replace(/^(?:re|fw|fwd):\s*/i, ''), [
    String.raw`^\s*(?:catering\s+)?(?:quote|quotation|estimate)\s+from\s+${capture('[^:\\n]+?')}(?=\s+for\b|\s+on\b|:|$)`,
    String.raw`^\s*(?!(?:catering|quote|quotation|estimate)\b)${capture(String.raw`[\p{L}\d][\p{L}\d &'’().-]{0,100}?`)}\s+(?:catering\s+)?(?:quote|quotation|estimate)(?=\s+for\b|\s*:|\s*$)`,
  ], parseVendor);
  const eventDate = collect(parsedBody, [
    String.raw`^\s*(?:event\s+date|date)\s*[:=]\s*${capture(String.raw`\d{4}-\d{2}-\d{2}`)}\b`,
    String.raw`\bon\s+${capture(String.raw`\d{4}-\d{2}-\d{2}`)}\b`,
  ], value => validDate(value) ? value : undefined);
  const countNumber = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?![\d,.]|\s*[-–—]\s*\d)`;
  const guestCount = collect(parsedBody, [
    String.raw`\b(?:guests?|guest\s+count|headcount|attendees?|attendance)\s*[:=]\s*${capture(countNumber)}`,
    String.raw`(?<![\w.,+\-–—])${capture(countNumber)}\s+(?:guests?|attendees?|people)\b`,
  ], value => {
    const count = Number(value.replaceAll(',', ''));
    return Number.isSafeInteger(count) && count > 0 ? count : undefined;
  });
  const perPersonCents = collect(parsedBody, [
    String.raw`\b(?:per[- ](?:person|guest)|unit\s+(?:price|rate)|price\s+per\s+(?:person|guest)|rate)\s*[:=]\s*${capture(money)}`,
    String.raw`${capture(money)}\s*(?:per\s+(?:person|guest)|/\s*(?:person|guest|pp)\b|pp\b|each\b)`,
  ], cents, true);
  const deliveryCents = collect(parsedBody, [
    String.raw`\bdelivery(?:\s+(?:fee|charge|cost))?\s*[:=]?\s*${capture(money)}`,
    String.raw`${capture(money)}\s+(?:for\s+)?delivery\b`,
  ], cents, true);
  const totalCents = collect(parsedBody, [
    String.raw`\b(?:(?:quoted|quote|grand)\s+)?total(?:\s+(?:quote|cost|price|amount))?\s*[:=]?\s*${capture(money)}`,
    String.raw`${capture(money)}\s+(?:in\s+)?total\b`,
  ], cents, true);
  const fields = { vendor, eventDate, guestCount, perPersonCents, deliveryCents, totalCents };
  for (const [name, result] of Object.entries(fields)) {
    if (result.error) return reject(`${result.error === 'conflicting' ? 'Conflicting' : 'Invalid'} ${name} in fresh message.`);
    if (result.value === undefined) return reject(`Missing explicit ${name}; no amount or event detail is assumed.`);
  }
  // Every price must belong to one of the supported components, not an option, old rate, or extra fee.
  const priceMarkers = /(?:USD\s*|US\$\s*|\$\s*)[+-]?\d|[+-]?\d[\d,.]*\s*(?:USD\b|U\.?S\.? dollars\b)/gi;
  for (const match of parsedBody.matchAll(priceMarkers)) {
    if (!monetarySpans.some(span => match.index! >= span.start && match.index! + match[0].length <= span.end)) {
      return reject('Additional or ambiguous monetary amount requires manual review.');
    }
  }
  const calculated = guestCount.value! * perPersonCents.value! + deliveryCents.value!;
  if (!Number.isSafeInteger(calculated) || calculated !== totalCents.value) return reject('Quoted total does not reconcile guestCount × perPersonCents + deliveryCents.');
  return { kind: 'quote', quote: { vendor: vendor.value!, eventDate: eventDate.value!, guestCount: guestCount.value!,
    perPersonCents: perPersonCents.value!, deliveryCents: deliveryCents.value!, totalCents: totalCents.value!, currency: 'USD' }, provenance };
}
