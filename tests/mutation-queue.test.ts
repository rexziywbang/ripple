import { describe, expect, it } from 'vitest';
import { createMutationQueue } from '../web/src/mutation-queue.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('mutation queue', () => {
  it('runs every queued edit in FIFO order without overlap or dropped operations', async () => {
    const queue = createMutationQueue();
    const gate = deferred<void>();
    const events: string[] = [];
    let active = 0;
    const operations = [0, 1, 2, 3].map(index => queue.enqueue(async () => {
      expect(active).toBe(0);
      active++;
      events.push(`start ${index}`);
      if (index === 0) await gate.promise;
      events.push(`end ${index}`);
      active--;
      return index;
    }));

    await Promise.resolve();
    expect(events).toEqual(['start 0']);
    gate.resolve();
    expect(await Promise.all(operations)).toEqual([0, 1, 2, 3]);
    expect(events).toEqual(['start 0', 'end 0', 'start 1', 'end 1', 'start 2', 'end 2', 'start 3', 'end 3']);
    expect(queue.pending).toBe(0);
  });

  it('returns a rejection to its caller and still runs subsequent mutations', async () => {
    const queue = createMutationQueue();
    const failure = new Error('Save failed');
    const first = queue.enqueue(async () => { throw failure; });
    const second = queue.enqueue(async () => 'saved next edit');

    await expect(first).rejects.toBe(failure);
    await expect(second).resolves.toBe('saved next edit');
    expect(queue.pending).toBe(0);

    await expect(queue.enqueue(async () => 42)).resolves.toBe(42);
    expect(queue.pending).toBe(0);
  });

  it('counts queued and active operations immediately and decrements on each completion', async () => {
    const queue = createMutationQueue();
    const firstGate = deferred<number>();
    const secondGate = deferred<string>();
    expect(queue.pending).toBe(0);
    const first = queue.enqueue(() => firstGate.promise);
    expect(queue.pending).toBe(1);
    const second = queue.enqueue(() => secondGate.promise);
    expect(queue.pending).toBe(2);

    firstGate.resolve(1);
    await expect(first).resolves.toBe(1);
    expect(queue.pending).toBe(1);
    secondGate.resolve('two');
    await expect(second).resolves.toBe('two');
    expect(queue.pending).toBe(0);
  });
});
