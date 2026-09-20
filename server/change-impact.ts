import type { Area, ChangeImpact, FactPatch, Facts, ProjectState, Proposal, Receipt } from '../shared/types.js';

type ImpactChange = { id: string; title: string; before: FactPatch; after: FactPatch; area?: Area };
export type ChangeImpactInput = {
  facts: Facts;
  change?: ImpactChange;
  /** Only proposals belonging to this initiating change and its consequences. */
  proposals: readonly Proposal[];
  allProposals?: readonly Proposal[];
  receipts: readonly Receipt[];
  budget?: ProjectState['budget'];
  note?: string;
  area?: Area;
  planning?: boolean;
};
const areaLabels: Record<Area, string> = { guests: 'Guest details', catering: 'Catering', staff: 'Staffing', venue: 'Room fit', equipment: 'Equipment', budget: 'Budget', brief: 'Event schedule' };
const areaOrder: Area[] = ['catering', 'staff', 'venue', 'equipment', 'guests', 'budget', 'brief'];
const primaryFields: Array<[keyof Facts, Area]> = [
  ['attendance', 'guests'], ['venue', 'venue'], ['caterer', 'catering'], ['dietary', 'catering'], ['staffCount', 'staff'],
  ['budgetLimitCents', 'budget'], ['equipmentCostCents', 'equipment'], ['date', 'brief'], ['time', 'brief'], ['format', 'brief'],
  ['venueAddress', 'venue'], ['venueCapacity', 'venue'], ['venueIncludesAV', 'venue'], ['venueCostCents', 'venue'],
  ['cateringPerPersonCents', 'catering'], ['cateringDeliveryCents', 'catering'], ['staffCostEachCents', 'staff'], ['notes', 'brief'],
];
const cash = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
const compact = (text: string, limit = 150) => {
  const value = text.replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit - 1).trimEnd()}…` : value;
};
const countLabel = (count: number, label: string) => `${count} ${label}${count === 1 ? '' : 's'}`;

function fieldValue(key: keyof Facts, value: unknown): string | undefined {
  if (value === undefined || value === null) return;
  if (key.endsWith('Cents') && typeof value === 'number') return cash(value);
  if (key === 'attendance') return `${value} guests`;
  if (key === 'staffCount') return `${value} staff`;
  if (key === 'venueCapacity') return `${value} places`;
  if (key === 'venueIncludesAV') return value ? 'AV included' : 'External AV needed';
  return compact(String(value), 90) || 'Not entered';
}

function amounts(input: ChangeImpactInput) {
  const f = input.facts, old = { ...f, ...input.change?.before };
  const oldCatering = old.attendance * old.cateringPerPersonCents + old.cateringDeliveryCents;
  const catering = f.attendance * f.cateringPerPersonCents + f.cateringDeliveryCents;
  const cateringLine = input.budget?.lines.find(line => line.label === 'Catering');
  const knownCatering = f.caterer === old.caterer && f.cateringStatus !== 'awaiting_quote' && old.cateringStatus !== 'awaiting_quote' && (!input.budget || !!cateringLine && cateringLine.amountCents === catering);
  const touched = Object.keys(input.change?.before ?? {});
  const foodChanged = touched.some(key => ['attendance', 'cateringPerPersonCents', 'cateringDeliveryCents'].includes(key));
  let delta = (foodChanged && knownCatering ? catering - oldCatering : 0)
    + f.staffCount * f.staffCostEachCents - old.staffCount * old.staffCostEachCents
    + f.venueCostCents - old.venueCostCents + f.equipmentCostCents - old.equipmentCostCents + f.sunkCostCents - old.sunkCostCents;
  // Historical receipts survive Undo; count only consequences still in the plan.
  for (const p of input.proposals) if (p.kind === 'fact' && p.status === 'applied' && p.costImpactCents !== null && p.patch && Object.entries(p.patch).every(([key, value]) => f[key as keyof Facts] === value) && !Object.keys(p.patch).some(key => touched.includes(key)) && input.receipts.some(receipt => receipt.proposalId === p.id && receipt.status === 'local')) delta += p.costImpactCents;
  const canCompareBudget = input.budget && (!foodChanged || knownCatering) && !input.budget.lines.some(line => line.status === 'awaiting quote') && old.caterer === f.caterer;
  return { catering, oldCatering, knownCatering, oldBudget: canCompareBudget && delta ? input.budget!.totalCents - delta : undefined };
}

function concreteDetail(area: Area, facts: Facts, proposals: readonly Proposal[], input: ChangeImpactInput): string {
  const staffProposal = proposals.find(proposal => proposal.kind === 'fact' && proposal.status === 'pending' && proposal.patch?.staffCount !== undefined);
  const totals = amounts(input), budget = input.budget;
  switch (area) {
    case 'catering': return `${facts.attendance} planned meals${facts.cateringStatus === 'awaiting_quote' ? ' · quote pending' : totals.knownCatering && totals.oldCatering !== totals.catering ? ` · ${cash(totals.oldCatering)} → ${cash(totals.catering)}` : ''}`;
    case 'staff': return staffProposal ? `${facts.staffCount} → ${staffProposal.patch!.staffCount} staff proposed` : `${facts.staffCount} staff · ${cash(facts.staffCount * facts.staffCostEachCents)} planned`;
    case 'venue': return (facts.venueCapacityPending ?? facts.venueDetailsPending) || facts.venueCapacity <= 0
      ? `Capacity unconfirmed for ${facts.attendance} guests`
      : facts.attendance > facts.venueCapacity ? `${facts.attendance - facts.venueCapacity} seats short · ${facts.attendance} guests` : `${facts.attendance} guests / ${facts.venueCapacity} places`;
    case 'equipment': return `${cash(facts.equipmentCostCents)} allowance${(facts.venueAVPending ?? facts.venueDetailsPending) ? ' · AV unconfirmed' : facts.venueIncludesAV ? ' · house AV included' : ''}`;
    case 'budget': {
      const oldLimit = input.change?.before.budgetLimitCents;
      const limit = oldLimit !== undefined && oldLimit !== facts.budgetLimitCents ? `${cash(oldLimit)} → ${cash(facts.budgetLimitCents)} limit` : `${cash(facts.budgetLimitCents)} limit`;
      return budget ? `${totals.oldBudget !== undefined && totals.oldBudget >= 0 ? `${cash(totals.oldBudget)} → ` : ''}${cash(budget.totalCents)} forecast / ${limit}` : limit;
    }
    case 'guests': return proposals.some(proposal => proposal.kind === 'invitation') ? 'Guest invitation details' : `${facts.attendance} expected guests`;
    case 'brief': return [facts.date, facts.time].filter(Boolean).join(' · ') || 'Event schedule';
  }
}

/** The graph describes dependencies; only receipts establish a completed update. */
export function buildChangeImpact(input: ChangeImpactInput): ChangeImpact | undefined {
  const { change, facts } = input;
  if (!change && !input.note?.trim()) return;
  const field = primaryFields.find(([key]) => change?.after[key] !== undefined && change.after[key] !== change.before[key]);
  const area = input.area ?? change?.area ?? field?.[1] ?? 'brief';
  const root: ChangeImpact = {
    id: change?.id ?? 'pending-change', title: change?.title ?? 'Planning update', area,
    ...(field ? { before: fieldValue(field[0], change?.before[field[0]]), after: fieldValue(field[0], change?.after[field[0]]) } : {}),
    ...(input.note?.trim() ? { note: compact(input.note, 220) } : {}), nodes: [], edges: [],
  };
  const current = input.proposals.filter(proposal => !['stale', 'withdrawn', 'denied'].includes(proposal.status));
  const groups = new Map<Area, Proposal[]>();
  for (const proposal of current) groups.set(proposal.area, [...(groups.get(proposal.area) ?? []), proposal]);
  const expected: Partial<Record<Area, Area[]>> = { guests: ['catering', 'staff', 'venue', 'budget'], venue: ['catering', 'staff', 'equipment', 'guests', 'budget'], catering: ['staff', 'guests', 'budget'], staff: ['staff', 'budget'], equipment: ['equipment', 'budget'], brief: ['venue', 'catering', 'staff', 'guests'], budget: ['budget'] };
  if (input.planning) for (const dependent of expected[area] ?? []) if (!groups.has(dependent)) groups.set(dependent, []);
  const receiptFor = (proposal: Proposal) => input.receipts.filter(receipt => receipt.proposalId === proposal.id).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  const actionable = (proposal: Proposal) => !['file', 'warning'].includes(proposal.kind);
  const selected = [...groups.keys()].sort((a, b) => {
    const priority = (value: Area) => groups.get(value)!.some(proposal => actionable(proposal) && ['pending', 'approved', 'blocked'].includes(proposal.status)) ? 2 : value === 'budget' ? 1 : 0;
    return priority(b) - priority(a) || areaOrder.indexOf(a) - areaOrder.indexOf(b);
  }).slice(0, 6).sort((a, b) => areaOrder.indexOf(a) - areaOrder.indexOf(b));
  for (const nodeArea of selected) {
    const proposals = groups.get(nodeArea)!;
    const failed = proposals.some(proposal => receiptFor(proposal)?.status === 'failed');
    const ready = proposals.filter(proposal => proposal.status === 'pending' && actionable(proposal) && proposal.dependencies.every(id => (input.allProposals ?? current).find(candidate => candidate.id === id)?.status === 'applied'));
    const waiting = proposals.some(proposal => ['approved', 'blocked'].includes(proposal.status) || proposal.status === 'pending' && actionable(proposal) && !ready.includes(proposal));
    const warning = proposals.some(proposal => proposal.kind === 'warning' && proposal.status === 'pending');
    const localFiles = proposals.filter(proposal => proposal.kind === 'file' && proposal.status === 'applied' && receiptFor(proposal)?.status === 'local').length;
    const completed = proposals.filter(proposal => proposal.status === 'applied' && ['local', 'delivered'].includes(receiptFor(proposal)?.status ?? '')).length;
    const simulated = proposals.some(proposal => proposal.status === 'applied' && receiptFor(proposal)?.status === 'simulated');
    const status: ChangeImpact['nodes'][number]['status'] = failed ? 'waiting' : ready.length || warning ? 'review' : waiting ? 'waiting' : completed || simulated ? 'updated' : 'checking';
    const progress = failed ? 'Needs attention' : ready.length > 1 ? countLabel(ready.length, 'decision') : localFiles ? `${countLabel(localFiles, 'file')} updated locally` : simulated ? 'Recorded locally' : undefined;
    root.nodes.push({ id: nodeArea, area: nodeArea, label: areaLabels[nodeArea], detail: compact([concreteDetail(nodeArea, facts, proposals, input), progress].filter(Boolean).join(' · ')), status, proposalIds: proposals.map(proposal => proposal.id) });
  }
  const exists = (id: string) => root.nodes.some(node => node.id === id);
  const edge = (from: string, to: string) => { if (from !== to && !root.edges.some(item => item.from === from && item.to === to)) root.edges.push({ from, to }); };
  if (exists('budget')) for (const from of ['catering', 'staff', 'equipment', 'venue']) if (exists(from)) edge(from, 'budget');
  // The initiating guest/venue/etc. change is the root, not another completed task.
  for (const node of root.nodes) if (!root.edges.some(item => item.to === node.id)) edge('change', node.id);
  return root;
}
