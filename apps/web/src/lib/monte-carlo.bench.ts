/**
 * Monte Carlo micro-benchmark — tracks `runMonteCarlo` throughput so a
 * performance regression is measurable in CI. Runs OUTSIDE the normal test
 * suite (`vitest bench`), so it never gates correctness.
 *
 * The fixtures mirror the representative two-account household used in
 * `monte-carlo.test.ts` (equities-heavy brokerage + bonds-heavy IRA) at a
 * moderate `pathCount` so the bench finishes in a few seconds. A second bench
 * exercises the per-year tax path via a single-filer `taxContext`.
 *
 * A third describe block records the production 10k-path wall-time for both the
 * Combined-Pot kernel and a named-strategy (rothFirst) tax-aware run so the
 * named-strategy two-pass cost can be read as a RATIO against Combined-Pot (the
 * named-strategy path runs ~2× the drawdown work; the budget is
 * ≤ ~2.5× the Combined-Pot 10k bench on the same machine).
 */
import { test } from 'vitest';
import {
  runMonteCarlo,
  type McTaxContext,
  type MonteCarloAccountLedger,
  type MonteCarloInput,
} from './monte-carlo.js';
import { DEFAULT_TAX_CALIBRATION_BUNDLE } from './tax-integration.js';
import { makeMonthlyExpenseBase } from './monte-carlo.test-helpers.js';

const FIRST_YEAR = 2026;
const RETIREMENT_YEAR = 2046;
const HORIZON_YEAR = 2086;
const PATH_COUNT = 2000;
const SEED = 12345;

const BASE_STEPS = (HORIZON_YEAR - FIRST_YEAR + 1) * 12;
const BASE_RETIREMENT_STEP = (RETIREMENT_YEAR - FIRST_YEAR) * 12;

// Two-account ledger: equities-heavy brokerage (70/25/5, post-tax) +
// bonds-heavy IRA (40/55/5, pre-tax). The per-account split exercises
// per-account sampling rather than a single household-blended return.
function buildLedger(): MonteCarloAccountLedger[] {
  const monthlyContribPost = (20_000 * 0.6) / 12;
  const monthlyContribPre = (20_000 * 0.4) / 12;
  const contribPostPrimary = new Float64Array(BASE_STEPS);
  const contribPreSecondary = new Float64Array(BASE_STEPS);
  for (let i = 0; i < Math.min(BASE_RETIREMENT_STEP, BASE_STEPS); i += 1) {
    contribPostPrimary[i] = monthlyContribPost;
    contribPreSecondary[i] = monthlyContribPre;
  }
  return [
    {
      id: 'primary',
      initialPre: 0,
      initialPost: 300_000,
      contribPre: new Float64Array(BASE_STEPS),
      contribPost: contribPostPrimary,
      deposit: new Float64Array(BASE_STEPS),
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
      assetMixSeries: null,
      cbpPlanningReturnPct: null,
      // Post-tax brokerage: tax metadata so the tax-context bench actually
      // exercises the taxable (LTCG/QDI proxy) classification path rather
      // than falling back to the legacy all-pre-tax routing.
      taxTreatment: 'POST_TAX',
      accountType: 'BROKERAGE',
    },
    {
      id: 'secondary',
      initialPre: 200_000,
      initialPost: 0,
      contribPre: contribPreSecondary,
      contribPost: new Float64Array(BASE_STEPS),
      deposit: new Float64Array(BASE_STEPS),
      assetMix: { stocksPct: 40, bondsPct: 55, cashPct: 5 },
      assetMixSeries: null,
      cbpPlanningReturnPct: null,
      // Pre-tax IRA: ordinary-income withdrawal classification.
      taxTreatment: 'PRE_TAX',
      accountType: 'RETIREMENT_IRA',
    },
  ];
}

/** Nominal SS/other-income year arrays (SS starts at retirement). */
function buildYearArrays(): { ssByYear: number[]; incomeByYear: number[] } {
  const years = HORIZON_YEAR - FIRST_YEAR + 1;
  const ssByYear = Array.from({ length: years }, (_, i) =>
    FIRST_YEAR + i >= RETIREMENT_YEAR ? 30_000 : 0,
  );
  const incomeByYear = Array.from({ length: years }, () => 0);
  return { ssByYear, incomeByYear };
}

/** Single-filer tax context (age 55 in 2026; Medicare at 65 = 2036). */
function buildTaxContext(): McTaxContext {
  return {
    taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
    filingStatus: 'Single',
    members: [
      {
        memberId: 'mc-bench-primary',
        isoBirthdate: '1971-06-15',
        onMedicare: false,
        hasAcaCoverage: false,
      },
    ],
    householdSize: 1,
  };
}

const baseInput: MonteCarloInput = {
  portfolioToday: 500_000,
  accountMcLedger: buildLedger(),
  annualContribution: 20_000,
  firstYear: FIRST_YEAR,
  retirementYear: RETIREMENT_YEAR,
  horizonYear: HORIZON_YEAR,
  monthlyExpenseBase: makeMonthlyExpenseBase(80_000, BASE_STEPS),
  ...buildYearArrays(),
  pathCount: PATH_COUNT,
  seed: SEED,
  strategyKind: 'taxEfficient',
};

const taxInput: MonteCarloInput = {
  ...baseInput,
  taxContext: buildTaxContext(),
};

test('runMonteCarlo', async ({ bench }) => {
  await bench.compare(
    bench('multi-account, no tax context', () => {
      runMonteCarlo(baseInput);
    }),
    bench('multi-account, with tax context', () => {
      runMonteCarlo(taxInput);
    }),
  );
});

/** Production-scale 10k-path inputs (mirrors `PlanStressTestSection.tsx`). Every
 *  named strategy funds tax per path via the two-pass expense fold; benching two named
 *  strategies makes the per-strategy cost comparable. */
const PROD_PATH_COUNT = 10_000;

const taxEfficient10k: MonteCarloInput = {
  ...taxInput,
  pathCount: PROD_PATH_COUNT,
  strategyKind: 'taxEfficient',
};

const namedStrategy10k: MonteCarloInput = {
  ...taxInput,
  pathCount: PROD_PATH_COUNT,
  strategyKind: 'rothFirst',
};

test('runMonteCarlo — 10k paths (named-strategy two-pass cost)', async ({ bench }) => {
  await bench.compare(
    bench('taxEfficient, with tax context (10k)', () => {
      runMonteCarlo(taxEfficient10k);
    }),
    bench('named-strategy rothFirst, with tax context (10k)', () => {
      runMonteCarlo(namedStrategy10k);
    }),
  );
});
