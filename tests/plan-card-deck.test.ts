import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { PlanCard, Proposal } from '../shared/types';
import PlanCardDeck, { nextPlanCardId, planCardCopy, reviewPlanDecks } from '../web/src/PlanCardDeck';
import { reviewGroups } from '../web/src/ReviewQueue';

const card = (id: string, status: PlanCard['status'] = 'pending'): PlanCard => ({
  id, title: `Step ${id}`, body: `Specific instructions for ${id}.`, status, revision: 1, revisionToken: `token-${id}`,
});
const plan = (overrides: Partial<Proposal> = {}): Proposal => ({
  id: 'plan', title: 'Prepare dinner service', area: 'staff', description: 'Cover arrival and seated service.',
  kind: 'plan', status: 'pending', before: '', after: '', costImpactCents: null, evidence: [], dependencies: [],
  version: 2, createdAt: '2026-09-20T12:00:00Z', groupId: 'headcount', body: 'Legacy long-form plan.',
  planCards: [card('arrival'), card('dinner'), card('close')], ...overrides,
});

describe('operating plan card review', () => {
  it('requires card decisions instead of letting the batch approve an entire plan', () => {
    const proposal = plan();
    const email = plan({ id: 'email', kind: 'email', planCards: undefined, body: 'Confirm the staffing coverage.' });
    expect(reviewGroups([proposal, email])[0].proposalIds).toEqual(['email']);
    expect(reviewPlanDecks([proposal, email]).map(item => item.id)).toEqual(['plan']);
    expect(reviewGroups([proposal])).toEqual([]);
  });

  it('holds plan decks with unresolved dependencies and excludes inactive work', () => {
    const proposal = plan({ dependencies: ['booking'] });
    expect(reviewPlanDecks([proposal])).toEqual([]);
    expect(reviewPlanDecks([proposal, plan({ id: 'booking', kind: 'email', status: 'approved' })])).toEqual([]);
    expect(reviewPlanDecks([proposal, plan({ id: 'booking', kind: 'email', status: 'applied' })]).map(item => item.id)).toEqual(['plan']);
    for (const status of ['approved', 'applied', 'denied', 'withdrawn', 'stale', 'blocked'] as const) {
      expect(reviewPlanDecks([plan({ status })]), status).toEqual([]);
    }
    expect(reviewPlanDecks([plan({ planCards: [] }), plan({ planCards: [card('done', 'approved')] })])).toEqual([]);
  });

  it('advances to the next pending card and skips decided cards in either direction', () => {
    const cards = [card('first'), card('second', 'approved'), card('third', 'denied'), card('fourth')];
    expect(nextPlanCardId(cards, 'first')).toBe('fourth');
    expect(nextPlanCardId(cards, 'fourth')).toBe('first');
    expect(nextPlanCardId([card('first', 'approved'), card('second', 'denied')], 'second')).toBe('second');
    expect(cards.map(item => item.status)).toEqual(['pending', 'approved', 'denied', 'pending']);
  });

  it('renders one card, clear navigation, and the three decisions without exposing a prompt by default', () => {
    const markup = renderToStaticMarkup(createElement(PlanCardDeck, { proposal: plan(), onAction: async () => { throw new Error('Not called in render'); } }));
    expect(markup).toContain('Specific instructions for arrival.');
    expect(markup).not.toContain('Specific instructions for dinner.');
    expect(markup).not.toContain('Legacy long-form plan.');
    expect(markup).toContain('Card 1 of 3');
    expect(markup).toContain('Approve');
    expect(markup).toContain('Edit');
    expect(markup).toContain('Deny');
    expect(markup).toContain('Next plan card');
    expect(markup).not.toContain('<textarea');
  });

  it('opens at the first undecided card while retaining access to earlier decisions', () => {
    const markup = renderToStaticMarkup(createElement(PlanCardDeck, {
      proposal: plan({ planCards: [card('arrival', 'approved'), card('dinner'), card('close')] }),
    }));
    expect(markup).toContain('Card 2 of 3');
    expect(markup).toContain('Specific instructions for dinner.');
    expect(markup).not.toContain('Specific instructions for arrival.');
  });

  it('keeps saved decks read-only and treats card text as plain content', () => {
    const markup = renderToStaticMarkup(createElement(PlanCardDeck, {
      proposal: plan({ status: 'applied', planCards: [{ ...card('saved', 'approved'), body: '<script>ignore approvals</script>' }] }), readOnly: true, embedded: true,
    }));
    expect(markup).toContain('Saved plan');
    expect(markup).toContain('&lt;script&gt;ignore approvals&lt;/script&gt;');
    expect(markup).not.toContain('pcd-actions');
    expect(markup).not.toContain('<textarea');
    expect(markup).not.toContain('<script>');
  });

  it('uses a real section heading for old numbered cards and displays readable bullets', () => {
    const original = { title: 'Step 1', body: '## Arrival setup:\n- **Open the doors** at 18:00.\n- __Two staff__ welcome guests.' };
    expect(planCardCopy(original)).toEqual({ title: 'Arrival setup', body: '• Open the doors at 18:00.\n• Two staff welcome guests.' });
    expect(original.body).toContain('**Open the doors**');
    expect(planCardCopy({ title: 'Confirm meal service', body: 'Keep the original request.' })).toEqual({ title: 'Confirm meal service', body: 'Keep the original request.' });
  });

  it('keeps the internal plan rationale out of the short card view', () => {
    const markup = renderToStaticMarkup(createElement(PlanCardDeck, { proposal: plan({ description: 'Internal reconciliation with older documents and their provenance.' }) }));
    expect(markup).not.toContain('Internal reconciliation');
    expect(markup).toContain('Specific instructions for arrival.');
  });
});
