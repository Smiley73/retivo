/**
 * Fail-safe serialization of console and error arguments for the on-device diagnostics log: allowlist-based, because a key denylist fails open (CWE-532).
 * An entropy/digit masker defangs secrets in strings; best-effort, so the export also carries a "may contain personal data" warning.
 */

// Allowlist: every other key is dropped. `name` is excluded because it is usually a member, account
// or scenario label (PII); `redactError` captures `Error.name` separately.
const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'code',
  'status',
  'statusText',
  'phase',
  'scenarioId',
  'aggregateId',
  'aggregateType',
  'mutationId',
  'traceId',
  'kind',
  'operation',
  'schemaVersion',
  'version',
]);

// Borrowed from data-import.ts so the two boundary serializers share caps.
const MAX_NESTING_DEPTH = 32;
const MAX_ARRAY_LENGTH = 100_000;
const MAX_STRING_LENGTH = 2_000;
const MAX_MESSAGE_LENGTH = 8_000;

// Run of 20+ url-safe-base64 chars: masks JWTs, refresh tokens and the 256-bit HDK.
const ENTROPY_RE = /[A-Za-z0-9_-]{20,}/g;
// Run of 7+ digits: defangs account balances (integer cents) and numeric PII.
const DIGIT_RUN_RE = /\d{7,}/g;

const MASK = '[redacted]';

function maskString(value: string): string {
  const masked = value
    .replace(ENTROPY_RE, MASK)
    .replace(DIGIT_RUN_RE, MASK);
  return masked.length > MAX_STRING_LENGTH
    ? `${masked.slice(0, MAX_STRING_LENGTH)}…`
    : masked;
}

function redactError(err: Error): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: typeof err.name === 'string' ? err.name : 'Error',
    message: maskString(typeof err.message === 'string' ? err.message : ''),
  };
  // Keep only the error-class path: file paths and arg dumps can carry PII.
  if (typeof err.stack === 'string') {
    const frames = err.stack
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('at '))
      .map((line) => {
        const match = /^at\s+([^(\s]+)/.exec(line);
        return match ? match[1] : 'at <anonymous>';
      })
      .slice(0, 10);
    if (frames.length > 0) out.stackFrames = frames;
  }
  return out;
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > MAX_NESTING_DEPTH) return '[depth-limit]';
  if (value === null || value === undefined) return value ?? null;

  const t = typeof value;
  if (t === 'string') return maskString(value as string);
  if (t === 'number' || t === 'boolean') return value;
  if (t === 'bigint') return `${(value as bigint).toString()}n`;
  if (t === 'function' || t === 'symbol') return `[${t}]`;

  if (value instanceof Error) return redactError(value);

  if (Array.isArray(value)) {
    const width = Math.min(value.length, MAX_ARRAY_LENGTH);
    const arr: unknown[] = [];
    for (let i = 0; i < width; i += 1) {
      arr.push(redactValue(value[i], depth + 1));
    }
    if (value.length > width) arr.push('[array-truncated]');
    return arr;
  }

  if (t === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (!ALLOWED_KEYS.has(key)) continue;
      out[key] = redactValue((value as Record<string, unknown>)[key], depth + 1);
    }
    return out;
  }

  return `[${t}]`;
}

/** Serialize a captured first arg into the `message`; never throws (the caller must not). */
export function redactMessage(first: unknown): string {
  try {
    if (typeof first === 'string') return maskString(first);
    const serialized = JSON.stringify(redactValue(first, 0));
    const out = serialized ?? '[unserializable]';
    return out.length > MAX_MESSAGE_LENGTH
      ? `${out.slice(0, MAX_MESSAGE_LENGTH)}…`
      : out;
  } catch {
    return '[unserializable]';
  }
}

/**
 * Redact a console/error arg list into a `detail` string, or `undefined` when there are none; never
 * throws.
 */
export function redactArgs(args: readonly unknown[]): string | undefined {
  if (args.length === 0) return undefined;
  try {
    const serialized = JSON.stringify(args.map((a) => redactValue(a, 0)));
    if (serialized === undefined) return '[unserializable]';
    return serialized.length > MAX_MESSAGE_LENGTH
      ? `${serialized.slice(0, MAX_MESSAGE_LENGTH)}…`
      : serialized;
  } catch {
    return '[unserializable]';
  }
}
