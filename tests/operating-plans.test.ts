import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Proposal, Source } from '../shared/types';
import OperatingPlans, { savedOperatingPlans } from '../web/src/OperatingPlans';

const plan = (id: string, overrides: Partial<Proposal> = {}): Proposal => ({
  id, kind: 'plan', status: 'applied', title: 'Dinner service plan', area: 'staff',
  description: 'Four staff cover arrival and dinner service for 200 guests.',
  body: 'Draft proposal text', before: '', after: '', costImpactCents: null, evidence: [], dependencies: [],
  version: 2, createdAt: '2026-09-20T12:00:00Z', ...overrides,
});
const source = (id: string, body = '18:00 — Two staff greet arrivals.\n18:30 — Open dinner seating.'): Source => ({
  id: `approved-plan:${id}`, title: 'Dinner service plan', area: 'staff', path: '/Operating plans/service.md',
  content: `# Dinner service plan\n\n${body}`,
});

describe('saved operating plans', () => {
  it('shows the saved document after approval instead of reconstructing it from a proposal', () => {
    const document = source('service');
    const selected = savedOperatingPlans({ proposals: [plan('service')], sources: [document] });
    expect(selected).toHaveLength(1);
    expect(selected[0].body).toBe('18:00 — Two staff greet arrivals.\n18:30 — Open dinner seating.');
    expect(selected[0].body).not.toContain('Draft proposal text');
    expect(selected[0].reason).toContain('200 guests');
  });

  it('does not expose a pending, queued, denied, or superseded proposal as a saved plan', () => {
    for (const status of ['pending', 'approved', 'denied', 'stale', 'withdrawn', 'blocked'] as const) {
      expect(savedOperatingPlans({ proposals: [plan('service', { status })], sources: [source('service')] }), status).toEqual([]);
    }
    expect(savedOperatingPlans({ proposals: [plan('service', { kind: 'email' })], sources: [source('service')] })).toEqual([]);
  });

  it('hides a document when Undo or later context changes clear its source', () => {
    for (const sources of [[], [{ ...source('service'), content: '' }], [{ ...source('service'), content: ' \n ' }], [source('service', '')]]) {
      expect(savedOperatingPlans({ proposals: [plan('service')], sources })).toEqual([]);
    }
    expect(savedOperatingPlans({ proposals: [plan('service')], sources: [source('different-plan')] })).toEqual([]);
  });

  it('keeps independent saved plans available and puts the newer plan first', () => {
    const selected = savedOperatingPlans({
      proposals: [plan('old', { version: 1 }), plan('new', { version: 3 })],
      sources: [source('new', 'New plan'), source('old', 'Older still-valid plan')],
    });
    expect(selected.map(item => item.id)).toEqual(['new', 'old']);
    expect(selected.map(item => item.body)).toEqual(['New plan', 'Older still-valid plan']);
  });

  it('renders a compact document disclosure with escaped plain text and no send controls', () => {
    const markup = renderToStaticMarkup(createElement(OperatingPlans, {
      state: { proposals: [plan('service')], sources: [source('service', 'Check <script>alert(1)</script> & microphones.')] },
    }));
    expect(markup).toContain('<details');
    expect(markup).toContain('Operating plans');
    expect(markup).toContain('Saved for this event');
    expect(markup).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(markup).not.toContain('<button');
    expect(markup).not.toContain('<script>');
    expect(markup).not.toContain('Delivered');
  });

  it('adds no empty panel when no approved record is available', () => {
    expect(renderToStaticMarkup(createElement(OperatingPlans, { state: { proposals: [plan('pending', { status: 'pending' })], sources: [] } }))).toBe('');
  });

  it('shows only approved cards in the saved plan, leaving declined material out', () => {
    const proposal = plan('service', { planCards: [
      { id: 'keep', title: 'Arrival', body: 'Approved arrival instructions.', status: 'approved', revision: 1, revisionToken: 'approved' },
      { id: 'drop', title: 'Unwanted option', body: 'Declined instructions.', status: 'denied', revision: 1, revisionToken: 'denied' },
    ] });
    const state = { proposals: [proposal], sources: [source('service')] };
    expect(savedOperatingPlans(state)[0].cards.map(card => card.id)).toEqual(['keep']);
    const markup = renderToStaticMarkup(createElement(OperatingPlans, { state }));
    expect(markup).toContain('Approved arrival instructions.');
    expect(markup).not.toContain('Declined instructions.');
    expect(markup).not.toContain('pcd-actions');
  });
});
