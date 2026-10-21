/**
 * Cross-engine pin tests — under injected-returns mode the
 * Monte Carlo engine consumes a caller-provided per-month
 * return + CPI series instead of historical bootstrap. With CPI pinned
 * at 0 and a flat return rate, MC's per-path trajectory collapses onto
 * the deterministic drawdown engine's per-year balance series — same
 * kernel, same inputs, identical outputs.
 *
 * **Builder-backed inputs.** Each MC side here
 * constructs a `BalanceProjectionMcBundle` and runs it through the
 * production `buildMonteCarloInputs` rather than hand-rolling a
 * `MonteCarloInput`. That way the parity contract exercises both the
 * engine math AND the builder's event-routing, scalar packaging, and
 * validation pass-through.
 *
 * Coverage (the five paths pinned here):
 *   1. Single-pool drawdown — baseline numerical identity.
 *   2. Post-primary windfall — September event five years past primary
 *      retirement.
 *   3. Secondary post-primary contributions — monthly stream across the
 *      overlap window.
 *   4. CBP annuity — balance excluded from portfolio; annuity income
 *      added once via `incomeByYear` / `incomeByMonth`.
 *   5. CBP lump-sum — `cbpLumpSum` event at retirement month with
 *      grown-balance amount.
 */
import { describe, expect, it } from 'vitest';
import { simulateDrawdown } from './drawdown-engine.js';
import { ENGINE_VERSION, runMonteCarlo, type MonteCarloInput } from './monte-carlo.js';
import { monthlyEquivalent } from './projection-engine/monthly-conversion.js';
import {
  addOneOff,
  buildMonthlyFromAnnualMap,
  emptyMonthlySeries,
  type MonthlyCashflowSeries,
} from './monthly-cashflow.js';
import { mcInputFromBundle } from './balance-projection-runner-mc.js';
import {
  runBalanceProjection,
  runBalanceProjectionForPage,
  runBalanceProjectionMc,
} from './balance-projection-runner.js';
import { makeMonthlyExpenseBase } from './monte-carlo.test-helpers.js';
import { applyMcRmdToRepresentativeYears } from './monte-carlo-rmd.js';
import { computeMcRmdFloorCents } from './monte-carlo-tax.js';
import { derivePerAccountRmdShortfallCents } from './balance-projection-runner-tax-helpers.js';
import { computeRmd, type RmdAccountInput } from './rmd.js';
import {
  applyTaxYearForFilingPlan,
  computeRmdFloorCents,
  DEFAULT_TAX_CALIBRATION_BUNDLE,
  type ApplyFilingPlanYearInput,
  type TaxAccountSnapshot,
} from './tax-integration.js';
import type { ResolvedTaxUnit } from './filing-status.js';
import { ownSsByMemberForYear } from './balance-projection-runner-tax-helpers.js';
import { canonicalSsSharesByYear } from './balance-projection-runner-mc.js';
import type {
  AccountMcLedgerEntry,
  BalanceProjectionMcBundle,
  ClassifiedDepositEvent,
} from './balance-projection-bundle.js';
import type { CbpValidationResult } from './cbp-resolution.js';
import type {
  AccountType,
  AccountPayload,
  AccountBalancePayload,
  Aggregate,
  ExpensePayload,
  HouseholdMemberPayload,
  QcdEntry,
  ScenarioOverrides,
  SocialSecurityBenefitPayload,
} from '../db/types.js';
import type { ScenarioAggregate } from './scenario-resolution.js';
import { CASH1_FLOOR, flooredFillArgs } from '../test/fixtures/fill-floor-household';
import type { DrawdownYear, DrawdownAccountYear } from './drawdown-engine-types.js';
import type { MonteCarloAccountLedger } from './monte-carlo-types.js';
import type { TaxMemberInput } from './tax-integration-helpers.js';
import type { PipelineContext } from './balance-projection-runner-types.js';

const RETIREMENT_YEAR = 2030;
const HORIZON_YEAR = 2050;
const YEAR_COUNT = HORIZON_YEAR - RETIREMENT_YEAR + 1;
const STEP_COUNT = YEAR_COUNT * 12;

const okValidation: CbpValidationResult = {
  ok: true,
  unconfigured: [],
  annuityMissingStream: [],
  annuityDuplicateStream: [],
};

const flatPct = (monthlyPct: number): Float64Array =>
  new Float64Array(STEP_COUNT).fill(monthlyPct);

const zeroCpi = (): Float64Array => new Float64Array(STEP_COUNT);

function fillMap(value: number): Map<number, number> {
  const m = new Map<number, number>();
  for (let y = RETIREMENT_YEAR; y <= HORIZON_YEAR; y += 1) m.set(y, value);
  return m;
}

interface PairInput {
  portfolio: number;
  annualExpense: number;
  annualIncome: number;
  ratePct: number;
  events?: ReadonlyArray<{ year: number; month0: number; amount: number }>;
  cbpLumpSumEvents?: ReadonlyArray<ClassifiedDepositEvent>;
  postPrimaryContributions?: ReadonlyArray<ClassifiedDepositEvent>;
  /** Extra annual income that also feeds MC's `incomeByYear`
   *  (e.g. CBP annuity benefit). Auto-included in monthly income series. */
  annualOtherIncome?: number;
  /** Override the single MC ledger account's tax bucketing so the parity
   *  contract exercises the targeted-deposit treatment routing: a PRE_TAX
   *  account holds the initial pool + any rollover in its pre-tax bucket, a
   *  POST_TAX account in its after-tax bucket. The deterministic single-account
   *  side tracks only the TOTAL balance, so total-balance parity holds either
   *  way — this pins that the bucket routing never perturbs the total. */
  ledgerTaxTreatment?: 'PRE_TAX' | 'POST_TAX';
  ledgerAccountType?: AccountType;
  ledgerInitialPreFraction?: number;
  /** Per-account plain-pension placement events (already MC-relative
   *  month). The drawdown side applies the same dollars via depositsByMonth. */
  plainPensionPlacementEvents?: ReadonlyArray<ClassifiedDepositEvent>;
  /** Per-calendar-year rolled-CBP RMD income (dollars) — spendable +
   *  taxable. The drawdown side adds it to its spendable income series; the MC
   *  side folds it into `incomeByYear` (= `otherIncome`). */
  rolledRmdIncomeByYear?: ReadonlyMap<number, number>;
  /** rolled-RMD income the drawdown side adds to its spendable income
   *  series at the event year (mirrors `rolledRmdIncomeByYear` on the MC side). */
  drawdownRmdIncomeByYear?: ReadonlyMap<number, number>;
}

function runDrawdownSide(p: PairInput): number[] {
  const expensesByMonth = buildMonthlyFromAnnualMap(
    fillMap(p.annualExpense),
    RETIREMENT_YEAR,
    HORIZON_YEAR,
  );
  const incomeByMonth = buildMonthlyFromAnnualMap(
    fillMap(p.annualIncome + (p.annualOtherIncome ?? 0)),
    RETIREMENT_YEAR,
    HORIZON_YEAR,
  );
  // The rollover-year RMD cash is spendable income, spread evenly across
  // the 12 months of its event year (mirrors the MC `incomeByYear / 12`
  // treatment so intra-year timing matches — see `addRolledRmdToIncomeSeries`).
  for (const [year, dollars] of p.drawdownRmdIncomeByYear ?? new Map<number, number>()) {
    for (let m = 0; m < 12; m += 1) addOneOff(incomeByMonth, year, m, dollars / 12);
  }
  const depositsByMonth: MonthlyCashflowSeries = emptyMonthlySeries(
    RETIREMENT_YEAR,
    HORIZON_YEAR,
  );
  if (p.events) {
    for (const ev of p.events) {
      addOneOff(depositsByMonth, ev.year, ev.month0, ev.amount);
    }
  }
  // Plain-pension placements add their dollars to the portfolio (the
  // drawdown side pools them; the MC side places them per-account).
  for (const ev of p.plainPensionPlacementEvents ?? []) {
    const year = RETIREMENT_YEAR + Math.floor(ev.month / 12);
    const m0 = ev.month % 12;
    addOneOff(depositsByMonth, year, m0, ev.amount);
  }
  for (const ev of p.cbpLumpSumEvents ?? []) {
    const year = RETIREMENT_YEAR + Math.floor(ev.month / 12);
    const m0 = ev.month % 12;
    addOneOff(depositsByMonth, year, m0, ev.amount);
  }
  for (const ev of p.postPrimaryContributions ?? []) {
    const year = RETIREMENT_YEAR + Math.floor(ev.month / 12);
    const m0 = ev.month % 12;
    addOneOff(depositsByMonth, year, m0, ev.amount);
  }
  // The Combined Pot single-pool path is retired, so the deterministic
  // side runs the per-account engine with ONE account mirroring the MC ledger
  // (`pin-main`): same tax treatment + pre/post split, and the household deposit
  // series routes onto that single account. Under a single account the
  // per-account engine reproduces the single-pool trajectory the MC side hits.
  const ledgerTaxTreatment = p.ledgerTaxTreatment ?? 'POST_TAX';
  const initialPre =
    ledgerTaxTreatment === 'PRE_TAX' ? p.portfolio * (p.ledgerInitialPreFraction ?? 1) : 0;
  const initialPost =
    ledgerTaxTreatment === 'PRE_TAX'
      ? p.portfolio * (1 - (p.ledgerInitialPreFraction ?? 1))
      : p.portfolio;
  const out = simulateDrawdown({
    portfolioAtRetirement: p.portfolio,
    ratePct: p.ratePct,
    expensesByMonth,
    incomeByMonth,
    depositsByMonth: emptyMonthlySeries(RETIREMENT_YEAR, HORIZON_YEAR),
    retirementYear: RETIREMENT_YEAR,
    horizonYear: HORIZON_YEAR,
    withdrawalStrategy: { kind: 'taxEfficient' },
    accounts: [
      {
        id: 'pin-main',
        initialPre,
        initialPost,
        annualRatePct: p.ratePct,
        depositsByMonth,
        taxTreatment: ledgerTaxTreatment,
        accountType: p.ledgerAccountType ?? 'BROKERAGE',
      },
    ],
  });
  return out.years.map((y) => y.balance);
}

/**
 * Build a Monte Carlo bundle that mirrors the drawdown side and
 * produces the same trajectory under injected-returns mode. `firstYear`
 * = retirementYear so there's no accumulation phase to mismatch.
 */
function runMcSide(p: PairInput): number[] {
  const monthlyRate = monthlyEquivalent(p.ratePct);
  // Single-account ledger so the per-account branch runs with one
  // ledger entry. Under injected-returns mode every account adopts the
  // injected per-step return, so the per-account dimension collapses
  // and the parity contract with the deterministic single-pool drawdown
  // still holds. Initial bucket goes into `initialPost` so MIXED-tax
  // split semantics don't perturb the comparison (the drawdown side
  // doesn't track pre/post separately).
  const bundle: BalanceProjectionMcBundle = {
    scenarioId: 'pin-test',
    todayYear: RETIREMENT_YEAR,
    todayMonthIndex: 0,
    retirementYear: RETIREMENT_YEAR,
    primaryRetirementMonth0: 0,
    horizonYear: HORIZON_YEAR,
    retirementFractionalYear: RETIREMENT_YEAR,
    lifeMarkers: [],
    portfolioToday: p.portfolio,
    blendedMix: { stocksPct: 100, bondsPct: 0, cashPct: 0 },
    annualContribution: 0,
    monthlyExpenseBase: makeMonthlyExpenseBase(p.annualExpense, YEAR_COUNT * 12),
    // Year-indexed nominal arrays. firstYear = retirementYear;
    // SS starts immediately (all years in payout). Other income flat.
    ssByYear: new Array<number>(YEAR_COUNT).fill(p.annualIncome),
    incomeByYear: new Array<number>(YEAR_COUNT).fill(p.annualOtherIncome ?? 0),
    // Cross-engine pin runs MC in injected-returns mode, which ignores
    // `scenarioInflationPct` (the v8 mean-shift only applies to the
    // historical-bootstrap path). Any value is fine here; 0 mirrors the
    // pre-v8 flat-CPI behavior used by these pin tests.
    scenarioInflationPct: 0,
    cbpValidation: okValidation,
    cbpLumpSumEvents: p.cbpLumpSumEvents ?? [],
    // Production sources plain-pension dollars into BOTH the household
    // spread (`targetedOneOffEvents`, via `MonthlyIncomeRow.depositInflow`) AND
    // the per-account `plainPensionPlacementEvents`. Mirror that here so the
    // parity contract exercises the real flow: `mcInputFromBundle` subtracts the
    // ledger-MATCHED placements from the spread (placed once per-account) and
    // leaves UNMATCHED placements in the spread (placed once via the spread).
    targetedOneOffEvents: [
      ...(p.events ?? []).map((ev) => ({
        month: (ev.year - RETIREMENT_YEAR) * 12 + ev.month0,
        amount: ev.amount,
      })),
      ...(p.plainPensionPlacementEvents ?? []).map((ev) => ({
        month: ev.month,
        amount: ev.amount,
      })),
    ],
    postPrimaryContributionEvents: p.postPrimaryContributions ?? [],
    plainPensionPlacementEvents: p.plainPensionPlacementEvents ?? [],
    rolledRmdIncomeByYear: p.rolledRmdIncomeByYear ?? new Map<number, number>(),
    accounts: [],
    members: [],
    accountMcLedger: [
      {
        id: 'pin-main',
        initialPre:
          p.ledgerTaxTreatment === 'PRE_TAX'
            ? p.portfolio * (p.ledgerInitialPreFraction ?? 1)
            : 0,
        initialPost:
          p.ledgerTaxTreatment === 'PRE_TAX'
            ? p.portfolio * (1 - (p.ledgerInitialPreFraction ?? 1))
            : p.portfolio,
        contribPre: new Float64Array(STEP_COUNT),
        contribPost: new Float64Array(STEP_COUNT),
        deposit: new Float64Array(STEP_COUNT),
        depositPre: new Float64Array(STEP_COUNT),
        depositPost: new Float64Array(STEP_COUNT),
        assetMix: { stocksPct: 100, bondsPct: 0, cashPct: 0 },
        assetMixSeries: null,
        cbpPlanningReturnPct: null,
        taxTreatment: p.ledgerTaxTreatment ?? 'POST_TAX',
        accountType: p.ledgerAccountType ?? 'BROKERAGE',
        ownerId: 'pin-primary',
        contribGrowthMode: 'fixed',
        plannedContribPostBase: null,
      },
    ],
  };
  // Cross-engine-pin reroutes through the runner's public
  // `mcInputFromBundle` so the parity contract exercises the same
  // input-builder BPP + the optimizer use.
  const built = mcInputFromBundle(bundle);
  const input: MonteCarloInput = {
    ...built,
    pathCount: 1,
    seed: 1,
    injectedReturns: flatPct(monthlyRate),
    injectedCpi: zeroCpi(),
  };
  const mc = runMonteCarlo(input);
  return mc.percentilesNominal.p50;
}

function assertSeriesEqual(a: number[], b: number[]): void {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i += 1) {
    // Penny-level tolerance — both kernels are bit-deterministic, but
    // Float64 rounding accumulates over 252 monthly steps. $0.01 is a
    // comfortable budget.
    expect(b[i]).toBeCloseTo(a[i], 2);
  }
}

describe('cross-engine pin — deterministic drawdown vs MC (builder-backed)', () => {
  // (a) Single-pool baseline: no events, no CBP.
  it('single-pool drawdown agrees with MC at flat 6% rate', () => {
    const cfg: PairInput = {
      portfolio: 1_000_000,
      annualExpense: 60_000,
      annualIncome: 25_000,
      ratePct: 6,
    };
    assertSeriesEqual(runDrawdownSide(cfg), runMcSide(cfg));
  });

  // (b) Post-primary windfall — September of year-5 past retirement.
  it('Sept windfall five years post-retirement agrees on both engines', () => {
    const cfg: PairInput = {
      portfolio: 800_000,
      annualExpense: 55_000,
      annualIncome: 20_000,
      ratePct: 5,
      events: [{ year: RETIREMENT_YEAR + 5, month0: 8, amount: 40_000 }],
    };
    assertSeriesEqual(runDrawdownSide(cfg), runMcSide(cfg));
  });

  // (c) Secondary post-primary contributions: $1500/mo over 5 years.
  it('synthesized monthly secondary-contribution stream lines up', () => {
    const postPrimary: ClassifiedDepositEvent[] = [];
    for (let m = 0; m < 60; m += 1) {
      postPrimary.push({ month: m, amount: 1500 });
    }
    const cfg: PairInput = {
      portfolio: 700_000,
      annualExpense: 65_000,
      annualIncome: 22_000,
      ratePct: 6,
      postPrimaryContributions: postPrimary,
    };
    assertSeriesEqual(runDrawdownSide(cfg), runMcSide(cfg));
  });

  // (d) CBP annuity: portfolio is already net of CBP balance; annuity
  //     income flows in via `incomeByYear` (deterministic side also reads
  //     it through `incomeByMonth`).
  it('CBP annuity (balance excluded + annuity income added) matches across engines', () => {
    const portfolioAtRetirementNet = 750_000;
    const annuityIncome = 18_000;
    const cfg: PairInput = {
      portfolio: portfolioAtRetirementNet,
      annualExpense: 60_000,
      annualIncome: 25_000,
      annualOtherIncome: annuityIncome,
      ratePct: 6,
    };
    assertSeriesEqual(runDrawdownSide(cfg), runMcSide(cfg));
  });

  // (e) CBP lump-sum: builder emits `cbpLumpSum` event at retirement
  //     month; drawdown side gets the same dollars via depositsByMonth.
  it('CBP lump-sum at retirement matches across engines', () => {
    const portfolioBeforeLumpSum = 700_000;
    const lumpSum = 200_000;
    const cbpLumpSumEvents: ClassifiedDepositEvent[] = [
      { month: 0, amount: lumpSum, accountId: 'cbp-1' },
    ];
    const cfg: PairInput = {
      portfolio: portfolioBeforeLumpSum,
      annualExpense: 60_000,
      annualIncome: 25_000,
      ratePct: 5,
      cbpLumpSumEvents,
    };
    assertSeriesEqual(runDrawdownSide(cfg), runMcSide(cfg));
  });

  // (f) Qualifying pre-tax account holding BOTH pre and post dollars: the
  //     deposit-routing fix must not perturb the total-balance trajectory
  //     vs the deterministic single-account engine. (The pre-vs-post bucket split
  //     is asserted directly in the engine unit tests; here we pin that the
  //     shared seam keeps the cross-engine TOTAL identical.)
  it('a pre-tax account with both pre and post dollars matches the deterministic total', () => {
    const cfg: PairInput = {
      portfolio: 900_000,
      annualExpense: 55_000,
      annualIncome: 20_000,
      ratePct: 6,
      ledgerTaxTreatment: 'PRE_TAX',
      ledgerAccountType: 'RETIREMENT_IRA',
      ledgerInitialPreFraction: 0.8, // pre>0 AND post>0
    };
    assertSeriesEqual(runDrawdownSide(cfg), runMcSide(cfg));
  });

  // (g) Targeted CBP rollover into a PRE_TAX account: the rollover lands in the
  //     pre-tax bucket on the MC side yet the cross-engine TOTAL still
  //     tracks the deterministic single-account engine penny-for-penny.
  it('a CBP rollover into a pre-tax account matches the deterministic total', () => {
    const cbpLumpSumEvents: ClassifiedDepositEvent[] = [
      { month: 0, amount: 200_000, accountId: 'cbp-1' },
    ];
    const cfg: PairInput = {
      portfolio: 700_000,
      annualExpense: 60_000,
      annualIncome: 25_000,
      ratePct: 5,
      cbpLumpSumEvents,
      ledgerTaxTreatment: 'PRE_TAX',
      ledgerAccountType: 'RETIREMENT_IRA',
      ledgerInitialPreFraction: 1,
    };
    assertSeriesEqual(runDrawdownSide(cfg), runMcSide(cfg));
  });

  // (h) plain-pension per-account placement: a post-retirement plain
  //     pension lump-sum placed in a specific account (MC side) vs pooled into
  //     the portfolio (drawdown side) — the cross-engine TOTAL still tracks
  //     penny-for-penny under injected returns.
  it('a plain-pension per-account placement matches the deterministic total', () => {
    const placement: ClassifiedDepositEvent[] = [
      // September of year-3 past retirement. Targets a non-ledger account so the
      // household-spread fallback routes it onto the single MC account —
      // mathematically identical to per-account placement under one account, and
      // it exercises the conservation path (the in-ledger bucket placement is
      // pinned by the focused engine tests). The drawdown side pools it.
      { month: 3 * 12 + 8, amount: 50_000, accountId: 'plain-pension-target' },
    ];
    const cfg: PairInput = {
      portfolio: 800_000,
      annualExpense: 55_000,
      annualIncome: 20_000,
      ratePct: 5,
      plainPensionPlacementEvents: placement,
      ledgerTaxTreatment: 'PRE_TAX',
      ledgerAccountType: 'RETIREMENT_IRA',
      ledgerInitialPreFraction: 1,
    };
    assertSeriesEqual(runDrawdownSide(cfg), runMcSide(cfg));
  });

  // (i) linked-CBP rollover-year RMD split: given the SAME split inputs
  //     (rolled EXCESS as the CBP lump-sum event + the carved RMD as per-year
  //     spendable income), the two engines agree to the cent at a non-January
  //     event month. The split helper's
  //     arithmetic is unit-tested in rmd-rollover-split.test.ts; here we pin
  //     that the engines route the split's two legs identically.
  it('a linked-CBP rollover-year RMD split matches the deterministic total', () => {
    const eventMonth = 5 * 12 + 8; // September, five years past retirement
    const rolledExcess = 170_000;
    const carvedRmd = 30_000;
    const eventYear = RETIREMENT_YEAR + 5;
    const cbpLumpSumEvents: ClassifiedDepositEvent[] = [
      { month: eventMonth, amount: rolledExcess, accountId: 'cbp-1' },
    ];
    const cfg: PairInput = {
      portfolio: 700_000,
      annualExpense: 60_000,
      annualIncome: 25_000,
      ratePct: 5,
      cbpLumpSumEvents,
      rolledRmdIncomeByYear: new Map([[eventYear, carvedRmd]]),
      drawdownRmdIncomeByYear: new Map([[eventYear, carvedRmd]]),
      ledgerTaxTreatment: 'PRE_TAX',
      ledgerAccountType: 'RETIREMENT_IRA',
      ledgerInitialPreFraction: 1,
    };
    assertSeriesEqual(runDrawdownSide(cfg), runMcSide(cfg));
  });

  it('pins the Monte Carlo ENGINE_VERSION at 73 (the stress test offsets the early-withdrawal penalty with the ACA credit as the projection does, and the line\u2019s poverty-line limit counts only the gain of a taxable-account draw)', () => {
    expect(ENGINE_VERSION).toBe(73);
  });
});

// ---------------------------------------------------------------------------
// Last-resort floor-reserve depletion — reserve DRAW parity
// (deterministic vs MC representative run). Both engines run the per-account
// path with a floored POST_TAX brokerage under a heavy spend, so the ordinary
// above-floor draw AND the last-resort reserve draw both fire — draining the
// account to $0 and depleting the plan tail. Under injected flat returns + 0 CPI
// the MC representative P50 run replays a single deterministic path, so the
// per-year balance series (incl. the depleted tail) must match to the cent.
// ---------------------------------------------------------------------------
describe('cross-engine pin — last-resort floor-reserve depletion', () => {
  const RATE_PCT = 3;
  const ANNUAL_EXPENSE = 90_000;
  const FLOOR_DOLLARS = 150_000;
  const BROK_INITIAL = 500_000;

  function drawdownReserveSide(): DrawdownYear[] {
    const out = simulateDrawdown({
      portfolioAtRetirement: 0,
      ratePct: RATE_PCT,
      expensesByMonth: buildMonthlyFromAnnualMap(fillMap(ANNUAL_EXPENSE), RETIREMENT_YEAR, HORIZON_YEAR),
      incomeByMonth: emptyMonthlySeries(RETIREMENT_YEAR, HORIZON_YEAR),
      depositsByMonth: emptyMonthlySeries(RETIREMENT_YEAR, HORIZON_YEAR),
      retirementYear: RETIREMENT_YEAR,
      horizonYear: HORIZON_YEAR,
      withdrawalStrategy: { kind: 'taxEfficient' },
      accounts: [
        {
          id: 'brok', initialPre: 0, initialPost: BROK_INITIAL, annualRatePct: RATE_PCT,
          taxTreatment: 'POST_TAX', accountType: 'BROKERAGE',
          depositsByMonth: emptyMonthlySeries(RETIREMENT_YEAR, HORIZON_YEAR),
          floorDollars: FLOOR_DOLLARS,
        },
      ],
    });
    return out.years;
  }

  function mcReserveSide(): DrawdownYear[] {
    const monthlyRate = monthlyEquivalent(RATE_PCT);
    const bundle: BalanceProjectionMcBundle = {
      scenarioId: 'pin-reserve', todayYear: RETIREMENT_YEAR, todayMonthIndex: 0,
      retirementYear: RETIREMENT_YEAR, primaryRetirementMonth0: 0, horizonYear: HORIZON_YEAR,
      retirementFractionalYear: RETIREMENT_YEAR, lifeMarkers: [],
      portfolioToday: BROK_INITIAL,
      blendedMix: { stocksPct: 100, bondsPct: 0, cashPct: 0 }, annualContribution: 0,
      monthlyExpenseBase: makeMonthlyExpenseBase(ANNUAL_EXPENSE, STEP_COUNT),
      ssByYear: new Array<number>(YEAR_COUNT).fill(0),
      incomeByYear: new Array<number>(YEAR_COUNT).fill(0),
      scenarioInflationPct: 0, cbpValidation: okValidation,
      cbpLumpSumEvents: [], targetedOneOffEvents: [], postPrimaryContributionEvents: [],
      plainPensionPlacementEvents: [], rolledRmdIncomeByYear: new Map<number, number>(),
      accounts: [], members: [],
      accountMcLedger: [
        {
          id: 'brok', initialPre: 0, initialPost: BROK_INITIAL,
          contribPre: new Float64Array(STEP_COUNT), contribPost: new Float64Array(STEP_COUNT),
          deposit: new Float64Array(STEP_COUNT),
          depositPre: new Float64Array(STEP_COUNT), depositPost: new Float64Array(STEP_COUNT),
          assetMix: { stocksPct: 100, bondsPct: 0, cashPct: 0 }, assetMixSeries: null,
          cbpPlanningReturnPct: null, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE',
          ownerId: 'pin-primary', contribGrowthMode: 'fixed', plannedContribPostBase: null,
          floorDollars: FLOOR_DOLLARS,
        },
      ],
    };
    const built = mcInputFromBundle(bundle);
    const mc = runMonteCarlo({
      ...built, pathCount: 1, seed: 1,
      injectedReturns: flatPct(monthlyRate), injectedCpi: zeroCpi(),
    });
    const rep = mc.representativeByBasis?.['mc-typical'];
    if (!rep) throw new Error('expected a P50 (mc-typical) representative run');
    return [...rep.years];
  }

  it('drains the floored reserve to $0 (incl. depleted tail) identically on both engines', () => {
    const det = drawdownReserveSide().filter((y) => y.accountBalances);
    const mc = mcReserveSide().filter((y) => y.accountBalances);
    expect(det.length).toBeGreaterThan(0);
    expect(mc.length).toBeGreaterThan(0);
    const n = Math.min(det.length, mc.length);
    let sawBelowFloor = false;
    let sawZero = false;
    for (let i = 0; i < n; i += 1) {
      // Cent-level per-year total-balance parity across engines.
      expect(mc[i].balance).toBeCloseTo(det[i].balance, 2);
      const dBrok = det[i].accountBalances?.get('brok');
      if (dBrok && dBrok.balance < FLOOR_DOLLARS - 1) sawBelowFloor = true;
      if (dBrok && dBrok.balance <= 1) sawZero = true;
    }
    expect(sawBelowFloor).toBe(true); // last-resort reserve draw fired
    expect(sawZero).toBe(true); // the floored account drained all the way to $0
  });
});

// ---------------------------------------------------------------------------
// HSA medical/emergency parity (deterministic vs MC representative run).
//
// Both engines run the per-account path with a brokerage + HSA account and a
// nonzero flat medical demand. Under injected returns (flat rate, 0 CPI) the MC
// representative P50 run replays a single deterministic path, so the HSA
// withdrawn + the medical/emergency split must reconcile to the cent.
// ---------------------------------------------------------------------------

describe('cross-engine pin — HSA medical/emergency split', () => {
  const RATE_PCT = 4;
  const ANNUAL_EXPENSE = 48_000; // $4k/mo
  const ANNUAL_MEDICAL = 12_000; // $1k/mo medical demand
  const BROK_INITIAL = 600_000;
  const HSA_INITIAL = 120_000;

  function drawdownHsaSide(): DrawdownYear[] {
    const medicalDemandByMonth = new Array<number>(STEP_COUNT).fill(
      Math.round((ANNUAL_MEDICAL / 12) * 100),
    );
    const out = simulateDrawdown({
      portfolioAtRetirement: 0,
      ratePct: RATE_PCT,
      expensesByMonth: buildMonthlyFromAnnualMap(fillMap(ANNUAL_EXPENSE), RETIREMENT_YEAR, HORIZON_YEAR),
      incomeByMonth: emptyMonthlySeries(RETIREMENT_YEAR, HORIZON_YEAR),
      depositsByMonth: emptyMonthlySeries(RETIREMENT_YEAR, HORIZON_YEAR),
      retirementYear: RETIREMENT_YEAR,
      horizonYear: HORIZON_YEAR,
      // Single brokerage + HSA per-account ledger (proportional draw).
      accounts: [
        {
          id: 'brok', initialPre: 0, initialPost: BROK_INITIAL, annualRatePct: RATE_PCT,
          taxTreatment: 'POST_TAX', accountType: 'BROKERAGE',
          depositsByMonth: emptyMonthlySeries(RETIREMENT_YEAR, HORIZON_YEAR),
        },
        {
          id: 'hsa', initialPre: 0, initialPost: HSA_INITIAL, annualRatePct: RATE_PCT,
          taxTreatment: 'HSA', accountType: 'HSA',
          depositsByMonth: emptyMonthlySeries(RETIREMENT_YEAR, HORIZON_YEAR),
        },
      ],
      medicalDemandByMonth,
    });
    return out.years;
  }

  function mcHsaSide(): DrawdownYear[] {
    const monthlyRate = monthlyEquivalent(RATE_PCT);
    const ledger = (
      id: string,
      initialPost: number,
      taxTreatment: 'POST_TAX' | 'HSA',
      accountType: AccountType,
    ): AccountMcLedgerEntry => ({
      id, initialPre: 0, initialPost,
      contribPre: new Float64Array(STEP_COUNT),
      contribPost: new Float64Array(STEP_COUNT),
      deposit: new Float64Array(STEP_COUNT),
      depositPre: new Float64Array(STEP_COUNT),
      depositPost: new Float64Array(STEP_COUNT),
      assetMix: { stocksPct: 100, bondsPct: 0, cashPct: 0 },
      assetMixSeries: null, cbpPlanningReturnPct: null,
      taxTreatment, accountType, ownerId: 'pin-primary',
      contribGrowthMode: 'fixed', plannedContribPostBase: null,
    });
    const bundle: BalanceProjectionMcBundle = {
      scenarioId: 'pin-hsa', todayYear: RETIREMENT_YEAR, todayMonthIndex: 0,
      retirementYear: RETIREMENT_YEAR, primaryRetirementMonth0: 0, horizonYear: HORIZON_YEAR,
      retirementFractionalYear: RETIREMENT_YEAR, lifeMarkers: [],
      portfolioToday: BROK_INITIAL + HSA_INITIAL,
      blendedMix: { stocksPct: 100, bondsPct: 0, cashPct: 0 }, annualContribution: 0,
      monthlyExpenseBase: makeMonthlyExpenseBase(ANNUAL_EXPENSE, STEP_COUNT),
      monthlyMedicalDemandBase: new Array<number>(STEP_COUNT).fill(ANNUAL_MEDICAL / 12),
      medicalDemandRatePct: 0,
      ssByYear: new Array<number>(YEAR_COUNT).fill(0),
      incomeByYear: new Array<number>(YEAR_COUNT).fill(0),
      scenarioInflationPct: 0, cbpValidation: okValidation,
      cbpLumpSumEvents: [], targetedOneOffEvents: [], postPrimaryContributionEvents: [],
      plainPensionPlacementEvents: [], rolledRmdIncomeByYear: new Map<number, number>(),
      accounts: [], members: [],
      accountMcLedger: [
        ledger('brok', BROK_INITIAL, 'POST_TAX', 'BROKERAGE'),
        ledger('hsa', HSA_INITIAL, 'HSA', 'HSA'),
      ],
    };
    const built = mcInputFromBundle(bundle);
    const mc = runMonteCarlo({
      ...built, pathCount: 1, seed: 1,
      injectedReturns: flatPct(monthlyRate), injectedCpi: zeroCpi(),
    });
    const rep = mc.representativeByBasis?.['mc-typical'];
    if (!rep) throw new Error('expected a P50 (mc-typical) representative run');
    return [...rep.years];
  }

  it('reconciles HSA withdrawn + the medical/emergency split to the cent', () => {
    const det = drawdownHsaSide();
    const mc = mcHsaSide();
    // Compare the drawdown-phase years (MC representative starts at retirement).
    const detDraw = det.filter((y) => y.accountBalances);
    const mcDraw = mc.filter((y) => y.accountBalances);
    expect(mcDraw.length).toBeGreaterThan(0);
    const n = Math.min(detDraw.length, mcDraw.length);
    let assertedMedical = false;
    for (let i = 0; i < n; i += 1) {
      const dHsa = detDraw[i].accountBalances?.get('hsa');
      const mHsa = mcDraw[i].accountBalances?.get('hsa');
      expect(mHsa?.withdrawn ?? 0).toBeCloseTo(dHsa?.withdrawn ?? 0, 2);
      const dMed = dHsa?.medicalQualifiedWithdrawnCents ?? 0;
      const mMed = mHsa?.medicalQualifiedWithdrawnCents ?? 0;
      expect(Math.abs(mMed - dMed)).toBeLessThanOrEqual(1); // ~$0.01
      // Medical + emergency residual sum exactly to the committed HSA cents.
      const committed = Math.round((dHsa?.withdrawn ?? 0) * 100);
      expect(committed - dMed).toBeGreaterThanOrEqual(0);
      if (dMed > 0) assertedMedical = true;
    }
    expect(assertedMedical).toBe(true); // the medical pass actually fired
  });
});

// ---------------------------------------------------------------------------
// RMD-shortfall pooling parity — deterministic vs MC derivation site.
//
// The balance-series pin above runs a single-account MC,
// which never exercises the per-account RMD-shortfall pooling. This block feeds
// IDENTICAL two-same-owner-IRA uneven-draw inputs to BOTH derivation sites
// (`derivePerAccountRmdShortfallCents` deterministic + `applyMcRmdToRepresentativeYears`
// MC) and asserts they return cent-identical `rmdShortfallCents`, plus the
// pool-aggregation invariants (`Σ poolRequired === rmdFloorCents`,
// `0 ≤ shortfall ≤ floor`).
// ---------------------------------------------------------------------------

const PARITY_RMD_SNAPSHOT = DEFAULT_TAX_CALIBRATION_BUNDLE.rmd;

/** Member born 1951 → RMD trigger age 73 (RMD applies for any year ≥ 2024). */
const PARITY_PRIMARY: TaxMemberInput = {
  memberId: 'owner-a',
  isoBirthdate: '1951-03-10',
  onMedicare: true,
  hasAcaCoverage: false,
};

function parityLedger(
  id: string,
  initialPre: number,
): MonteCarloAccountLedger {
  return {
    id,
    initialPre,
    initialPost: 0,
    contribPre: new Float64Array(0),
    contribPost: new Float64Array(0),
    deposit: new Float64Array(0),
    assetMix: null,
    assetMixSeries: null,
    cbpPlanningReturnPct: null,
    taxTreatment: 'PRE_TAX',
    accountType: 'RETIREMENT_IRA',
    ownerId: 'owner-a',
  };
}

function parityAcctYear(preEnd: number, withdrawn: number): DrawdownAccountYear {
  return { balance: preEnd, preEnd, postEnd: 0, withdrawn, deposit: 0 };
}

/** Minimal PipelineContext exposing only `accountProjections` (the sole field
 *  `derivePerAccountRmdShortfallCents` reads). */
function parityCtx(): PipelineContext {
  const mkProj = (id: string) => ({
    account: {
      id,
      householdId: 'hh',
      payload: {
        type: 'RETIREMENT_IRA',
        taxTreatment: 'PRE_TAX',
        ownerId: 'owner-a',
      },
    },
  });
  return {
    accountProjections: [mkProj('A'), mkProj('B')],
  } as unknown as PipelineContext;
}

describe('cross-engine pin — RMD-shortfall pooling parity (det vs MC)', () => {
  it('two same-owner IRAs, uneven draw (pool satisfied) → both engines report shortfall 0 with floor invariants', () => {
    const pre = 500_000;
    const year = 2046; // born 1951 → age 95, well past trigger
    // Pool minimum for $1M at this age ≈ $112k; A draws $150k, B draws $0.
    const aDraw = 150_000;

    // ----- Deterministic side -----
    // Build rmdPerAccountCents the SAME way production does (computeRmd over the
    // owner's two qualifying IRAs), then derive the pooled shortfall.
    const rmdAccounts: RmdAccountInput[] = [
      { id: 'A', balanceDec31PriorYearCents: pre * 100, accountType: 'RETIREMENT_IRA', taxTreatment: 'PRE_TAX' },
      { id: 'B', balanceDec31PriorYearCents: pre * 100, accountType: 'RETIREMENT_IRA', taxTreatment: 'PRE_TAX' },
    ];
    const rmd = computeRmd(
      { isoBirthdate: PARITY_PRIMARY.isoBirthdate, taxYear: year, accounts: rmdAccounts },
      PARITY_RMD_SNAPSHOT,
    );
    const detFloor = rmd.ownerRmdCents;
    const detYear: DrawdownYear = {
      year,
      balance: 2 * pre,
      withdrawn: aDraw,
      netNeed: aDraw,
      growth: 0,
      deposit: 0,
      depleted: false,
      accountBalances: new Map([
        ['A', parityAcctYear(pre, aDraw)],
        ['B', parityAcctYear(pre, 0)],
      ]),
    };
    const detShortfall = derivePerAccountRmdShortfallCents(
      parityCtx(),
      detYear,
      rmd.perAccountRmdCents,
    );

    // ----- MC side -----
    const mcYears: DrawdownYear[] = [
      {
        year: year - 1,
        balance: 2 * pre,
        withdrawn: 0,
        netNeed: 0,
        growth: 0,
        deposit: 0,
        depleted: false,
        accountBalances: new Map([
          ['A', parityAcctYear(pre, 0)],
          ['B', parityAcctYear(pre, 0)],
        ]),
      },
      {
        year,
        balance: 2 * pre,
        withdrawn: aDraw,
        netNeed: aDraw,
        growth: 0,
        deposit: 0,
        depleted: false,
        accountBalances: new Map([
          ['A', parityAcctYear(pre, aDraw)],
          ['B', parityAcctYear(pre, 0)],
        ]),
      },
    ];
    applyMcRmdToRepresentativeYears({
      years: mcYears,
      ledger: [parityLedger('A', pre), parityLedger('B', pre)],
      members: [PARITY_PRIMARY],
      rmdSnapshot: PARITY_RMD_SNAPSHOT,
    });
    const mcFloor = mcYears[1].rmdFloorCents!;
    const mcShortfall = mcYears[1].rmdShortfallCents!;

    // Both engines agree the pool was satisfied → 0 shortfall, cent-identical.
    expect(detShortfall).toBe(0);
    expect(mcShortfall).toBe(0);
    expect(mcShortfall).toBe(detShortfall);

    // Σ poolRequired === rmdFloorCents (the floor is the sum of the per-account
    // required shares, which pool to the same total).
    expect(mcFloor).toBe(detFloor);
    expect(detFloor).toBeGreaterThan(0);
    // 0 ≤ shortfall ≤ floor on both sides.
    expect(detShortfall!).toBeGreaterThanOrEqual(0);
    expect(detShortfall!).toBeLessThanOrEqual(detFloor);
    expect(mcShortfall).toBeGreaterThanOrEqual(0);
    expect(mcShortfall).toBeLessThanOrEqual(mcFloor);
  });
});

// ---------------------------------------------------------------------------
// Per-owner RMD floor parity (det vs MC). For a Roth-heavy or all-taxable
// household at RMD age the RMD floor is $0 in BOTH engines: the deterministic
// `computeRmdFloorCents` skips non-qualifying accounts, and the MC per-path
// `computeMcRmdFloorCents` reads an empty per-owner pre-tax basis. The legacy MC
// whole-portfolio synthetic floor would have produced a phantom positive here.
// ---------------------------------------------------------------------------
describe('cross-engine pin — per-owner RMD floor = 0 for Roth/taxable at RMD age', () => {
  it('all-Roth household at RMD age → MC floor 0 == deterministic floor 0', () => {
    const year = 2046; // PARITY_PRIMARY born 1951 → well past trigger
    // Deterministic: a Roth IRA is non-qualifying → $0 floor.
    const detAccounts: TaxAccountSnapshot[] = [
      {
        id: 'roth',
        type: 'RETIREMENT_ROTH_IRA',
        taxTreatment: 'ROTH',
        ownerId: PARITY_PRIMARY.memberId,
        balancePriorYearDollars: 1_000_000,
        withdrawalDollars: 0,
      },
    ];
    const detFloor = computeRmdFloorCents([PARITY_PRIMARY], detAccounts, year, PARITY_RMD_SNAPSHOT);
    // MC: no pre-tax sub-bucket → empty per-owner map → $0 floor.
    const mcFloor = computeMcRmdFloorCents(new Map(), [PARITY_PRIMARY], year, PARITY_RMD_SNAPSHOT);
    expect(detFloor).toBe(0);
    expect(mcFloor).toBe(0);
    expect(mcFloor).toBe(detFloor);
  });

  it('all-taxable (brokerage) household at RMD age → MC floor 0 == deterministic floor 0', () => {
    const year = 2046;
    const detAccounts: TaxAccountSnapshot[] = [
      {
        id: 'brk',
        type: 'BROKERAGE',
        taxTreatment: 'POST_TAX',
        ownerId: PARITY_PRIMARY.memberId,
        balancePriorYearDollars: 1_000_000,
        withdrawalDollars: 0,
      },
    ];
    const detFloor = computeRmdFloorCents([PARITY_PRIMARY], detAccounts, year, PARITY_RMD_SNAPSHOT);
    const mcFloor = computeMcRmdFloorCents(new Map(), [PARITY_PRIMARY], year, PARITY_RMD_SNAPSHOT);
    expect(detFloor).toBe(0);
    expect(mcFloor).toBe(0);
    expect(mcFloor).toBe(detFloor);
  });

  it('pre-tax household at RMD age → both engines produce the SAME positive floor', () => {
    const year = 2046;
    const detAccounts: TaxAccountSnapshot[] = [
      {
        id: 'ira',
        type: 'RETIREMENT_IRA',
        taxTreatment: 'PRE_TAX',
        ownerId: PARITY_PRIMARY.memberId,
        balancePriorYearDollars: 1_000_000,
        withdrawalDollars: 0,
      },
    ];
    const detFloor = computeRmdFloorCents([PARITY_PRIMARY], detAccounts, year, PARITY_RMD_SNAPSHOT);
    const mcFloor = computeMcRmdFloorCents(
      new Map([[PARITY_PRIMARY.memberId, 1_000_000_00]]),
      [PARITY_PRIMARY],
      year,
      PARITY_RMD_SNAPSHOT,
    );
    expect(detFloor).toBeGreaterThan(0);
    expect(mcFloor).toBe(detFloor); // identical seam → cent-identical
  });
});

// ---------------------------------------------------------------------------
// QCD — det↔MC parity at the shared RMD-floor / QCD-offset
// seam. The deterministic engine reduces the IRA-pool RMD floor by `min(Q, gross
// IRA RMD)` (the offset) and reports `netTaxableRmdCents = gross − offset`; the
// MC per-path tax floor (`computeMcRmdFloorCents` with the per-owner offset map)
// must land on the SAME offset-reduced taxable floor cent-for-cent — both ride
// the shared `computeRmdFloorCents` seam, so a QCD cannot diverge the two engines'
// taxable-RMD basis.
// ---------------------------------------------------------------------------
describe('cross-engine pin — QCD IRA-pool RMD-floor offset (det vs MC)', () => {
  it('det net-taxable-RMD (gross − offset) == MC offset-reduced floor, cent-identical', () => {
    const year = 2046; // PARITY_PRIMARY born 1951 → well past trigger
    const preCents = 1_000_000_00;
    // Gross IRA-pool RMD floor (shared seam) — the basis the offset reduces.
    const grossFloor = computeRmdFloorCents(
      [PARITY_PRIMARY],
      [
        {
          id: 'ira',
          type: 'RETIREMENT_IRA',
          taxTreatment: 'PRE_TAX',
          ownerId: PARITY_PRIMARY.memberId,
          balancePriorYearDollars: preCents / 100,
          withdrawalDollars: 0,
        },
      ],
      year,
      PARITY_RMD_SNAPSHOT,
    );
    expect(grossFloor).toBeGreaterThan(0);
    // A $40k QCD (< gross) → deterministic net-taxable-RMD = gross − 40k.
    const qcdCents = 40_000_00;
    const detNetTaxable = grossFloor - Math.min(qcdCents, grossFloor);
    // MC: the per-owner offset-reduced floor reads the SAME pre-tax basis +
    // subtracts the SAME offset → cent-identical to the deterministic net.
    const mcNetTaxable = computeMcRmdFloorCents(
      new Map([[PARITY_PRIMARY.memberId, preCents]]),
      [PARITY_PRIMARY],
      year,
      PARITY_RMD_SNAPSHOT,
      new Map([[PARITY_PRIMARY.memberId, qcdCents]]),
    );
    expect(mcNetTaxable).toBe(detNetTaxable);
  });

  it('a QCD ≥ the gross IRA RMD zeroes the taxable floor in BOTH engines', () => {
    const year = 2046;
    const preCents = 1_000_000_00;
    const grossFloor = computeRmdFloorCents(
      [PARITY_PRIMARY],
      [
        {
          id: 'ira',
          type: 'RETIREMENT_IRA',
          taxTreatment: 'PRE_TAX',
          ownerId: PARITY_PRIMARY.memberId,
          balancePriorYearDollars: preCents / 100,
          withdrawalDollars: 0,
        },
      ],
      year,
      PARITY_RMD_SNAPSHOT,
    );
    // Q ≥ gross → deterministic net-taxable-RMD clamps to 0 (gross − min(Q,gross)).
    const hugeQcd = grossFloor + 1_000_00;
    const detNetTaxable = grossFloor - Math.min(hugeQcd, grossFloor);
    expect(detNetTaxable).toBe(0);
    const mcNetTaxable = computeMcRmdFloorCents(
      new Map([[PARITY_PRIMARY.memberId, preCents]]),
      [PARITY_PRIMARY],
      year,
      PARITY_RMD_SNAPSHOT,
      new Map([[PARITY_PRIMARY.memberId, hugeQcd]]),
    );
    expect(mcNetTaxable).toBe(0);
    expect(mcNetTaxable).toBe(detNetTaxable);
  });
});

// ---------------------------------------------------------------------------
// det↔MC FULL-SERIES QCD parity (the double-exclusion arbiter).
//
// The primitives above pin only the RMD-floor / offset seam in isolation. This
// case drives BOTH engines off ONE identical scenario with an ACTIVE QCD (a 70½+
// owner, a PRE_TAX IRA, a $20k/yr gift ≤ the owner's gross IRA RMD in an
// RMD-driven year): the deterministic engine via `runBalanceProjectionForPage`,
// the MC engine via `runBalanceProjectionMc` + injected flat returns / 0 CPI (so
// the P50 representative run replays a single deterministic path). It asserts the
// QCD year's net taxable RMD + federal tax are cent-identical across engines (the
// deterministic MAGI-drop-equals-the-gift pin lives in `balance-projection-runner-qcd.test.ts`).
//
// This is the load-bearing single-exclusion witness: under the prior double-exclusion the MC
// taxable RMD was `gross − 2Q` while the deterministic side was `gross − Q`, so
// the QCD-year federal tax diverged. After the single-exclusion fix both engines
// exclude the gift exactly once (structural debit + offset-reduced floor) and the
// year's tax fields reconcile to the cent. (The MC representative tax-burden
// post-pass stamps `federalTaxCents` / `netTaxableRmdCents` but not `magiCents`,
// so the MAGI-drop = Q invariant is asserted on the deterministic side; the
// federal-tax cent-parity is the cross-engine MAGI witness — federal tax is a
// function of the QCD-reduced taxable income.)
// ---------------------------------------------------------------------------
describe('cross-engine pin — QCD full-series det↔MC parity', () => {
  const Q_TODAY = new Date('2026-06-15T00:00:00Z');
  const Q_TODAY_YEAR = Q_TODAY.getUTCFullYear();
  const Q_TODAY_MONTH = Q_TODAY.getUTCMonth();
  // Born 1955-01-01 → RMD trigger age 73 (2028); QCD 70½ first-eligible 2025.
  // Retires at 73 so drawdown opens AT the RMD trigger year (RMD + QCD active).
  const Q_PRIMARY: Aggregate<HouseholdMemberPayload> = {
    id: 'm1', householdId: 'h', schemaVersion: 1, version: 1,
    updatedAt: '2026-05-01T00:00:00Z', deviceId: 'd', aggregateType: 'householdMember',
    payload: { isPrimary: true, firstName: 'Pat', lastName: 'Doe', email: 'm1@example.test', birthdate: '1955-01-01' },
  };
  const qAccount: Aggregate<AccountPayload> = {
    id: 'ira', householdId: 'h', schemaVersion: 1, version: 1,
    updatedAt: '2026-05-01T00:00:00Z', deviceId: 'd', aggregateType: 'account',
    payload: {
      name: 'ira', type: 'RETIREMENT_IRA', ownershipType: 'INDIVIDUAL', taxTreatment: 'PRE_TAX',
      ownerId: 'm1', institution: 'Vanguard', notes: '', planningReturnPct: 4, active: true,
      plannedContributionPreTax: 0, plannedContributionPostTax: 0,
      assetMix: { stocksPct: 60, bondsPct: 30, cashPct: 10 },
    },
  };
  const qBalance: Aggregate<AccountBalancePayload> = {
    id: 'b-ira-2025', householdId: 'h', schemaVersion: 1, version: 1,
    updatedAt: '2026-05-01T00:00:00Z', deviceId: 'd', aggregateType: 'accountBalance',
    payload: {
      accountId: 'ira', year: 2025, lastUpdated: '2025-12-31',
      startingBalance: 2_000_000 * 0.95, startingBalancePreTax: null, startingBalancePostTax: null,
      contributionsPreTax: null, contributionsPostTax: null, companyContributions: 0,
      companyContributionsPreTax: null, companyContributionsPostTax: null, rollover: 0,
      distributions: 0, endingBalance: 2_000_000, endingBalancePreTax: null,
      endingBalancePostTax: null, totalContributions: 0, comment: null,
    },
  };
  const qExpense: Aggregate<ExpensePayload> = {
    id: 'e-living', householdId: 'h', schemaVersion: 1, version: 1,
    updatedAt: '2026-05-01T00:00:00Z', deviceId: 'd', aggregateType: 'expense',
    payload: {
      name: 'Living', categoryId: 'cat-housing', amount: 40_000, frequency: 'yearly',
      classification: 'essential', start: { kind: 'retirementStart' }, end: { kind: 'lifetime', whose: 'last' },
    },
  };
  const qSs: Aggregate<SocialSecurityBenefitPayload> = {
    id: 'ss-m1', householdId: 'h', schemaVersion: 1, version: 1,
    updatedAt: '2026-05-01T00:00:00Z', deviceId: 'd', aggregateType: 'socialSecurityBenefit',
    payload: { householdMemberId: 'm1', pia: 2_500, piaAsOfDate: '2026-01-01', notes: null },
  };
  const qcdEntry: QcdEntry = {
    memberId: 'm1', sourceAccountId: 'ira', annualAmountDollars: 20_000,
    start: { kind: 'year', year: 2028 }, end: { kind: 'year', year: 2034 },
  };
  function qScenario(overrides: ScenarioOverrides): ScenarioAggregate {
    return {
      id: 's', householdId: 'h', schemaVersion: 1, version: 1,
      updatedAt: '2026-05-01T00:00:00Z', deviceId: 'd', aggregateType: 'scenario',
      payload: {
        name: 'Base', description: '', parentScenarioId: null, isPrimary: true, notes: '',
        overrides: {
          socialSecurity: { primary: { ageYears: 70, ageMonths: 0 } },
          retirementAge: { primary: { ageYears: 73, ageMonths: 0 } },
          inflation: { ratePct: 0 },
          lifeExpectancy: { primary: 88 },
          withdrawalStrategy: { kind: 'taxEfficient' },
          ...overrides,
        },
      },
    };
  }
  function qArgs(qcd: readonly QcdEntry[]) {
    return {
      scenarioId: 's',
      scenarios: [qScenario(qcd.length > 0 ? { qualifiedCharitableDistributions: qcd } : {})],
      accounts: [qAccount],
      balances: [qBalance],
      members: [Q_PRIMARY],
      ssBenefits: [qSs],
      expenses: [qExpense],
      incomeStreams: [],
      todayYear: Q_TODAY_YEAR,
      todayMonthIndex: Q_TODAY_MONTH,
    };
  }

  /** Deterministic per-year drawdown rows (page path — carries `qcdCents` /
   *  `netTaxableRmdCents`, which the bare `runBalanceProjection` rows omit). */
  function detYears(qcd: readonly QcdEntry[]): DrawdownYear[] {
    return [...(runBalanceProjectionForPage(qArgs(qcd)).planned?.years ?? [])];
  }

  /** The MC representative-run drawdown years under injected flat returns + 0 CPI
   *  (so the P50 representative path IS the single deterministic trajectory). The
   *  injected series is sized to the MC input's own horizon. */
  function mcRepYears(qcd: readonly QcdEntry[]): DrawdownYear[] {
    const built = runBalanceProjectionMc(qArgs(qcd));
    const steps = (built.horizonYear - built.firstYear + 1) * 12;
    const mc = runMonteCarlo({
      ...built,
      pathCount: 1,
      seed: 1,
      injectedReturns: new Float64Array(steps).fill(monthlyEquivalent(4)),
      injectedCpi: new Float64Array(steps),
    });
    const rep = mc.representativeByBasis?.['mc-typical'];
    if (!rep) throw new Error('expected a P50 (mc-typical) representative run');
    return [...rep.years];
  }

  it('a QCD year reconciles net-taxable-RMD + federal tax to the cent (det vs MC)', () => {
    const det = detYears([qcdEntry]);
    const mcYears = mcRepYears([qcdEntry]);

    // The first active QCD/RMD year (2028 — drawdown opens at the trigger age).
    const QCD_YEAR = 2028;
    const detYear = det.find((y) => y.year === QCD_YEAR);
    const mcYear = mcYears.find((y) => y.year === QCD_YEAR);
    expect(detYear).toBeDefined();
    expect(mcYear).toBeDefined();

    // Sanity: the QCD actually fired (the gift was stamped on BOTH engines).
    expect(detYear!.qcdCents).toBe(20_000_00); // 0% CPI → nominal == real $20k
    expect(mcYear!.qcdCents).toBe(20_000_00);
    // The IRA RMD floor exceeds the gift, so it is the RMD-DRIVEN case the
    // double-exclusion corrupted (Q ≤ gross IRA RMD).
    expect(detYear!.rmdFloorCents ?? 0).toBeGreaterThan(20_000_00);

    // Net taxable RMD = gross − min(Q, gross), excluded EXACTLY ONCE on both sides.
    expect(mcYear!.netTaxableRmdCents).toBe(detYear!.netTaxableRmdCents);
    // Federal tax reconciles to the cent — the single-exclusion witness (under a
    // double-exclusion MC would have under-stated it by a second Q's worth of tax,
    // since it taxed `gross − 2Q` instead of `gross − Q`).
    expect(mcYear!.federalTaxCents).toBe(detYear!.federalTaxCents);
  });
});

// ---------------------------------------------------------------------------
// Conversion-tax funding respects account floors — deterministic vs MC parity for
// Fill-mode conversion-tax funding against a floored cash-like account. Both
// engines share `drawCapSafeTaxFunding` via `runYearByYearStrategyAware`; under a
// flat 5% return (= each account's planned rate) + 2% inflation the MC
// representative run replays the deterministic trajectory, so BOTH engines must
// draw the floored `cash1` down to — never below — its own post-only floor.
// ---------------------------------------------------------------------------
describe('cross-engine pin — Fill conversion-tax funding respects the floor', () => {
  // PERCENT-unit monthly rates: `injectedReturns` is read as `returnPct[i]` and
  // `injectedCpi` as `cpiPct[i]`, both divided by 100 downstream, so a value of
  // `5` means 5%. These compound to the intended ~5%/yr return and ~2%/yr CPI
  // (equal to `monthlyEquivalent(5)` / `monthlyEquivalent(2)`).
  const MONTHLY_RETURN = (1.05 ** (1 / 12) - 1) * 100;
  const MONTHLY_CPI = (1.02 ** (1 / 12) - 1) * 100;

  it('both engines run the Fill conversion and the MC per-path draw respects the floor', () => {
    const args = flooredFillArgs({ withFloor: true });
    // Deterministic engine (planned 5% rate, 2% inflation). Under the injected
    // flat 5% return + 2% CPI the MC representative path replays this same
    // trajectory, so both engines share the `drawCapSafeTaxFunding` seam and must
    // agree — NOT within a wide multiplicative band. Two levels of parity are
    // asserted below: (1) the Fill conversions (a MAGI-cap-solve internal transfer,
    // deterministic given identical income) match to the CENT year-by-year; and
    // (2) the per-year TOTAL nominal balance matches to a tight relative band.
    //
    // Known limitation (documented): the high-level `runBalanceProjection` exposes
    // per-account balances (`accountYears`) only for the base year — the drawdown
    // trajectory surfaces only as per-YEAR `nominalBalance` TOTALS on
    // `drawdownYears`, so a per-account (cash1/cash2) cent-level det↔MC comparison
    // is NOT reachable through this API. The per-year total is the tightest
    // per-year balance surface both engines expose; the two engines' distinct
    // month-compounding representations leave a sub-0.05% residual on it, so the
    // total-balance comparison uses a small RELATIVE band (not cent-level) while
    // the conversions themselves reconcile exactly.
    const detResult = runBalanceProjection(args);
    const detDrawByYear = new Map(detResult.drawdownYears.map((y) => [y.year, y]));
    const detConverted = detResult.drawdownYears.reduce(
      (s, y) => s + (y.rothConvertedCents ?? 0),
      0,
    );
    expect(detConverted).toBeGreaterThan(0);

    // MC engine: inject the SAME flat 5% return + 2% CPI so the single representative
    // path is deterministic (no market-loss noise on the per-account floor check).
    const input = runBalanceProjectionMc(args);
    const stepCount = (input.horizonYear - input.firstYear + 1) * 12;
    const summary = runMonteCarlo({
      ...input,
      pathCount: 1,
      seed: 1,
      injectedReturns: new Float64Array(stepCount).fill(MONTHLY_RETURN),
      injectedCpi: new Float64Array(stepCount).fill(MONTHLY_CPI),
    });
    const mcYears = (summary.representativeByBasis?.['mc-typical']?.years ?? []).filter((y) => y.accountBalances);
    expect(mcYears.length).toBeGreaterThan(0);

    // (1) The Fill conversion is a deterministic MAGI-cap-solve internal transfer:
    // the lifetime converted total reconciles to the CENT, and every year's
    // conversion matches exactly. This is the strong parity the old 0.3x..3x band
    // masked — a real engine divergence in the floored-funding path would break it.
    const mcConverted = mcYears.reduce((s, y) => s + (y.rothConvertedCents ?? 0), 0);
    expect(mcConverted).toBe(detConverted);
    let assertedConversionYear = false;
    for (const my of mcYears) {
      const dy = detDrawByYear.get(my.year);
      if (!dy) continue;
      expect(my.rothConvertedCents ?? 0).toBe(dy.rothConvertedCents ?? 0);
      if ((my.rothConvertedCents ?? 0) > 0) assertedConversionYear = true;
    }
    expect(assertedConversionYear).toBe(true); // conversion years were actually compared

    // (2) Per-year TOTAL nominal balance parity to a tight RELATIVE band. The two
    // engines' month-compounding representations differ by well under 0.05% across
    // the whole horizon; a genuine divergence in the floored conversion-tax funding
    // would move a year's balance by percent-level or more, so this 0.1% band
    // (with a $1 absolute floor for the earliest, smallest residuals) catches it
    // while tolerating only the representation residual. This replaces the old
    // 0.3x..3x ratio band, which could have passed a real divergence.
    let assertedTotalYear = false;
    for (const my of mcYears) {
      const dy = detDrawByYear.get(my.year);
      if (!dy) continue;
      const tol = Math.max(1, Math.abs(dy.nominalBalance) * 1e-3);
      expect(Math.abs(my.balance - dy.nominalBalance)).toBeLessThanOrEqual(tol);
      assertedTotalYear = true;
    }
    expect(assertedTotalYear).toBe(true); // per-year totals were actually compared

    // The MC per-path drawdown (the shared `drawCapSafeTaxFunding` seam) never
    // draws the floored cash1 below its NOMINAL floor while the unfloored cash2
    // still funds — isolating the conversion-tax draw from the v57 last-resort
    // reserve pass, which only fires once every other liquid source is gone. The
    // conversion tax DOES draw cash1 down to (exactly) its floor (binding).
    let minCash1 = Number.POSITIVE_INFINITY;
    for (const y of mcYears) {
      const cash1 = y.accountBalances!.get('cash1');
      const cash2 = y.accountBalances!.get('cash2');
      if (!cash1 || !cash2 || cash2.balance <= 1) continue;
      expect(cash1.balance).toBeGreaterThanOrEqual(CASH1_FLOOR - 1);
      minCash1 = Math.min(minCash1, cash1.balance);
    }
    expect(minCash1).toBeLessThanOrEqual(CASH1_FLOOR + 1);
  });
});

// ---------------------------------------------------------------------------
// det↔MC DISPLAYED representative-year tax parity for the taxable-
// income model (assumed-yield drag + evolving basis + cash-like interest).
//
// One identical brokerage + CD + HSA household drives BOTH engines: the
// deterministic tax annotation via `runBalanceProjectionForPage`, and the MC
// representative tax-burden post-pass via `runBalanceProjectionMc` +
// `runMonteCarlo` under injected flat returns + 0 CPI (so the P50
// representative path replays the deterministic trajectory). Deposits (planned
// pre-retirement contributions) and drawdown withdrawals both occur, so the
// shared accumulator's start-balance carry, basis evolution, and per-account
// interest derivation are all exercised. Each drawdown year's DISPLAYED
// federal tax must agree within $1 (the cross-engine parity claim) — a wrong
// start balance, a diverged basis seed, or a mis-classified account (e.g. HSA
// growth taxed as CD interest) in either engine breaks this.
// ---------------------------------------------------------------------------
describe('cross-engine pin — displayed tax parity (brokerage + CD + HSA)', () => {
  const T_TODAY = new Date('2026-06-15T00:00:00Z');
  function tMember(): Aggregate<HouseholdMemberPayload> {
    return {
      id: 'm1', householdId: 'h', schemaVersion: 1, version: 1, updatedAt: '2026-05-01T00:00:00Z', deviceId: 'd',
      aggregateType: 'householdMember',
      payload: { isPrimary: true, firstName: 'Pat', lastName: 'Doe', email: 'm1@example.test', birthdate: '1962-01-01' },
    };
  }
  function tSs(): Aggregate<SocialSecurityBenefitPayload> {
    return {
      id: 'ss-m1', householdId: 'h', schemaVersion: 1, version: 1, updatedAt: '2026-05-01T00:00:00Z', deviceId: 'd',
      aggregateType: 'socialSecurityBenefit',
      payload: { householdMemberId: 'm1', pia: 2_200, piaAsOfDate: '2026-01-01', notes: null },
    };
  }
  function tAccount(
    id: string,
    type: AccountPayload['type'],
    taxTreatment: AccountPayload['taxTreatment'],
    plannedContributionPostTax: number,
  ): Aggregate<AccountPayload> {
    return {
      id, householdId: 'h', schemaVersion: 1, version: 1, updatedAt: '2026-05-01T00:00:00Z', deviceId: 'd',
      aggregateType: 'account',
      payload: {
        name: id, type, ownershipType: 'INDIVIDUAL', taxTreatment, ownerId: 'm1', institution: 'V', notes: '',
        planningReturnPct: 4, active: true, plannedContributionPreTax: 0, plannedContributionPostTax,
        assetMix: { stocksPct: 60, bondsPct: 30, cashPct: 10 },
      },
    };
  }
  function tBalance(accountId: string, endingBalance: number): Aggregate<AccountBalancePayload> {
    return {
      id: `b-${accountId}`, householdId: 'h', schemaVersion: 1, version: 1, updatedAt: '2026-05-01T00:00:00Z', deviceId: 'd',
      aggregateType: 'accountBalance',
      payload: {
        accountId, year: 2025, lastUpdated: '2025-12-31', startingBalance: endingBalance * 0.95,
        startingBalancePreTax: null, startingBalancePostTax: null, contributionsPreTax: null, contributionsPostTax: null,
        companyContributions: 0, companyContributionsPreTax: null, companyContributionsPostTax: null,
        rollover: 0, distributions: 0, endingBalance, endingBalancePreTax: null, endingBalancePostTax: null,
        totalContributions: 0, comment: null,
      },
    };
  }
  function tExpense(): Aggregate<ExpensePayload> {
    return {
      id: 'living', householdId: 'h', schemaVersion: 1, version: 1, updatedAt: '2026-05-01T00:00:00Z', deviceId: 'd',
      aggregateType: 'expense',
      payload: {
        name: 'living', categoryId: 'cat-housing', amount: 70_000, frequency: 'yearly',
        classification: 'essential', start: { kind: 'retirementStart' }, end: { kind: 'lifetime', whose: 'last' },
      },
    };
  }
  function tArgs() {
    const scenario: ScenarioAggregate = {
      id: 's', householdId: 'h', schemaVersion: 1, version: 1, updatedAt: '2026-05-01T00:00:00Z', deviceId: 'd',
      aggregateType: 'scenario',
      payload: {
        name: 'TaxParity', description: '', parentScenarioId: null, isPrimary: true, notes: '',
        overrides: {
          // Retire at 66 (2028) → 1.5 accumulation years of planned brokerage/CD
          // deposits, then drawdown withdrawals — both legs of the row shape.
          retirementAge: { primary: { ageYears: 66, ageMonths: 0 } },
          socialSecurity: { primary: { ageYears: 67, ageMonths: 0 } },
          inflation: { ratePct: 0 }, // zero-CPI: nominal == real on both engines.
          lifeExpectancy: { primary: 85 },
          withdrawalStrategy: { kind: 'taxEfficient' },
        },
      },
    };
    return {
      scenarioId: 's',
      scenarios: [scenario],
      accounts: [
        tAccount('brok', 'BROKERAGE', 'POST_TAX', 12_000),
        tAccount('cd', 'CD', 'POST_TAX', 6_000),
        tAccount('hsa', 'HSA', 'HSA', 0),
      ],
      balances: [
        tBalance('brok', 800_000),
        tBalance('cd', 200_000),
        tBalance('hsa', 100_000),
      ],
      members: [tMember()],
      ssBenefits: [tSs()],
      expenses: [tExpense()],
      incomeStreams: [],
      todayYear: T_TODAY.getUTCFullYear(),
      todayMonthIndex: T_TODAY.getUTCMonth(),
    };
  }

  it('each drawdown year\'s DISPLAYED federal tax agrees within $1 (det annotation vs MC representative post-pass)', () => {
    const args = tArgs();
    // Deterministic side: the page runner's annotated drawdown rows.
    const det = runBalanceProjectionForPage(args).planned?.years ?? [];
    const detByYear = new Map(det.map((y) => [y.year, y]));
    expect(det.length).toBeGreaterThan(0);

    // MC side: injected flat 4% (= every account's planningReturnPct) + 0 CPI so
    // the P50 representative path replays the same trajectory, then the
    // representative tax-burden post-pass stamps the displayed cents.
    const input = runBalanceProjectionMc(args);
    const steps = (input.horizonYear - input.firstYear + 1) * 12;
    const mc = runMonteCarlo({
      ...input,
      pathCount: 1,
      seed: 1,
      injectedReturns: new Float64Array(steps).fill(monthlyEquivalent(4)),
      injectedCpi: new Float64Array(steps),
    });
    const rep = mc.representativeByBasis?.['mc-typical'];
    if (!rep) throw new Error('expected a P50 (mc-typical) representative run');
    const mcDrawYears = rep.years.filter((y) => y.accountBalances);
    expect(mcDrawYears.length).toBeGreaterThan(0);

    let comparedYears = 0;
    let sawPositiveTax = false;
    for (const mcYear of mcDrawYears) {
      const detYear = detByYear.get(mcYear.year);
      if (!detYear || detYear.federalTaxCents === undefined) continue;
      comparedYears += 1;
      // The two engines' displayed representative-year federal
      // tax agree within $1 annually (100 cents).
      expect(Math.abs((mcYear.federalTaxCents ?? 0) - detYear.federalTaxCents)).toBeLessThanOrEqual(100);
      if (detYear.federalTaxCents > 0) sawPositiveTax = true;
    }
    expect(comparedYears).toBeGreaterThan(3); // a real multi-year comparison ran
    // The taxable-income components actually produced displayed tax: this all-POST_TAX
    // household owes federal tax only via the assumed-yield drag / evolving-basis
    // LTCG / CD interest (+ taxable SS later) — a $0-everywhere series would
    // mean the model silently stopped firing on either engine.
    expect(sawPositiveTax).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Filing plan — SS attribution parity between the two engines
// ---------------------------------------------------------------------------

describe('cross-engine pin — separate-filing Social Security attribution', () => {
  const MEMBERS: TaxMemberInput[] = [
    { memberId: 'p', isoBirthdate: '1958-03-10', onMedicare: false, hasAcaCoverage: false },
    { memberId: 's', isoBirthdate: '1959-04-02', onMedicare: false, hasAcaCoverage: false },
  ];
  const SEPARATE_UNITS: ResolvedTaxUnit[] = [
    { memberIds: ['primary'], filingStatus: 'MFS', householdSize: 1 },
    { memberIds: ['secondary'], filingStatus: 'MFS', householdSize: 1 },
  ];
  const TAX_YEAR = 2030;
  /** One spouse collects $54k, the other $6k — deliberately UNEQUAL, because an
   *  even split is the degenerate case where every attribution agrees. */
  const PRIMARY_SS = 54_000;
  const SECONDARY_SS = 6_000;
  const HOUSEHOLD_SS = PRIMARY_SS + SECONDARY_SS;

  /** Per-month SS run-rate rows, the deterministic engine's own SS source. */
  const ssRows = Array.from({ length: 12 }, (_, month0) => ({
    year: TAX_YEAR,
    month0,
    total: HOUSEHOLD_SS,
    primary: PRIMARY_SS,
    secondary: SECONDARY_SS,
  }));

  it('derives the SAME per-member gross SS from each engine own source', () => {
    // Deterministic: per-member SS series → `ownSsByMemberForYear`.
    const deterministic = ownSsByMemberForYear(ssRows, TAX_YEAR, 'p', 's');
    // MC: the same rows canonicalized to a per-year share on `McTaxContext`,
    // then re-expanded against the household total the kernel carries.
    const { ssSharesByYear } = canonicalSsSharesByYear(ssRows, true);
    const share = ssSharesByYear!.find((e) => e.year === TAX_YEAR)!.primaryShare;
    const mc = {
      p: HOUSEHOLD_SS * share,
      s: HOUSEHOLD_SS * (1 - share),
    };
    expect(mc.p).toBeCloseTo(deterministic.p, 6);
    expect(mc.s).toBeCloseTo(deterministic.s, 6);
    expect(deterministic.p).toBeCloseTo(PRIMARY_SS, 6);
  });

  it('computes the same taxable Social Security on both engines attribution', () => {
    // §86 is NON-LINEAR per return, so this is a funded divergence, not a
    // display one: the same household must not get two different taxable-SS
    // figures depending on which engine ran it.
    const yearInput = (
      grossSsDollarsByMemberId: Record<string, number>,
    ): ApplyFilingPlanYearInput => ({
      taxYear: TAX_YEAR,
      filingStatus: 'MFJ',
      grossSsDollars: HOUSEHOLD_SS,
      preTaxWithdrawalDollars: 40_000,
      postTaxNonRothWithdrawalDollars: 0,
      rothWithdrawalDollars: 0,
      otherOrdinaryIncomeDollars: 0,
      taxExemptInterestDollars: 0,
      householdSize: 2,
      members: MEMBERS,
      accounts: [],
      taxpayersAge65Plus: 0,
      memberIdByRole: { primary: 'p', secondary: 's' },
      taxUnits: SEPARATE_UNITS,
      grossSsDollarsByMemberId,
    });
    const deterministic = ownSsByMemberForYear(ssRows, TAX_YEAR, 'p', 's');
    const { ssSharesByYear } = canonicalSsSharesByYear(ssRows, true);
    const share = ssSharesByYear!.find((e) => e.year === TAX_YEAR)!.primaryShare;
    const mcAttribution = { p: HOUSEHOLD_SS * share, s: HOUSEHOLD_SS * (1 - share) };

    const detResult = applyTaxYearForFilingPlan(
      yearInput(deterministic),
      DEFAULT_TAX_CALIBRATION_BUNDLE,
    );
    const mcResult = applyTaxYearForFilingPlan(
      yearInput(mcAttribution),
      DEFAULT_TAX_CALIBRATION_BUNDLE,
    );
    expect(mcResult.taxableSsCents).toBe(detResult.taxableSsCents);
    expect(mcResult.federalTaxCents).toBe(detResult.federalTaxCents);

    // And the attribution genuinely matters — a blanket 50/50 split (the MC
    // behaviour before the share table existed) lands somewhere else entirely.
    const evenSplit = applyTaxYearForFilingPlan(
      { ...yearInput(deterministic), grossSsDollarsByMemberId: undefined },
      DEFAULT_TAX_CALIBRATION_BUNDLE,
    );
    expect(evenSplit.taxableSsCents).not.toBe(detResult.taxableSsCents);
  });
});

// Inherited Roth IRA pass-through. Both engines must commit the SAME
// withdrawal and the SAME ending balance for an inherited Roth IRA draw whose
// five-year clock is unmet. Pre-change the deterministic engine taxed that draw
// as ordinary income (`isRothIraDistributionQualified` waives only the AGE test
// for an inherited account — the clock still gated) while Monte Carlo routed the
// same dollars tax-free.
//
// The DISCRIMINATING shape holds an inherited Roth IRA AND an active employer
// (designated) Roth plan, drawing from both in the same year: with no designated
// account `iraShareOfOrderedPool` is 1 either way, so the inherited balance skews
// nothing and the exclusion of the inherited balance is invisible.
// ---------------------------------------------------------------------------

describe('cross-engine pin — inherited Roth IRA pass-through', () => {
  const TODAY_YEAR = 2026;
  const TODAY_MONTH_INDEX = 5;
  const MONTHLY_RETURN = (1.05 ** (1 / 12) - 1) * 100;
  const MONTHLY_CPI = 0;

  function iMember(
    id: string,
    isPrimary: boolean,
    birthdate: string,
  ): Aggregate<HouseholdMemberPayload> {
    return {
      id, householdId: 'h', schemaVersion: 1, version: 1,
      updatedAt: '2026-05-01T00:00:00Z', deviceId: 'd',
      aggregateType: 'householdMember',
      payload: {
        isPrimary, firstName: id, lastName: 'Doe',
        email: `${id}@example.test`, birthdate,
      },
    };
  }
  function iAccount(
    id: string,
    ownerId: string,
    type: AccountPayload['type'],
    taxTreatment: AccountPayload['taxTreatment'],
    extra: Partial<AccountPayload> = {},
  ): Aggregate<AccountPayload> {
    return {
      id, householdId: 'h', schemaVersion: 1, version: 1,
      updatedAt: '2026-05-01T00:00:00Z', deviceId: 'd',
      aggregateType: 'account',
      payload: {
        name: id, type, ownershipType: 'INDIVIDUAL', taxTreatment, ownerId,
        institution: 'V', notes: '', planningReturnPct: 5, active: true,
        plannedContributionPreTax: 0, plannedContributionPostTax: 0,
        assetMix: { stocksPct: 60, bondsPct: 30, cashPct: 10 },
        ...extra,
      },
    };
  }
  function iBalance(
    accountId: string,
    endingBalance: number,
    /** Recorded Roth history on the row — an employer plan's in-plan-rollover
     *  principal IS its designated-Roth basis, and a Roth IRA's recorded
     *  contributions ARE its §408A basis. */
    rothHistory: Partial<AccountBalancePayload> = {},
  ): Aggregate<AccountBalancePayload> {
    return {
      id: `b-${accountId}`, householdId: 'h', schemaVersion: 1, version: 1,
      updatedAt: '2026-05-01T00:00:00Z', deviceId: 'd',
      aggregateType: 'accountBalance',
      payload: {
        accountId, year: 2025, lastUpdated: '2025-12-31',
        startingBalance: endingBalance, startingBalancePreTax: null,
        startingBalancePostTax: null, contributionsPreTax: null,
        contributionsPostTax: null, companyContributions: 0,
        companyContributionsPreTax: null, companyContributionsPostTax: null,
        rollover: 0, distributions: 0, endingBalance,
        endingBalancePreTax: null, endingBalancePostTax: null,
        totalContributions: 0, comment: null,
        ...rothHistory,
      },
    };
  }
  function iExpense(): Aggregate<ExpensePayload> {
    return {
      id: 'living', householdId: 'h', schemaVersion: 1, version: 1,
      updatedAt: '2026-05-01T00:00:00Z', deviceId: 'd',
      aggregateType: 'expense',
      payload: {
        // $144k: divisible by 12 (the MC monthly split stays cent-exact), and
        // large enough that a mis-split HALF of the designated draw ($36k/yr)
        // clears the MFJ standard deduction — a smaller spend leaves the
        // erroneous slice fully absorbed by the deduction, taxed $0 either
        // way, and the mutation invisible.
        name: 'living', categoryId: 'cat-housing', amount: 144_000, frequency: 'yearly',
        classification: 'essential', start: { kind: 'retirementStart' },
        end: { kind: 'lifetime', whose: 'last' },
      },
    };
  }

  /** Household holding an inherited Roth IRA (recorded clock unmet in every
   *  compared year) plus an ACTIVE designated Roth 401(k) and a pre-tax IRA,
   *  drawn by `rothFirst` so both Roth sources are hit in the same years.
   *
   *  The DISCRIMINATING contrast is qualified-vs-unmet-clock, not basis: both
   *  owners are past 59½ in every compared year and the designated clock (2005)
   *  is met, so every CORRECT draw is tax-free on both engines and the pin
   *  holds at $0 federal tax, cent-exact. The §408A Roth-IRA regime, by
   *  contrast, has NO recorded pool here — the household's only Roth IRA is
   *  inherited, so its pooled clock is absent (conservatively unmet) and its
   *  basis is $0. Any regression that routes dollars through that regime is
   *  therefore taxed by exactly ONE engine and breaks parity: losing the inherited
   *  balance exclusion inflates `iraShareOfOrderedPool`, so Monte Carlo taxes
   *  the mis-split half of the designated draw; losing the funding-pass
   *  inherited skip makes the deterministic engine order the inherited draw
   *  against an owner carrier (empty → all-earnings, unmet clock → taxable).
   *  `twoRothOwners` moves the designated plan onto the second member, which is
   *  what proves the funding-pass classifier carries the inherited marker: the
   *  household-aggregate Roth bucket is attributed to ONE owner's carrier entry
   *  there, so a marker-less classifier would consume the wrong owner's carrier
   *  — equally empty, equally taxable, equally divergent.
   *
   *  Deliberately NOT a "nonqualified draws against
   *  meaningful basis" shape: the engines fund NONQUALIFIED designated-Roth tax
   *  differently (deterministic defers the tax draw; Monte Carlo grosses up
   *  in-year), a pre-existing divergence unrelated to the inherited marker that
   *  would fail this pin on every run. */
  function inheritedArgs(twoRothOwners: boolean) {
    const scenario: ScenarioAggregate = {
      id: 's', householdId: 'h', schemaVersion: 1, version: 1,
      updatedAt: '2026-05-01T00:00:00Z', deviceId: 'd',
      aggregateType: 'scenario',
      payload: {
        name: 'Inherited', description: '', parentScenarioId: null,
        isPrimary: true, notes: '',
        overrides: {
          // Retire at 60 (past 59½ in every drawdown year) and die at 65: the
          // compared window 2030-2035 sits entirely between 59½ and the years
          // where the engines' Medicare-era cost handling diverges (at this
          // spending level, from 2036 the deterministic engine adds a premium
          // draw Monte Carlo does not — a pre-existing gap this pin has no
          // reason to carry).
          retirementAge: {
            primary: { ageYears: 60, ageMonths: 0 },
            secondary: { ageYears: 60, ageMonths: 0 },
          },
          socialSecurity: {
            primary: { ageYears: 67, ageMonths: 0 },
            secondary: { ageYears: 67, ageMonths: 0 },
          },
          inflation: { ratePct: 0 },
          lifeExpectancy: { primary: 65, secondary: 65 },
          withdrawalStrategy: { kind: 'rothFirst' },
          acaMarketplaceOptOutMemberIds: ['m1', 'm2'],
        },
      },
    };
    return {
      scenarioId: 's',
      scenarios: [scenario],
      accounts: [
        // Inherited: the recorded first-contribution year leaves the five-year
        // clock UNMET in every compared drawdown year (2030-2035), and with
        // both owners past 59½ that clock is the ONLY gate left — so a
        // self-consistent restoration of the old annotation (inherited pool
        // + ordered draw) taxes this draw's earnings and fails the pin through
        // the CLOCK alone, never through the pooled 59½ test. No
        // engine reads an inherited account's recorded year, so the pinned
        // numbers do not move.
        iAccount('roth-inherited', 'm1', 'RETIREMENT_ROTH_IRA', 'ROTH', {
          rmdInheritedAccount: true,
          rmdBeneficiaryType: 'OTHER_DESIGNATED',
          rmdInheritedOwnerDeathDate: '2025-03-01',
          rmdInheritedOwnerDiedOnOrAfterRbd: false,
          rmdOriginalOwnerBirthdate: '1950-01-01',
          rothIraRegularContributionBasis: 0,
          rothIraFirstContributionTaxYear: 2045,
        }),
        // The designated plan's draws are QUALIFIED (owner 59½+, 2005 clock
        // met) and therefore tax-free on BOTH engines; its basis is real —
        // $400k of recorded in-plan-rollover principal on the balance row below
        // — and consumed by the §402A bookkeeping, but the pin's
        // discrimination comes from the qualification contrast against the
        // clockless §408A regime — see the fixture docblock.
        iAccount(
          'roth-401k',
          twoRothOwners ? 'm2' : 'm1',
          'RETIREMENT_ROTH_401K',
          'ROTH',
          { designatedRothFirstParticipationTaxYear: 2005 },
        ),
        iAccount('ira', 'm1', 'RETIREMENT_IRA', 'PRE_TAX'),
      ],
      balances: [
        iBalance('roth-inherited', 700_000),
        iBalance('roth-401k', 700_000, { rothInPlanRolloverTaxableAmount: 400_000 }),
        iBalance('ira', 600_000),
      ],
      members: [iMember('m1', true, '1970-01-01'), iMember('m2', false, '1970-01-01')],
      // No Social Security benefit rows: MC's even household-SS split is a
      // pre-existing det↔MC divergence this pin has no reason to carry.
      ssBenefits: [],
      expenses: [iExpense()],
      incomeStreams: [],
      todayYear: TODAY_YEAR,
      todayMonthIndex: TODAY_MONTH_INDEX,
    };
  }

  for (const twoRothOwners of [false, true]) {
    const label = twoRothOwners ? 'two Roth owners' : 'one Roth owner';
    it(`commits the same withdrawal and ending balance in both engines (${label})`, () => {
      const args = inheritedArgs(twoRothOwners);
      const det = runBalanceProjection(args);
      const detByYear = new Map(det.drawdownYears.map((y) => [y.year, y]));

      const input = runBalanceProjectionMc(args);
      const stepCount = (input.horizonYear - input.firstYear + 1) * 12;
      const summary = runMonteCarlo({
        ...input,
        pathCount: 1,
        seed: 7,
        injectedReturns: new Float64Array(stepCount).fill(MONTHLY_RETURN),
        injectedCpi: new Float64Array(stepCount).fill(MONTHLY_CPI),
      });
      const mcYears = (summary.representativeByBasis?.['mc-typical']?.years ?? []).filter(
        (y) => y.accountBalances,
      );
      expect(mcYears.length).toBeGreaterThan(0);

      // The inherited account is genuinely drawn — otherwise this asserts
      // nothing — and BOTH Roth accounts are drawn in at least one common
      // compared year, so the aggregate Roth bucket really is split between
      // the inherited (tax-free) and designated (basis-ordered) slices in the
      // same year rather than the accounts being exercised serially.
      let drewInherited = false;
      let drewBothSameYear = false;
      let comparedYears = 0;
      for (const my of mcYears) {
        const dy = detByYear.get(my.year);
        if (!dy) continue;
        const inheritedDraw = my.accountBalances!.get('roth-inherited')?.withdrawn ?? 0;
        const designatedDraw = my.accountBalances!.get('roth-401k')?.withdrawn ?? 0;
        if (inheritedDraw > 0) drewInherited = true;
        if (inheritedDraw > 0 && designatedDraw > 0) drewBothSameYear = true;
        // Cent-exact on BOTH surfaces — every correct draw here is tax-free on
        // both engines, so any taxed dollar on either side moves these figures
        // by whole dollars. Pre-change the deterministic engine taxed
        // the inherited draw as ordinary income (its recorded clock is unmet)
        // while Monte Carlo routed the same dollars tax-free, so the two funded
        // different amounts and their balances diverged.
        expect(my.balance).toBeCloseTo(dy.nominalBalance, 2);
        expect(my.withdrawn).toBeCloseTo(dy.withdrawal, 2);
        // The reported tax too — the FUNDING pass and the ANNOTATION pass are
        // independent short-circuits, and only this surface catches a regression
        // in the second one (an unqualified inherited pool created on demand
        // taxes the draw without changing what the year funded).
        expect(my.federalTaxCents).toBe(dy.federalTaxCents);
        comparedYears += 1;
      }
      expect(drewInherited).toBe(true);
      expect(drewBothSameYear).toBe(true);
      expect(comparedYears).toBeGreaterThan(5);
    });
  }

  // ---------------------------------------------------------------------
  // The §408A basis cutover moved BOTH engines onto one derivation at one
  // seam, so their agreement is structural. These pin it on the four Roth
  // shapes the seam distinguishes. The measured surfaces are the COMMITTED
  // WITHDRAWAL and the ENDING BALANCE, not reported tax alone: reported tax
  // passes while the funding pass is still solving against a different basis.
  //
  // The FIRST shape is where the resolved basis actually enters the arithmetic,
  // and it has to be built for it: its §408A five-year clock is UNMET across the
  // whole compared window (both owners still past 59½, so no §72(t) leg), and its
  // recorded basis covers only the first year and a half of drawing. The ordering
  // therefore returns the derived regular basis tax-free and routes everything
  // past it to ordinary income, so the derived figure sets the year's tax, the
  // funded draw, and the ending balance — and a det-vs-MC basis divergence moves
  // all three. The `basis moves the answer` control below proves exactly that.
  //
  // The other three shapes are QUALIFIED and therefore tax-free by construction:
  // they pin that both engines agree on WHICH REGIME a shape lands in (inherited
  // pass-through, designated §402A, own §408A) and that neither invents a tax the
  // other does not, not on the basis figure. A nonqualified DESIGNATED shape is
  // deliberately not added: the engines fund nonqualified designated-Roth tax
  // differently (deterministic defers the tax draw; Monte Carlo grosses up
  // in-year) — the pre-existing divergence the fixture docblock above records,
  // which this seam does not control and which would fail the pin on every run.
  // ---------------------------------------------------------------------
  describe('four Roth shapes commit the same withdrawal and ending balance', () => {
    /** A smaller living expense than the inherited pin's: enough that the
     *  nonqualified shape's draw runs PAST its recorded basis inside the compared
     *  window (so the basis boundary is exercised), and small enough that the
     *  qualified shapes' Roth balances carry the whole window. */
    function modestExpense(): Aggregate<ExpensePayload> {
      const base = iExpense();
      return {
        ...base,
        id: 'living-modest',
        payload: { ...base.payload, name: 'living-modest', amount: 96_000 },
      };
    }

    /** The `inheritedArgs` household with its Roth side swapped out. */
    function shapeArgs(
      rothAccounts: ReadonlyArray<Aggregate<AccountPayload>>,
      rothBalances: ReadonlyArray<Aggregate<AccountBalancePayload>>,
    ): ReturnType<typeof inheritedArgs> {
      const base = inheritedArgs(false);
      return {
        ...base,
        accounts: [...rothAccounts, iAccount('ira', 'm1', 'RETIREMENT_IRA', 'PRE_TAX')],
        balances: [...rothBalances, iBalance('ira', 600_000)],
        expenses: [modestExpense()],
      };
    }

    /** The complete inherited-beneficiary fact set the demo/report surfaces
     *  need, so an inherited shape raises no required-withdrawal blocker. */
    const inheritedFacts: Partial<AccountPayload> = {
      rmdInheritedAccount: true,
      rmdBeneficiaryType: 'OTHER_DESIGNATED',
      rmdInheritedOwnerDeathDate: '2025-03-01',
      rmdInheritedOwnerDiedOnOrAfterRbd: false,
      rmdOriginalOwnerBirthdate: '1950-01-01',
    };

    const shapes: ReadonlyArray<{
      readonly label: string;
      readonly args: () => ReturnType<typeof inheritedArgs>;
      /** The shape's Roth draws are NONQUALIFIED, so the resolved basis decides
       *  the year's tax rather than qualification making it $0 whatever the
       *  basis. Asserted below, so a shape that silently becomes qualified (or
       *  stops being taxed because its basis grew) fails rather than passing
       *  vacuously. */
      readonly basisDecidesTax?: boolean;
    }> = [
      {
        // The DISCRIMINATING shape: nonqualified on the CLOCK (first contribution
        // 2032, so the five-taxable-year period is unmet through 2035) while both
        // owners stay past 59½, and $180k of derived basis against ~$100k a year
        // of drawing. §408A ordering hands back the derived regular basis
        // tax-free and taxes the excess as ordinary income, so the resolved basis
        // — the one thing the cutover moved — is what the year's tax, funded draw
        // and ending balance are computed FROM.
        label: 'pooled own Roth IRAs, five-year clock unmet',
        basisDecidesTax: true,
        args: () =>
          shapeArgs(
            [
              iAccount('roth-ira-a', 'm1', 'RETIREMENT_ROTH_IRA', 'ROTH', {
                rothIraFirstContributionTaxYear: 2032,
              }),
              iAccount('roth-ira-b', 'm1', 'RETIREMENT_ROTH_IRA', 'ROTH', {
                rothIraFirstContributionTaxYear: 2033,
              }),
            ],
            [
              iBalance('roth-ira-a', 400_000, { totalContributions: 120_000 }),
              iBalance('roth-ira-b', 300_000, { totalContributions: 60_000 }),
            ],
          ),
      },
      {
        label: 'an inherited Roth IRA',
        args: () =>
          shapeArgs(
            [
              iAccount('roth-inherited', 'm1', 'RETIREMENT_ROTH_IRA', 'ROTH', {
                ...inheritedFacts,
                rothIraFirstContributionTaxYear: 2045,
              }),
            ],
            [iBalance('roth-inherited', 700_000)],
          ),
      },
      {
        label: 'an inherited Roth 401(k)',
        args: () =>
          shapeArgs(
            [
              iAccount('roth-401k-inherited', 'm1', 'RETIREMENT_ROTH_401K', 'ROTH', {
                ...inheritedFacts,
                designatedRothFirstParticipationTaxYear: 2005,
              }),
            ],
            [
              iBalance('roth-401k-inherited', 700_000, {
                rothInPlanRolloverTaxableAmount: 700_000,
              }),
            ],
          ),
      },
      {
        // QUALIFIED, and it has to stay that way: with a nonqualified designated
        // draw the deterministic engine DEFERS the resulting tax draw while Monte
        // Carlo grosses it up in-year (measured: $100,452 vs $96,000 in the first
        // compared year), a pre-existing funding divergence this seam does not
        // control. What this shape pins is that both engines route an employer
        // plan through the §402A regime against the SAME recorded
        // in-plan-rollover principal.
        label: 'an employer Roth plan',
        args: () =>
          shapeArgs(
            [
              iAccount('roth-401k', 'm1', 'RETIREMENT_ROTH_401K', 'ROTH', {
                designatedRothFirstParticipationTaxYear: 2005,
              }),
            ],
            [
              iBalance('roth-401k', 700_000, {
                rothInPlanRolloverTaxableAmount: 700_000,
              }),
            ],
          ),
      },
      {
        // QUALIFIED on both the clock (2010) and age, with the derived basis
        // well BELOW the annual draw. §408A(d)(2) makes every dollar tax-free
        // whatever the basis figure, and both engines' annotation/ordering
        // report $0 — but a funding pass that ignores qualification taxes the
        // draw past the derived basis as phantom ordinary income, inflating the
        // deterministic committed withdrawal every year while Monte Carlo
        // (which threads the pooled clock) funds nothing. The three shapes
        // above never exercise this boundary: their recorded basis meets or
        // exceeds the compared draws.
        label: 'a qualified own Roth IRA whose derived basis is far below the draw',
        args: () =>
          shapeArgs(
            [
              iAccount('roth-ira-q', 'm1', 'RETIREMENT_ROTH_IRA', 'ROTH', {
                rothIraFirstContributionTaxYear: 2010,
              }),
            ],
            [iBalance('roth-ira-q', 500_000, { totalContributions: 60_000 })],
          ),
      },
    ];

    for (const shape of shapes) {
      it(`agrees on ${shape.label}`, () => {
        const args = shape.args();
        const det = runBalanceProjection(args);
        const detByYear = new Map(det.drawdownYears.map((y) => [y.year, y]));

        const input = runBalanceProjectionMc(args);
        const stepCount = (input.horizonYear - input.firstYear + 1) * 12;
        const summary = runMonteCarlo({
          ...input,
          pathCount: 1,
          seed: 11,
          injectedReturns: new Float64Array(stepCount).fill(MONTHLY_RETURN),
          injectedCpi: new Float64Array(stepCount).fill(MONTHLY_CPI),
        });
        const mcYears = (summary.representativeByBasis?.['mc-typical']?.years ?? []).filter(
          (y) => y.accountBalances,
        );
        expect(mcYears.length).toBeGreaterThan(0);

        let comparedYears = 0;
        let drewRoth = false;
        let taxedYears = 0;
        for (const my of mcYears) {
          const dy = detByYear.get(my.year);
          if (!dy) continue;
          for (const [id, acct] of my.accountBalances!) {
            if (id !== 'ira' && (acct.withdrawn ?? 0) > 0) drewRoth = true;
          }
          if ((dy.federalTaxCents ?? 0) > 0) taxedYears += 1;
          // Single Roth OWNER throughout, so this is exact: MC pools every
          // household member's Roth basis into one carrier entry, which
          // only diverges once two owners share that pool.
          expect(my.withdrawn).toBeCloseTo(dy.withdrawal, 2);
          expect(my.balance).toBeCloseTo(dy.nominalBalance, 2);
          comparedYears += 1;
        }
        expect(drewRoth).toBe(true);
        expect(comparedYears).toBeGreaterThan(5);
        // Without this the pin cannot tell a shape it MEANT to make basis-driven
        // from one that quietly became tax-free for some other reason and so
        // agrees on every basis, including $0.
        if (shape.basisDecidesTax === true) {
          expect(taxedYears).toBeGreaterThan(0);
        } else {
          expect(taxedYears).toBe(0);
        }
      });
    }

    // The CONTROL for the nonqualified shape: replace the recorded contribution
    // history — the only input the derivation reads — and both engines' committed
    // withdrawals and ending balances have to move. That is what makes the pin
    // above capable of failing: if the resolved basis did not reach the funded
    // draw, these two runs would be identical and every assertion up there would
    // hold with the basis at $0.
    it('a different recorded basis moves BOTH engines’ committed answers', () => {
      const withBasis = shapes[0].args();
      const noBasis = shapeArgs(
        [
          iAccount('roth-ira-a', 'm1', 'RETIREMENT_ROTH_IRA', 'ROTH', {
            rothIraFirstContributionTaxYear: 2032,
          }),
          iAccount('roth-ira-b', 'm1', 'RETIREMENT_ROTH_IRA', 'ROTH', {
            rothIraFirstContributionTaxYear: 2033,
          }),
        ],
        // Same balances, NO recorded contributions → the pool derives $0 basis,
        // so every nonqualified dollar is earnings from the first year.
        [iBalance('roth-ira-a', 400_000), iBalance('roth-ira-b', 300_000)],
      );

      const runBoth = (args: ReturnType<typeof inheritedArgs>) => {
        const det = runBalanceProjection(args);
        const input = runBalanceProjectionMc(args);
        const stepCount = (input.horizonYear - input.firstYear + 1) * 12;
        const summary = runMonteCarlo({
          ...input,
          pathCount: 1,
          seed: 11,
          injectedReturns: new Float64Array(stepCount).fill(MONTHLY_RETURN),
          injectedCpi: new Float64Array(stepCount).fill(MONTHLY_CPI),
        });
        const mcYears = (summary.representativeByBasis?.['mc-typical']?.years ?? []).filter(
          (y) => y.accountBalances,
        );
        return {
          detWithdrawal: det.drawdownYears.reduce((s, y) => s + y.withdrawal, 0),
          detBalance: det.drawdownYears[det.drawdownYears.length - 1]?.nominalBalance ?? 0,
          mcWithdrawal: mcYears.reduce((s, y) => s + y.withdrawn, 0),
          mcBalance: mcYears[mcYears.length - 1]?.balance ?? 0,
        };
      };

      const rich = runBoth(withBasis);
      const bare = runBoth(noBasis);
      // More basis → less tax → a smaller funded draw and more left at the end,
      // on BOTH engines. Whole dollars, not a rounding difference.
      expect(rich.detWithdrawal).toBeLessThan(bare.detWithdrawal - 1);
      expect(rich.mcWithdrawal).toBeLessThan(bare.mcWithdrawal - 1);
      expect(rich.detBalance).toBeGreaterThan(bare.detBalance + 1);
      expect(rich.mcBalance).toBeGreaterThan(bare.mcBalance + 1);
      // And the two engines still agree with each other under BOTH basis figures.
      expect(rich.mcBalance).toBeCloseTo(rich.detBalance, 2);
      expect(bare.mcBalance).toBeCloseTo(bare.detBalance, 2);
    });

    // MC pools every household member's Roth basis into ONE carrier
    // entry, so with two Roth owners one owner's withdrawal can consume the
    // other's basis and the engines are NOT guaranteed to agree exactly the way
    // the single-owner shapes above are. A BOUND is what stays true whatever
    // the split does: neither engine strands or invents money, so the two
    // ending balances track each other closely.
    //
    // Nonqualified on the clock for the same reason the first shape is: with
    // qualified draws there is no tax, so there is no split for the two engines
    // to disagree about and the band would bound nothing.
    it('stays within a bound (not exact) for a two-Roth-owner household', () => {
      const args = shapeArgs(
        [
          iAccount('roth-ira-a', 'm1', 'RETIREMENT_ROTH_IRA', 'ROTH', {
            rothIraFirstContributionTaxYear: 2032,
          }),
          iAccount('roth-ira-b', 'm2', 'RETIREMENT_ROTH_IRA', 'ROTH', {
            rothIraFirstContributionTaxYear: 2033,
          }),
        ],
        [
          iBalance('roth-ira-a', 400_000, { totalContributions: 120_000 }),
          iBalance('roth-ira-b', 300_000, { totalContributions: 80_000 }),
        ],
      );
      const det = runBalanceProjection(args);
      const detByYear = new Map(det.drawdownYears.map((y) => [y.year, y]));

      const input = runBalanceProjectionMc(args);
      const stepCount = (input.horizonYear - input.firstYear + 1) * 12;
      const summary = runMonteCarlo({
        ...input,
        pathCount: 1,
        seed: 11,
        injectedReturns: new Float64Array(stepCount).fill(MONTHLY_RETURN),
        injectedCpi: new Float64Array(stepCount).fill(MONTHLY_CPI),
      });
      const mcYears = (summary.representativeByBasis?.['mc-typical']?.years ?? []).filter(
        (y) => y.accountBalances,
      );
      let comparedYears = 0;
      let taxedYears = 0;
      for (const my of mcYears) {
        const dy = detByYear.get(my.year);
        if (!dy) continue;
        if ((dy.federalTaxCents ?? 0) > 0) taxedYears += 1;
        // Within 5% of each other, every compared year — the two engines split
        // a two-owner household's Roth basis differently (MC pools it, the
        // deterministic engine keeps a carrier per pool), so the figures drift
        // rather than matching to the cent.
        const scale = Math.max(1, Math.abs(dy.nominalBalance));
        expect(Math.abs(my.balance - dy.nominalBalance) / scale).toBeLessThan(0.05);
        comparedYears += 1;
      }
      expect(comparedYears).toBeGreaterThan(5);
      // There IS a taxed split for the band to bound.
      expect(taxedYears).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------
  // The funding pass must FUND, at projection level, the §402A(c)(4)(D)
  // recapture (and the pro-rata earnings tax) the annotation pass REPORTS —
  // measured on the committed withdrawal. Deterministic engine only: the two
  // engines fund nonqualified designated-Roth tax on different schedules (see
  // the fixture docblocks above), so this is a det-internal consistency pin.
  // Every projection-level fixture before this one either kept the owners past
  // 59½ or dated the rollover outside its compared window, so the funded
  // recapture leg was never non-zero end-to-end and its wiring (the seed-once
  // pooled state, the real tax-year dating) was unpinned.
  // ---------------------------------------------------------------------
  describe('funding pass funds the reported §402A recapture (projection level)', () => {
    it('drawing years cover the annotation-reported tax; past the window the penalty falls to earnings only', () => {
      const base = inheritedArgs(false);
      const scenario = base.scenarios[0];
      const expenseDollars = 96_000;
      const args = {
        ...base,
        scenarios: [
          {
            ...scenario,
            payload: {
              ...scenario.payload,
              overrides: {
                ...scenario.payload.overrides,
                // Retire at 55 (2028): the compared drawing years sit BEFORE
                // 59½, so the §72(t) leg is live — the configuration every
                // other projection-level fixture avoids.
                retirementAge: {
                  primary: { ageYears: 55, ageMonths: 0 },
                  secondary: { ageYears: 55, ageMonths: 0 },
                },
              },
            },
          },
        ],
        accounts: [
          // $150k of the $400k plan is a 2025 taxable in-plan rollover: inside
          // its five-tax-year §402A(c)(4)(D) window for drawing years
          // 2028-2029, outside it from 2030 — one projection pins both the
          // funded recapture and its expiry.
          iAccount('roth-401k', 'm1', 'RETIREMENT_ROTH_401K', 'ROTH', {
            designatedRothFirstParticipationTaxYear: 2005,
          }),
          iAccount('ira', 'm1', 'RETIREMENT_IRA', 'PRE_TAX'),
        ],
        balances: [
          iBalance('roth-401k', 400_000, { rothInPlanRolloverTaxableAmount: 150_000 }),
          iBalance('ira', 600_000),
        ],
        members: [iMember('m1', true, '1973-02-01'), iMember('m2', false, '1973-02-01')],
        expenses: [
          { ...iExpense(), payload: { ...iExpense().payload, amount: expenseDollars } },
        ],
      };
      const det = runBalanceProjection(args);
      const detByYear = new Map(det.drawdownYears.map((y) => [y.year, y]));
      // Form 5329 folding: the 10% additional tax is part of `federalTaxCents`
      // (the row does not surface `earlyWithdrawalPenaltyCents` separately).
      const reportedTaxDollars = (y: { federalTaxCents?: number }): number =>
        (y.federalTaxCents ?? 0) / 100;

      // Full-expense years only (2028 is a part-year: February retirement).
      // 2029 is IN the lot's window (recapture in the base); 2030-2031 are past
      // it (earnings-only base).
      const y2029 = detByYear.get(2029)!;
      const y2030 = detByYear.get(2030)!;
      const y2031 = detByYear.get(2031)!;
      expect(y2029).toBeDefined();
      expect(y2030).toBeDefined();
      expect(y2031).toBeDefined();
      // Each year's committed withdrawal FUNDS the tax that year reports —
      // in BOTH directions: an under-funding (recapture
      // sheltered as plain contribution basis; or earnings sheltered by
      // another regime's basis) and an over-funding (a stale lot re-charged
      // past its window, phantom earnings income) both break it. The 25% band
      // absorbs the documented funding-pass approximations (the pass-1
      // classification, the static pooled balance); the regimes disagreeing
      // puts the gap far outside it.
      for (const y of [y2029, y2030, y2031]) {
        const funded = y.withdrawal - expenseDollars;
        const reported = reportedTaxDollars(y);
        expect(reported).toBeGreaterThan(0);
        expect(Math.abs(funded - reported)).toBeLessThan(0.25 * reported);
      }
      // The in-window year really carries the recapture and the funded draw
      // follows it: when the lot's five-tax-year window lapses (2030) both the
      // reported tax and the FUNDED withdrawal drop by the recaptured slice —
      // a funding pass that kept charging expired principal (or never charged
      // it) flattens one side of this step.
      expect(reportedTaxDollars(y2029) - reportedTaxDollars(y2030)).toBeGreaterThan(2_000);
      expect(y2029.withdrawal - y2030.withdrawal).toBeGreaterThan(2_000);
    });
  });
});
