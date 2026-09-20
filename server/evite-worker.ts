import express from 'express';
import { z } from 'zod';
import type { ProjectState } from '../shared/types.js';
import type { LiveBridge, LiveJob } from './live-bridge.js';
import { latestAppliedInvitationSnapshot } from './invitation-sync.js';
import { writeGuestInvitation } from '../shared/invitation-copy.js';

export const EVITE_WORKER = 'ripple-evite-extension';
export function eviteInvitationId(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !['www.evite.com', 'evite.com'].includes(url.hostname)) return;
    return /^\/invitation\/([A-Za-z0-9]+)\/(?:preview|customize|details|send)\/?$/.exec(url.pathname)?.[1];
  } catch { return; }
}

const isPreview = (value: string) => !!eviteInvitationId(value) && /\/preview\/?$/.test(new URL(value).pathname);
const snapshotSchema = z.object({
  name: z.string(), date: z.string(), time: z.string(), timezone: z.string(), venue: z.string(),
  venueAddress: z.string(), caterer: z.string(), dietary: z.string(), format: z.string(),
}).strict().refine(snapshot => !!snapshot.name.trim() && !!snapshot.venue.trim());
const payloadSchema = z.object({ eventUrl: z.string(), snapshot: snapshotSchema, proposalId: z.string(),
  description: z.string(), metadataOnly: z.literal(true), notifyGuests: z.literal(false) });

/** Mounted behind the existing local extension capability-token guard. */
export function createEviteWorkerRouter(bridge: LiveBridge, getState: (id: string) => ProjectState) {
  const router = express.Router();
  const request = z.object({ workerId: z.literal(EVITE_WORKER), eventUrl: z.string().url().max(2000) });
  function approved(job: LiveJob, eventUrl: string) {
    if (job.provider !== 'evite' || job.action !== 'update_event' || !isPreview(eventUrl)) return false;
    const parsed = payloadSchema.safeParse(job.payload);
    if (!parsed.success) return false;
    const payload = parsed.data;
    const config = bridge.getConfig(job.projectId);
    let state: ProjectState;
    try { state = getState(job.projectId); } catch { return false; }
    if (!state.projects.some(project => project.id === job.projectId)) return false;
    const current = latestAppliedInvitationSnapshot(state);
    const eventId = eviteInvitationId(eventUrl);
    return !!eventId && eventId === eviteInvitationId(config.eviteEventUrl) && eventId === eviteInvitationId(payload.eventUrl) &&
      config.emailDelivery === 'live' && !!current && current.proposalId === payload.proposalId &&
      JSON.stringify(current.snapshot) === JSON.stringify(payload.snapshot) &&
      payload.description === writeGuestInvitation(current.snapshot);
  }
  const find = (id: string) => bridge.listJobs().find(job => job.id === id);
  router.post('/claim', (req, res) => {
    const input = request.strict().parse(req.body);
    const job = bridge.listJobs().find(job => job.status === 'queued' && approved(job, input.eventUrl));
    res.json(job ? bridge.claimById(job.id, EVITE_WORKER) : null);
  });
  router.post('/jobs/:id/before-save', (req, res) => {
    const input = request.strict().parse(req.body); const job = find(req.params.id);
    if (!job || job.status !== 'running' || job.workerId !== EVITE_WORKER || !approved(job, input.eventUrl)) {
      return res.status(409).json({ error: 'The approved invitation changed. Nothing should be saved.' });
    }
    res.json({ allowed: true, jobId: job.id });
  });
  router.post('/jobs/:id/complete', (req, res) => {
    const input = request.extend({ title: z.string(), location: z.string(), description: z.string(), reloaded: z.literal(true) }).strict().parse(req.body);
    const job = find(req.params.id);
    if (!job || !['running', 'completed'].includes(job.status) || job.workerId !== EVITE_WORKER || !approved(job, input.eventUrl)) throw new Error('No matching approved invitation.');
    const snapshot = job.payload.snapshot as Record<string, string>;
    const text = (value: string) => value.replace(/\s+/g, ' ').trim();
    const venue = text(snapshot.venue); const location = text(input.location);
    const venueMatches = location === venue || (location.startsWith(venue) && /^(?:\s|[,·|—-]|\d)/u.test(location.slice(venue.length)));
    if (text(input.title) !== text(snapshot.name) || !venueMatches || text(input.description) !== text(String(job.payload.description))) throw new Error('The saved Evite fields do not match the approved changes.');
    res.json(bridge.complete(job.id, { url: input.eventUrl, detail: 'Reloaded Evite and verified the saved event title, venue, and description.' }));
  });
  router.post('/jobs/:id/fail', (req, res) => {
    const input = request.extend({ error: z.string().min(1).max(1000) }).strict().parse(req.body);
    const job = find(req.params.id);
    if (!job || job.provider !== 'evite' || job.action !== 'update_event' || job.workerId !== EVITE_WORKER || eviteInvitationId(input.eventUrl) !== eviteInvitationId(job.payload.eventUrl)) throw new Error('No matching Evite job.');
    res.json(bridge.fail(job.id, input.error));
  });
  return router;
}
