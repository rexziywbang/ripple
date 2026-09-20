import { createHash } from 'node:crypto';
import type { ProjectState, Source } from '../shared/types.js';
import type { LiveBridge, LiveJob } from './live-bridge.js';

export type DropboxPlanState = Pick<ProjectState, 'project' | 'budget'> & {sources?:Array<Pick<Source,'content'>&Partial<Omit<Source,'content'>>>;proposals?:ProjectState['proposals']};
export const DROPBOX_PLAN_FILE_NAME = 'Ripple event plan.md';

const money = (cents: number) => `USD ${(cents / 100).toFixed(2)}`;
const plain = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]!).replace(/([\\`*{}\[\]#+|~])/g, '\\$1');
const inline = (value: string) => plain(value).replace(/\r?\n/g, ' ').trim() || 'Not entered';

/** Selected planning fields only: no credentials, routing settings, mail bodies, or source documents. */
export function buildDropboxContent(state: DropboxPlanState): string {
  const { name, facts: f } = state.project;
  const venuePending = f.venueDetailsPending === true;
  const evidence=state.sources?.find(source=>source.id===f.venueCapacityEvidenceId)?.venueEvidence;
  const matchingEvidence=evidence?.name===f.venue&&evidence.address===f.venueAddress&&evidence.eventFormat===f.format?evidence:undefined;
  const capacity=matchingEvidence?.capacity?.guests===f.venueCapacity?matchingEvidence.capacity:undefined;
  const av=matchingEvidence?.av?.included===f.venueIncludesAV?matchingEvidence.av:undefined;
  const capacityPending=(f.venueCapacityPending??venuePending)||(venuePending&&!capacity);
  const avPending=(f.venueAVPending??venuePending)||(venuePending&&!av);
  const quotePending = f.cateringStatus === 'awaiting_quote';
  const incomplete = venuePending || state.budget.lines.some(line => line.status === 'awaiting quote');
  const cateringStatus = {
    confirmed: 'Confirmed in the current plan', awaiting_quote: 'Quote pending; price is unknown',
    quoted: 'Quoted; booking is not confirmed', awaiting_confirmation: 'Booking confirmation pending',
  }[f.cateringStatus];
  const lines = [
    `# ${inline(name)}`, '',
    'Current planning snapshot from Ripple. Estimates, quotes, and confirmed arrangements retain their stated status; this document does not confirm a booking or send invitations.', '',
    '## Event brief', '',
    `- Date: ${inline(f.date)}`,
    `- Start time: ${inline(f.time)} (${inline(f.timezone)})`,
    `- Expected guests: ${f.attendance}`,
    `- Format: ${inline(f.format)}`, '',
    '### Notes', '',
    ...(f.notes.trim() ? plain(f.notes).split(/\r?\n/).map(line => `> ${line}`) : ['No notes entered.']), '',
    '## Venue', '',
    `- Venue: ${inline(f.venue)}`,
    `- Address: ${inline(f.venueAddress)}`,
    `- Detail status: ${venuePending ? 'Venue price and availability need confirmation; published room details are listed separately below.' : 'Recorded in the current plan; verify availability separately.'}`,
    `- Seated capacity: ${capacityPending ? 'Needs confirmation' : f.venueCapacity > 0 ? `${f.venueCapacity}${capacity?` — ${inline(capacity.room)} (${inline(capacity.layout)})`:''}` : 'Not entered'}`,
    ...(capacity&&!capacityPending?[`- Capacity source: ${capacity.sourceUrl}`,`- Published capacity evidence: ${inline(capacity.excerpt)}`]:[]),
    ...(matchingEvidence?.roomLimit?[`- Published room maximum: ${matchingEvidence.roomLimit.guests} — ${inline(matchingEvidence.roomLimit.room)}; seating layout is unspecified and this is not a seated-dinner capacity.`,`- Room maximum source: ${matchingEvidence.roomLimit.sourceUrl}`]:[]),
    `- Room cost: ${money(f.venueCostCents)}${venuePending ? ' — carried planning estimate from the previous venue; not a quote for this venue' : ' — recorded planning amount'}`,
    `- Included AV: ${avPending ? 'Needs confirmation' : f.venueIncludesAV ? av?`${inline(av.room)} — ${av.items.map(inline).join(', ')}`:'Marked included; confirm required equipment scope' : 'Not marked included'}`,
    ...(av&&!avPending?[`- AV source: ${av.sourceUrl}`,`- Published AV evidence: ${inline(av.excerpt)}`]:[]), '',
    '## Catering', '',
    `- Partner: ${inline(f.caterer)}`,
    `- Status: ${cateringStatus}`,
    `- Dietary requirements: ${inline(f.dietary)}`,
    `- Price per guest: ${quotePending ? 'Unknown until a matching quote arrives' : money(f.cateringPerPersonCents)}`,
    `- Delivery: ${quotePending ? 'Unknown until a matching quote arrives' : money(f.cateringDeliveryCents)}`, '',
    '## Staff and equipment', '',
    `- Staff: ${f.staffCount} people at ${money(f.staffCostEachCents)} each; ${money(f.staffCount * f.staffCostEachCents)} total`,
    `- Equipment budget: ${money(f.equipmentCostCents)}`,
    `- Equipment scope: ${avPending ? 'Confirm the selected venue’s AV scope; the current equipment estimate is retained.' : f.venueIncludesAV ? 'House AV is marked included. Existing rental costs remain until their cancellation is processed.' : 'Plan for external equipment; confirm scope and costs.'}`, '',
    '## Budget', '',
    `- Budget limit: ${money(f.budgetLimitCents)}`,
    `- Current forecast: ${money(state.budget.totalCents)}${incomplete ? ' — incomplete; pending quotes or venue details need confirmation' : ''}`,
    `- Retained non-refundable costs recorded: ${money(f.sunkCostCents)}`, '',
    '| Item | Amount | Status | Detail |',
    '| --- | ---: | --- | --- |',
    ...state.budget.lines.map(line => `| ${inline(line.label)} | ${line.status === 'awaiting quote' ? 'Unknown' : money(line.amountCents)} | ${inline(line.status)} | ${inline(line.detail)} |`), '',
    'Outstanding commitments and pending quotes are shown above. A zero placeholder for an awaited quote is not a free service.', '',
  ];
  const plans=state.sources?.filter(source=>source.id?.startsWith('approved-plan:')&&source.content.trim())??[];
  if(plans.length)lines.push('## Approved operating plans','',...plans.flatMap(source=>[`### ${inline(source.title??'Operating plan')}`,'',...plain(source.content).split(/\r?\n/).map(line=>`> ${line}`),'']));
  const applied=state.proposals?.filter(proposal=>proposal.kind==='invitation'&&proposal.status==='applied').at(-1);
  const invitation=applied?.invitationSnapshot&&!applied.invitationSnapshotRevoked?applied.invitationSnapshot:undefined;
  lines.push('## Invitation status','',...(invitation?[
    `Approved details: ${inline(invitation.name)} · ${inline(invitation.date)} at ${inline(invitation.time)} (${inline(invitation.timezone)}) · ${inline(invitation.venue)}, ${inline(invitation.venueAddress)}.`,
    `Meal: ${inline(invitation.caterer||'To be confirmed')}. Dietary needs: ${inline(invitation.dietary)}.`,
    'Publication and guest delivery are tracked separately from approval.',
  ]:['No current approved invitation snapshot. Review the next invitation change before publishing.']),'');
  return lines.join('\n');
}

/** Queue one stable file in the configured event folder. Only a browser worker can verify upload. */
export function syncDropbox(state: DropboxPlanState, bridge: LiveBridge): LiveJob | undefined {
  const projectId = state.project.id;
  const folderUrl = bridge.getConfig(projectId).dropboxFolderUrl;
  const previous = bridge.listJobs(projectId).filter(job => job.provider === 'dropbox' && job.action === 'update_file');
  if (!folderUrl) {
    for (const job of previous) if (job.status === 'queued') bridge.cancel(job.id);
    return undefined;
  }
  const content = buildDropboxContent(state);
  const contentHash = createHash('sha256').update(JSON.stringify({ folderUrl, fileName: DROPBOX_PLAN_FILE_NAME, content })).digest('hex');
  const latest = previous.at(-1);
  if (latest?.payload.contentHash === contentHash && latest.status !== 'cancelled') {
    for (const job of previous) if (job.id !== latest.id && job.status === 'queued') bridge.cancel(job.id);
    // A failed upload may have reached Dropbox; do not silently retry uncertain work.
    return latest;
  }
  const next = bridge.enqueue({
    projectId, provider: 'dropbox', action: 'update_file', revision: state.project.revision,
    dedupeKey: `dropbox:${contentHash}:${latest?.id ?? 'initial'}`,
    payload: { folderUrl, fileName: DROPBOX_PLAN_FILE_NAME, content, contentHash },
  });
  for (const job of previous) if (job.status === 'queued') bridge.cancel(job.id);
  return next;
}
