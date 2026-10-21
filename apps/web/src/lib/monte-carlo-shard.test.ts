/**
 * Sharding primitives.
 *
 * - The in-process determinism proof: the full 4-step
 *   `runPathRange` → `mergePathRanges` → `assembleAccumulationFromTyped` →
 *   `assembleMonteCarloSummary` pipeline, for shard splits {1, 3} of a
 *   200-path run, deep-equals a plain `runMonteCarlo` (no workers, no
 *   `postMessage` — proving the reconstruction itself is correct independent
 *   of the transfer mechanics). 3 does not divide 200 → the remainder case.
 * - `shardBounds` chunking (equal + remainder + shardCount > pathCount).
 * - `mergePathRanges` typed merge (offset placement, histogram/successes sum,
 *   −1 sentinel preserved).
 * - `assembleAccumulationFromTyped` reconstruction (depletion push-order, −1 ↔
 *   null mapping, tax-matrix rebuild).
 */
import { describe, expect, it } from 'vitest';
import {
  buildRunContext,
  runMonteCarlo,
  type MonteCarloAccountLedger,
  type McTaxContext,
  type MonteCarloInput,
} from './monte-carlo';
import { assembleMonteCarloSummary } from './monte-carlo-summary';
import {
  assembleAccumulationFromTyped,
  mergePathRanges,
  runPathRange,
  shardBounds,
  type MergedAccumulationTransfer,
  type PathRangeResult,
} from './monte-carlo-shard';
import { DEFAULT_TAX_CALIBRATION_BUNDLE } from './tax-integration';
import { makeMonthlyExpenseBase, summaryToComparable } from './monte-carlo.test-helpers';

const FIRST_YEAR = 2026;
const RETIREMENT_YEAR = 2032;
const HORIZON_YEAR = 2060;
const STEP_COUNT = (HORIZON_YEAR - FIRST_YEAR + 1) * 12;
const RETIREMENT_STEP = (RETIREMENT_YEAR - FIRST_YEAR) * 12;

function buildLedger(): MonteCarloAccountLedger[] {
  const contribPre = new Float64Array(STEP_COUNT);
  const contribPost = new Float64Array(STEP_COUNT);
  for (let i = 0; i < Math.min(RETIREMENT_STEP, STEP_COUNT); i += 1) {
    contribPost[i] = (20_000 * 0.6) / 12;
    contribPre[i] = (20_000 * 0.4) / 12;
  }
  return [
    {
      id: 'brokerage',
      ownerId: 'member-1',
      initialPre: 0,
      initialPost: 260_000,
      contribPre: new Float64Array(STEP_COUNT),
      contribPost,
      deposit: new Float64Array(STEP_COUNT),
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
      assetMixSeries: null,
      cbpPlanningReturnPct: null,
      taxTreatment: 'POST_TAX',
      accountType: 'BROKERAGE',
    },
    {
      id: 'ira',
      ownerId: 'member-1',
      initialPre: 180_000,
      initialPost: 0,
      contribPre,
      contribPost: new Float64Array(STEP_COUNT),
      deposit: new Float64Array(STEP_COUNT),
      assetMix: { stocksPct: 45, bondsPct: 50, cashPct: 5 },
      assetMixSeries: null,
      cbpPlanningReturnPct: null,
      taxTreatment: 'PRE_TAX',
      accountType: 'RETIREMENT_IRA',
    },
  ];
}

function buildTaxContext(): McTaxContext {
  return {
    taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
    filingStatus: 'Single',
    members: [
      {
        memberId: 'member-1',
        isoBirthdate: '1969-06-15',
        onMedicare: false,
        hasAcaCoverage: false,
      },
    ],
    householdSize: 1,
  };
}

/** A tax-bearing two-account household with a non-zero scenario inflation and a
 *  mid-year as-of month, and high enough spending that some paths deplete (so
 *  the depletion / histogram / sentinel reconstruction is exercised). */
function buildInput(overrides?: Partial<MonteCarloInput>): MonteCarloInput {
  const years = HORIZON_YEAR - FIRST_YEAR + 1;
  return {
    portfolioToday: 440_000,
    accountMcLedger: buildLedger(),
    annualContribution: 20_000,
    firstYear: FIRST_YEAR,
    retirementYear: RETIREMENT_YEAR,
    horizonYear: HORIZON_YEAR,
    monthlyExpenseBase: makeMonthlyExpenseBase(95_000, STEP_COUNT),
    ssByYear: Array.from({ length: years }, (_v, i) =>
      FIRST_YEAR + i >= RETIREMENT_YEAR ? 24_000 : 0,
    ),
    incomeByYear: Array.from({ length: years }, () => 0),
    pathCount: 200,
    seed: 20260703,
    strategyKind: 'taxEfficient',
    taxContext: buildTaxContext(),
    scenarioInflationPct: 3,
    todayMonthIndex: 6,
    ...overrides,
  };
}

describe('shardBounds', () => {
  it('splits into equal contiguous chunks with the remainder on the last', () => {
    expect(shardBounds(500, 1)).toEqual([{ start: 0, end: 500 }]);
    expect(shardBounds(500, 2)).toEqual([
      { start: 0, end: 250 },
      { start: 250, end: 500 },
    ]);
    // 500 / 3 = 166 rem 2 → last chunk absorbs the remainder.
    expect(shardBounds(500, 3)).toEqual([
      { start: 0, end: 166 },
      { start: 166, end: 332 },
      { start: 332, end: 500 },
    ]);
    // 500 / 7 = 71 rem 3 → six chunks of 71, last of 74.
    const seven = shardBounds(500, 7);
    expect(seven).toHaveLength(7);
    expect(seven[0]).toEqual({ start: 0, end: 71 });
    expect(seven[6]).toEqual({ start: 426, end: 500 });
    // Contiguous, gap-free, full coverage.
    for (let i = 1; i < seven.length; i += 1) expect(seven[i].start).toBe(seven[i - 1].end);
  });

  it('clamps shardCount to [1, pathCount]', () => {
    // More shards than paths → pathCount chunks of 1.
    expect(shardBounds(3, 8)).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 2 },
      { start: 2, end: 3 },
    ]);
    expect(shardBounds(4, 0)).toEqual([{ start: 0, end: 4 }]);
  });
});

describe('mergePathRanges', () => {
  function makeRange(
    pathStart: number,
    pathEnd: number,
    fill: number,
    depletion: number[],
  ): PathRangeResult {
    const horizon = 2;
    const len = pathEnd - pathStart;
    const mk = (): Float64Array[] => [new Float64Array(len).fill(fill), new Float64Array(len).fill(fill * 2)];
    const hist = new Int32Array(horizon);
    for (const d of depletion) if (d !== -1) hist[Math.min(d, horizon - 1)] += 1;
    return {
      pathStart,
      pathEnd,
      balancesByYearNominal: mk(),
      balancesByYearReal: mk(),
      tax: null,
      endingNominal: new Float64Array(len).fill(fill),
      endingReal: new Float64Array(len).fill(fill),
      depletionYearByPath: Int32Array.from(depletion),
      failureYearHistogram: hist,
      successes: depletion.filter((d) => d === -1).length,
    };
  }

  it('places each range at its absolute path offset and sums totals', () => {
    const input = { firstYear: 2026, horizonYear: 2027, pathCount: 4, taxContext: undefined } as MonteCarloInput;
    const r0 = makeRange(0, 2, 10, [-1, 1]);
    const r1 = makeRange(2, 4, 20, [0, -1]);
    const merged = mergePathRanges([r0, r1], input);
    expect(Array.from(merged.endingNominal)).toEqual([10, 10, 20, 20]);
    expect(Array.from(merged.balancesByYearNominal[0])).toEqual([10, 10, 20, 20]);
    expect(Array.from(merged.balancesByYearNominal[1])).toEqual([20, 20, 40, 40]);
    // −1 sentinel survives the merge unchanged.
    expect(Array.from(merged.depletionYearByPath)).toEqual([-1, 1, 0, -1]);
    // Histograms + successes sum across ranges.
    expect(Array.from(merged.failureYearHistogram)).toEqual([1, 1]);
    expect(merged.successes).toBe(2);
    expect(merged.tax).toBeNull();
  });
});

describe('assembleAccumulationFromTyped', () => {
  it('rebuilds depletionYears in ascending path index, maps −1 → null, rebuilds tax matrices', () => {
    const input = { firstYear: 2026, horizonYear: 2027, pathCount: 4, taxContext: {} } as MonteCarloInput;
    const mk = (rows: number[][]): Float64Array[] => rows.map((r) => Float64Array.from(r));
    const merged: MergedAccumulationTransfer = {
      balancesByYearNominal: mk([
        [1, 2, 3, 4],
        [5, 6, 7, 8],
      ]),
      balancesByYearReal: mk([
        [1, 1, 1, 1],
        [2, 2, 2, 2],
      ]),
      tax: {
        fedTaxByYear: mk([
          [100, 0, 200, 0],
          [0, 0, 0, 0],
        ]),
        irmaaSurchargeByYear: mk([
          [1, 2, 3, 4],
          [0, 0, 0, 0],
        ]),
        acaPtcSubsidyByYear: mk([
          [0, 0, 0, 0],
          [9, 8, 7, 6],
        ]),
        acaCreditAppliedToPremiumsByYear: mk([
          [0, 0, 0, 0],
          [5, 4, 3, 0],
        ]),
        effectiveTaxRateByYear: mk([
          [0.1, 0.2, 0.3, 0.4],
          [0, 0, 0, 0],
        ]),
        netAfterTaxByYear: mk([
          [10, 20, 30, 40],
          [0, 0, 0, 0],
        ]),
      },
      endingNominal: Float64Array.from([4, 3, 2, 1]),
      endingReal: Float64Array.from([1, 1, 1, 1]),
      // path 0 survives, path 1 depletes 2030, path 2 survives, path 3 depletes 2028
      depletionYearByPath: Int32Array.from([-1, 2030, -1, 2028]),
      failureYearHistogram: Int32Array.from([1, 1]),
      successes: 2,
    };
    const acc = assembleAccumulationFromTyped(merged, input);
    // Push order is ASCENDING path index: path 1 (2030) before path 3 (2028).
    expect(acc.depletionYears).toEqual([2030, 2028]);
    expect(acc.depletionYearByPath).toEqual([null, 2030, null, 2028]);
    expect(acc.successes).toBe(2);
    expect(acc.failureYearHistogram).toEqual([1, 1]);
    expect(acc.balancesByYearNominal).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ]);
    expect(acc.endingNominal).toEqual([4, 3, 2, 1]);
    expect(acc.taxAcc?.fedTaxByYear[0]).toEqual([100, 0, 200, 0]);
    expect(acc.taxAcc?.acaPtcSubsidyByYear[1]).toEqual([9, 8, 7, 6]);
    expect(acc.taxAcc?.acaCreditAppliedToPremiumsByYear[1]).toEqual([5, 4, 3, 0]);
    expect(Array.isArray(acc.taxAcc?.fedTaxByYear[0])).toBe(true);
  });

  it('returns a null taxAcc when the merged payload has no tax matrices', () => {
    const input = { firstYear: 2026, horizonYear: 2026, pathCount: 2, taxContext: undefined } as MonteCarloInput;
    const merged: MergedAccumulationTransfer = {
      balancesByYearNominal: [Float64Array.from([1, 2])],
      balancesByYearReal: [Float64Array.from([1, 2])],
      tax: null,
      endingNominal: Float64Array.from([1, 2]),
      endingReal: Float64Array.from([1, 2]),
      depletionYearByPath: Int32Array.from([-1, -1]),
      failureYearHistogram: Int32Array.from([0]),
      successes: 2,
    };
    expect(assembleAccumulationFromTyped(merged, input).taxAcc).toBeNull();
  });
});

describe('in-process sharded ≡ serial determinism', () => {
  const input = buildInput();
  const serial = runMonteCarlo(input);
  const expected = summaryToComparable(serial);

  for (const splits of [1, 3]) {
    it(`split into ${splits} shard(s) deep-equals a serial runMonteCarlo`, () => {
      const runCtx = buildRunContext(input);
      const ranges = shardBounds(input.pathCount, splits).map((b) =>
        runPathRange(input, runCtx, b.start, b.end),
      );
      const merged = mergePathRanges(ranges, input);
      const acc = assembleAccumulationFromTyped(merged, input);
      const summary = assembleMonteCarloSummary(input, runCtx, acc);
      expect(summaryToComparable(summary)).toEqual(expected);
    });
  }

  it('exercises depletion in the fixture (some paths fail, some succeed)', () => {
    // Guards the determinism proof against a degenerate all-survive fixture
    // that would never touch the sentinel / histogram reconstruction.
    expect(serial.successProbability).toBeGreaterThan(0);
    expect(serial.successProbability).toBeLessThan(1);
  });
});
