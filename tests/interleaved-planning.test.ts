import { afterEach, describe, expect, it } from 'vitest';
import { createService } from '../server/domain.js';
import { initialFacts, sources } from '../server/fixtures.js';
import type { Planner } from '../shared/types.js';

const services: ReturnType<typeof createService>[] = [];
const checked: Planner = async () => ({ patch: {}, summary: 'Checked the connected plan.', questions: [], evidenceIds: [] });
function setup(planner = checked) {
  const api = createService({ dbPath: ':memory:', planner, aiStatus: () => ({ mode: 'live', model: 'test', fallbackModel: 'test', estimatedSpendUsd: 0, spendLimitUsd: 8 }) });
  services.push(api); return api;
}
afterEach(() => services.splice(0).forEach(api => api.close()));

describe('connected event changes', () => {
  it('checks pending natural-language and field edits together without replaying superseded values', async () => {
    let calls = 0;
    const api = setup(async input => {
      calls++; expect(input.facts).toMatchObject({ attendance: 100, staffCount: 4, budgetLimitCents: 1200000 });
      expect(input.note).toContain('another projector'); expect(input.note).toContain('quieter dinner');
      return { patch: { attendance: 250, budgetLimitCents: 9999999, notes: 'A quieter dinner with one additional projector.' }, summary: 'Prepared room and equipment changes.', questions: [], evidenceIds: [] };
    });
    const id = api.getState().project.id;
    api.edit(id, { area: 'equipment', note: 'We need another projector' });
    api.edit(id, { area: 'brief', note: 'Make it a quieter dinner' });
    api.edit(id, { area: 'staff', note: 'four staff' });
    api.edit(id, { area: 'guests', note: '100 guests' });
    api.edit(id, { area: 'budget', note: 'under 12k is the budget' });
    await api.tick();
    expect(calls).toBe(1); expect(api.getState().project.facts).toMatchObject({ attendance: 100, staffCount: 4, budgetLimitCents: 1200000, notes: 'A quieter dinner with one additional projector.' });
  });

  it('updates the actual room, service, staffing, equipment and budget documents from a guest change', async () => {
    const api = setup(); const before = api.getState();
    api.edit(before.project.id, { area: 'guests', note: '300 guests' }); await api.tick();
    const state = api.getState();
    for (const area of ['brief', 'guests', 'venue', 'catering', 'staff', 'equipment', 'budget']) {
      expect(state.sources.find(source => source.id === `record:${area}`)?.content).toContain('Expected guests: 300');
      expect(state.proposals.some(proposal => proposal.kind === 'file' && proposal.area === area && proposal.status === 'applied')).toBe(true);
    }
    expect(state.sources.find(source => source.id === 'record:venue')?.content).toContain('40 guests above');
    expect(state.sources.find(source => source.id === 'record:budget')?.content).toContain('$17,400.00');
    expect(state.messages).toEqual([]);
    for (const source of before.sources) expect(state.sources.find(candidate => candidate.id === source.id)?.content).toBe(source.content);
  });

  it('updates an existing service document when only dietary needs change', async () => {
    const api = setup(); const id = api.getState().project.id;
    api.edit(id, { area: 'staff', note: 'five staff' }); await api.tick();
    api.edit(id, { area: 'catering', note: '20 vegetarian meals, 5 kosher meals' }); await api.tick();
    const state = api.getState();
    expect(state.project.facts.staffCount).toBe(5);
    expect(state.sources.find(source => source.id === 'record:staff')?.content).toContain('20 vegetarian meals, 5 kosher meals');
    expect(state.sources.find(source => source.id === 'record:brief')?.content).toContain('20 vegetarian meals, 5 kosher meals');
    expect(state.sources.filter(source => source.id === 'record:staff')).toHaveLength(1);
    expect(state.proposals.some(proposal => proposal.kind === 'fact' && proposal.status === 'pending' && proposal.patch?.staffCount !== undefined)).toBe(false);
  });

  it('keeps an explicitly chosen staff count when the spending limit changes', async () => {
    const api = setup(); const id = api.getState().project.id;
    api.edit(id, { area: 'staff', note: 'five staff' }); await api.tick();
    api.edit(id, { area: 'budget', note: 'under 12k is the budget' }); await api.tick();
    const state = api.getState(); expect(state.project.facts).toMatchObject({ staffCount: 5, budgetLimitCents: 1200000 });
    expect(state.proposals.some(proposal => proposal.status === 'pending' && proposal.patch?.staffCount !== undefined)).toBe(false);
    expect(state.budget.totalCents).toBeGreaterThan(1200000);
  });

  it('runs real planning for equipment edits in an imported walkthrough and preserves its source folder', async () => {
    let calls = 0;
    const api = setup(async input => { calls++; return { patch: { notes: `${input.facts.notes}\nEquipment: two projectors.` }, summary: 'Two projectors requested.', questions: [], evidenceIds: ['equipment-contract'], actions: [{ kind: 'plan', area: 'equipment', title: 'Set up the second display', reason: 'Keep slides visible from the back of the room.', body: '## Place the second display\nPut the second projector where the back tables can see it. Check the venue power and signal path before requesting a rental.', evidenceIds: ['equipment-contract'], recipient: null, subject: null }] }; });
    const imported = api.createImportedProject({ name: 'Team dinner', facts: initialFacts, sources, demoPlanning: true });
    api.edit(imported.project.id, { area: 'equipment', note: 'We need another projector' }); await api.tick();
    const state = api.getState(imported.project.id);
    expect(calls).toBe(1); expect(state.project.facts.equipmentCostCents).toBe(initialFacts.equipmentCostCents);
    expect(state.sources.find(source => source.id === 'record:equipment')?.content).toContain('two projectors');
    expect(state.proposals.some(proposal => proposal.kind === 'plan' && proposal.title === 'Set up the second display' && proposal.status === 'pending')).toBe(true);
    expect(state.messages).toEqual([]);
  });
});
