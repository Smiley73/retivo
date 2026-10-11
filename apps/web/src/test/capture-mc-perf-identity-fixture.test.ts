/**
 * Capture script (vitest-based) for the MC perf-identity fixture — a
 * purpose-built byte-identity pin captured BEFORE the hot-path
 * memoization/hoisting changes landed, so a later change that
 * silently moves a number fails loudly here (independent of whether the
 * frozen BPP demo-dataset parity fixture happens to exercise the same seam).
 *
 * `describe.skip` by default — does NOT run on `pnpm test`. To capture or
 * refresh the fixture:
 *
 *   1. Edit `describe.skip(...)` → `describe(...)` below.
 *   2. Run: `pnpm --filter @retirement/web exec vitest run capture-mc-perf-identity-fixture`
 *   3. Inspect `apps/web/src/lib/__fixtures__/mc-perf-identity.json`.
 *   4. Re-apply `describe.skip(...)` BEFORE committing.
 *   5. Commit the fixture + the (still-skipped) capture test together.
 *
 * SIX cases. The first two are built directly as `MonteCarloInput`
 * (mirroring `monte-carlo.bench.ts`'s ledger/tax-context builders — NOT
 * imported from the bench) — NEVER 0% inflation /
 * January, so `cumCpi` actually varies path-to-path and the shared
 * inflation-anchor invariant is exercised somewhere a mismatch would be visible:
 *   (a) the bench-shaped `taxEfficient` two-account household with a tax
 *       context, `pathCount: 500, seed: 12345`.
 *   (b) the same household plus a single-window `magiCapOverride` (Fill mode
 *       targeting a Roth IRA added to the ledger) and a `qcdContext` entry,
 *       `pathCount: 200` — exercising the conversion-hook and QCD seams.
 * The last four are the injected-return kernel-truncation edge
 * cases (`futureRetirement`, `alreadyRetired`, `guardrailsEnabled`,
 * `qcdEnabled`), sharing ONE builder module with the always-on assert
 * (`monte-carlo.kernel-truncation.test.ts`) so both use byte-identical inputs.
 *
 * The assert counterpart (`monte-carlo.perf-identity.test.ts`) rebuilds these
 * exact two inputs independently (its own copy of the builders below — copied,
 * not shared) and deep-equals
 * `summaryToComparable(runMonteCarlo(input))` against this fixture on every
 * run — never re-captured except via the procedure above.
 *
 * On an `ENGINE_VERSION` bump this fixture is re-stamped (only the
 * `engineVersion` stamps move when the cases are unaffected) or re-captured
 * (see "ENGINE_VERSION bump" in AGENTS.md).
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runMonteCarlo } from '../lib/monte-carlo';
import type {
  McQcdContext,
  MonteCarloAccountLedger,
  MonteCarloInput,
  McTaxContext,
} from '../lib/monte-carlo';
import { DEFAULT_TAX_CALIBRATION_BUNDLE } from '../lib/tax-integration';
import { makeMonthlyExpenseBase, summaryToComparable } from '../lib/monte-carlo.test-helpers';
import type { MagiCapOverride } from '../db/types';
// The four injected-return kernel-truncation edge cases share
// ONE builder module with the always-on assert, so the captured fixture and the
// recomputed summary use byte-identical inputs.
import {
  buildAlreadyRetiredInput,
  buildFutureRetirementInput,
  buildGuardrailsEnabledInput,
  buildQcdEnabledInput,
} from '../lib/monte-carlo.kernel-truncation-cases';

const FIRST_YEAR = 2026;
const RETIREMENT_YEAR = 2046;
const HORIZON_YEAR = 2086;
const SEED = 12345;
/** 0-indexed (July) — a non-January as-of month. */
const TODAY_MONTH_INDEX = 6;
/** Non-zero scenario inflation rate. */
const SCENARIO_INFLATION_PCT = 3;

const STEP_COUNT = (HORIZON_YEAR - FIRST_YEAR + 1) * 12;
const RETIREMENT_STEP = (RETIREMENT_YEAR - FIRST_YEAR) * 12;

const FIXTURE_PATH = path.resolve(
  __dirname,
  '..',
  'lib',
  '__fixtures__',
  'mc-perf-identity.json',
);

/** Two-account ledger mirroring `monte-carlo.bench.ts`'s `buildLedger` —
 *  equities-heavy brokerage (post-tax) + bonds-heavy IRA (pre-tax), both
 *  owned by the single tax-context member so RMD/QCD owner-matching engages. */
function buildBaseLedger(): MonteCarloAccountLedger[] {
  const monthlyContribPost = (20_000 * 0.6) / 12;
  const monthlyContribPre = (20_000 * 0.4) / 12;
  const contribPostPrimary = new Float64Array(STEP_COUNT);
  const contribPreSecondary = new Float64Array(STEP_COUNT);
  for (let i = 0; i < Math.min(RETIREMENT_STEP, STEP_COUNT); i += 1) {
    contribPostPrimary[i] = monthlyContribPost;
    contribPreSecondary[i] = monthlyContribPre;
  }
  return [
    {
      id: 'primary',
      ownerId: 'member-1',
      initialPre: 0,
      initialPost: 300_000,
      contribPre: new Float64Array(STEP_COUNT),
      contribPost: contribPostPrimary,
      deposit: new Float64Array(STEP_COUNT),
      assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
      assetMixSeries: null,
      cbpPlanningReturnPct: null,
      taxTreatment: 'POST_TAX',
      accountType: 'BROKERAGE',
    },
    {
      id: 'secondary',
      ownerId: 'member-1',
      initialPre: 200_000,
      initialPost: 0,
      contribPre: contribPreSecondary,
      contribPost: new Float64Array(STEP_COUNT),
      deposit: new Float64Array(STEP_COUNT),
      assetMix: { stocksPct: 40, bondsPct: 55, cashPct: 5 },
      assetMixSeries: null,
      cbpPlanningReturnPct: null,
      taxTreatment: 'PRE_TAX',
      accountType: 'RETIREMENT_IRA',
    },
  ];
}

/** Nominal SS/other-income year arrays (SS starts at retirement), mirroring
 *  `monte-carlo.bench.ts`'s `buildYearArrays`. */
function buildYearArrays(): { ssByYear: number[]; incomeByYear: number[] } {
  const years = HORIZON_YEAR - FIRST_YEAR + 1;
  const ssByYear = Array.from({ length: years }, (_, i) =>
    FIRST_YEAR + i >= RETIREMENT_YEAR ? 30_000 : 0,
  );
  const incomeByYear = Array.from({ length: years }, () => 0);
  return { ssByYear, incomeByYear };
}

/** Single-filer tax context, mirroring `monte-carlo.bench.ts`'s
 *  `buildTaxContext` (member id unified to `member-1` so the ledger's
 *  `ownerId` and the QCD/RMD owner keys all resolve to the same person). */
function buildTaxContext(): McTaxContext {
  return {
    taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
    filingStatus: 'Single',
    members: [
      {
        memberId: 'member-1',
        isoBirthdate: '1971-06-15',
        onMedicare: false,
        hasAcaCoverage: false,
      },
    ],
    householdSize: 1,
  };
}

/** Case (a): bench-shaped `taxEfficient` two-account household with a tax
 *  context, `pathCount: 500, seed: 12345`, non-zero inflation + a non-January
 *  as-of month. */
function buildCaseAInput(): MonteCarloInput {
  return {
    portfolioToday: 500_000,
    accountMcLedger: buildBaseLedger(),
    annualContribution: 20_000,
    firstYear: FIRST_YEAR,
    retirementYear: RETIREMENT_YEAR,
    horizonYear: HORIZON_YEAR,
    monthlyExpenseBase: makeMonthlyExpenseBase(80_000, STEP_COUNT),
    ...buildYearArrays(),
    pathCount: 500,
    seed: SEED,
    strategyKind: 'taxEfficient',
    taxContext: buildTaxContext(),
    scenarioInflationPct: SCENARIO_INFLATION_PCT,
    todayMonthIndex: TODAY_MONTH_INDEX,
  };
}

/** Case (b): case (a)'s household plus a single-window `magiCapOverride`
 *  (Fill mode targeting a Roth IRA added to the ledger) and a `qcdContext`
 *  entry, `pathCount: 200` — exercises the conversion-hook and QCD seams. */
function buildCaseBInput(): MonteCarloInput {
  const caseA = buildCaseAInput();
  const rothLedgerEntry: MonteCarloAccountLedger = {
    id: 'roth',
    ownerId: 'member-1',
    initialPre: 0,
    initialPost: 10_000,
    contribPre: new Float64Array(STEP_COUNT),
    contribPost: new Float64Array(STEP_COUNT),
    deposit: new Float64Array(STEP_COUNT),
    assetMix: { stocksPct: 70, bondsPct: 25, cashPct: 5 },
    assetMixSeries: null,
    cbpPlanningReturnPct: null,
    taxTreatment: 'ROTH',
    accountType: 'RETIREMENT_ROTH_IRA',
  };
  const magiCapOverride: MagiCapOverride = {
    windows: [
      {
        start: { kind: 'retirementStart' },
        end: { kind: 'year', year: HORIZON_YEAR + 1 },
        magiCeilingAnnualDollars: 150_000,
        capMode: 'fill',
        capMagiLine: 'irmaa',
        targetRothAccountId: 'roth',
      },
    ],
  };
  const magiCapWindowBounds = [
    { startYear: RETIREMENT_YEAR, endYear: HORIZON_YEAR + 1, brokenAnchor: false },
  ];
  const qcdContext: McQcdContext = {
    entries: [
      {
        memberId: 'member-1',
        sourceAccountId: 'secondary',
        annualAmountDollars: 10_000,
        startYear: RETIREMENT_YEAR,
        endYear: HORIZON_YEAR + 1,
      },
    ],
    firstEligibleYearByOwner: { 'member-1': RETIREMENT_YEAR },
    inflationPct: SCENARIO_INFLATION_PCT,
  };
  return {
    ...caseA,
    accountMcLedger: [...caseA.accountMcLedger, rothLedgerEntry],
    pathCount: 200,
    magiCapOverride,
    magiCapWindowBounds,
    qcdContext,
  };
}

// `describe.skip` keeps this off the standard test run. Un-skip to
// regenerate the fixture (see file header).
describe.skip('capture MC perf-identity fixture', () => {
  it('writes the comparable summaries for all six cases (2 base cases + 4 kernel-truncation edge cases)', () => {
    const fixture = {
      caseA: summaryToComparable(runMonteCarlo(buildCaseAInput())),
      caseB: summaryToComparable(runMonteCarlo(buildCaseBInput())),
      // The four kernel-truncation injected-return edge cases.
      futureRetirement: summaryToComparable(runMonteCarlo(buildFutureRetirementInput())),
      alreadyRetired: summaryToComparable(runMonteCarlo(buildAlreadyRetiredInput())),
      guardrailsEnabled: summaryToComparable(runMonteCarlo(buildGuardrailsEnabledInput())),
      qcdEnabled: summaryToComparable(runMonteCarlo(buildQcdEnabledInput())),
    };
    return fs
      .mkdir(path.dirname(FIXTURE_PATH), { recursive: true })
      .then(() => fs.writeFile(FIXTURE_PATH, `${JSON.stringify(fixture, null, 2)}\n`))
      .then(() => {
        for (const value of Object.values(fixture)) expect(value).toBeTruthy();
      });
  });
});
