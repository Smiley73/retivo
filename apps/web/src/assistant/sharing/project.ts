/**
 * Applies a classification to a stored value. The walk is driven by the
 * classification, never by the value: a key the map does not list is not read,
 * a value of the wrong type is dropped, and nothing is copied wholesale. Stored
 * data comes from imports and older builds, so every leaf is validated as if it
 * were hostile.
 */
import { DANGEROUS_CATEGORY_RATE_KEYS } from '../../db/types';
import type { Classification } from './classification';
import { applyMonthlyRounding, applyRounding } from './rounding';
import { sanitizeFreeText, sanitizeLabel, type Masker } from './sanitize';
import type { SharingChoices } from './switches';

/** Returned for a value that is not shared; distinct from `null`, which is a real "cleared" marker. */
const OMIT: unique symbol = Symbol('omit');

export interface ProjectionContext {
  choices: SharingChoices;
  masker: Masker;
}

/** Opaque references to other aggregates: a UUID, or a short slug. No spaces, no `@`. */
const ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,79}$/;
/** One enum-like token, at most 64 characters. */
const ENUM_PATTERN = /^[A-Za-z0-9_.:+-]{1,64}$/;
const YEAR_KEY_PATTERN = /^\d{4}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}(?:T[0-9:.]{1,16}(?:Z|[+-]\d{2}:?\d{2})?)?$/;

export function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value) && !DANGEROUS_CATEGORY_RATE_KEYS.has(value);
}

/** A string shaped like an opaque id or an enum token: no spaces, no `@`, so never prose and never an email. */
export function isStructuralToken(value: string): boolean {
  return ID_PATTERN.test(value) || ENUM_PATTERN.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownValue(source: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined;
}

function project(value: unknown, classification: Classification, context: ProjectionContext): unknown {
  if (value === undefined) return OMIT;
  switch (classification.kind) {
    case 'never':
    case 'firstName':
      // A first name is emitted only by the member builder, which knows the role label to fall back to.
      return OMIT;
    case 'gated':
      if (!context.choices[classification.category]) return OMIT;
      return project(value, classification.shape, context);
    default:
      break;
  }
  // A stored `null` is the scenario patches' clear marker; it carries no data and passes through.
  if (value === null) return null;
  switch (classification.kind) {
    case 'plain':
      if (typeof value === 'boolean') return value;
      if (typeof value === 'number') return Number.isFinite(value) ? value : OMIT;
      // Enum-like text: one token of letters, digits and a few separators. Prose is not an enum.
      if (typeof value === 'string') return ENUM_PATTERN.test(value) ? value : OMIT;
      return OMIT;
    case 'dollars':
      if (typeof value !== 'number' || !Number.isFinite(value)) return OMIT;
      return applyRounding(value, context.choices.exactDollars);
    case 'monthlyDollars':
      if (typeof value !== 'number' || !Number.isFinite(value)) return OMIT;
      return applyMonthlyRounding(value, context.choices.exactDollars);
    case 'label':
      return typeof value === 'string' ? sanitizeLabel(value, context.masker) : OMIT;
    case 'text':
      if (!context.choices.notes) return OMIT;
      return typeof value === 'string' ? sanitizeFreeText(value, context.masker) : OMIT;
    case 'id':
      return isOpaqueId(value) ? value : OMIT;
    case 'date':
      return typeof value === 'string' && DATE_PATTERN.test(value) ? value : OMIT;
    case 'object': {
      if (!isPlainObject(value)) return OMIT;
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(classification.fields)) {
        const projected = project(ownValue(value, key), inner, context);
        if (projected !== OMIT) out[key] = projected;
      }
      return out;
    }
    case 'array': {
      if (!Array.isArray(value)) return OMIT;
      const out: unknown[] = [];
      for (const item of value as unknown[]) {
        const projected = project(item, classification.item, context);
        if (projected !== OMIT) out.push(projected);
      }
      return out;
    }
    case 'record': {
      if (!isPlainObject(value)) return OMIT;
      const entries: [string, unknown][] = [];
      for (const [key, inner] of Object.entries(value)) {
        const keyOk = classification.keys === 'year' ? YEAR_KEY_PATTERN.test(key) : isOpaqueId(key);
        if (!keyOk) continue;
        const projected = project(inner, classification.value, context);
        if (projected !== OMIT) entries.push([key, projected]);
      }
      // fromEntries defines own data properties, so a key like `__proto__` cannot reach the prototype.
      return Object.fromEntries(entries);
    }
  }
}

/** Projects a payload through its field map into a fresh object, leaving out everything unlisted. */
export function projectPayload(
  payload: unknown,
  fields: Readonly<Record<string, Classification>>,
  context: ProjectionContext,
): Record<string, unknown> {
  const projected = project(payload, { kind: 'object', fields }, context);
  return isPlainObject(projected) ? projected : {};
}
