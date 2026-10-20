/**
 * The last pass over a finished view: defense in depth, never the mechanism.
 * The allowlist in `classification.ts` is what keeps the never-shareable fields
 * out; this walks the result once more and removes any key that is never
 * shareable, and masks any literal occurrence of the terms a tool must not say.
 * If it ever changes something, a field map or a sanitizer let it through.
 */
import { MASK, type Masker } from './sanitize';

/** Key names that never appear in a share view, at any depth. */
export const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  'email',
  'lastName',
  'householdId',
  'deviceId',
  'schemaVersion',
  'version',
  'updatedAt',
  'deletedAt',
  'aggregateType',
]);

export function scrubValue(value: unknown, masker: Masker): unknown {
  if (typeof value === 'string') return masker.pattern === null ? value : value.replace(masker.pattern, MASK);
  if (Array.isArray(value)) return (value as unknown[]).map((item) => scrubValue(item, masker));
  if (typeof value === 'object' && value !== null) {
    const entries: [string, unknown][] = [];
    for (const [key, inner] of Object.entries(value)) {
      if (!FORBIDDEN_KEYS.has(key)) entries.push([key, scrubValue(inner, masker)]);
    }
    return Object.fromEntries(entries);
  }
  return value;
}
