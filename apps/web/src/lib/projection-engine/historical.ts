/** Historical monthly returns + CPI loader (Shiller + Ken French CSVs, inlined via `?raw`, parsed once) and bootstrap samplers.
 * Source and refresh: `historical-data/REFRESH.md`. */
import shillerCsv from './../historical-data/shiller-monthly.csv?raw';
import frenchCsv from './../historical-data/french-rf-monthly.csv?raw';
import type { Rng } from '../sfc32';

export interface HistoricalMonth {
  readonly date: string;
  readonly stockPct: number;
  readonly bondPct: number;
  readonly cashPct: number;
  /** Month-over-month CPI change in percent; real on every row (Shiller CPI predates the 1926-07 join window). */
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

// Start the bootstrap at 1950-01, not the joined series' 1926-07: the Depression, WW2 and Bretton-Woods eras (much lower stock means, a very different rate regime) distort modern sequence-of-returns risk.
const SAMPLER_START_DATE = '1950-01';

function joinAndDeriveCpi(): HistoricalMonth[] {
  const shiller = parseShiller();
  const french = parseFrench();
  const cashByDate = new Map<string, number>();
  for (const r of french) cashByDate.set(r.date, r.cashPct);

  // `prevCpi` is the prior month's Shiller CPI even when that month is outside the join window, so every retained row has a real CPI change.
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

/** Draws one month uniformly at random from the dataset. */
export function drawOneMonth(rng: Rng): HistoricalMonth {
  const data = loadHistoricalMonthly();
  const n = data.length;
  const idx = rng.uniformInt(0, n - 1);
  return data[idx];
}

/**
 * Default mean block length L (months): the smallest candidate whose lag-1 |return| autocorrelation clears the
 * clustering bar while keeping the success-probability SE within the recorded margin; table in `__fixtures__/sampler-stats.json`.
 */
export const DEFAULT_MEAN_BLOCK_LENGTH = 3;

/**
 * Stationary bootstrap (Politis & Romano 1994) of `monthCount` months: blocks of consecutive
 * `(stock, bond, cash, cpi)` rows with wrap-around, so cross-asset correlation and volatility clustering carry over.
 * Block length is geometric with mean `meanBlockLength` (continuation probability `1 - 1/L`).
 * `meanBlockLength = 1` reduces exactly to an IID sampler: no continuation draw, one `rng.uniformInt(0, n - 1)` per month.
 * Object-returning wrapper over `drawMonthlyIndices` for tests and sampler-stats tooling; draws the same RNG sequence.
 */
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

/** Struct-of-arrays view of the dataset: four `Float64Array` columns aligned to `loadHistoricalMonthly()` row order, so hot loops index by sampled row. */
export interface HistoricalColumns {
  readonly stockPct: Float64Array;
  readonly bondPct: Float64Array;
  readonly cashPct: Float64Array;
  readonly cpiPct: Float64Array;
}

let memoColumns: HistoricalColumns | null = null;

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

/** Sampled dataset row indices as an `Int32Array`; the canonical bootstrap loop that `drawMonthlySeries` maps to row objects. */
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
 * Market-stress return shock: `annualInvestmentCostPct` is a flat portfolio drag, `returnShock` a per-asset annual pp reduction.
 * The MC per-account hot path inlines the same arithmetic; `historical.test.ts` pins this reference formula so a drift is caught.
 */
export interface BlendedReturnShock {
  readonly annualInvestmentCostPct?: number;
  readonly returnShock?: {
    readonly stocksPct: number;
    readonly bondsPct: number;
    readonly cashPct: number;
  };
}

/** Mix-weighted monthly return percent for a sampled month, less any market-stress shock. Sampled returns are gross of fees; the only fee is the "Higher fees" stress. */
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
