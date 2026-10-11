/**
 * Shared test helpers for the Monte Carlo engine. `makeMonthlyExpenseBase`
 * builds the windowed per-month expense base a `MonteCarloInput` requires from
 * a single flat annual figure — the run-rate ÷ 12 spread across every
 * projection month, giving a flat per-month expense for lifetime-expense
 * fixtures. Test cases that exercise WINDOWING build the base directly (full
 * literal amount in a one-off's spike month, 0 outside an expense's active
 * window).
 *
 * `summaryToComparable` is the fixture/live comparator for the byte-identity
 * perf-preservation pins: it drops the wall-clock-only
 * `computedAt` field and normalizes every `ReadonlyMap` / typed array into a
 * plain JSON-stable shape so a freshly-computed `MonteCarloSummary` and one
 * reloaded from a captured JSON fixture compare equal by deep structural
 * equality.
 */
import type { MonteCarloSummary } from './monte-carlo-types';

/**
 * Distribute a flat annual expense as `annualAmount / 12` per month across all
 * `stepCount` months (one entry per projection month, `0 = January of
 * `firstYear``). Gives lifetime-expense fixtures a flat per-month expense.
 */
export function makeMonthlyExpenseBase(
  annualAmount: number,
  stepCount: number,
): number[] {
  return new Array<number>(stepCount).fill(annualAmount / 12);
}

/**
 * Recursively convert every `Map`/`ReadonlyMap` encountered into a key-sorted
 * `[key, value][]` array, every typed array (`Float64Array`/`Int32Array`/…)
 * into a plain `number[]`, and walk plain arrays/objects unchanged otherwise.
 * `summaryToComparable`'s helper — kept module-private since the JSON
 * round-trip it feeds is the only supported entry point (see the self-test in
 * `monte-carlo.perf-identity.test.ts`).
 */
function normalizeForComparison(value: unknown): unknown {
  if (value instanceof Map) {
    return Array.from(value.entries())
      .map(([k, v]) => [k, normalizeForComparison(v)] as [string, unknown])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    // Float64Array / Int32Array / etc: JSON.stringify on a bare typed array
    // yields an index-keyed OBJECT ({"0":1,"1":2}), not an array — convert to
    // a plain array FIRST so the later JSON round-trip is shape-stable
    // whether the source is a freshly-computed summary or one already
    // reloaded from a captured JSON fixture (plain arrays either way).
    return Array.from(value as unknown as ArrayLike<number>);
  }
  if (Array.isArray(value)) {
    return value.map((v) => normalizeForComparison(v));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = normalizeForComparison(v);
    }
    return out;
  }
  return value;
}

/**
 * Structured-clone-then-normalize a `MonteCarloSummary` (minus `computedAt`,
 * which is wall-clock and never bit-identical across runs) into a
 * deep-equal-comparable, JSON-stable shape: every
 * `ReadonlyMap` (representative `accountBalances`, `accumulationAccountBalances`)
 * becomes a key-sorted `[key, value][]` array via `normalizeForComparison`, and
 * a FINAL `JSON.parse(JSON.stringify(...))` pass normalizes typed arrays and
 * drops `undefined` fields identically whether the input is a freshly-computed
 * summary or one already reloaded from a captured JSON fixture.
 */
export function summaryToComparable(summary: MonteCarloSummary): unknown {
  // `-readonly` + `Partial` (not just `Partial`, which keeps fields readonly)
  // so `delete` is legal on the local copy below; `summary` itself is untouched.
  const rest: Partial<{ -readonly [K in keyof MonteCarloSummary]: MonteCarloSummary[K] }> = {
    ...summary,
  };
  delete rest.computedAt;
  return JSON.parse(JSON.stringify(normalizeForComparison(rest)));
}
