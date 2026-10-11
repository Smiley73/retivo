/**
 * Historical monthly returns + inflation data loader. Bundles the
 * pre-derived Shiller + Ken French CSVs (committed under
 * `apps/web/src/lib/historical-data/`) and exposes the joined dataset
 * + samplers consumed by the Monte Carlo runner.
 *
 * Source of record + refresh procedure: `historical-data/REFRESH.md`.
 *
 * Vite inlines the CSV strings at build time via `?raw`; we parse once
 * into `Float64Array` columns on first import and memoise the result.
 * No runtime fetch — the dataset is part of the worker chunk.
 */
import shillerCsv from './../historical-data/shiller-monthly.csv?raw';
import frenchCsv from './../historical-data/french-rf-monthly.csv?raw';
import type { Rng } from '../sfc32';

export interface HistoricalMonth {
  /** Calendar month identifier as `YYYY-MM`. */
  readonly date: string;
  /** S&P 500 monthly total return, percent. */
  readonly stockPct: number;
  /** 10-year US Treasury monthly total return, percent. */
  readonly bondPct: number;
  /** 1-month T-bill total return, percent. */
  readonly cashPct: number;
  /** Month-over-month CPI change, percent. Real on every row (the
   *  prior-month index always exists; Shiller's CPI series predates the
   *  1926-07 join window). */
  readonly cpiPct: number;
}

interface ShillerRow {
  date: string;
  stockPct: number;
  bondPct: number;
  cpiIndex: number;
}

interface FrenchRow {
  date: string;
  cashPct: number;
}

function parseShiller(): ShillerRow[] {
  const rows: ShillerRow[] = [];
  const lines = shillerCsv.split('\n');
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const parts = line.split(',');
    if (parts.length < 5) continue;
    const date = parts[0];
    const stockPct = Number(parts[1]);
    const bondPct = Number(parts[2]);
    const cpiIndex = Number(parts[3]);
    if (!date || Number.isNaN(stockPct) || Number.isNaN(bondPct) || Number.isNaN(cpiIndex)) {
      continue;
    }
    rows.push({ date, stockPct, bondPct, cpiIndex });
  }
  return rows;
}

function parseFrench(): FrenchRow[] {
  const rows: FrenchRow[] = [];
  const lines = frenchCsv.split('\n');
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const parts = line.split(',');
    if (parts.length < 2) continue;
    const date = parts[0];
    const cashPct = Number(parts[1]);
    if (!date || Number.isNaN(cashPct)) continue;
    rows.push({ date, cashPct });
  }
  return rows;
}

/**
 * Sampler-window start. The joined Shiller × French series technically
 * begins 1926-07, but we cap the bootstrap at 1950-01 to drop the
 * Depression / WW2 / Bretton-Woods era — those decades distort modern
 * sequence-of-returns risk (much lower stock means, very different rate
 * regime). 1950+ keeps a wider sample than the prior 1972 annual series
 * while staying within the post-WW2 macro regime users intuitively
 * compare against.
 */
const SAMPLER_START_DATE = '1950-01';

function joinAndDeriveCpi(): HistoricalMonth[] {
  const shiller = parseShiller();
  const french = parseFrench();
  const cashByDate = new Map<string, number>();
  for (const r of french) cashByDate.set(r.date, r.cashPct);

  // Inner-join on `date`, then filter to `SAMPLER_START_DATE` onward.
  // `prevCpi` tracks the Shiller CPI of the immediately prior month
  // (even when that month is outside the join window) so each retained
  // row carries a real month-over-month CPI change.
  const out: HistoricalMonth[] = [];
  let prevCpi: number | null = null;
  for (const s of shiller) {
    const cash = cashByDate.get(s.date);
    if (cash === undefined) {
      prevCpi = s.cpiIndex;
      continue;
    }
    const cpiPct = prevCpi === null || prevCpi === 0 ? 0 : (s.cpiIndex / prevCpi - 1) * 100;
    prevCpi = s.cpiIndex;
    if (s.date < SAMPLER_START_DATE) continue;
    out.push({
      date: s.date,
      stockPct: s.stockPct,
      bondPct: s.bondPct,
      cashPct: cash,
      cpiPct,
    });
  }
  return out;
}

let memoData: readonly HistoricalMonth[] | null = null;

function loadHistoricalMonthly(): readonly HistoricalMonth[] {
  if (memoData) return memoData;
  memoData = Object.freeze(joinAndDeriveCpi());
  return memoData;
}

/** Frozen joined dataset. First row's `cpiPct` is 0 (no prior month). */
export const HISTORICAL_MONTHLY: readonly HistoricalMonth[] =
  /* @__PURE__ */ loadHistoricalMonthly();

interface HistoricalSummaryStats {
  readonly arithMeanPct: number;
  readonly stdDevPct: number;
  readonly min: number;
  readonly max: number;
}

export interface HistoricalMonthlySummary {
  readonly firstDate: string;
  readonly lastDate: string;
  readonly monthCount: number;
  readonly stock: HistoricalSummaryStats;
  readonly bond: HistoricalSummaryStats;
  readonly cash: HistoricalSummaryStats;
  readonly cpi: HistoricalSummaryStats;
}

function statsOf(values: number[]): HistoricalSummaryStats {
  const n = values.length;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const mean = sum / n;
  let varSum = 0;
  for (const v of values) varSum += (v - mean) ** 2;
  const stdDev = Math.sqrt(varSum / (n - 1));
  return { arithMeanPct: mean, stdDevPct: stdDev, min, max };
}

let memoSummary: HistoricalMonthlySummary | null = null;

export function historicalMonthlySummary(): HistoricalMonthlySummary {
  if (memoSummary) return memoSummary;
  const data = loadHistoricalMonthly();
  // Skip index 0 for the sampler-aligned stats (first month's cpiPct = 0
  // is synthetic), but include it in stock/bond/cash so the count
  // matches the on-screen dataset row count.
  const stock = statsOf(data.map((r) => r.stockPct));
  const bond = statsOf(data.map((r) => r.bondPct));
  const cash = statsOf(data.map((r) => r.cashPct));
  const cpi = statsOf(data.map((r) => r.cpiPct));
  memoSummary = {
    firstDate: data[0]?.date ?? '',
    lastDate: data[data.length - 1]?.date ?? '',
    monthCount: data.length,
    stock,
    bond,
    cash,
    cpi,
  };
  return memoSummary;
}

/** Draw one month uniformly at random from the dataset (1950-01 →
 *  most recent). All four series are real on every row — the first
 *  row's `cpiPct` reflects the 1949-12 → 1950-01 change. */
export function drawOneMonth(rng: Rng): HistoricalMonth {
  const data = loadHistoricalMonthly();
  const n = data.length;
  const idx = rng.uniformInt(0, n - 1);
  return data[idx];
}

/**
 * Default mean block length L (months) for the stationary bootstrap. Selected
 * from the candidate set {1, 3, 6, 12, 18, 24} as the smallest L whose
 * lag-1 |return| autocorrelation clears the clustering bar
 * (≥ baseline_iid + 0.05 AND ≥ 0.5 × empirical) while keeping the
 * successProbability Monte Carlo SE within the recorded margin
 * (≤ baseline_iid_success_se × 1.5). L = 3 is the smallest candidate clearing
 * both bars; the per-candidate autocorrelation/SE table is recorded in
 * `__fixtures__/sampler-stats.json`.
 */
export const DEFAULT_MEAN_BLOCK_LENGTH = 3;

/**
 * Bootstrap a series of `monthCount` months via a **stationary bootstrap**
 * (Politis & Romano 1994). Instead of drawing each month independently, the
 * series is built from runs of *consecutive* historical months ("blocks"),
 * each block a whole `(stock, bond, cash, cpi)` tuple sequence with
 * wrap-around at the dataset end — so cross-asset correlations stay intact
 * AND multi-month volatility clustering / regime persistence carry over.
 *
 * Each block's length is a geometric random variable with mean `meanBlockLength`
 * (= L): a fresh block starts at a uniformly random dataset position, then
 * extends by one consecutive month with continuation probability `1 − 1/L` per
 * step (else a new block starts). Blocks concatenate until `monthCount` months
 * are filled.
 *
 * `meanBlockLength = 1` reduces EXACTLY to an IID sampler: the
 * continuation probability is `1 − 1/1 = 0`, so no continuation decision is
 * ever drawn and every month is a single `rng.uniformInt(0, n - 1)` draw — the
 * exact index sequence an IID sampler produces, with no extra RNG draws. The
 * two-arg call (no `meanBlockLength`) defaults to `DEFAULT_MEAN_BLOCK_LENGTH`.
 *
 * This is a thin object-returning wrapper over `drawMonthlyIndices` (the two
 * share one bootstrap loop): it draws the same row indices and maps each to its
 * `HistoricalMonth` row, so the RNG call sequence — and thus the sampled series
 * — is byte-for-byte identical to indexing `HISTORICAL_MONTHLY` by the indices.
 * Retained for the test / sampler-stats tooling that wants row objects; the MC
 * runner hot path uses `drawMonthlyIndices` + `historicalColumns()` directly.
 */
// The sampled returns are GROSS of fees: nothing is deducted from the
// historical series, and there is no base-plan investment-cost setting. The
// only fee the app applies is the "Higher fees" market stress, applied as a
// per-month drag in `buildPerAccountReturnSeries` (monte-carlo-per-account.ts);
// `blendedReturnMonthly` is the reference definition of that same shock. The
// methodology modal (MonteCarloMethodologyModal.tsx) discloses the
// clustered-history sampling and the Shiller monthly-average prices.
export function drawMonthlySeries(
  rng: Rng,
  monthCount: number,
  meanBlockLength: number = DEFAULT_MEAN_BLOCK_LENGTH,
): HistoricalMonth[] {
  const idx = drawMonthlyIndices(rng, monthCount, meanBlockLength);
  const data = loadHistoricalMonthly();
  const out: HistoricalMonth[] = new Array(monthCount);
  for (let i = 0; i < monthCount; i += 1) out[i] = data[idx[i]];
  return out;
}

/** Struct-of-arrays view of the joined historical dataset:
 *  four parallel `Float64Array` columns aligned to `loadHistoricalMonthly()`'s
 *  row order (`columns.stockPct[i] === HISTORICAL_MONTHLY[i].stockPct`, etc.).
 *  Built once and memoized. Lets the hottest per-account blend loops index
 *  packed columns by a sampled row index instead of chasing pointers through
 *  per-row objects — same doubles, same op order. */
export interface HistoricalColumns {
  readonly stockPct: Float64Array;
  readonly bondPct: Float64Array;
  readonly cashPct: Float64Array;
  readonly cpiPct: Float64Array;
}

let memoColumns: HistoricalColumns | null = null;

/** Memoized struct-of-arrays view of `loadHistoricalMonthly()`. */
export function historicalColumns(): HistoricalColumns {
  if (memoColumns) return memoColumns;
  const data = loadHistoricalMonthly();
  const n = data.length;
  const stockPct = new Float64Array(n);
  const bondPct = new Float64Array(n);
  const cashPct = new Float64Array(n);
  const cpiPct = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const row = data[i];
    stockPct[i] = row.stockPct;
    bondPct[i] = row.bondPct;
    cashPct[i] = row.cashPct;
    cpiPct[i] = row.cpiPct;
  }
  memoColumns = { stockPct, bondPct, cashPct, cpiPct };
  return memoColumns;
}

/**
 * Struct-of-arrays sampler: returns the sampled dataset ROW
 * INDICES (`Int32Array`) directly, so a caller can index the packed
 * `historicalColumns()` arrays. This is the canonical stationary-bootstrap loop
 * — `drawMonthlySeries` delegates to it and maps each index to its row object,
 * so `HISTORICAL_MONTHLY[drawMonthlyIndices(rng, n, L)[i]] ===
 * drawMonthlySeries(sameSeededRng, n, L)[i]` by object identity for every `i`.
 * The MC runner hot path (`monte-carlo.ts` → `buildStepInputs`) calls this
 * directly; `drawMonthlySeries` serves the test / sampler-stats tooling that
 * wants row objects.
 */
export function drawMonthlyIndices(
  rng: Rng,
  monthCount: number,
  meanBlockLength: number = DEFAULT_MEAN_BLOCK_LENGTH,
): Int32Array {
  const out = new Int32Array(monthCount);
  const data = loadHistoricalMonthly();
  const n = data.length;
  const continueProb = 1 - 1 / meanBlockLength;
  let i = 0;
  while (i < monthCount) {
    let pos = rng.uniformInt(0, n - 1);
    out[i] = pos;
    i += 1;
    while (continueProb > 0 && i < monthCount && rng.next() < continueProb) {
      pos = pos + 1 === n ? 0 : pos + 1;
      out[i] = pos;
      i += 1;
    }
  }
  return out;
}

export interface BlendedMix {
  readonly stocksPct: number;
  readonly bondsPct: number;
  readonly cashPct: number;
}

/**
 * Market-stress return shock. `annualInvestmentCostPct`
 * is a flat portfolio drag; `returnShock` is a per-asset annual pp reduction.
 * The shape is the REFERENCE definition of the `−cost/12` and `−(blended
 * shock)/12` mean-shift. It is applied two different ways: the MC per-account
 * HOT PATH (`buildPerAccountReturnSeries` in `monte-carlo-per-account.ts`)
 * inlines the identical arithmetic per step to drop the call overhead and is NOT
 * a caller of `blendedReturnMonthly`; the reference `blendedReturnMonthly` below
 * carries the same definition for non-hot-path consumers. The two must stay in
 * lock-step — `historical.test.ts` pins the reference formula so a drift is
 * caught. Absent / all-zero → the gross blend, unchanged.
 */
export interface BlendedReturnShock {
  readonly annualInvestmentCostPct?: number;
  readonly returnShock?: {
    readonly stocksPct: number;
    readonly bondsPct: number;
    readonly cashPct: number;
  };
}

/** Mix-weighted monthly return percent for the given sampled month, less any
 *  market-stress fee/return shock (absent shock ⇒ the gross blend). This is
 *  the REFERENCE shock definition; the MC per-account hot path inlines the same
 *  arithmetic (see `BlendedReturnShock`) rather than calling this. */
// The sampled returns are GROSS of fees: nothing is deducted from the
// historical series, and there is no base-plan investment-cost setting. The
// only fee the app applies is the "Higher fees" market stress, applied as a
// per-month drag in `buildPerAccountReturnSeries` (monte-carlo-per-account.ts);
// `blendedReturnMonthly` is the reference definition of that same shock. The
// methodology modal (MonteCarloMethodologyModal.tsx) discloses the
// clustered-history sampling and the Shiller monthly-average prices.
export function blendedReturnMonthly(
  mix: BlendedMix,
  m: HistoricalMonth,
  shock?: BlendedReturnShock,
): number {
  const gross =
    (mix.stocksPct / 100) * m.stockPct +
    (mix.bondsPct / 100) * m.bondPct +
    (mix.cashPct / 100) * m.cashPct;
  if (!shock) return gross;
  const costMonthly = (shock.annualInvestmentCostPct ?? 0) / 12;
  const rs = shock.returnShock;
  const shockMonthly = rs
    ? ((mix.stocksPct / 100) * rs.stocksPct +
        (mix.bondsPct / 100) * rs.bondsPct +
        (mix.cashPct / 100) * rs.cashPct) /
      12
    : 0;
  return costMonthly === 0 && shockMonthly === 0 ? gross : gross - costMonthly - shockMonthly;
}
