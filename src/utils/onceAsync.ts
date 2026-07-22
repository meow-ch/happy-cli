/** Returns one shared promise for every concurrent or later invocation. */
export function onceAsync<T>(operation: () => Promise<T>): () => Promise<T> {
  let execution: Promise<T> | null = null;
  return () => {
    if (!execution) {
      // Assign before invoking operation so synchronous re-entry also coalesces.
      execution = Promise.resolve().then(operation);
    }
    return execution;
  };
}
