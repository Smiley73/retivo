/**
 * The last pass over the data in a finished view: defense in depth, never the mechanism.
 * The allowlist in `classification.ts` is what keeps the never-shareable fields
 * out; this walks the result once more, removes any key that is never shareable
 * and deals with any literal occurrence of the terms a tool must not say. If it
 * ever changes something, a field map or a sanitizer let it through.
 *
 * What it does to a string depends on what the string is, because a masked
 * fragment would break a reference or an enum value:
 *  - prose (a label, a note) has every occurrence masked, as the sanitizers do;
 *  - an id or enum token (`isStructuralToken`) cannot hold an email and is never
 *    edited in part, but one that *is* a term (a last name stored in an enum
 *    field) is dropped whole, together with its key or list slot.
 * The caller scrubs the data only: the `withheld` list and the rounding
 * descriptor are generated text, not stored text, and are not passed through.
 */
import { isStructuralToken } from './project';
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

/** Marks a leaf that is removed with its key or list slot. */
const DROP: unique symbol = Symbol('drop');

function scrub(value: unknown, masker: Masker): unknown {
  if (typeof value === 'string') {
    if (masker.pattern === null) return value;
    if (isStructuralToken(value)) return masker.isTerm(value) ? DROP : value;
    return value.replace(masker.pattern, MASK);
  }
  if (Array.isArray(value)) {
    return (value as unknown[]).map((item) => scrub(item, masker)).filter((item) => item !== DROP);
  }
  if (typeof value === 'object' && value !== null) {
    const entries: [string, unknown][] = [];
    for (const [key, inner] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) continue;
      const scrubbed = scrub(inner, masker);
      if (scrubbed !== DROP) entries.push([key, scrubbed]);
    }
    return Object.fromEntries(entries);
  }
  return value;
}

export function scrubValue(value: unknown, masker: Masker): unknown {
  const scrubbed = scrub(value, masker);
  return scrubbed === DROP ? undefined : scrubbed;
}
