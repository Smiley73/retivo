/**
 * Pure statistical helpers for the Monte Carlo block-bootstrap sampler
 * validation suite. Shared by the red-first recorder (which records the
 * baseline constants into `__fixtures__/sampler-stats.json`) and the
 * statistical assertions in `monte-carlo.test.ts`, so the same maths backs
 * the recorded baselines and the live test bars.
 *
 * No randomness lives here — callers pass already-sampled month series.
 */
import type { BlendedMix } from './historical';
import { blendedReturnMonthly, type HistoricalMonth } from './historical';

/** Reference portfolio mix used for every clustering / tail statistic so the
 *  recorder and the tests measure the same |return| series. A balanced
 *  60/35/5 blend keeps both equity-clustering and bond/cash damping in view. */
export const REFERENCE_MIX: BlendedMix = { stocksPct: 60, bondsPct: 35, cashPct: 5 };

/** Lag-1 autocorrelation of a value series. Returns 0 for a degenerate
 *  (constant or <2-element) series. */
function lag1Autocorr(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  let mean = 0;
  for (const v of values) mean += v;
  mean /= n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    const d = values[i] - mean;
    den += d * d;
    if (i < n - 1) num += d * (values[i + 1] - mean);
  }
  return den === 0 ? 0 : num / den;
}

/** Absolute mix-weighted monthly portfolio return for each month. */
function absPortfolioReturns(
  months: readonly HistoricalMonth[],
  mix: BlendedMix = REFERENCE_MIX,
): number[] {
  return months.map((m) => Math.abs(blendedReturnMonthly(mix, m)));
}

/** Lag-1 autocorrelation of |monthly portfolio return| for a month series. */
export function absReturnAutocorr(
  months: readonly HistoricalMonth[],
  mix: BlendedMix = REFERENCE_MIX,
): number {
  return lag1Autocorr(absPortfolioReturns(months, mix));
}

/** Fraction of months that sit inside a sustained down-run of length ≥ `n`
 *  (a maximal run of consecutive negative portfolio returns whose length is
 *  at least `n` months). Measures multi-month drawdown clustering. */
export function drawdownRunFrequency(
  months: readonly HistoricalMonth[],
  runLength: number,
  mix: BlendedMix = REFERENCE_MIX,
): number {
  const total = months.length;
  if (total === 0) return 0;
  let monthsInLongRuns = 0;
  let run = 0;
  const flush = (): void => {
    if (run >= runLength) monthsInLongRuns += run;
    run = 0;
  };
  for (const m of months) {
    if (blendedReturnMonthly(mix, m) < 0) {
      run += 1;
    } else {
      flush();
    }
  }
  flush();
  return monthsInLongRuns / total;
}

/** Pearson correlation between two equal-length numeric series. 0 when either
 *  series is degenerate. */
function pearson(a: readonly number[], b: readonly number[]): number {
  const n = a.length;
  if (n < 2) return 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i += 1) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i += 1) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  const denom = Math.sqrt(va * vb);
  return denom === 0 ? 0 : cov / denom;
}

/** The four joined series (stock, bond, cash, cpi) extracted column-wise. */
const SERIES_KEYS = ['stockPct', 'bondPct', 'cashPct', 'cpiPct'] as const;
type SeriesKey = (typeof SERIES_KEYS)[number];

/** Symmetric per-month cross-asset + return-CPI correlation matrix, keyed
 *  `"stockPct|bondPct"` style so a fixture diff is order-stable and
 *  human-readable. Diagonal entries (self-correlation) are omitted. */
export function correlationMatrix(
  months: readonly HistoricalMonth[],
): Record<string, number> {
  const cols: Record<SeriesKey, number[]> = {
    stockPct: months.map((m) => m.stockPct),
    bondPct: months.map((m) => m.bondPct),
    cashPct: months.map((m) => m.cashPct),
    cpiPct: months.map((m) => m.cpiPct),
  };
  const out: Record<string, number> = {};
  for (let i = 0; i < SERIES_KEYS.length; i += 1) {
    for (let j = i + 1; j < SERIES_KEYS.length; j += 1) {
      const ki = SERIES_KEYS[i];
      const kj = SERIES_KEYS[j];
      out[`${ki}|${kj}`] = pearson(cols[ki], cols[kj]);
    }
  }
  return out;
}
