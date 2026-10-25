/** Input builders for the four kernel-truncation byte-identity scenarios, with injected returns/CPI.
 * Shared by the capture test and the always-on assert so both build byte-identical inputs. */
import { makeMonthlyExpenseBase } from './monte-carlo.test-helpers.js';
import { DEFAULT_TAX_CALIBRATION_BUNDLE } from './tax-integration.js';
import type {
  McQcdContext,
  McTaxContext,
  MonteCarloAccountLedger,
  MonteCarloInput,
} from './monte-carlo.js';
import type { DownturnGuardrailsOverride } from '../db/types.js';

const INJ_FIRST_YEAR = 2026;
const INJ_HORIZON_YEAR = 2050;
const INJ_STEP_COUNT = (INJ_HORIZON_YEAR - INJ_FIRST_YEAR + 1) * 12;

// Non-zero, month-to-month varying CPI; rational arithmetic only so it stays bit-identical across platforms.
function injectedCpiSeries(): Float64Array {
  const c = new Float64Array(INJ_STEP_COUNT);
  for (let i = 0; i < INJ_STEP_COUNT; i += 1) c[i] = 0.1 + ((i * 7 + 3) % 25) / 100;
  return c;
}

function injectedReturnSeries(): Float64Array {
  const r = new Float64Array(INJ_STEP_COUNT);
  for (let i = 0; i < INJ_STEP_COUNT; i += 1) r[i] = -0.4 + ((i * 11 + 5) % 111) / 100;
  return r;
}

function injLedger(retStep: number): MonteCarloAccountLedger[] {
  const contribPost = new Float64Array(INJ_STEP_COUNT);
  const contribPre = new Float64Array(INJ_STEP_COUNT);
  for (let i = 0; i < Math.min(retStep, INJ_STEP_COUNT); i += 1) {
    contribPost[i] = 1_000;
    contribPre[i] = 800;
  }
  return [
    {
      id: 'brok',
      ownerId: 'm',
      initialPre: 0,
      initialPost: 400_000,
      contribPre: new Float64Array(INJ_STEP_COUNT),
      contribPost,
      deposit: new Float64Array(INJ_STEP_COUNT),
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
      assetMixSeries: null,
      cbpPlanningReturnPct: null,
      taxTreatment: 'POST_TAX',
      accountType: 'BROKERAGE',
    },
    {
      id: 'ira',
      ownerId: 'm',
      initialPre: 300_000,
      initialPost: 0,
      contribPre,
      contribPost: new Float64Array(INJ_STEP_COUNT),
      deposit: new Float64Array(INJ_STEP_COUNT),
      assetMix: { stocksPct: 40, bondsPct: 55, cashPct: 5 },
      assetMixSeries: null,
      cbpPlanningReturnPct: null,
      taxTreatment: 'PRE_TAX',
      accountType: 'RETIREMENT_IRA',
    },
  ];
}

function injTaxContext(): McTaxContext {
  return {
    taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
    filingStatus: 'Single',
    members: [
      { memberId: 'm', isoBirthdate: '1955-06-15', onMedicare: true, hasAcaCoverage: false },
    ],
    householdSize: 1,
  };
}

function injBaseInput(retirementYear: number): MonteCarloInput {
  const years = INJ_HORIZON_YEAR - INJ_FIRST_YEAR + 1;
  const ssByYear = Array.from({ length: years }, (_, i) =>
    INJ_FIRST_YEAR + i >= retirementYear ? 24_000 : 0,
  );
  const incomeByYear = new Array<number>(years).fill(0);
  const retStep = Math.max(0, (retirementYear - INJ_FIRST_YEAR) * 12);
  return {
    portfolioToday: 700_000,
    accountMcLedger: injLedger(retStep),
    annualContribution: 21_600,
    firstYear: INJ_FIRST_YEAR,
    retirementYear,
    horizonYear: INJ_HORIZON_YEAR,
    monthlyExpenseBase: makeMonthlyExpenseBase(60_000, INJ_STEP_COUNT),
    ssByYear,
    incomeByYear,
    pathCount: 20,
    seed: 4242,
    strategyKind: 'taxEfficient',
    taxContext: injTaxContext(),
    scenarioInflationPct: 3,
    todayMonthIndex: 6,
    injectedReturns: injectedReturnSeries(),
    injectedCpi: injectedCpiSeries(),
  };
}

/** Future retirement: 10 accumulation years, kernel runs truncated. */
export function buildFutureRetirementInput(): MonteCarloInput {
  return injBaseInput(INJ_FIRST_YEAR + 10);
}

/** Already retired (`retStart === 0`): kernel skipped. */
export function buildAlreadyRetiredInput(): MonteCarloInput {
  return injBaseInput(INJ_FIRST_YEAR);
}

/** Downturn guardrail enabled; reads cumCpi at year starts. */
export function buildGuardrailsEnabledInput(): MonteCarloInput {
  const retirementYear = INJ_FIRST_YEAR + 5;
  const drawdownYears = INJ_HORIZON_YEAR - retirementYear + 1;
  const guardrails: DownturnGuardrailsOverride = {
    enabled: true,
    lowerBandPct: 85,
    upperBandPct: 115,
    stepPct: 10,
    maxRaisePct: 120,
  };
  return {
    ...injBaseInput(retirementYear),
    downturnGuardrails: guardrails,
    guardrailBaselineTotalRealByYear: new Array<number>(drawdownYears).fill(60_000),
    guardrailEssentialRealByYear: new Array<number>(drawdownYears).fill(30_000),
    guardrailBaselineRealNetNeedByYear: new Array<number>(drawdownYears).fill(36_000),
    guardrailEffectiveTaxRate: 0.15,
  };
}

/** QCD enabled; reads year-end cumCpi to inflate the real gift. */
export function buildQcdEnabledInput(): MonteCarloInput {
  const retirementYear = INJ_FIRST_YEAR + 5;
  const qcdContext: McQcdContext = {
    entries: [
      {
        memberId: 'm',
        sourceAccountId: 'ira',
        annualAmountDollars: 8_000,
        startYear: retirementYear,
        endYear: INJ_HORIZON_YEAR + 1,
      },
    ],
    firstEligibleYearByOwner: { m: INJ_FIRST_YEAR },
    inflationPct: 3,
  };
  return { ...injBaseInput(retirementYear), qcdContext };
}
