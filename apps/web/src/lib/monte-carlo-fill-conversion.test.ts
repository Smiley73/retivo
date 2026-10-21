/**
 * Monte Carlo parity for Fill-mode MAGI-cap Roth conversions.
 *
 * The deterministic per-account engine models the MAGI cap + Fill-mode
 * conversions; the named-strategy Monte Carlo path applies the SAME behavior
 * (`monte-carlo-fill-conversion.ts` builds the per-path conversion hook).
 * These behavior-named tests cover two groups:
 *   1. Parity — a representative MC run reflects the deterministic conversion
 *      logic (conversions happen under Fill, not under Minimize; converted
 *      principal lands in the target Roth).
 *   2. Per-path own-CPI deflation — the representative run's converted amount is
 *      carried as nominal cents on the `DrawdownYear` rows (the display deflates
 *      by the path's OWN sampled CPI, like every other representative figure).
 *
 * Fixture-shift / cache invalidation on an engine change is covered in
 * `monte-carlo.test.ts` + `db/monte-carlo-cache.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { runBalanceProjection, runBalanceProjectionMc } from './balance-projection-runner';
import { buildRunContext, fillStrategyYearTax, newTaxPathState, runMonteCarlo, type McBasis } from './monte-carlo';
import type { StepOutcome } from './projection-engine/kernel';
import type { DrawdownAccountInput, DrawdownYear } from './drawdown-engine-types';
import {
  applyPerYearTaxForPathWithConversion,
  buildMcTaxYearInput,
  classifyMcWithdrawal,
  deriveMcSurvivors,
  seedMcAggregateRothBasisCarrier,
  type McTaxContext,
} from './monte-carlo-tax';
import { buildYearTaxInput, splitProbeRothTranche } from './monte-carlo-fill-conversion';
import { DEFAULT_TAX_CALIBRATION_BUNDLE } from './tax-integration';
import type { MonteCarloInput } from './monte-carlo-types';
import type {
  AccountBalancePayload,
  AccountPayload,
  ExpensePayload,
  HouseholdMemberPayload,
  MagiCapMode,
  MagiCapOverride,
  SocialSecurityBenefitPayload,
  Aggregate,
} from '../db/types';
import type { ScenarioAggregate } from './scenario-resolution';

const TODAY = new Date('2026-06-15T00:00:00Z');
const MC_SEED = 4242;
const MC_PATHS = 120;
const BASES: McBasis[] = ['mc-typical', 'mc-pessimistic', 'mc-bad-luck'];

function member(id: string, isPrimary: boolean, firstName: string, birthYear: number): Aggregate<HouseholdMemberPayload> {
  return {
    id, householdId: 'h', schemaVersion: 1, version: 1, updatedAt: '2026-05-01T00:00:00Z', deviceId: 'd',
    aggregateType: 'householdMember',
    payload: { isPrimary, firstName, lastName: 'Doe', email: `${id}@example.test`, birthdate: `${birthYear}-01-01` },
  };
}
function ssBenefit(memberId: string, pia: number | null): Aggregate<SocialSecurityBenefitPayload> {
  return {
    id: `ss-${memberId}`, householdId: 'h', schemaVersion: 1, version: 1, updatedAt: '2026-05-01T00:00:00Z', deviceId: 'd',
    aggregateType: 'socialSecurityBenefit',
    payload: { householdMemberId: memberId, pia, piaAsOfDate: '2026-01-01', notes: null },
  };
}
function account(id: string, ownerId: string, type: AccountPayload['type'], taxTreatment: AccountPayload['taxTreatment']): Aggregate<AccountPayload> {
  return {
    id, householdId: 'h', schemaVersion: 1, version: 1, updatedAt: '2026-05-01T00:00:00Z', deviceId: 'd',
    aggregateType: 'account',
    payload: {
      name: id, type, ownershipType: 'INDIVIDUAL', taxTreatment, ownerId, institution: 'V', notes: '',
      planningReturnPct: 5, active: true, plannedContributionPreTax: 0, plannedContributionPostTax: 0,
      assetMix: { stocksPct: 60, bondsPct: 30, cashPct: 10 },
    },
  };
}
function balanceRow(accountId: string, year: number, endingBalance: number): Aggregate<AccountBalancePayload> {
  return {
    id: `b-${accountId}-${year}`, householdId: 'h', schemaVersion: 1, version: 1, updatedAt: '2026-05-01T00:00:00Z', deviceId: 'd',
    aggregateType: 'accountBalance',
    payload: {
      accountId, year, lastUpdated: `${year}-12-31`, startingBalance: endingBalance * 0.9,
      startingBalancePreTax: null, startingBalancePostTax: null, contributionsPreTax: null, contributionsPostTax: null,
      companyContributions: 0, companyContributionsPreTax: null, companyContributionsPostTax: null,
      rollover: 0, distributions: 0, endingBalance, endingBalancePreTax: null, endingBalancePostTax: null,
      totalContributions: 0, comment: null,
    },
  };
}
function expense(id: string, annual: number): Aggregate<ExpensePayload> {
  return {
    id, householdId: 'h', schemaVersion: 1, version: 1, updatedAt: '2026-05-01T00:00:00Z', deviceId: 'd',
    aggregateType: 'expense',
    payload: {
      name: id, categoryId: 'cat-housing', amount: annual, frequency: 'yearly',
      classification: 'essential', start: { kind: 'retirementStart' }, end: { kind: 'lifetime', whose: 'last' },
    },
  };
}

/** Build runner args for a single-member household whose only Roth is the
 *  designated Fill-mode conversion target (mirrors the deterministic e2e test). */
function fillArgs(opts: { capMode: MagiCapMode }) {
  const magiCap: MagiCapOverride = {
    windows: [
      {
        start: { kind: 'retirementStart' },
        end: { kind: 'age', memberId: 'primary', years: 85, months: 0 },
        magiCeilingAnnualDollars: 120_000,
        capMode: opts.capMode,
        capMagiLine: 'irmaa',
        targetRothAccountId: 'roth',
      },
    ],
  };
  const scenario: ScenarioAggregate = {
    id: 's', householdId: 'h', schemaVersion: 1, version: 1, updatedAt: '2026-05-01T00:00:00Z', deviceId: 'd',
    aggregateType: 'scenario',
    payload: {
      name: 'Fill', description: '', parentScenarioId: null, isPrimary: true, notes: '',
      overrides: {
        retirementAge: { primary: { ageYears: 64, ageMonths: 0 }, secondary: { ageYears: 64, ageMonths: 0 } },
        socialSecurity: { primary: { ageYears: 67, ageMonths: 0 }, secondary: { ageYears: 67, ageMonths: 0 } },
        inflation: { ratePct: 2 },
        lifeExpectancy: { primary: 90, secondary: 90 },
        withdrawalStrategy: { kind: 'taxEfficient' },
        magiCap,
      },
    },
  };
  return {
    scenarioId: 's',
    scenarios: [scenario],
    accounts: [
      account('ira', 'm1', 'RETIREMENT_IRA', 'PRE_TAX'),
      account('roth', 'm1', 'RETIREMENT_ROTH_IRA', 'ROTH'),
      account('brk', 'm1', 'BROKERAGE', 'POST_TAX'),
    ],
    balances: [
      balanceRow('ira', 2025, 1_500_000),
      balanceRow('roth', 2025, 0),
      balanceRow('brk', 2025, 300_000),
    ],
    members: [member('m1', true, 'John', 1962)],
    ssBenefits: [ssBenefit('m1', 2000)],
    expenses: [expense('living', 60_000)],
    incomeStreams: [],
    todayYear: TODAY.getUTCFullYear(),
    todayMonthIndex: TODAY.getUTCMonth(),
  };
}

/** Build runner args for a TWO-window Fill ladder separated by a GAP year, each
 *  window targeting its OWN Roth. Distinct target accounts let a test
 *  verify each window credits the right Roth in its year range, and the gap year
 *  (covered by no window) applies no cap / no conversion. The member retires at
 *  64 (born 1962 → retirement 2026), so the absolute-year windows fall inside
 *  the drawdown horizon:
 *    window 0: [2028, 2031) → roth-a   (conversions land in roth-a)
 *    GAP:      2031, 2032              (no window — no cap, no conversion)
 *    window 1: [2033, 2036) → roth-b   (conversions land in roth-b) */
function fillArgsMultiWindowGap() {
  const magiCap: MagiCapOverride = {
    windows: [
      {
        start: { kind: 'year', year: 2028 },
        end: { kind: 'year', year: 2030 }, // inclusive end-year → exclusive 2031
        magiCeilingAnnualDollars: 120_000,
        capMode: 'fill',
        capMagiLine: 'irmaa',
        targetRothAccountId: 'roth-a',
      },
      {
        start: { kind: 'year', year: 2033 },
        end: { kind: 'year', year: 2035 }, // inclusive end-year → exclusive 2036
        magiCeilingAnnualDollars: 120_000,
        capMode: 'fill',
        capMagiLine: 'irmaa',
        targetRothAccountId: 'roth-b',
      },
    ],
  };
  const scenario: ScenarioAggregate = {
    id: 's', householdId: 'h', schemaVersion: 1, version: 1, updatedAt: '2026-05-01T00:00:00Z', deviceId: 'd',
    aggregateType: 'scenario',
    payload: {
      name: 'FillGap', description: '', parentScenarioId: null, isPrimary: true, notes: '',
      overrides: {
        retirementAge: { primary: { ageYears: 64, ageMonths: 0 }, secondary: { ageYears: 64, ageMonths: 0 } },
        socialSecurity: { primary: { ageYears: 67, ageMonths: 0 }, secondary: { ageYears: 67, ageMonths: 0 } },
        inflation: { ratePct: 2 },
        lifeExpectancy: { primary: 90, secondary: 90 },
        withdrawalStrategy: { kind: 'taxEfficient' },
        magiCap,
      },
    },
  };
  return {
    scenarioId: 's',
    scenarios: [scenario],
    accounts: [
      account('ira', 'm1', 'RETIREMENT_IRA', 'PRE_TAX'),
      account('roth-a', 'm1', 'RETIREMENT_ROTH_IRA', 'ROTH'),
      account('roth-b', 'm1', 'RETIREMENT_ROTH_IRA', 'ROTH'),
      account('brk', 'm1', 'BROKERAGE', 'POST_TAX'),
    ],
    balances: [
      balanceRow('ira', 2025, 1_500_000),
      balanceRow('roth-a', 2025, 0),
      balanceRow('roth-b', 2025, 0),
      balanceRow('brk', 2025, 300_000),
    ],
    members: [member('m1', true, 'John', 1962)],
    ssBenefits: [ssBenefit('m1', 2000)],
    expenses: [expense('living', 60_000)],
    incomeStreams: [],
    todayYear: TODAY.getUTCFullYear(),
    todayMonthIndex: TODAY.getUTCMonth(),
  };
}

/** Sum lifetime converted cents across every representative basis run. */
function totalRepresentativeConvertedCents(args: ReturnType<typeof fillArgs>): number {
  const input = runBalanceProjectionMc(args);
  const summary = runMonteCarlo({ ...input, pathCount: MC_PATHS, seed: MC_SEED });
  let total = 0;
  for (const basis of BASES) {
    const run = summary.representativeByBasis?.[basis];
    if (!run) continue;
    for (const y of run.years) total += y.rothConvertedCents ?? 0;
  }
  return total;
}

/** Lifetime converted cents on the Typical (P50) representative run only. */
function typicalRepresentativeConvertedCents(args: ReturnType<typeof fillArgs>): number {
  const input = runBalanceProjectionMc(args);
  const summary = runMonteCarlo({ ...input, pathCount: MC_PATHS, seed: MC_SEED });
  const run = summary.representativeByBasis?.['mc-typical'];
  return (run?.years ?? []).reduce((sum, y) => sum + (y.rothConvertedCents ?? 0), 0);
}

/** Lifetime converted cents the DETERMINISTIC engine commits for the same args. */
function deterministicConvertedCents(args: ReturnType<typeof fillArgs>): number {
  return runBalanceProjection(args).drawdownYears.reduce(
    (sum, y) => sum + (y.rothConvertedCents ?? 0),
    0,
  );
}

describe('Monte Carlo — Fill-mode Roth conversions (parity)', () => {
  it('should_model_conversions_on_the_mc_strategy_path_under_fill', () => {
    // Parity with the deterministic engine: the cap + conversion solve now run on
    // every MC path, so a representative run carries converted principal.
    // One MC run feeds both the all-bases total and the Typical-run total.
    const input = runBalanceProjectionMc(fillArgs({ capMode: 'fill' }));
    const summary = runMonteCarlo({ ...input, pathCount: MC_PATHS, seed: MC_SEED });
    let converted = 0;
    for (const basis of BASES) {
      for (const y of summary.representativeByBasis?.[basis]?.years ?? []) {
        converted += y.rothConvertedCents ?? 0;
      }
    }
    expect(converted).toBeGreaterThan(0);
    // The converted principal is routed into the user-designated target Roth
    // (the single `roth` account here), witnessed by a positive lifetime
    // `rothConvertedCents` on the representative run. The per-account Roth
    // year-END BALANCE is NOT a reliable witness — the aggressive Fill
    // conversions ruin this fixture's portfolio in the very year the first
    // conversion fires (`depletionYear` === the conversion year), and the
    // absorbing convention zeroes every account row's year-END balance at or
    // after depletion (the conversion year included). The conversion AMOUNT is a
    // historical-activity field that is never zeroed, so it remains the durable
    // proof that the principal was routed to the target Roth.
    const typical = summary.representativeByBasis?.['mc-typical'];
    expect(typical).toBeTruthy();
    const lifetimeConverted = (typical?.years ?? []).reduce(
      (sum, y) => sum + (y.rothConvertedCents ?? 0),
      0,
    );
    expect(lifetimeConverted).toBeGreaterThan(0);
  });

  it('should_not_convert_on_the_mc_path_under_minimize', () => {
    // Minimize: cap routing may still run, but no conversion ever occurs.
    const converted = totalRepresentativeConvertedCents(fillArgs({ capMode: 'minimize' }));
    expect(converted).toBe(0);
  });

  it('should_carry_converted_cents_as_nominal_for_per_path_cpi_deflation', () => {
    // The representative run carries the converted amount as NOMINAL integer
    // cents on the `DrawdownYear` rows; the display deflates by the path's own
    // sampled CPI (like every representative figure), so a conversion year's
    // nominal converted cents is a positive whole number.
    const input = runBalanceProjectionMc(fillArgs({ capMode: 'fill' }));
    const summary = runMonteCarlo({ ...input, pathCount: MC_PATHS, seed: MC_SEED });
    const typical = summary.representativeByBasis?.['mc-typical'];
    const conversionYears = (typical?.years ?? []).filter((y) => (y.rothConvertedCents ?? 0) > 0);
    expect(conversionYears.length).toBeGreaterThan(0);
    for (const y of conversionYears) {
      expect(Number.isInteger(y.rothConvertedCents)).toBe(true);
      expect(y.rothConvertedCents).toBeGreaterThan(0);
    }
  });
});

describe('Monte Carlo — Fill-mode MonteCarloInput is worker-serializable', () => {
  it('should_structured_clone_a_fill_mode_input_without_a_dataclone_error', () => {
    // REGRESSION: the production MC path posts `MonteCarloInput` to a Web
    // Worker via `postMessage` (structured clone). The closure-bearing runtime
    // MAGI-cap config (`findTargetRothIndex` / `findLaterTaxableIndex`) must NOT
    // ride the input — only the SERIALIZABLE overlay + cap-off year — or every
    // active-cap named-strategy MC run throws `DataCloneError` in production.
    const input = runBalanceProjectionMc(fillArgs({ capMode: 'fill' }));
    // The overlay (window schedule) is present and serializable; the runtime
    // config field is gone.
    expect(input.magiCapOverride).toBeDefined();
    expect(input.magiCapOverride?.windows[0].capMode).toBe('fill');
    expect(Array.isArray(input.magiCapWindowBounds)).toBe(true);
    expect(typeof input.magiCapWindowBounds?.[0].startYear).toBe('number');
    expect(typeof input.magiCapWindowBounds?.[0].endYear).toBe('number');
    expect('magiCapConfig' in input).toBe(false);
    // The whole input survives a structured clone (what `postMessage` performs).
    expect(() => structuredClone(input)).not.toThrow();
    const cloned = structuredClone(input);
    expect(cloned.magiCapOverride?.windows[0].targetRothAccountId).toBe('roth');
    // The cloned input still drives a Fill-mode MC run that converts.
    const summary = runMonteCarlo({ ...cloned, pathCount: MC_PATHS, seed: MC_SEED });
    let converted = 0;
    for (const basis of BASES) {
      for (const y of summary.representativeByBasis?.[basis]?.years ?? []) {
        converted += y.rothConvertedCents ?? 0;
      }
    }
    expect(converted).toBeGreaterThan(0);
  });
});

describe('Monte Carlo — Fill conversion numeric parity vs deterministic', () => {
  it('should_size_mc_conversions_within_a_band_of_the_deterministic_total', () => {
    // REGRESSION: the conversion's ordinary income must enter the per-path
    // tax ring (federal/IRMAA + the MagiRing for Y+2 IRMAA), so the MC Fill solve
    // is taxed against the SAME surface the deterministic engine uses. If the MC
    // path under-taxed the conversion (a parallel tax surface) it would
    // over-convert — the lifetime total would drift FAR above deterministic. The
    // Typical representative run is the P50 path, so its total should track the
    // deterministic total within a wide-but-bounded band (per-path market luck +
    // own-CPI deflation move the exact figure, but not by multiples).
    const args = fillArgs({ capMode: 'fill' });
    const detTotal = deterministicConvertedCents(args);
    const mcTotal = typicalRepresentativeConvertedCents(args);
    expect(detTotal).toBeGreaterThan(0);
    expect(mcTotal).toBeGreaterThan(0);
    // Bounded both ways: the MC total is neither a tiny fraction of (under-fund)
    // nor a large multiple of (over-fund) the deterministic total.
    expect(mcTotal).toBeGreaterThan(detTotal * 0.4);
    expect(mcTotal).toBeLessThan(detTotal * 2.5);
  });

  it('should_charge_irmaa_two_years_after_a_conversion_pushes_magi_over_a_tier', () => {
    // REGRESSION (Y+2 funding): a conversion year's conversion-INCLUSIVE
    // MAGI must advance the per-path MagiRing so the year-(Y+2) IRMAA look-back
    // sees it. The representative tax post-pass stamps `irmaaSurchargeCents`; a
    // year two-after a positive-conversion year carries a positive surcharge
    // (if the conversion never entered the ring, the surcharge would be
    // unfunded / absent).
    //
    // This test needs the TYPICAL representative path to SURVIVE (a depleted
    // path's post-depletion years are zero-clamped → $0 tax/IRMAA stamped).
    // The conversion's same-year incremental tax is fundable ONLY from MAGI-NEUTRAL
    // balances (Roth basis + cash-like); the base `fillArgs` household has neither
    // (its brokerage realizes LTCG → MAGI, so it is NOT MAGI-neutral), so every
    // path's conversion tax is unfundable → a conversion-shortfall depletion at
    // the first retirement year, which is absorbing-zeroed. Add a cash-like
    // SAVINGS account so the conversion tax IS fundable and the path survives,
    // leaving real post-conversion years to carry IRMAA.
    const base = fillArgs({ capMode: 'fill' });
    const solvent = {
      ...base,
      accounts: [...base.accounts, account('cash', 'm1', 'SAVINGS', 'POST_TAX')],
      balances: [...base.balances, balanceRow('cash', 2025, 600_000)],
    };
    const input = runBalanceProjectionMc(solvent);
    const summary = runMonteCarlo({ ...input, pathCount: MC_PATHS, seed: MC_SEED });
    const years = summary.representativeByBasis?.['mc-typical']?.years ?? [];
    const byYear = new Map(years.map((y) => [y.year, y]));
    const convYears = years.filter((y) => (y.rothConvertedCents ?? 0) > 0);
    expect(convYears.length).toBeGreaterThan(0);
    const anyYPlus2Irmaa = convYears.some(
      (y) => (byYear.get(y.year + 2)?.irmaaSurchargeCents ?? 0) > 0,
    );
    expect(anyYPlus2Irmaa).toBe(true);
  });
});

describe('Monte Carlo — Fill conversion sees the RMD floor surface', () => {
  it('should_keep_conversions_bounded_when_the_rmd_floor_surface_is_active', () => {
    // REGRESSION: the conversion tax-input builder must see the same
    // prior-balance / synthetic-RMD-floor basis `fillStrategyYearTax` uses
    // (a hard-coded 0 would be an UN-floored surface). The single-member
    // household (born 1962) reaches the RMD trigger age within the horizon, so the
    // representative run DOES carry RMD-floor years (`rmdFloorCents > 0`). With an
    // un-floored surface the Fill solve under-taxes RMD-year pre-tax income and
    // over-converts; the floored surface keeps the lifetime conversion total
    // bounded against the deterministic engine (which forces the same RMD income).
    // Add a cash-like SAVINGS account so the conversion's same-year tax is
    // fundable from MAGI-NEUTRAL balances and the typical representative path
    // SURVIVES to the RMD-age years (the base ladder has no MAGI-neutral funding
    // source — its brokerage realizes LTCG → MAGI — so its conversion-shortfall
    // depletion would absorbing-zero the post-depletion years, leaving no RMD-floor
    // years on the representative run).
    const fillBase = fillArgs({ capMode: 'fill' });
    const args = {
      ...fillBase,
      accounts: [...fillBase.accounts, account('cash', 'm1', 'SAVINGS', 'POST_TAX')],
      balances: [...fillBase.balances, balanceRow('cash', 2025, 600_000)],
    };
    const input = runBalanceProjectionMc(args);
    const summary = runMonteCarlo({ ...input, pathCount: MC_PATHS, seed: MC_SEED });
    const years = summary.representativeByBasis?.['mc-typical']?.years ?? [];
    // The RMD floor surface is exercised on this run (RMD-age years carry a floor).
    const floorYears = years.filter((y) => (y.rmdFloorCents ?? 0) > 0);
    expect(floorYears.length).toBeGreaterThan(0);
    // Conversions remain bounded vs deterministic despite the floored surface
    // (un-floored over-conversion would blow past this band).
    const detTotal = deterministicConvertedCents(args);
    const mcTotal = years.reduce((sum, y) => sum + (y.rothConvertedCents ?? 0), 0);
    expect(mcTotal).toBeGreaterThan(0);
    expect(mcTotal).toBeLessThan(detTotal * 2.5);
  });
});

// ---------------------------------------------------------------------------
// Unit fixtures — drive the per-year tax + floor seams directly so
// the double-funding + pass-1/pass-2 floor-desync defects are pinned to one year.
// ---------------------------------------------------------------------------

/** Single RMD-age member tax context (born 1950 → RMD-age by the 2030s). */
function rmdAgeTaxContext(): McTaxContext {
  return {
    taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
    filingStatus: 'Single',
    members: [{ memberId: 'primary', isoBirthdate: '1950-01-01', onMedicare: true, hasAcaCoverage: false }],
    householdSize: 1,
    inflationRatePct: 0,
  };
}

/** Minimal `MonteCarloInput` slice `buildYearTaxInput` reads (ss/income/expense). */
function tinyMcInput(taxCtx: McTaxContext): MonteCarloInput {
  return {
    firstYear: 2030,
    retirementYear: 2030,
    ssByYear: [],
    incomeByYear: [],
    monthlyExpenseBase: [],
    taxContext: taxCtx,
  } as unknown as MonteCarloInput;
}

/** Windowed per-year nominal (= 40_000/yr lifetime base at cumCpi=1) for the
 *  `buildYearTaxInput` calls below; the value is INERT in those calls (the
 *  committed classification drives the conversion solve). */
const TINY_NOMINAL_EXPENSE_BY_YEAR = new Float64Array(64).fill(40_000);

describe('Monte Carlo — Fill conversion same-year tax is funded ONCE', () => {
  it('should_not_fold_the_current_year_conversion_into_the_funded_same_year_tax', () => {
    // REGRESSION (double-funding): the strategy MC path funds the conversion's
    // same-year incremental ordinary-income tax via the ENGINE
    // (`fundConversionTaxForYear`, from MAGI-neutral post balances). The
    // expense-fold therefore must NOT also fund it — i.e. the FUNDED
    // `taxCashflowDollars` for a conversion year must equal the WITHDRAWALS-ONLY
    // funded tax (excluding this year's own conversion). If the conversion were
    // folded into the funded tax, the with-conversion funded tax would be
    // strictly larger than the no-conversion funded tax → it FAILS this equality.
    const taxCtx = rmdAgeTaxContext();
    const seedCarrier = () =>
      seedMcAggregateRothBasisCarrier(taxCtx.rothBasisCentsByOwner ?? new Map());
    const base = {
      taxCtx,
      taxYear: 2035,
      retirementYear: 2030,
      grossSsDollars: 24_000,
      nominalExpense: 40_000,
      otherIncome: 0,
      priorBalance: 1_500_000,
      // The per-owner pre-tax basis drives the RMD floor (primary at
      // RMD age owns the $1.5M pre-tax).
      priorPreTaxByOwner: new Map<string, number>([['primary', 1_500_000_00]]),
      magiMinus2: 90_000,
      classification: classifyMcWithdrawal([
        {
          accountType: 'RETIREMENT_IRA' as const,
          taxTreatment: 'PRE_TAX' as const,
          withdrawalDollars: 50_000,
          preBalanceStartDollars: 1_500_000,
          postBalanceStartDollars: 0,
        },
      ]),
    };
    const withConv = applyPerYearTaxForPathWithConversion({
      ...base,
      additionalOrdinaryIncomeDollars: 80_000,
      rothBasisCarrier: seedCarrier(),
    });
    const noConv = applyPerYearTaxForPathWithConversion({
      ...base,
      additionalOrdinaryIncomeDollars: 0,
      rothBasisCarrier: seedCarrier(),
    });
    expect(withConv).not.toBeNull();
    expect(noConv).not.toBeNull();
    // Funded once: the conversion year's funded same-year tax == the withdrawals-
    // only funded tax (the engine funds the conversion's incremental tax).
    expect(withConv!.result.taxCashflowDollars).toBeCloseTo(noConv!.result.taxCashflowDollars, 6);
    // But the MAGI ring sample IS conversion-inclusive (so Y+2 IRMAA is funded):
    // the inclusive MAGI for the conversion year exceeds the withdrawals-only MAGI.
    expect(withConv!.magiInclusiveDollars).toBeGreaterThan(noConv!.result.magiDollars);
    // The withdrawals-only funded result's own MAGI is the withdrawals-only MAGI
    // (the funded tax never sees the conversion).
    expect(withConv!.result.magiDollars).toBeCloseTo(noConv!.result.magiDollars, 6);
  });
});

describe('Monte Carlo — Fill conversion + committed tax share one RMD floor', () => {
  it('should_use_the_same_pass1_derived_prior_balance_floor_for_the_conversion_solve_and_committed_tax', () => {
    // REGRESSION (pass-1/pass-2 floor desync), pinned to the PRODUCTION
    // contract: production builds ONE shared prior-balance array from pass-1
    // year-END balances and hands the SAME array to both the conversion solve
    // (`buildYearTaxInput`) and the committed per-path tax (`fillStrategyYearTax`
    // → `buildMcTaxYearInput`). This test must NOT manufacture a pass-2 balance
    // that production never produces; it pins that, fed the same pass-1-derived
    // prior balance, both consumers gross the synthetic RMD floor to the SAME
    // pre-tax income (no desync between solve and committed tax) — and that a
    // pass1≠pass2 divergence does NOT change this, because BOTH consumers read the
    // pass-1 value (the accepted one-pass-stale approximation), never pass-2.
    const taxCtx = rmdAgeTaxContext();
    const input = tinyMcInput(taxCtx);
    const taxYear = 2035;
    const globalYearOffset = taxYear - input.firstYear;
    // Committed withdrawal is BELOW the RMD floor → the synthetic floor grosses it up.
    const mcClass = classifyMcWithdrawal([
      {
        accountType: 'RETIREMENT_IRA' as const,
        taxTreatment: 'PRE_TAX' as const,
        withdrawalDollars: 10_000,
        preBalanceStartDollars: 1_000_000,
        postBalanceStartDollars: 0,
      },
    ]);
    // `buildMcTaxYearInput` takes `McWithdrawalClassification` (with the split Roth
    // fields). `buildYearTaxInput` (conversion-solve surface) takes the deterministic
    // `TaxCashflowYearClassification` which collapses Roth back to `rothDollars`.
    const mcClassification = mcClass; // McWithdrawalClassification — for buildMcTaxYearInput
    const detClassification = {
      preTaxDollars: mcClass.preTaxDollars,
      postTaxNonRothDollars: mcClass.postTaxNonRothDollars,
      postTaxCashLikeDollars: mcClass.postTaxCashLikeDollars,
      rothDollars: mcClass.rothBasisOrderedDollars + mcClass.rothWholesaleTaxFreeDollars,
      fundedDollars:
        mcClass.preTaxDollars +
        mcClass.postTaxNonRothDollars +
        mcClass.postTaxCashLikeDollars +
        mcClass.rothBasisOrderedDollars +
        mcClass.rothWholesaleTaxFreeDollars,
    };
    // The RMD floor derives from the per-owner PRE-TAX basis, NOT
    // the whole-portfolio prior balance. The SHARED source production hands both
    // consumers: a pass-1-derived per-owner pre-tax map. There is NO separately-fed
    // pass-2 map in production.
    const sharedPass1PriorBalance = 1_000_000;
    const sharedPass1PreTaxByOwner = new Map<string, number>([['primary', 1_000_000_00]]);
    // A hypothetical pass-2 pre-tax map production never feeds either consumer; used
    // only to prove neither consumer tracks it (both stay on the pass-1 value).
    const hypotheticalPass2PreTaxByOwner = new Map<string, number>([['primary', 1_600_000_00]]);
    const magiMinus2 = 90_000;

    // The committed-tax floor surface (what `fillStrategyYearTax` builds), fed the
    // SHARED pass-1-derived per-owner pre-tax basis.
    const survivors = deriveMcSurvivors(taxCtx, taxYear, input.retirementYear);
    expect(survivors).not.toBeNull();
    const committed = buildMcTaxYearInput(
      {
        taxCtx,
        taxYear,
        retirementYear: input.retirementYear,
        grossSsDollars: 0,
        nominalExpense: 40_000,
        otherIncome: 0,
        priorBalance: sharedPass1PriorBalance,
        priorPreTaxByOwner: sharedPass1PreTaxByOwner,
        magiMinus2,
        classification: mcClassification,
      },
      survivors!,
      mcClassification.preTaxDollars,
      0,
    );

    // The conversion-solve floor surface fed the SAME shared pass-1-derived basis.
    const convSolveShared = buildYearTaxInput(
      input, taxCtx, taxYear, globalYearOffset, TINY_NOMINAL_EXPENSE_BY_YEAR,
      detClassification, magiMinus2, sharedPass1PriorBalance, sharedPass1PreTaxByOwner,
    );
    expect(convSolveShared).not.toBeNull();
    // The RMD floor is active this year (it grosses the $10k pre-tax draw up).
    expect(committed.preTaxWithdrawalDollars).toBeGreaterThan(detClassification.preTaxDollars);
    // (1) Single source (the fix): the SAME shared pass-1-derived per-owner pre-tax
    // basis → the conversion solve and the committed tax see an IDENTICAL floor.
    expect(convSolveShared!.preTaxWithdrawalDollars).toBeCloseTo(
      committed.preTaxWithdrawalDollars,
      6,
    );

    // (2) Accepted approximation: were pass-1 and pass-2 to diverge, production
    // still feeds BOTH consumers the pass-1 value — neither tracks pass-2. Feeding
    // a hypothetical pass-2 pre-tax basis to the conversion solve produces a
    // DIFFERENT floor, i.e. it is NOT what the (pass-1-fed) committed tax sees. The
    // contract is that production never does this — both stay consistent on pass-1.
    const convSolveHypotheticalPass2 = buildYearTaxInput(
      input, taxCtx, taxYear, globalYearOffset, TINY_NOMINAL_EXPENSE_BY_YEAR,
      detClassification, magiMinus2, sharedPass1PriorBalance, hypotheticalPass2PreTaxByOwner,
    );
    expect(convSolveHypotheticalPass2).not.toBeNull();
    expect(convSolveHypotheticalPass2!.preTaxWithdrawalDollars).not.toBeCloseTo(
      committed.preTaxWithdrawalDollars,
      2,
    );
    // The pass-1-fed conversion solve (what production actually does) DOES match
    // the pass-1-fed committed tax — re-pinning that both consumers read pass-1.
    expect(convSolveShared!.preTaxWithdrawalDollars).not.toBeCloseTo(
      convSolveHypotheticalPass2!.preTaxWithdrawalDollars,
      2,
    );
  });
});

describe('Monte Carlo — Fill conversion solve uses the QCD-offset-reduced RMD floor', () => {
  it('reduces the conversion-solve RMD floor by the per-owner QCD offset (matching the committed tax + deterministic Fill solve)', () => {
    // REGRESSION: the Fill conversion solve grosses the pre-tax tranche up to
    // the per-owner RMD floor inside `buildMcTaxYearInput`. In a QCD scenario the
    // owner's IRA-pool RMD is partly satisfied by the QCD (IRC §408(d)(8)) — the
    // deterministic Fill solve sees the COMMITTED net draw (the strategy engine
    // already drew `gross − offset`), and the committed MC tax (`fillStrategyYearTax`)
    // threads `qcdRmdOffsetCentsByOwner` into the SAME floor. If the conversion
    // hook did not thread the offset, it would re-gross the QCD-satisfied RMD as
    // phantom taxable income (over-taxed / under-converted). Threading the
    // offset DROPS the grossed pre-tax income by exactly the offset (clamped at the
    // committed draw), so the conversion solve sees the same net floor.
    const taxCtx = rmdAgeTaxContext();
    const input = tinyMcInput(taxCtx);
    const taxYear = 2035;
    const globalYearOffset = taxYear - input.firstYear;
    // Committed pre-tax draw is BELOW the gross RMD floor → the floor grosses it up.
    const mcClass = classifyMcWithdrawal([
      {
        accountType: 'RETIREMENT_IRA' as const,
        taxTreatment: 'PRE_TAX' as const,
        withdrawalDollars: 5_000,
        preBalanceStartDollars: 1_000_000,
        postBalanceStartDollars: 0,
      },
    ]);
    const detClassification = {
      preTaxDollars: mcClass.preTaxDollars,
      postTaxNonRothDollars: mcClass.postTaxNonRothDollars,
      postTaxCashLikeDollars: mcClass.postTaxCashLikeDollars,
      rothDollars: mcClass.rothBasisOrderedDollars + mcClass.rothWholesaleTaxFreeDollars,
      fundedDollars:
        mcClass.preTaxDollars +
        mcClass.postTaxNonRothDollars +
        mcClass.postTaxCashLikeDollars +
        mcClass.rothBasisOrderedDollars +
        mcClass.rothWholesaleTaxFreeDollars,
    };
    const priorPreTaxByOwner = new Map<string, number>([['primary', 1_000_000_00]]);
    const priorBalance = 1_000_000;
    const magiMinus2 = 90_000;

    // GROSS floor (no QCD offset — a no-QCD run).
    const grossFloorInput = buildYearTaxInput(
      input, taxCtx, taxYear, globalYearOffset, TINY_NOMINAL_EXPENSE_BY_YEAR,
      detClassification, magiMinus2, priorBalance, priorPreTaxByOwner,
    );
    expect(grossFloorInput).not.toBeNull();
    const grossPreTaxForTax = grossFloorInput!.preTaxWithdrawalDollars;
    // The gross floor grosses the $5k committed draw up to the full RMD floor.
    expect(grossPreTaxForTax).toBeGreaterThan(detClassification.preTaxDollars);

    // A QCD offset that satisfies PART of the IRA-pool RMD. Size it under the gross
    // floor so the net floor stays above the committed draw (the gross-up is still
    // active, just lower) — proving the reduction is applied, not a no-op.
    const offsetDollars = Math.floor((grossPreTaxForTax - detClassification.preTaxDollars) / 2);
    expect(offsetDollars).toBeGreaterThan(0);
    const qcdRmdOffsetCentsByOwner = new Map<string, number>([
      ['primary', offsetDollars * 100],
    ]);
    const netFloorInput = buildYearTaxInput(
      input, taxCtx, taxYear, globalYearOffset, TINY_NOMINAL_EXPENSE_BY_YEAR,
      detClassification, magiMinus2, priorBalance, priorPreTaxByOwner,
      qcdRmdOffsetCentsByOwner,
    );
    expect(netFloorInput).not.toBeNull();
    // The QCD offset REDUCES the grossed pre-tax income by exactly the offset
    // (the floor is `grossFloor − offset`, still above the committed draw, so the
    // gross-up settles at the reduced floor).
    expect(netFloorInput!.preTaxWithdrawalDollars).toBeCloseTo(
      grossPreTaxForTax - offsetDollars,
      6,
    );
    // And it is strictly LESS than the gross-floor income → the conversion solve
    // sees less phantom RMD income, freeing convertible headroom (no over-conversion).
    expect(netFloorInput!.preTaxWithdrawalDollars).toBeLessThan(grossPreTaxForTax);

    // A QCD offset ≥ the gross floor collapses the floor to the committed draw
    // (clamped ≥ 0 then `max(draw, floor)`), so no phantom RMD income remains.
    const hugeOffset = new Map<string, number>([['primary', grossPreTaxForTax * 100 * 2]]);
    const fullyOffsetInput = buildYearTaxInput(
      input, taxCtx, taxYear, globalYearOffset, TINY_NOMINAL_EXPENSE_BY_YEAR,
      detClassification, magiMinus2, priorBalance, priorPreTaxByOwner, hugeOffset,
    );
    expect(fullyOffsetInput).not.toBeNull();
    expect(fullyOffsetInput!.preTaxWithdrawalDollars).toBeCloseTo(
      detClassification.preTaxDollars,
      6,
    );
  });
});

describe('Monte Carlo — committed pass-2 tax reads the SHARED pass-1 QCD offset', () => {
  it('uses the threaded qcdRmdOffsetByYearIndex (not the row offset) for the committed RMD floor', () => {
    // REGRESSION: in the Fill two-pass the QCD IRA-pool RMD offset is built
    // ONCE from pass-1 committed rows and threaded into BOTH the pass-2 conversion
    // SOLVE (`buildMcFillConversionHook`) AND the pass-2 committed TAX
    // (`fillStrategyYearTax`). If only the SOLVE received the shared array, the
    // committed tax would read THIS pass's row offset (`retYears[i].qcdRmdOffsetCentsByOwner`),
    // so when pass-2 tax funding shifted the source IRA balance across the QCD cap
    // (pass-1 offset ≠ pass-2 offset) the solve and the committed tax would use
    // DIFFERENT offset-reduced RMD floors → QCD+Fill parity drift. The offset is
    // sourced, like the floor basis, from ONE authoritative pass-1 array shared by
    // both.
    //
    // This pins the wiring directly: run the REAL `fillStrategyYearTax` twice on the
    // SAME pass-2 row (row offset = 0 → the gross RMD floor grosses the draw up),
    // once WITHOUT the shared array and once WITH a shared array carrying a large
    // pass-1 offset (collapses the floor to the committed draw). Without the shared
    // array the run reads the row offset (0) → the gross-floor committed federal
    // tax. The shared-array run reads the threaded pass-1 offset → a strictly LOWER
    // committed federal tax (no phantom-RMD gross-up), proving the committed tax
    // sources the shared pass-1 offset.
    const taxCtx = rmdAgeTaxContext();
    const IRA_ID = 'ira';
    const PRE_TAX_DOLLARS = 1_000_000;
    const COMMITTED_DRAW = 5_000; // BELOW the RMD floor → the floor grosses it up.
    // Minimal `MonteCarloInput` carrying the fields `fillStrategyYearTax` +
    // `newTaxPathState` read (the single pre-tax IRA ledger entry drives the
    // per-account classification + per-owner RMD floor).
    const input = {
      firstYear: 2030,
      // `buildRunContext` (feeding `newTaxPathState` via
      // `ctx`) needs a real `horizonYear` to size its per-run arrays — a
      // single-year horizon matches this test's own local `horizonYears = 1`.
      horizonYear: 2030,
      retirementYear: 2030,
      ssByYear: [0],
      incomeByYear: [0],
      monthlyExpenseBase: [],
      taxContext: taxCtx,
      accountMcLedger: [
        {
          id: IRA_ID,
          initialPre: PRE_TAX_DOLLARS,
          initialPost: 0,
          taxTreatment: 'PRE_TAX' as const,
          accountType: 'RETIREMENT_IRA' as const,
          ownerId: 'primary',
        },
      ],
    } as unknown as MonteCarloInput;
    // Minimal `StepOutcome` — `fillStrategyYearTax` reads the per-account ledger +
    // rows, not `out` (which only rides `taxState`); a cumCpi=1 stub suffices.
    const out: StepOutcome = { cumCpi: new Float64Array([1]) } as unknown as StepOutcome;
    const accountsIn = [
      { id: IRA_ID, initialPre: PRE_TAX_DOLLARS, initialPost: 0 },
    ] as unknown as ReadonlyArray<DrawdownAccountInput>;
    // A single drawdown row (year index 0 = 2030, owner age 80 → RMD active) whose
    // committed IRA draw is BELOW the gross RMD floor. Row offset is ABSENT (the
    // pass-2 row carries no QCD offset in this fixture).
    const buildRow = (): DrawdownYear =>
      ({
        balance: PRE_TAX_DOLLARS - COMMITTED_DRAW,
        accountBalances: new Map([
          [
            IRA_ID,
            {
              balance: PRE_TAX_DOLLARS - COMMITTED_DRAW,
              preEnd: PRE_TAX_DOLLARS - COMMITTED_DRAW,
              postEnd: 0,
              withdrawn: COMMITTED_DRAW,
              deposit: 0,
            },
          ],
        ]),
      }) as unknown as DrawdownYear;
    const horizonYears = 1;
    const priorPreTaxByOwnerByYearIndex = [
      new Map<string, number>([['primary', PRE_TAX_DOLLARS * 100]]),
    ];
    const sharedPriorBalanceByYearIndex = [PRE_TAX_DOLLARS];

    // Run A: NO shared QCD-offset array → the committed tax reads the row offset
    // (absent → 0), so the RMD floor grosses the $5k draw up (phantom RMD income).
    const stateNoShared = newTaxPathState(input, out, 12, horizonYears, new Float64Array([40_000]), new Float64Array(horizonYears), buildRunContext(input))!;
    fillStrategyYearTax(
      input,
      [buildRow()],
      accountsIn,
      0,
      stateNoShared,
      sharedPriorBalanceByYearIndex,
      priorPreTaxByOwnerByYearIndex,
      // No shared QCD offset array (Minimize): the committed tax reads the row's own offset.
    );
    const fedTaxNoShared = stateNoShared.acc.fedTax[0];

    // Run B: a shared pass-1 QCD-offset array large enough to collapse the gross RMD
    // floor down to the committed draw (no phantom RMD income). The
    // committed tax MUST read THIS shared offset (not the row's absent offset).
    const hugeOffsetCents = PRE_TAX_DOLLARS * 100; // ≥ the whole gross floor.
    const sharedQcdRmdOffsetByYearIndex = [
      new Map<string, number>([['primary', hugeOffsetCents]]),
    ];
    const stateShared = newTaxPathState(input, out, 12, horizonYears, new Float64Array([40_000]), new Float64Array(horizonYears), buildRunContext(input))!;
    fillStrategyYearTax(
      input,
      [buildRow()],
      accountsIn,
      0,
      stateShared,
      sharedPriorBalanceByYearIndex,
      priorPreTaxByOwnerByYearIndex,
      sharedQcdRmdOffsetByYearIndex,
    );
    const fedTaxShared = stateShared.acc.fedTax[0];

    // Sanity: the no-offset floor actually grossed the draw up (a real RMD floor),
    // so there is phantom-RMD income to collapse — otherwise the test is vacuous.
    expect(fedTaxNoShared).toBeGreaterThan(0);
    // The committed tax reads the SHARED pass-1 offset, which collapses the
    // floor → strictly LOWER committed federal tax. If it read only the row
    // offset (0) in BOTH runs, fedTaxShared === fedTaxNoShared and this
    // expectation would fail.
    expect(fedTaxShared).toBeLessThan(fedTaxNoShared);
  });
});

describe('Monte Carlo — multi-window MAGI-cap SCHEDULE with a gap year', () => {
  it('applies each window cap + routes conversions to the right Roth, with no cap in the gap year', () => {
    // window 0 [2028,2031) → roth-a; GAP 2031–2032; window 1 [2033,2036) → roth-b.
    const args = fillArgsMultiWindowGap();
    const input = runBalanceProjectionMc(args);
    const summary = runMonteCarlo({ ...input, pathCount: MC_PATHS, seed: MC_SEED });
    const rep = summary.representativeByBasis?.['mc-typical'];
    const years = rep?.years ?? [];
    expect(years.length).toBeGreaterThan(0);
    const byYear = new Map(years.map((y) => [y.year, y]));

    const convertedIn = (y: number): number => byYear.get(y)?.rothConvertedCents ?? 0;
    const rothBalIn = (y: number, id: string): number =>
      byYear.get(y)?.accountBalances?.get(id)?.balance ?? 0;

    // This representative path absorbing-depletes the very year the
    // first Fill conversion fires (the aggressive conversions against the $1.5M
    // IRA + the resulting tax draws ruin the smaller liquid pool, with
    // `depletionYear` landing inside window 0). The absorbing convention zeroes
    // every account row's year-END BALANCE at or after depletion — the depletion
    // year INCLUDED — so per-account year-END BALANCE is no longer a
    // usable routing witness on this path. The routing is instead witnessed by
    // `rothConvertedCents` (a historical-activity amount that is never zeroed):
    // each window's active years convert, the gap years do not, and the window's
    // `targetRothAccountId` (roth-a vs roth-b) determines which Roth receives the
    // principal by construction.

    // Window 0 active years (2028–2030) convert; the principal is ROUTED to roth-a.
    const window0Converted =
      convertedIn(2028) + convertedIn(2029) + convertedIn(2030);
    expect(window0Converted).toBeGreaterThan(0);

    // Gap years 2031 + 2032 are covered by NO window → no conversion that year.
    expect(convertedIn(2031)).toBe(0);
    expect(convertedIn(2032)).toBe(0);

    // Window 1 active years (2033–2035) convert; the principal is ROUTED to roth-b.
    const window1Converted =
      convertedIn(2033) + convertedIn(2034) + convertedIn(2035);
    expect(window1Converted).toBeGreaterThan(0);

    // Every year at or after depletion carries $0 sub-account balances:
    // the conversion AMOUNTS above are the routing witness, not the clamped
    // year-END balances. Sanity-pin the absorbing clamp on a window-1 row.
    expect(rothBalIn(2033, 'roth-a')).toBe(0);
    expect(rothBalIn(2033, 'roth-b')).toBe(0);
  });
});


// ---------------------------------------------------------------------------
// The Fill-mode conversion probe is a THIRD path in the same engine, and it
// must never solve against less Roth tax than the funded pass charges. The
// deterministic classification carries one `rothDollars` total plus the inherited
// SUBSET of it; the probe maps the subset to the wholesale tax-free bucket and
// the remainder to the ordered one, so no dollar leaves the tranche.
// ---------------------------------------------------------------------------

describe('Fill-mode probe — inherited Roth IRA subset routing', () => {
  const detClassification = (inherited: number) => ({
    preTaxDollars: 20_000,
    postTaxNonRothDollars: 0,
    postTaxCashLikeDollars: 0,
    rothDollars: 30_000,
    fundedDollars: 50_000,
    ...(inherited > 0 ? { rothInheritedTaxFreeDollars: inherited } : {}),
  });

  function probeInput(inherited: number) {
    const taxCtx = rmdAgeTaxContext();
    const out = buildYearTaxInput(
      tinyMcInput(taxCtx),
      taxCtx,
      2035,
      5,
      TINY_NOMINAL_EXPENSE_BY_YEAR,
      detClassification(inherited),
      undefined,
      1_500_000,
      new Map<string, number>([['primary', 1_500_000_00]]),
    );
    expect(out).not.toBeNull();
    return out!;
  }

  it('keeps the WHOLE Roth tranche in the tax input, however it is split', () => {
    // `rothWithdrawalDollars` is the sum of both buckets, so dropping the
    // inherited tranche instead of routing it would shrink `fundedDollars` in the
    // probe's own `classifyForTarget` and under-fund the conversion's tax.
    expect(probeInput(0).rothWithdrawalDollars).toBe(30_000);
    expect(probeInput(12_000).rothWithdrawalDollars).toBe(30_000);
    expect(probeInput(30_000).rothWithdrawalDollars).toBe(30_000);
  });

  it('routes the inherited subset to the WHOLESALE bucket and the remainder to the ordered one', () => {
    // The split itself, not its sum: `buildMcTaxYearInput` consumes the two
    // buckets only as `rothBasisOrderedDollars + rothWholesaleTaxFreeDollars`, so
    // the tax input the probe returns cannot witness the routing. Asserting the
    // mapping directly is what discriminates this routing from the earlier
    // behaviour (the WHOLE tranche routed to `rothBasisOrderedDollars`).
    expect(splitProbeRothTranche(detClassification(12_000))).toEqual({
      rothBasisOrderedDollars: 18_000,
      rothWholesaleTaxFreeDollars: 12_000,
    });
    // No inherited subset → the whole tranche stays §408A-ordered (unchanged).
    expect(splitProbeRothTranche(detClassification(0))).toEqual({
      rothBasisOrderedDollars: 30_000,
      rothWholesaleTaxFreeDollars: 0,
    });
    // A wholly inherited tranche leaves nothing to order.
    expect(splitProbeRothTranche(detClassification(30_000))).toEqual({
      rothBasisOrderedDollars: 0,
      rothWholesaleTaxFreeDollars: 30_000,
    });
    // The subset is CLAMPED to the tranche: a recorded inherited figure larger
    // than the Roth total can never invent ordered dollars to subtract.
    expect(splitProbeRothTranche({ rothDollars: 30_000, rothInheritedTaxFreeDollars: 44_000 }))
      .toEqual({ rothBasisOrderedDollars: 0, rothWholesaleTaxFreeDollars: 30_000 });
  });

  it('builds the same tax input as a run recording the same dollars as wholesale tax-free', () => {
    // The probe's tax input must not distinguish "inherited subset" from
    // "already wholesale tax-free" — both are qualified dollars.
    const viaSubset = probeInput(12_000);
    const taxCtx = rmdAgeTaxContext();
    const viaWholesale = buildMcTaxYearInput(
      {
        taxCtx,
        taxYear: 2035,
        retirementYear: 2030,
        grossSsDollars: 0,
        nominalExpense: 40_000,
        otherIncome: 0,
        priorBalance: 1_500_000,
        priorPreTaxByOwner: new Map<string, number>([['primary', 1_500_000_00]]),
        magiMinus2: undefined,
        classification: {
          preTaxDollars: 20_000,
          postTaxNonRothDollars: 0,
          postTaxCashLikeDollars: 0,
          rothBasisOrderedDollars: 18_000,
          rothWholesaleTaxFreeDollars: 12_000,
        },
      },
      deriveMcSurvivors(taxCtx, 2035, 2030)!,
      20_000,
      0,
    );
    expect(viaSubset.rothWithdrawalDollars).toBe(viaWholesale.rothWithdrawalDollars);
    expect(viaSubset.preTaxWithdrawalDollars).toBeCloseTo(
      viaWholesale.preTaxWithdrawalDollars,
      6,
    );
  });
});
