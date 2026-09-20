import { createHash } from 'node:crypto';
import {writeGuestInvitation} from '../shared/invitation-copy.js';
import type { ProjectState, Proposal } from '../shared/types.js';
import type { LiveBridge, LiveJob } from './live-bridge.js';

export type InvitationSyncState = Pick<ProjectState, 'project' | 'proposals'>;
export type InvitationSnapshot = NonNullable<Proposal['invitationSnapshot']>;
export type AppliedInvitationSnapshot = {
  proposalId: string;
  proposalCreatedAt: string;
  revision: number;
  snapshot: InvitationSnapshot;
};
const snapshotKeys = ['name', 'date', 'time', 'timezone', 'venue', 'venueAddress', 'caterer', 'dietary', 'format'] as const;

/** Domain proposals are appended. A later proposal wins equal creation timestamps. */
export function latestAppliedInvitationSnapshot(state: Pick<ProjectState, 'proposals'>): AppliedInvitationSnapshot | undefined {
  let latest: Proposal | undefined;
  let latestTime = -Infinity;
  for (const proposal of state.proposals) {
    if (proposal.kind !== 'invitation' || proposal.status !== 'applied') continue;
    const parsedTime = Date.parse(proposal.createdAt);
    const createdTime = Number.isFinite(parsedTime) ? parsedTime : -Infinity;
    if (!latest || createdTime >= latestTime) { latest = proposal; latestTime = createdTime; }
  }
  // Do not fall back to an older approval or reconstruct a missing snapshot from current facts.
  if (latest?.invitationSnapshotRevoked || !latest?.invitationSnapshot || snapshotKeys.some(key => typeof latest.invitationSnapshot?.[key] !== 'string')) return undefined;
  const snapshot = Object.fromEntries(snapshotKeys.map(key => [key, latest!.invitationSnapshot![key]])) as InvitationSnapshot;
  return { proposalId: latest.id, proposalCreatedAt: latest.createdAt, revision: latest.version, snapshot };
}

/** Stage approved event metadata only. No invitations, guest lists, or notifications are sent. */
export function syncInvitations(state: InvitationSyncState, bridge: LiveBridge): LiveJob[] {
  const projectId = state.project.id;
  const config = bridge.getConfig(projectId);
  const applied = latestAppliedInvitationSnapshot(state);
  const jobs = bridge.listJobs(projectId);
  const result: LiveJob[] = [];
  for (const [provider, eventUrl] of [['evite', config.eviteEventUrl], ['partiful', config.partifulEventUrl]] as const) {
    const previous = jobs.filter(job => job.provider === provider && job.action === 'update_event');
    if (!eventUrl || !applied) {
      for (const job of previous) if (job.status === 'queued') bridge.cancel(job.id);
      continue;
    }
    // Caterer is copied from the approved snapshot. The domain left it empty unless confirmed.
    const snapshotHash = createHash('sha256').update(JSON.stringify({ eventUrl, snapshot: applied.snapshot })).digest('hex');
    const latest = previous.at(-1);
    if (latest?.payload.snapshotHash === snapshotHash && latest.status !== 'cancelled') {
      for (const job of previous) if (job.id !== latest.id && job.status === 'queued') bridge.cancel(job.id);
      // Failed work may have reached the provider; polling cannot resolve that uncertainty.
      result.push(latest);
      continue;
    }
    const next = bridge.enqueue({
      projectId, provider, action: 'update_event', revision: applied.revision,
      dedupeKey: `invitation:${snapshotHash}:${latest?.id ?? 'initial'}`,
      payload: {
        eventUrl, snapshot: applied.snapshot, snapshotHash, description:writeGuestInvitation(applied.snapshot),
        proposalId: applied.proposalId, proposalCreatedAt: applied.proposalCreatedAt,
        metadataOnly: true, notifyGuests: false,
      },
    });
    for (const job of previous) if (job.status === 'queued') bridge.cancel(job.id);
    result.push(next);
  }
  return result;
}
