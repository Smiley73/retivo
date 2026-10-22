/** Test helpers for the Monte Carlo engine: flat monthly expense base and the
 * fixture/live summary comparator for the byte-identity perf pins. */
import type { MonteCarloSummary } from './monte-carlo-types';

/** Spreads a flat annual expense as `annualAmount / 12` across `stepCount` months. */
export function makeMonthlyExpenseBase(
  annualAmount: number,
  stepCount: number,
): number[] {
  return new Array<number>(stepCount).fill(annualAmount / 12);
}

function normalizeForComparison(value: unknown): unknown {
  if (value instanceof Map) {
    return Array.from(value.entries())
      .map(([k, v]) => [k, normalizeForComparison(v)] as [string, unknown])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  }
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    // JSON.stringify on a bare typed array yields an index-keyed object, so convert to a plain array first.
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

/** Normalises a summary (minus wall-clock `computedAt`) into a JSON-stable shape so a fresh summary and a reloaded fixture compare equal. */
export function summaryToComparable(summary: MonteCarloSummary): unknown {
  const rest: Partial<{ -readonly [K in keyof MonteCarloSummary]: MonteCarloSummary[K] }> = {
    ...summary,
  };
  delete rest.computedAt;
  return JSON.parse(JSON.stringify(normalizeForComparison(rest)));
}
