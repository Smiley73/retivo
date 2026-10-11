/**
 * Shared content-signature primitive for reactive read layers.
 *
 * A page that imperatively batch-loads several aggregate lists (rather than
 * binding to a single `useAggregates` row array) needs a cheap, stable string
 * to tell a real edit from a no-op re-read: the same ids + versions yield the
 * same string, a version bump / added / removed row yields a different one.
 * Extracted so the SS-optimizer batch + the Scenarios-card batch share one
 * implementation (DRY).
 */

/**
 * Join a row list to an `id:version`-per-row, comma-separated signature.
 * Order-sensitive — callers that need order-independence sort first.
 */
export function idVersionSignature(
  rows: ReadonlyArray<{ id: string; version: number }>,
): string {
  return rows.map((r) => `${r.id}:${r.version}`).join(',');
}
