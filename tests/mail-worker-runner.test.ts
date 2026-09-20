import { describe, expect, it } from 'vitest';
// @ts-expect-error The unpacked extension intentionally ships plain JavaScript without a bundler.
import { createMailRunner, WORKER_ID } from '../extensions/ripple-mail/runner.js';

const account = 'ripple-test@gmail.com';
function setup(overrides: Record<string,any> = {}) {
  const state: Record<string,any> = { token: 'a'.repeat(64), account, tabId: 10, enabled: true, ...overrides.state };
  const calls: {path: string; body: unknown}[] = []; let sends = 0;
  const job = { id: 'job-one', provider: 'email', action: 'send_email', workerId: WORKER_ID, status: 'running', payload: { account, recipient: account, subject: 'Approved quote request', body: 'Please send a quote.', ...overrides.payload } };
  let completeAttempts = 0;
  const runner = createMailRunner({
    read: async () => structuredClone(state),
    write: async (patch: Record<string,unknown>) => { Object.assign(state, structuredClone(patch)); },
    post: async (_config: unknown, path: string, body: unknown) => {
      calls.push({ path, body });
      if (path === '/claim') { if (overrides.claimError) throw new Error('Response lost'); return job; }
      if (path.endsWith('/before-send')) { if (overrides.rejectedApproval) throw new Error('Approval changed'); return { allowed: true, jobId: job.id }; }
      if (path.endsWith('/complete')) { if (overrides.lostReceipt && completeAttempts++ === 0) throw new Error('Receipt response lost'); return { status: 'completed' }; }
      if (path.endsWith('/fail')) return { status: 'failed' };
      throw new Error('Unexpected route');
    },
    tabMessage: async (_tabId: number, message: {type: string}) => {
      if (message.type === 'ripple:ready') return { ready: !overrides.draftOpen, account };
      sends++;
      try { await runner.beforeSend(10, job.id); } catch (error) { return { sent: false, clicked: false, error: error instanceof Error ? error.message : 'Approval failed' }; }
      if (overrides.uncertain) return { sent: false, clicked: true, error: 'No visible confirmation.' };
      return { sent: true, clicked: true, verification: { method: 'gmail_sent_confirmation', subject: job.payload.subject, recipient: job.payload.recipient }, detail: 'New Message sent confirmation appeared.', url: 'https://mail.google.com/mail/u/0/#sent' };
    }
  });
  return { runner, calls, get state() { return state; }, get sends() { return sends; } };
}
describe('durable Gmail worker runner', () => {
  it('checks approval and records a receipt only after a matching Gmail result', async () => {
    const ctx = setup(); await ctx.runner.run();
    expect(ctx.calls.map(call => call.path)).toEqual(['/claim','/jobs/job-one/before-send','/jobs/job-one/complete']);
    expect(ctx.sends).toBe(1); expect(ctx.state.inFlight).toBeNull(); expect(ctx.state.lastResult.status).toBe('completed');
  });
  it('sends to the explicitly allowed demo recipient with an exact matching receipt', async () => {
    const ctx = setup({ payload: { recipient: 'rexziyw@gmail.com' } });
    await ctx.runner.run();
    expect(ctx.sends).toBe(1);
    expect(ctx.state.lastResult.status).toBe('completed');
  });
  it('does not claim jobs while an existing draft is open', async () => {
    const ctx = setup({ draftOpen: true }); await ctx.runner.run(); expect(ctx.calls).toHaveLength(0); expect(ctx.sends).toBe(0);
  });
  it('blocks external recipients before opening compose', async () => {
    const ctx = setup({ payload: { recipient: 'vendor@realcompany.com' } }); await ctx.runner.run();
    expect(ctx.sends).toBe(0); expect(ctx.state.enabled).toBe(false); expect(ctx.state.inFlight.phase).toBe('claiming');
  });
  it('never repeats a claim whose HTTP response was lost', async () => {
    const ctx = setup({ claimError: true }); await ctx.runner.run(); await ctx.runner.run();
    expect(ctx.calls.map(call => call.path)).toEqual(['/claim']); expect(ctx.sends).toBe(0); expect(ctx.state.enabled).toBe(false);
  });
  it('never replays a send interrupted after intent was persisted', async () => {
    const ctx = setup({ state: { inFlight: { phase: 'sending', job: { id: 'job-one' }, account, tabId: 10 } } });
    await ctx.runner.run(); expect(ctx.calls).toHaveLength(0); expect(ctx.sends).toBe(0); expect(ctx.state.enabled).toBe(false);
  });
  it('retries only a confirmed receipt when the backend response is lost', async () => {
    const ctx = setup({ lostReceipt: true }); await ctx.runner.run();
    expect(ctx.state.inFlight.phase).toBe('confirmed'); await ctx.runner.run();
    expect(ctx.sends).toBe(1); expect(ctx.calls.filter(call => call.path.endsWith('/complete'))).toHaveLength(2); expect(ctx.state.inFlight).toBeNull();
  });
  it('records uncertainty as failed and pauses without a completion receipt', async () => {
    const ctx = setup({ uncertain: true }); await ctx.runner.run(); await ctx.runner.run();
    expect(ctx.state.enabled).toBe(false); expect(ctx.state.lastResult.status).toBe('failed'); expect(ctx.sends).toBe(1);
    expect(ctx.calls.some(call => call.path.endsWith('/complete'))).toBe(false);
  });
  it('rejects a withdrawn approval and serializes overlapping polling calls', async () => {
    const ctx = setup({ rejectedApproval: true }); await Promise.all([ctx.runner.run(),ctx.runner.run()]);
    expect(ctx.calls.filter(call => call.path === '/claim')).toHaveLength(1);
    expect(ctx.state.lastResult.status).toBe('failed'); expect(ctx.calls.some(call => call.path.endsWith('/complete'))).toBe(false);
  });
});
