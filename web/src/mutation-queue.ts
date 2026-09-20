/** Serialize mutations without dropping edits or letting one failure stop the queue. */
export function createMutationQueue() {
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;

  return {
    get pending() {
      return pending;
    },
    enqueue<T>(operation: () => Promise<T>): Promise<T> {
      pending++;
      const result = tail.then(operation).finally(() => {
        pending--;
      });
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}
