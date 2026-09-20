import { describe, expect, it } from 'vitest';
import { selectCateringQuoteSource } from '../server/catering-quote-source';
import { prepareDropboxMaterials } from '../server/dropbox-materials';
import type { Message, Source } from '../shared/types';

const facts = { caterer: 'Maple Table Catering', date: '2026-12-11', attendance: 10 };
const body = (rate = 2750) => `# Catering quote\n**Vendor:** Maple Table Catering\nEvent date: 2026-12-11\nGuests: 10\nPer person: USD ${(rate / 100).toFixed(2)}\nDelivery: USD 18.00\nTotal: USD ${((10 * rate + 1800) / 100).toFixed(2)}`;
const documents = (content = body(), provenance: 'user_selected' | 'fictional_scenario' = 'user_selected') => prepareDropboxMaterials([{ path: 'Catering/Quote.md', content }], provenance);
const select = (sources: Source[], extra = {}) => selectCateringQuoteSource({ facts, sources, ...extra });

describe('source-backed catering quote selection', () => {
  it('parses an explicitly selected Markdown quote for a generic vendor', () => {
    expect(select(documents())).toMatchObject({ kind: 'match', candidate: { provenance: 'document', simulated: false, quote: { guestCount: 10, perPersonCents: 2750, deliveryCents: 1800, totalCents: 29300 } } });
  });
  it('does not reinterpret fixture prose or an outline as a current vendor quote', () => {
    expect(select([{ id: 'fixture', title: 'Quote example', area: 'catering', path: 'fixture.md', content: body() }]).kind).toBe('none');
    expect(select(documents('# Previous agreement\n240 guests at $24 per person.')).kind).toBe('none');
    expect(select(documents(body().replace('Delivery: USD 18.00\n', ''))).kind).toBe('none');
  });
  it('requires exact vendor identity, date and headcount without guessing aliases', () => {
    for (const changed of [{ ...facts, caterer: 'Maple Table Catering Boston' }, { ...facts, date: '2026-12-12' }, { ...facts, attendance: 240 }]) {
      expect(selectCateringQuoteSource({ facts: changed, sources: documents() }).kind).toBe('none');
    }
  });
  it('keeps conflicting complete quotes for review instead of choosing a cheap one', () => {
    const other = prepareDropboxMaterials([{ path: 'Catering/Other quote.md', content: body(3000) }]);
    expect(select([...documents(), ...other])).toMatchObject({ kind: 'ambiguous' });
  });
  it('allows explicitly fictional documents only in rehearsal, retaining that provenance', () => {
    const sources = documents(body(), 'fictional_scenario');
    expect(select(sources, { mailMode: 'live' }).kind).toBe('none');
    expect(select(sources, { mailMode: 'rehearsal' })).toMatchObject({ kind: 'match', candidate: { simulated: true, provenance: 'document' } });
  });
  it('never reads outgoing or unaccepted email as a quote; a validated received reply can supersede a document', () => {
    const message: Message = { id: 'message', externalId: 'mail-1', direction: 'inbound', simulated: false, from: 'vendor@example.net', at: '2026-09-20T00:00:00Z', subject: 'Catering quote', body: body(3000).replace(/\*\*/g, '').replace(/^# /, '') };
    const source: Source = { id: 'gmail:mail-1', title: 'Catering quote', path: 'https://mail.google.com/mail/u/0/#inbox/thread1', area: 'catering', content: 'Captured reply provenance' };
    expect(select([source], { messages: [message] }).kind).toBe('none');
    expect(select([source], { messages: [{ ...message, direction: 'outbound' }], acceptedReplyIds: ['mail-1'] }).kind).toBe('none');
    expect(select([...documents(), source], { messages: [message], acceptedReplyIds: ['mail-1'] })).toMatchObject({ kind: 'match', candidate: { provenance: 'received_email', externalId: 'mail-1', quote: { perPersonCents: 3000 } } });
  });
});
