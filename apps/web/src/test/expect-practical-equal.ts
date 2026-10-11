/**
 * Practical-tolerance equality helper. One source of truth
 * for every BPP-runner-migration parity test (deterministic fixture
 * parity, MC fixture parity, MC input-builder parity, cross-pipeline
 * parity). The tolerance is per-field:
 *
 *  - Numbers: relative ≤ `rel` (default `1e-10`) for any non-zero
 *    scalar, OR absolute ≤ `abs` (default `0.01`) — passes if either.
 *  - Arrays: identical lengths, then element-wise recurse.
 *  - Maps: identical key sets, then value-wise recurse.
 *  - null / undefined / string / boolean / NaN: `Object.is`-compatible
 *    (NaN === NaN under `Object.is`).
 *  - Plain objects: own-key set equality, then value-wise recurse.
 *
 * A 1e-10 relative diff on $1M is $0.0001 — well below the $0.01
 * absolute floor — so a real numerical regression shifts results far
 * past either threshold. Harmless floating-point reassociation does
 * not.
 */
import { expect } from 'vitest';

export interface PracticalEqualOptions {
  readonly rel?: number;
  readonly abs?: number;
}

const DEFAULT_REL = 1e-10;
const DEFAULT_ABS = 0.01;

export function expectPracticalEqual(
  actual: unknown,
  expected: unknown,
  opts: PracticalEqualOptions = {},
): void {
  const rel = opts.rel ?? DEFAULT_REL;
  const abs = opts.abs ?? DEFAULT_ABS;
  compare(actual, expected, rel, abs, '');
}

function compare(
  actual: unknown,
  expected: unknown,
  rel: number,
  abs: number,
  path: string,
): void {
  // Identity / Object.is cases (handles NaN-NaN, null-null, etc.).
  if (Object.is(actual, expected)) return;

  // Numbers — relative + absolute tolerance.
  if (typeof actual === 'number' && typeof expected === 'number') {
    if (Number.isNaN(actual) && Number.isNaN(expected)) return;
    const diff = Math.abs(actual - expected);
    if (diff <= abs) return;
    const denom = Math.max(Math.abs(actual), Math.abs(expected));
    if (denom > 0 && diff / denom <= rel) return;
    expect.fail(
      `expectPracticalEqual: numeric mismatch at "${path || '<root>'}": ` +
        `actual=${actual}, expected=${expected}, diff=${diff}`,
    );
  }

  // Map handling.
  if (actual instanceof Map && expected instanceof Map) {
    if (actual.size !== expected.size) {
      expect.fail(
        `expectPracticalEqual: Map size mismatch at "${path}": ` +
          `actual.size=${actual.size}, expected.size=${expected.size}`,
      );
    }
    expected.forEach((v, k) => {
      if (!actual.has(k)) {
        expect.fail(
          `expectPracticalEqual: Map missing key at "${path}": ${String(k)}`,
        );
      }
      compare(actual.get(k), v, rel, abs, `${path}.<key:${String(k)}>`);
    });
    return;
  }

  // Array handling.
  if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length !== expected.length) {
      expect.fail(
        `expectPracticalEqual: array length mismatch at "${path}": ` +
          `actual.length=${actual.length}, expected.length=${expected.length}`,
      );
    }
    for (let i = 0; i < actual.length; i += 1) {
      compare(actual[i], expected[i], rel, abs, `${path}[${i}]`);
    }
    return;
  }

  // Plain object handling.
  if (
    typeof actual === 'object' &&
    actual !== null &&
    typeof expected === 'object' &&
    expected !== null
  ) {
    const actualKeys = Object.keys(actual as Record<string, unknown>).sort();
    const expectedKeys = Object.keys(
      expected as Record<string, unknown>,
    ).sort();
    if (
      actualKeys.length !== expectedKeys.length ||
      actualKeys.some((k, i) => k !== expectedKeys[i])
    ) {
      expect.fail(
        `expectPracticalEqual: object key-set mismatch at "${path}": ` +
          `actual=${JSON.stringify(actualKeys)}, expected=${JSON.stringify(expectedKeys)}`,
      );
    }
    for (const k of actualKeys) {
      compare(
        (actual as Record<string, unknown>)[k],
        (expected as Record<string, unknown>)[k],
        rel,
        abs,
        path ? `${path}.${k}` : k,
      );
    }
    return;
  }

  // Anything else that didn't pass Object.is — string mismatch,
  // boolean mismatch, type mismatch.
  expect.fail(
    `expectPracticalEqual: value mismatch at "${path || '<root>'}": ` +
      `actual=${String(actual)}, expected=${String(expected)}`,
  );
}
