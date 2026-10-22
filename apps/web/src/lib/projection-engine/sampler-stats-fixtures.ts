/** Scaffolding for the block-bootstrap sampler validation suite: recorder seed, candidate block lengths,
 * a deterministic `MonteCarloInput` builder and the concat-sampled-paths helper. */
import type { HistoricalMonth } from './historical';
import type {
  MonteCarloAccountLedger,
  MonteCarloInput,
} from '../monte-carlo.js';
import { makeMonthlyExpenseBase } from '../monte-carlo.test-helpers.js';

export const RECORDER_SEED = 9001;

export const RECORDER_SERIES_LEN = 600;

const RECORDER_PATH_COUNT = 40;

/** A run of at least N consecutive down-months counts as a sustained drawdown. */
export const RECORDER_DRAWDOWN_RUN_N = 3;

/** Mean block-length candidates in months; `L = 1` is the IID sampler. */
export const L_CANDIDATES = [1, 3, 6, 12, 18, 24] as const;

/** Seeds for the cross-seed Monte Carlo SE estimate; the same set backs the IID baseline and every candidate. */
export const SE_SEED_SET = [
  101, 202, 303, 404, 505, 606, 707, 808, 909, 1010, 1111, 1212,
] as const;

/** Standard error of a proportion `p` over `n` paths: `sqrt(p(1-p)/n)`. */
export function binomialSe(p: number, n: number): number {
  return Math.sqrt((p * (1 - p)) / n);
}

/** Concatenates `RECORDER_PATH_COUNT` fixed-seed sampled paths into one month series; seeds derive from `RECORDER_SEED`. */
export function concatSampledPaths(
  drawPath: (seed: number) => HistoricalMonth[],
): HistoricalMonth[] {
  const out: HistoricalMonth[] = [];
  for (let p = 0; p < RECORDER_PATH_COUNT; p += 1) {
    out.push(...drawPath(RECORDER_SEED + p * 7919));
  }
  return out;
}

function singleAccountLedger(stepCount: number, retirementStepIdx: number): MonteCarloAccountLedger[] {
  const monthlyContribPost = (24_000 * 0.6) / 12;
  const monthlyContribPre = (24_000 * 0.4) / 12;
  const contribPostPrimary = new Float64Array(stepCount);
  const contribPreSecondary = new Float64Array(stepCount);
  for (let i = 0; i < Math.min(retirementStepIdx, stepCount); i += 1) {
    contribPostPrimary[i] = monthlyContribPost;
    contribPreSecondary[i] = monthlyContribPre;
  }
  return [
    {
      id: 'primary',
      initialPre: 0,
      initialPost: 300_000,
      contribPre: new Float64Array(stepCount),
      contribPost: contribPostPrimary,
      deposit: new Float64Array(stepCount),
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
      assetMixSeries: null,
      cbpPlanningReturnPct: null,
    },
    {
      id: 'secondary',
      initialPre: 200_000,
      initialPost: 0,
      contribPre: contribPreSecondary,
      contribPost: new Float64Array(stepCount),
      deposit: new Float64Array(stepCount),
      assetMix: { stocksPct: 40, bondsPct: 55, cashPct: 5 },
      assetMixSeries: null,
      cbpPlanningReturnPct: null,
    },
  ];
}

const RECORDER_FIRST_YEAR = 2026;
const RECORDER_RETIREMENT_YEAR = 2046;
const RECORDER_HORIZON_YEAR = 2086;

/** Moderately stressed plan so `successProbability` sits off the 0/1 rails and the block sampler's tail shift is observable. */
export function buildRecorderInput(overrides?: Partial<MonteCarloInput>): MonteCarloInput {
  const stepCount = (RECORDER_HORIZON_YEAR - RECORDER_FIRST_YEAR + 1) * 12;
  const retirementStepIdx = (RECORDER_RETIREMENT_YEAR - RECORDER_FIRST_YEAR) * 12;
  const years = RECORDER_HORIZON_YEAR - RECORDER_FIRST_YEAR + 1;
  const ssByYear = Array.from({ length: years }, (_, i) =>
    RECORDER_FIRST_YEAR + i >= RECORDER_RETIREMENT_YEAR ? 30_000 : 0,
  );
  const incomeByYear = Array.from({ length: years }, () => 0);
  return {
    portfolioToday: 500_000,
    accountMcLedger: singleAccountLedger(stepCount, retirementStepIdx),
    annualContribution: 24_000,
    firstYear: RECORDER_FIRST_YEAR,
    retirementYear: RECORDER_RETIREMENT_YEAR,
    horizonYear: RECORDER_HORIZON_YEAR,
    monthlyExpenseBase: makeMonthlyExpenseBase(72_000, stepCount),
    ssByYear,
    incomeByYear,
    pathCount: 2_000,
    seed: RECORDER_SEED,
    strategyKind: 'taxEfficient',
    ...overrides,
  };
}
