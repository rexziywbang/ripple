import { afterEach, describe, expect, it } from 'vitest';
import { createService, fallbackPlan } from '../server/domain.js';
import type { Planner } from '../shared/types.js';

const services: ReturnType<typeof createService>[] = [];
function setup(planner: Planner = async input => fallbackPlan(input)) {
  const service = createService({ dbPath: ':memory:', planner, aiStatus: () => ({ mode: 'demo', model: 'fixture', fallbackModel: 'fixture', estimatedSpendUsd: 0, spendLimitUsd: 8 }) });
  services.push(service); return service;
}
afterEach(() => services.splice(0).forEach(service => service.close()));

describe('the visible ripple follows the initiating edit', () => {
  it('keeps one causal identity from save through review, approval and undo', async () => {
    const service = setup(); const initial = service.getState(); const projectId = initial.project.id;
    const saved = service.edit(projectId, { area: 'guests', patch: { attendance: 300 } });
    expect(saved.impact).toMatchObject({ id: saved.workflow!.id, before: '240 guests', after: '300 guests' });
    expect(saved.impact!.nodes.every(node => node.status === 'checking')).toBe(true);
    await service.tick(); let state = service.getState();
    expect(state.impact!.id).toBe(saved.impact!.id);
    expect(state.impact!.edges).toContainEqual({ from: 'catering', to: 'budget' });
    expect(state.impact!.nodes.some(node => node.status === 'updated')).toBe(true);
    const staffing = state.proposals.find(proposal => proposal.kind === 'fact' && proposal.patch?.staffCount && proposal.status === 'pending')!;
    expect(state.impact!.nodes.find(node => node.area === 'staff')!.proposalIds).toContain(staffing.id);
    state = service.decide(projectId, staffing.id, 'approve', staffing.approvalToken);
    expect(state.impact!.id).toBe(saved.impact!.id);
    expect(state.impact!.nodes.find(node => node.area === 'staff')!.detail).toContain(`${state.project.facts.staffCount} staff`);
    const restored = service.undo(projectId, saved.workflow!.trigger!.changeId!);
    expect(restored.project.facts.attendance).toBe(initial.project.facts.attendance);
    expect(restored.impact).toBeUndefined();
  });

  it('does not show earlier unrelated proposals as consequences of a new note-only request', async () => {
    const service = setup(async input => ({ patch: {}, summary: 'Prepared', questions: [], evidenceIds: ['equipment-contract'], actions: input.note.includes('projector') ? [{ kind: 'plan', area: 'equipment', title: 'Place the extra projector', reason: 'Give the back tables a clear view.', body: '## Second screen\nPut the second screen beside the back tables.', evidenceIds: ['equipment-contract'], subject: null, recipient: null }] : [] }));
    const projectId = service.getState().project.id;
    service.edit(projectId, { area: 'guests', patch: { attendance: 300 } }); await service.tick();
    const oldIds = new Set(service.getState().proposals.map(proposal => proposal.id));
    const saved = service.edit(projectId, { area: 'equipment', note: 'Add another projector' });
    expect(saved.impact!.before).toBeUndefined(); expect(saved.impact!.after).toBeUndefined();
    expect(saved.impact!.note).toBe('Add another projector');
    await service.tick(); const state = service.getState();
    expect(state.impact!.id).toBe(saved.impact!.id);
    expect(state.impact!.nodes.flatMap(node => node.proposalIds).some(id => oldIds.has(id))).toBe(false);
    expect(state.impact!.nodes.some(node => node.area === 'equipment' && node.status === 'review')).toBe(true);
  });

  it('removes an undone staffing consequence from the original budget comparison', async () => {
    const service = setup(); const initial = service.getState(); const projectId = initial.project.id;
    const saved = service.edit(projectId, { area: 'guests', patch: { attendance: 300 } });
    await service.tick(); const planned = service.getState();
    const staffing = planned.proposals.find(proposal => proposal.kind === 'fact' && proposal.patch?.staffCount === 5 && proposal.status === 'pending')!;
    const approved = service.decide(projectId, staffing.id, 'approve', staffing.approvalToken);
    const child = approved.activity.find(item => item.title === staffing.title && item.changeId && item.canUndo)!;
    expect(child.changeId).not.toBe(saved.workflow!.trigger!.changeId);
    expect(approved.project.facts.staffCount).toBe(5);

    const restored = service.undo(projectId, child.changeId!);
    expect(restored.project.facts).toMatchObject({ attendance: 300, staffCount: initial.project.facts.staffCount });
    expect(restored.impact!.id).toBe(saved.impact!.id);
    expect(restored.budget.totalCents).toBe(planned.budget.totalCents);
    // Keep the historical receipt without treating its reversed cost as current.
    expect(restored.receipts.some(receipt => receipt.proposalId === staffing.id && receipt.status === 'local')).toBe(true);
    const cash = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(cents / 100);
    expect(restored.impact!.nodes.find(node => node.area === 'budget')!.detail)
      .toContain(`${cash(initial.budget.totalCents)} → ${cash(restored.budget.totalCents)} forecast`);
  });
});
