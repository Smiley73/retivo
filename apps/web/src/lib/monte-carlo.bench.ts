/** Monte Carlo micro-benchmark (`vitest bench`, outside the test suite): `runMonteCarlo` throughput.
 * The named-strategy 10k-path run does ~2x the drawdown work; budget is at most ~2.5x the Combined-Pot bench. */
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
      taxTreatment: 'PRE_TAX',
      accountType: 'RETIREMENT_IRA',
    },
  ];
}

function buildYearArrays(): { ssByYear: number[]; incomeByYear: number[] } {
  const years = HORIZON_YEAR - FIRST_YEAR + 1;
  const ssByYear = Array.from({ length: years }, (_, i) =>
    FIRST_YEAR + i >= RETIREMENT_YEAR ? 30_000 : 0,
  );
  const incomeByYear = Array.from({ length: years }, () => 0);
  return { ssByYear, incomeByYear };
}

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
