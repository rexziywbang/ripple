import { describe, expect, it } from 'vitest';
import { buildChangeImpact } from '../server/change-impact.js';
import { initialFacts } from '../server/fixtures.js';
import type { Area, Proposal, Receipt } from '../shared/types.js';

const change = { id: 'guest-change', title: 'Guest count changed', before: { attendance: 100 }, after: { attendance: 120 } };
const facts = { ...initialFacts, attendance: 120 };
function proposal(area: Area, kind: Proposal['kind'], status: Proposal['status'] = 'pending', extra: Partial<Proposal> = {}): Proposal {
  return { id: `${area}-${kind}`, area, kind, status, title: 'Prepared update', description: 'Prepared update', before: '', after: '', costImpactCents: null, evidence: [], dependencies: [], version: 1, createdAt: '2026-09-20T10:00:00Z', ...extra };
}
function receipt(p: Proposal, status: Receipt['status'] = 'local', at = '2026-09-20T10:01:00Z'): Receipt {
  return { id: `${p.id}-${status}`, proposalId: p.id, status, at, title: 'Recorded result', provider: 'Local planning folder', detail: 'Recorded result' };
}

describe('causal change impact', () => {
  it('connects a guest-count change to real catering, staffing, room and budget consequences', () => {
    const budget = proposal('budget', 'file', 'applied');
    const proposals = [proposal('catering', 'email'), proposal('staff', 'fact', 'pending', { patch: { staffCount: 2 } }), proposal('venue', 'warning'), budget];
    const impact = buildChangeImpact({ facts, change, proposals, receipts: [receipt(budget)], budget: { totalCents: 1274000, lines: [] } })!;
    expect(impact).toMatchObject({ id: 'guest-change', area: 'guests', before: '100 guests', after: '120 guests' });
    expect(impact.nodes.find(node => node.id === 'catering')).toMatchObject({ status: 'review', proposalIds: ['catering-email'], detail: '120 planned meals' });
    expect(impact.nodes.find(node => node.id === 'staff')?.detail).toContain('4 → 2 staff proposed');
    expect(impact.nodes.find(node => node.id === 'budget')).toMatchObject({ status: 'updated', detail: '$12,740 forecast / $18,000 limit · 1 file updated locally' });
    for (const to of ['catering', 'staff', 'venue']) expect(impact.edges).toContainEqual({ from: 'change', to });
    for (const from of ['catering', 'staff', 'venue']) expect(impact.edges).toContainEqual({ from, to: 'budget' });
  });

  it('uses human-readable venue and money roots without substituting later facts', () => {
    const venue = buildChangeImpact({ facts, change: { id: 'venue-change', title: 'Venue updated', before: { venue: 'Garden Hall' }, after: { venue: 'Boston Marriott Cambridge' } }, proposals: [], receipts: [] })!;
    expect(venue).toMatchObject({ area: 'venue', before: 'Garden Hall', after: 'Boston Marriott Cambridge' });
    const budget = buildChangeImpact({ facts, change: { id: 'budget-change', title: 'Budget updated', before: { budgetLimitCents: 1300000 }, after: { budgetLimitCents: 1200000 } }, proposals: [], receipts: [] })!;
    expect(budget).toMatchObject({ area: 'budget', before: '$13,000', after: '$12,000' });
  });

  it('does not label an applied flag as an updated document without a receipt', () => {
    const file = proposal('budget', 'file', 'applied');
    const impact = buildChangeImpact({ facts, change, proposals: [file], receipts: [] })!;
    expect(impact.nodes[0].status).toBe('checking'); expect(impact.nodes[0].detail).not.toContain('updated locally');
  });

  it('keeps queued and dependency-blocked work waiting without a sent claim', () => {
    const approved = proposal('catering', 'email', 'approved');
    const blocked = proposal('budget', 'fact', 'pending', { dependencies: [approved.id] });
    const impact = buildChangeImpact({ facts, change, proposals: [approved, blocked], receipts: [] })!;
    expect(impact.nodes.every(node => node.status === 'waiting')).toBe(true);
    expect(JSON.stringify(impact)).not.toMatch(/sent|delivered|updated locally/i);
  });

  it('does not hide failed delivery under an earlier receipt', () => {
    const email = proposal('catering', 'email', 'approved');
    const impact = buildChangeImpact({ facts, change, proposals: [email], receipts: [receipt(email, 'failed', '2026-09-20T10:02:00Z'), receipt(email, 'local')] })!;
    expect(impact.nodes[0]).toMatchObject({ status: 'waiting' }); expect(impact.nodes[0].detail).toContain('Needs attention');
  });

  it('records real or simulated receipts without claiming an email was sent', () => {
    for (const status of ['delivered', 'simulated'] as const) {
      const email = proposal('catering', 'email', 'applied');
      const impact = buildChangeImpact({ facts, change, proposals: [email], receipts: [receipt(email, status)] })!;
      expect(impact.nodes[0]).toMatchObject({ status: 'updated' }); if (status === 'simulated') expect(impact.nodes[0].detail).toContain('Recorded locally');
      expect(impact.nodes[0].detail).not.toMatch(/sent|delivered/);
    }
  });

  it('compares supported catering and forecast amounts and includes applied local cost consequences', () => {
    const catering = proposal('catering', 'email'); const budget = proposal('budget', 'file', 'applied');
    const values = { ...facts, staffCount: 2 };
    const staff = proposal('staff', 'fact', 'applied', { patch: { staffCount: 2 }, costImpactCents: -60000 });
    const impact = buildChangeImpact({ facts: values, change, proposals: [catering, budget, staff], receipts: [receipt(budget), receipt(staff)], budget: { totalCents: 1248000, lines: [{ label: 'Catering', amountCents: 288000, status: 'confirmed', detail: '' }] } })!;
    expect(impact.nodes.find(node => node.id === 'catering')?.detail).toContain('$2,400 → $2,880');
    expect(impact.nodes.find(node => node.id === 'budget')?.detail).toContain('$12,600 → $12,480 forecast');
  });

  it('does not invent earlier quote totals when the current quote is unknown or a fixed vendor commitment', () => {
    for (const status of ['awaiting_quote', 'confirmed'] as const) {
      const impact = buildChangeImpact({ facts: { ...facts, cateringStatus: status }, change, proposals: [proposal('catering', 'email'), proposal('budget', 'file')], receipts: [], budget: { totalCents: 1274000, lines: [{ label: 'Previous vendor commitment', amountCents: 500000, status: 'committed', detail: '' }] } })!;
      expect(impact.nodes.find(node => node.id === 'catering')?.detail).not.toContain('→');
      expect(impact.nodes.find(node => node.id === 'budget')?.detail).not.toContain('→');
    }
  });

  it('resolves prerequisites from another change without displaying that unrelated proposal', () => {
    const prior = proposal('equipment', 'email', 'applied');
    const current = proposal('budget', 'fact', 'pending', { dependencies: [prior.id] });
    const impact = buildChangeImpact({ facts, change, proposals: [current], allProposals: [prior, current], receipts: [] })!;
    expect(impact.nodes).toHaveLength(1); expect(impact.nodes[0]).toMatchObject({ status: 'review', proposalIds: [current.id] });
  });

  it('drops obsolete decisions and keeps capacity uncertainty separate from price uncertainty', () => {
    const known = buildChangeImpact({ facts: { ...facts, attendance: 300, venueDetailsPending: true, venueCapacityPending: false }, change, proposals: [proposal('venue', 'warning'), proposal('catering', 'email', 'stale'), proposal('staff', 'fact', 'denied')], receipts: [] })!;
    expect(known.nodes).toHaveLength(1); expect(known.nodes[0].detail).toContain('40 seats short');
    const unknown = buildChangeImpact({ facts: { ...facts, venueCapacityPending: true }, change, proposals: [proposal('venue', 'warning')], receipts: [] })!;
    expect(unknown.nodes[0].detail).toContain('Capacity unconfirmed'); expect(unknown.nodes[0].detail).not.toContain('260 places');
  });

  it('shows checking branches only when planning is active, without fake completion', () => {
    const impact = buildChangeImpact({ facts, change, proposals: [], receipts: [], planning: true })!;
    expect(impact.nodes.map(node => node.area)).toEqual(['catering', 'staff', 'venue', 'budget']);
    expect(impact.nodes.every(node => node.status === 'checking' && node.proposalIds.length === 0)).toBe(true);
    expect(buildChangeImpact({ facts, change, proposals: [], receipts: [] })!.nodes).toEqual([]);
  });

  it('caps groups at six and never creates dangling or duplicate edges', () => {
    const areas: Area[] = ['venue', 'guests', 'staff', 'catering', 'budget', 'equipment', 'brief'];
    const proposals = areas.map(area => proposal(area, 'file', 'applied'));
    const impact = buildChangeImpact({ facts, change, proposals, receipts: proposals.map(p => receipt(p)) })!;
    expect(impact.nodes).toHaveLength(6); const ids = ['change', ...impact.nodes.map(node => node.id)];
    expect(impact.edges.every(edge => ids.includes(edge.from) && ids.includes(edge.to) && edge.from !== edge.to)).toBe(true);
    expect(new Set(impact.edges.map(edge => `${edge.from}/${edge.to}`)).size).toBe(impact.edges.length);
  });

  it('retains the initiating note without inventing before/after values', () => {
    const impact = buildChangeImpact({ facts, note: 'Add another projector', area: 'equipment', proposals: [proposal('equipment', 'plan')], receipts: [] })!;
    expect(impact).toMatchObject({ area: 'equipment', note: 'Add another projector' }); expect(impact.before).toBeUndefined(); expect(impact.after).toBeUndefined();
    expect(impact.nodes[0].status).toBe('review');
    expect(buildChangeImpact({ facts, proposals: [], receipts: [] })).toBeUndefined();
  });
});
