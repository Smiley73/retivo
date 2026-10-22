/** Pure statistical helpers for the block-bootstrap sampler validation suite; callers pass sampled month series.
 * Shared by the recorder of `__fixtures__/sampler-stats.json` and the assertions in `monte-carlo.test.ts`. */
import type { BlendedMix } from './historical';
import { blendedReturnMonthly, type HistoricalMonth } from './historical';

export const REFERENCE_MIX: BlendedMix = { stocksPct: 60, bondsPct: 35, cashPct: 5 };

// Lag-1 autocorrelation; 0 for a constant or shorter-than-2 series.
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

function absPortfolioReturns(
  months: readonly HistoricalMonth[],
  mix: BlendedMix = REFERENCE_MIX,
): number[] {
  return months.map((m) => Math.abs(blendedReturnMonthly(mix, m)));
}

export function absReturnAutocorr(
  months: readonly HistoricalMonth[],
  mix: BlendedMix = REFERENCE_MIX,
): number {
  return lag1Autocorr(absPortfolioReturns(months, mix));
}

/** Fraction of months inside a maximal run of at least `n` consecutive negative portfolio returns. */
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

// Pearson correlation; 0 when either series is degenerate.
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

const SERIES_KEYS = ['stockPct', 'bondPct', 'cashPct', 'cpiPct'] as const;
type SeriesKey = (typeof SERIES_KEYS)[number];

/** Per-month correlation matrix keyed `"stockPct|bondPct"`; diagonal omitted. */
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
