/**
 * Fail-safe serialization of console / error arguments for the on-device
 * diagnostics log. The captured args are arbitrary app console output,
 * so a key-name *denylist* would fail open (CWE-532; ASVS V7.1.1/V8.3.4):
 * any unanticipated key carrying a secret/balance/PII would slip through.
 * Instead this serializer is **allowlist-based** — object args emit only a
 * fixed safe-key set and drop every other key — layered with an entropy /
 * digit masker so any secret/balance/PII that reaches a captured *string*
 * (including a truncated `Error.message`) is defanged by construction.
 *
 * Bounds (depth / total length / array width) borrow the `data-import.ts`
 * cap VALUES so the two boundary serializers stay aligned. The redaction is
 * best-effort defense-in-depth: it removes structured secrets/PII but
 * cannot guarantee a free-text prose string is PII-free — the export carries
 * a "may contain personal data" warning on top.
 */

/**
 * The ONLY object keys whose values survive serialization. Everything else
 * on an object arg is dropped. Keep this list intentionally small + boring —
 * codes/ids/HTTP-status fields that help debugging without carrying secrets or
 * balances. A generic `name` is deliberately NOT here: an object arg's `name`
 * is most often a member/account/scenario/household label (PII in a
 * zero-knowledge app), so it is dropped by construction. `Error.name` is
 * captured separately by `redactError` (the `Error` branch), never via this
 * allowlist, so dropping the generic key keeps error class names. Account
 * balances (integer cents) and member PII live under other keys and are
 * therefore dropped by construction.
 */
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
// Per-string cap: keep entries small; truncate long blobs (an Error.message
// or a serialized payload that slipped a giant string in).
const MAX_STRING_LENGTH = 2_000;
// Total serialized-message cap so one chatty arg can't bloat a ring entry.
const MAX_MESSAGE_LENGTH = 8_000;

// High-entropy / base64url blob: a run of ≥20 url-safe-base64 chars. Masks
// JWTs, refresh tokens, the 256-bit HDK, and similar secrets that leak into a
// captured string. Global so every occurrence in a string is masked.
const ENTROPY_RE = /[A-Za-z0-9_-]{20,}/g;
// Long digit run (≥7): defangs account balances (integer cents) and other
// numeric secrets/PII embedded in a string.
const DIGIT_RUN_RE = /\d{7,}/g;

const MASK = '[redacted]';

/**
 * Mask high-entropy blobs + long digit runs inside a string, then truncate.
 * Applied to every captured string value (and `Error.message`).
 */
function maskString(value: string): string {
  const masked = value
    .replace(ENTROPY_RE, MASK)
    .replace(DIGIT_RUN_RE, MASK);
  return masked.length > MAX_STRING_LENGTH
    ? `${masked.slice(0, MAX_STRING_LENGTH)}…`
    : masked;
}

/**
 * Reduce an `Error` to a safe shape: `name`, a redacted + truncated
 * `message`, and the stack's class-name path only (never the raw message
 * body, never enumerable own-props which can carry attached PII).
 */
function redactError(err: Error): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: typeof err.name === 'string' ? err.name : 'Error',
    message: maskString(typeof err.message === 'string' ? err.message : ''),
  };
  // Stack: keep only the error-class line(s), drop file paths / arg dumps
  // that can carry PII. The first line is conventionally `Name: message`,
  // so re-derive a class-name path rather than echoing the raw stack.
  if (typeof err.stack === 'string') {
    const frames = err.stack
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('at '))
      .map((line) => {
        // `at fnName (file:line:col)` → keep only `fnName`.
        const match = /^at\s+([^(\s]+)/.exec(line);
        return match ? match[1] : 'at <anonymous>';
      })
      .slice(0, 10);
    if (frames.length > 0) out.stackFrames = frames;
  }
  return out;
}

/**
 * Serialize a single arg fail-safe. Primitives pass (strings masked); arrays
 * recurse (width-capped); plain objects emit ONLY allowlisted keys; `Error`
 * is handled specially; anything else collapses to its type tag.
 */
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

/**
 * Serialize a captured first-arg into the human-readable `message`. A string
 * is masked + truncated in place; anything else is JSON-ified through the
 * allowlist serializer. Never throws (the caller is must-not-throw) —
 * any serialization failure collapses to a placeholder.
 */
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
 * Redact + serialize a full console/error arg list into a `detail` string,
 * or `undefined` when there are no extra args beyond the message. Allowlist
 * serialization + entropy/digit masking + `Error` handling. Never
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
