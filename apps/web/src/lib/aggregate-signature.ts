/** Content signature for batch-loaded aggregate lists, so a real edit differs from a no-op re-read; order-sensitive, so sort first when order must not matter. */
export function idVersionSignature(
  rows: ReadonlyArray<{ id: string; version: number }>,
): string {
  return rows.map((r) => `${r.id}:${r.version}`).join(',');
}
