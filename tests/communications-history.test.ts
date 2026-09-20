import { describe, expect, it } from 'vitest';
import type { Message, ProjectState, Proposal } from '../shared/types';
import { messagePresentation, vendorSummary } from '../web/src/CommunicationsHistory';

const project: ProjectState['project'] = {
  id: 'event', name: 'Dinner', revision: 2, createdAt: '2026-09-19T12:00:00Z',
  facts: { attendance: 240, date: '2026-12-11', time: '18:00', timezone: 'America/Detroit', format: 'Dinner',
    venue: 'Hall', venueAddress: '', venueCapacity: 400, venueCostCents: 300000, venueIncludesAV: false,
    caterer: 'CAVA', cateringPerPersonCents: 2400, cateringDeliveryCents: 15000, cateringStatus: 'awaiting_quote',
    dietary: '', staffCount: 4, staffCostEachCents: 18000, equipmentCostCents: 0, budgetLimitCents: 2000000, sunkCostCents: 0, notes: '' },
};
const request: Proposal = { id: 'quote', title: 'Request a quote from CAVA', area: 'catering', description: '', before: '', after: '',
  costImpactCents: null, status: 'pending', kind: 'email', evidence: [], dependencies: [], version: 2, createdAt: '2026-09-19T12:00:00Z' };
const message: Message = { id: 'm', at: '2026-09-19T12:00:00Z', from: 'vendor@example.com', subject: 'Quote', body: 'Exact quote body', direction: 'inbound', simulated: false, url: 'https://mail.google.com/mail/u/0/#inbox/thread' };

describe('communication provenance and vendor state', () => {
  it('keeps local records distinct from actual incoming and outgoing Gmail messages', () => {
    expect(messagePresentation(message)).toMatchObject({ direction: 'Incoming', status: 'Received', gmailUrl: message.url });
    expect(messagePresentation({ ...message, direction: 'outbound' })).toMatchObject({ direction: 'Outgoing', status: 'Sent' });
    expect(messagePresentation({ ...message, simulated: true })).toEqual({ direction: 'Incoming', status: 'Recorded', gmailUrl: undefined });
  });
  it('does not label arbitrary message URLs as Gmail receipts', () => {
    for (const url of ['https://mail.google.com.evil.example/thread', 'javascript:alert(1)', 'https://example.com/', 'https://user@mail.google.com/mail/']) {
      expect(messagePresentation({ ...message, url }).gmailUrl).toBeUndefined();
    }
  });
  it('shows the unsent approval step and hides previous catering prices while a quote is pending', () => {
    const summary = vendorSummary({ project, proposals: [request], receipts: [] });
    expect(summary.label).toBe('Quote request ready');
    expect(summary.priced).toBe(false);
    expect(summary.detail).not.toContain('delivered');
  });
  it('does not claim delivery when the quote request has only been approved', () => {
    const summary = vendorSummary({ project, proposals: [{ ...request, status: 'approved' }], receipts: [] });
    expect(summary.detail).toContain('queued');
    expect(summary.priced).toBe(false);
  });
  it('requires a sending receipt before calling a recorded request sent', () => {
    const record = { id: 'r', at: message.at, title: request.title, provider: 'Email', proposalId: request.id, detail: '' };
    const props = { project, proposals: [{ ...request, status: 'applied' as const }] };
    expect(vendorSummary({ ...props, receipts: [{ ...record, status: 'simulated' }] }).label).toBe('Quote request recorded');
    expect(vendorSummary({ ...props, receipts: [{ ...record, status: 'delivered' }] }).detail).toContain('Request sent');
  });
  it('distinguishes a priced quote from a confirmed booking', () => {
    const quoted = vendorSummary({ project: { ...project, facts: { ...project.facts, cateringStatus: 'quoted' } }, proposals: [], receipts: [] });
    expect(quoted.priced).toBe(true);
    expect(quoted.label).toBe('Quote received');
    expect(quoted.detail).toContain('still needs booking approval');
    const confirming = vendorSummary({ project: { ...project, facts: { ...project.facts, cateringStatus: 'awaiting_confirmation' } }, proposals: [], receipts: [] });
    expect(confirming.label).toBe('Awaiting booking confirmation');
  });
});
