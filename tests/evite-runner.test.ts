import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error The unpacked extension ships plain JavaScript without a bundler.
import { createEviteRunner } from '../extensions/ripple-mail/evite-runner.js';

const preview = 'https://www.evite.com/invitation/abc123/preview';
const send = 'https://www.evite.com/invitation/abc123/send?source=editor#saved';
const job = { id: 'update-1', payload: { eventUrl: preview, snapshot: { name: 'Dinner', venue: 'River Hall' }, description: 'Approved event copy' } };
function setup() {
  const state: Record<string, any> = { token: 'local-capability', enabled: true };
  const post = vi.fn(async (_config: unknown, path: string) => path === '/evite/claim' ? structuredClone(job) : { allowed: true });
  const tabMessage = vi.fn(async (_tab: number, message: { type: string }) => message.type === 'ripple:evite-save' ? { saveStarted: true } : { verified: true, fields: { title: 'Dinner', location: 'River Hall', description: 'Approved event copy' } });
  const navigate = vi.fn(async () => {});
  const dependencies = { read: async () => structuredClone(state), write: async (patch: Record<string, unknown>) => { Object.assign(state, structuredClone(patch)); }, post, tabMessage, navigate };
  return { state, post, tabMessage, navigate, dependencies, run: createEviteRunner(dependencies) };
}

describe('persistent Evite save and reload sequence', () => {
  it('persists uncertainty before invoking the editor and verifies only after navigation', async () => {
    const ctx = setup();
    ctx.tabMessage.mockImplementationOnce(async () => { expect(ctx.state.eviteFlight.phase).toBe('awaiting-save'); return { saveStarted: true }; });
    await ctx.run(7, preview);
    expect(ctx.state.eviteFlight.phase).toBe('awaiting-save');
    expect(ctx.post.mock.calls.some(([, path]) => path.endsWith('/complete'))).toBe(false);
    await ctx.run(7, send);
    expect(ctx.state.eviteFlight.phase).toBe('verify');
    expect(ctx.navigate).toHaveBeenLastCalledWith(7, preview);
    expect(ctx.tabMessage).toHaveBeenCalledTimes(1);
    await ctx.run(7, preview);
    expect(ctx.post).toHaveBeenLastCalledWith(expect.anything(), '/evite/jobs/update-1/complete', expect.objectContaining({ eventUrl: preview, reloaded: true }));
    expect(ctx.state.eviteFlight).toBeNull();
  });

  it('survives a navigation-closed message port and service-worker restart without replaying the save', async () => {
    const ctx = setup(); ctx.tabMessage.mockRejectedValueOnce(new Error('Message port closed during navigation.'));
    await ctx.run(7, preview);
    expect(ctx.state.eviteFlight.phase).toBe('awaiting-save');
    expect(ctx.post.mock.calls.some(([, path]) => path.endsWith('/fail'))).toBe(false);
    const resumed = createEviteRunner(ctx.dependencies);
    await resumed(7, preview); expect(ctx.tabMessage).toHaveBeenCalledTimes(1);
    await resumed(7, send); await resumed(7, preview);
    expect(ctx.tabMessage.mock.calls.filter(([, message]) => message.type === 'ripple:evite-save')).toHaveLength(1);
    expect(ctx.state.eviteFlight).toBeNull();
  });

  it('resumes a persisted verification navigation before asking the content script for evidence', async () => {
    const ctx = setup(); ctx.state.eviteFlight = { phase: 'verify', tabId: 7, job };
    await ctx.run(7, send);
    expect(ctx.navigate).toHaveBeenCalledWith(7, preview);
    expect(ctx.tabMessage).not.toHaveBeenCalled();
    expect(ctx.post).not.toHaveBeenCalled();
  });

  it('does not inspect another tab or invitation, or run when disabled', async () => {
    const ctx = setup(); ctx.state.eviteFlight = { phase: 'verify', tabId: 7, job };
    await ctx.run(9, preview); await ctx.run(7, preview.replace('abc123', 'other'));
    ctx.state.enabled = false; await ctx.run(7, preview);
    expect(ctx.post).not.toHaveBeenCalled(); expect(ctx.tabMessage).not.toHaveBeenCalled(); expect(ctx.navigate).not.toHaveBeenCalled();
  });

  it('pauses a definitive editor failure and never retries it automatically', async () => {
    const ctx = setup(); ctx.tabMessage.mockResolvedValueOnce({ saveStarted: false, error: 'No approved editor found.' } as any);
    await ctx.run(7, preview);
    expect(ctx.state.eviteFlight.phase).toBe('paused');
    expect(ctx.post).toHaveBeenLastCalledWith(expect.anything(), '/evite/jobs/update-1/fail', expect.objectContaining({ error: 'No approved editor found.' }));
    await ctx.run(7, preview); expect(ctx.tabMessage).toHaveBeenCalledTimes(1);
  });

  it('never saves after preflight approval rejection or completes mismatching reload evidence', async () => {
    const ctx = setup(); ctx.post.mockImplementation(async (_config: unknown, path: string) => {
      if (path.endsWith('/before-save')) throw new Error('Approval revoked.');
      return path === '/evite/claim' ? structuredClone(job) : { allowed: true };
    });
    await ctx.run(7, preview); expect(ctx.tabMessage).not.toHaveBeenCalled(); expect(ctx.state.eviteFlight.phase).toBe('paused');
    ctx.state.eviteFlight = { phase: 'verify', tabId: 7, job };
    ctx.tabMessage.mockResolvedValueOnce({ verified: false } as any);
    await ctx.run(7, preview);
    expect(ctx.post.mock.calls.some(([, path]) => path.endsWith('/complete'))).toBe(false);
    expect(ctx.state.eviteFlight.phase).toBe('verify');
  });

  it('retries only verification acknowledgement after an uncertain completion response', async () => {
    const ctx = setup(); ctx.state.eviteFlight = { phase: 'verify', tabId: 7, job };
    ctx.post.mockRejectedValueOnce(new Error('Local server disconnected after receipt.'));
    await ctx.run(7, preview); expect(ctx.state.eviteFlight.phase).toBe('verify');
    await ctx.run(7, preview);
    expect(ctx.state.eviteFlight).toBeNull();
    expect(ctx.tabMessage.mock.calls.every(([, message]) => message.type === 'ripple:evite-verify')).toBe(true);
  });
});
