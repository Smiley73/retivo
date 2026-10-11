/**
 * Random identifier for client-generated aggregate IDs and similar.
 * Prefers `crypto.randomUUID()` (always present in modern browsers).
 *
 * `fallbackPrefix` is only used when `crypto` is unavailable — i.e. in
 * older dev/test sandboxes. Pass it to keep aggregate IDs visually
 * distinguishable in logs from the fallback path. Production never hits
 * this branch.
 */
export function cryptoUuid(fallbackPrefix?: string): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  const rand = Math.random().toString(36).slice(2);
  if (fallbackPrefix) return `${fallbackPrefix}-${rand}-${Date.now().toString(36)}`;
  return rand;
}
