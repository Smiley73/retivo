/**
 * How a rejected argument is named to the agent: the path of the first problem, such as
 * `overrides.expenses` for a setting the tool does not take. A path segment is something the agent
 * typed, so one that is not a short plain token is shown as `?` instead of being echoed back.
 */
import type { ZodError } from 'zod';
import { DANGEROUS_CATEGORY_RATE_KEYS } from '../db/types';

const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,40}$/;

function segment(raw: PropertyKey): string {
  const text = String(raw);
  return SAFE_SEGMENT.test(text) ? text : '?';
}

/** The dotted path of the first issue; for an unrecognised key, the path of the key itself. */
function firstIssuePath(error: ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return '';
  const path = issue.path.map(segment);
  if (issue.code === 'unrecognized_keys' && issue.keys.length > 0) path.push(segment(issue.keys[0]!));
  return path.join('.');
}

/** The `INVALID_ARGS` message for a call whose arguments the tool's schema rejected. */
export function invalidArgsMessage(tool: string, error: ZodError): string {
  return `The arguments for ${tool} are not valid (at "${firstIssuePath(error)}").`;
}

const MAX_WALK_DEPTH = 12;

function dangerousKeyIn(value: unknown, path: string[], depth: number): string[] | null {
  if (typeof value !== 'object' || value === null || depth > MAX_WALK_DEPTH) return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = dangerousKeyIn(value[index], [...path, String(index)], depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  for (const key of Object.keys(value)) {
    if (DANGEROUS_CATEGORY_RATE_KEYS.has(key)) return [...path, key];
    const found = dangerousKeyIn((value as Record<string, unknown>)[key], [...path, key], depth + 1);
    if (found !== null) return found;
  }
  return null;
}

/**
 * The `INVALID_ARGS` message for arguments that carry a key which could reach an object's prototype
 * (`__proto__`, `constructor`, `prototype`) at any depth, or `null` when they carry none. No tool takes such a
 * key, and the schema parser silently drops `__proto__` instead of refusing it, so this looks at the raw
 * arguments before they are parsed.
 */
export function dangerousKeyMessage(tool: string, args: unknown): string | null {
  const found = dangerousKeyIn(args, [], 0);
  return found === null ? null : `The arguments for ${tool} are not valid (at "${found.map(segment).join('.')}").`;
}
