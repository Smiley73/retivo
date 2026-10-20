/**
 * Idle-yield shim: run `run` in a browser idle slice (`requestIdleCallback`),
 * falling back to a macrotask where it is missing. Returns a cancel function.
 * Shared by the Scenarios cards' serial metrics drip and the Compare tab's
 * second projection, so CPU-bound projection work never lands inside a render.
 */
export function yieldToIdle(run: () => void): () => void {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void) => number })
    .requestIdleCallback;
  if (typeof ric === 'function') {
    const id = ric(run);
    const cancel = (globalThis as { cancelIdleCallback?: (id: number) => void })
      .cancelIdleCallback;
    return () => cancel?.(id);
  }
  const id = setTimeout(run, 0);
  return () => clearTimeout(id);
}
