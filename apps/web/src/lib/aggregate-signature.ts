// Content signature for pages that batch-load aggregate lists: the same ids and versions give the same string, so a real edit differs from a no-op re-read.

/** Joins rows to `id:version` pairs; order-sensitive, so sort first when order must not matter. */
export function idVersionSignature(
  rows: ReadonlyArray<{ id: string; version: number }>,
): string {
  return rows.map((r) => `${r.id}:${r.version}`).join(',');
}
