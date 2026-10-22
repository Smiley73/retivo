/** Fill-mode MAGI-cap Roth conversions in the MC strategy path: parity with the deterministic engine and per-path own-CPI deflation. */
import { describe, expect, it } from 'vitest';
import { runBalanceProjection, runBalanceProjectionMc } from './balance-projection-runner';
import { runMonteCarlo, type McBasis } from './monte-carlo';
import type { MagiCapWindowRuntime } from './drawdown-engine-per-account-strategy-helpers';
import {
  applyPerYearTaxForPathWithConversion,
  buildMcTaxYearInput,
  classifyMcWithdrawal,
  deriveMcSurvivors,
  seedMcAggregateRothBasisCarrier,
  type McTaxContext,
} from './monte-carlo-tax';
import { buildMcFillConversionHook } from './monte-carlo-fill-conversion';
import { solveFillConversion } from './tax-cashflow-solver';
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

// Two Fill windows separated by a gap year, each targeting its own Roth: [2028, 2031) to roth-a, gap 2031-2032, [2033, 2036) to roth-b;
// the member retires at 64 (2026), so the windows fall inside the drawdown horizon.
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

function typicalRepresentativeConvertedCents(args: ReturnType<typeof fillArgs>): number {
  const input = runBalanceProjectionMc(args);
  const summary = runMonteCarlo({ ...input, pathCount: MC_PATHS, seed: MC_SEED });
  const run = summary.representativeByBasis?.['mc-typical'];
  return (run?.years ?? []).reduce((sum, y) => sum + (y.rothConvertedCents ?? 0), 0);
}

function deterministicConvertedCents(args: ReturnType<typeof fillArgs>): number {
  return runBalanceProjection(args).drawdownYears.reduce(
    (sum, y) => sum + (y.rothConvertedCents ?? 0),
    0,
  );
}

describe('Monte Carlo — Fill-mode Roth conversions (parity)', () => {
  it('should_model_conversions_on_the_mc_strategy_path_under_fill', () => {
    const input = runBalanceProjectionMc(fillArgs({ capMode: 'fill' }));
    const summary = runMonteCarlo({ ...input, pathCount: MC_PATHS, seed: MC_SEED });
    let converted = 0;
    for (const basis of BASES) {
      for (const y of summary.representativeByBasis?.[basis]?.years ?? []) {
        converted += y.rothConvertedCents ?? 0;
      }
    }
    expect(converted).toBeGreaterThan(0);
    // The per-account Roth year-END balance is no witness here: the aggressive conversions deplete this fixture in the first conversion year and the
    // absorbing convention zeroes every balance from then on, so the never-zeroed `rothConvertedCents` proves the routing.
    const typical = summary.representativeByBasis?.['mc-typical'];
    expect(typical).toBeTruthy();
    const lifetimeConverted = (typical?.years ?? []).reduce(
      (sum, y) => sum + (y.rothConvertedCents ?? 0),
      0,
    );
    expect(lifetimeConverted).toBeGreaterThan(0);
  });

  it('should_not_convert_on_the_mc_path_under_minimize', () => {
    const converted = totalRepresentativeConvertedCents(fillArgs({ capMode: 'minimize' }));
    expect(converted).toBe(0);
  });

  it('should_carry_converted_cents_as_nominal_for_per_path_cpi_deflation', () => {
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
    // The production path posts `MonteCarloInput` to a Web Worker (structured clone); the closure-bearing runtime MAGI-cap config must not ride the input,
    // only the serializable overlay and cap-off year, or every active-cap named-strategy run throws `DataCloneError`.
    const input = runBalanceProjectionMc(fillArgs({ capMode: 'fill' }));
    expect(input.magiCapOverride).toBeDefined();
    expect(input.magiCapOverride?.windows[0].capMode).toBe('fill');
    expect(Array.isArray(input.magiCapWindowBounds)).toBe(true);
    expect(typeof input.magiCapWindowBounds?.[0].startYear).toBe('number');
    expect(typeof input.magiCapWindowBounds?.[0].endYear).toBe('number');
    expect('magiCapConfig' in input).toBe(false);
    expect(() => structuredClone(input)).not.toThrow();
    const cloned = structuredClone(input);
    expect(cloned.magiCapOverride?.windows[0].targetRothAccountId).toBe('roth');
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
    // Regression: the conversion's ordinary income must enter the per-path tax ring so the MC Fill solve is taxed on the same surface as the deterministic
    // engine; an under-taxed conversion over-converts, drifting far above the deterministic total.
    const args = fillArgs({ capMode: 'fill' });
    const detTotal = deterministicConvertedCents(args);
    const mcTotal = typicalRepresentativeConvertedCents(args);
    expect(detTotal).toBeGreaterThan(0);
    expect(mcTotal).toBeGreaterThan(0);
    expect(mcTotal).toBeGreaterThan(detTotal * 0.4);
    expect(mcTotal).toBeLessThan(detTotal * 2.5);
  });

  it('should_charge_irmaa_two_years_after_a_conversion_pushes_magi_over_a_tier', () => {
    // Regression (Y+2): a conversion year's MAGI must advance the per-path ring so the year-(Y+2) IRMAA look-back sees it. The typical path must survive for
    // IRMAA to be stamped, but the base fixture has no MAGI-neutral balance to fund the conversion tax (its brokerage realizes LTCG) and depletes in year one;
    // a cash-like SAVINGS account makes the tax fundable.
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
    // Regression: the conversion tax-input builder must see the same synthetic RMD-floor basis as `fillStrategyYearTax` (a hard-coded 0 is an un-floored surface and
    // over-converts in RMD years). Born 1962 reaches the RMD age within the horizon; a SAVINGS account keeps the path alive to the RMD years.
    const fillBase = fillArgs({ capMode: 'fill' });
    const args = {
      ...fillBase,
      accounts: [...fillBase.accounts, account('cash', 'm1', 'SAVINGS', 'POST_TAX')],
      balances: [...fillBase.balances, balanceRow('cash', 2025, 600_000)],
    };
    const input = runBalanceProjectionMc(args);
    const summary = runMonteCarlo({ ...input, pathCount: MC_PATHS, seed: MC_SEED });
    const years = summary.representativeByBasis?.['mc-typical']?.years ?? [];
    const floorYears = years.filter((y) => (y.rmdFloorCents ?? 0) > 0);
    expect(floorYears.length).toBeGreaterThan(0);
    const detTotal = deterministicConvertedCents(args);
    const mcTotal = years.reduce((sum, y) => sum + (y.rothConvertedCents ?? 0), 0);
    expect(mcTotal).toBeGreaterThan(0);
    expect(mcTotal).toBeLessThan(detTotal * 2.5);
  });
});

function rmdAgeTaxContext(): McTaxContext {
  return {
    taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
    filingStatus: 'Single',
    members: [{ memberId: 'primary', isoBirthdate: '1950-01-01', onMedicare: true, hasAcaCoverage: false }],
    householdSize: 1,
    inflationRatePct: 0,
  };
}

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

const TINY_NOMINAL_EXPENSE_BY_YEAR = new Float64Array(64).fill(40_000);

describe('Monte Carlo — Fill conversion same-year tax is funded ONCE', () => {
  it('should_not_fold_the_current_year_conversion_into_the_funded_same_year_tax', () => {
    // Regression (double funding): the engine funds the conversion's same-year incremental tax from MAGI-neutral post balances, so the expense fold must not
    // also fund it: a conversion year's funded `taxCashflowDollars` equals the withdrawals-only funded tax.
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
    expect(withConv!.result.taxCashflowDollars).toBeCloseTo(noConv!.result.taxCashflowDollars, 6);
    // The MAGI ring sample is conversion-inclusive, so Y+2 IRMAA is funded.
    expect(withConv!.magiInclusiveDollars).toBeGreaterThan(noConv!.result.magiDollars);
    expect(withConv!.result.magiDollars).toBeCloseTo(noConv!.result.magiDollars, 6);
  });
});

describe('Monte Carlo — Fill conversion solve reads the same RMD floor surface as the committed tax', () => {
  const taxCtx = rmdAgeTaxContext();
  const input = tinyMcInput(taxCtx);
  const taxYear = 2035;
  const yearIndex = taxYear - input.retirementYear;
  const ROOM = 500_000;
  const CEILING = 150_000;
  const DRAW = 5_000;

  const hookFor = (extra: Partial<Parameters<typeof buildMcFillConversionHook>[0]> = {}) =>
    buildMcFillConversionHook({
      input,
      magiCapWindows: [
        { startYear: 2030, endYear: 2060, originalIndex: 0, config: { capMode: 'fill' } },
      ] as unknown as ReadonlyArray<MagiCapWindowRuntime>,
      nominalExpenseByYear: TINY_NOMINAL_EXPENSE_BY_YEAR,
      preRetirementYears: 0,
      entryTotalBalance: 1_000_000,
      entryPreTaxByOwner: new Map([['primary', 1_000_000_00]]),
      ...extra,
    })!;
  const converted = (hook: ReturnType<typeof hookFor>): number =>
    hook.solveFillConversionForYear!(
      yearIndex,
      { preTaxDollars: DRAW, postTaxNonRothDollars: 0, postTaxCashLikeDollars: 0, rothDollars: 0, fundedDollars: DRAW },
      ROOM,
      'irmaa',
      CEILING,
    );
  const perYear = <T,>(value: T): T[] => Array.from({ length: yearIndex + 1 }, () => value);

  it('should_solve_against_the_same_pass1_derived_floor_the_committed_tax_is_built_on', () => {
    // Production hands ONE pass-1-derived per-owner pre-tax basis to the conversion solve and the committed tax; a pass-2 basis it never feeds sizes a different floor.
    const pass1 = new Map([['primary', 1_000_000_00]]);
    const pass2 = new Map([['primary', 1_600_000_00]]);
    const committed = buildMcTaxYearInput(
      {
        taxCtx,
        taxYear,
        retirementYear: input.retirementYear,
        grossSsDollars: 0,
        nominalExpense: 40_000,
        otherIncome: 0,
        priorBalance: 1_000_000,
        priorPreTaxByOwner: pass1,
        magiMinus2: undefined,
        classification: {
          preTaxDollars: DRAW,
          postTaxNonRothDollars: 0,
          postTaxCashLikeDollars: 0,
          rothBasisOrderedDollars: 0,
          rothWholesaleTaxFreeDollars: 0,
        },
      },
      deriveMcSurvivors(taxCtx, taxYear, input.retirementYear)!,
      DRAW,
      0,
    );
    const expected = solveFillConversion({
      taxInputBase: committed,
      bundle: taxCtx.taxBundle,
      capMagiLine: 'irmaa',
      magiCeilingDollars: CEILING,
      convertibleRoomDollars: ROOM,
    }).convertedDollars;
    expect(converted(hookFor({ priorPreTaxByOwnerByYearIndex: perYear(pass1) }))).toBe(expected);
    expect(converted(hookFor({ priorPreTaxByOwnerByYearIndex: perYear(pass2) }))).not.toBeCloseTo(expected, 0);
  });

  it('should_size_the_conversion_against_the_qcd_offset_reduced_rmd_floor', () => {
    // A QCD satisfies part of the IRA-pool RMD (IRC §408(d)(8)); a solve that ignored the offset would re-gross it as phantom taxable income and under-convert.
    const offsets = (dollars: number) => perYear(new Map([['primary', dollars * 100]]));
    const base = converted(hookFor());
    expect(converted(hookFor({ qcdRmdOffsetByYearIndex: offsets(10_000) })) - base).toBeCloseTo(10_000, -1);
    // An offset above the whole floor leaves no phantom RMD income: the room of a household with no pre-tax pool.
    expect(converted(hookFor({ qcdRmdOffsetByYearIndex: offsets(10_000_000) }))).toBeCloseTo(
      converted(hookFor({ entryPreTaxByOwner: new Map() })),
      2,
    );
  });
});

describe('Monte Carlo — multi-window MAGI-cap SCHEDULE with a gap year', () => {
  it('applies each window cap + routes conversions to the right Roth, with no cap in the gap year', () => {
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

    // This representative path depletes in the year of the first Fill conversion, and the absorbing convention zeroes per-account year-END balances from then on;
    // `rothConvertedCents`, never zeroed, witnesses the routing.

    const window0Converted =
      convertedIn(2028) + convertedIn(2029) + convertedIn(2030);
    expect(window0Converted).toBeGreaterThan(0);

    expect(convertedIn(2031)).toBe(0);
    expect(convertedIn(2032)).toBe(0);

    const window1Converted =
      convertedIn(2033) + convertedIn(2034) + convertedIn(2035);
    expect(window1Converted).toBeGreaterThan(0);

    expect(rothBalIn(2033, 'roth-a')).toBe(0);
    expect(rothBalIn(2033, 'roth-b')).toBe(0);
  });
});
