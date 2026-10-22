/** Run `run` in an idle slice (`requestIdleCallback`, else a macrotask); returns a cancel. */
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
