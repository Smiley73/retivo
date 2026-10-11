/**
 * Primary-source oracle harness — independently verifies the production
 * federal-tax, Social Security, IRMAA, ACA premium-credit, RMD, Roth and
 * market-stress engines against machine-readable fixtures derived from
 * primary legal/calibration sources.
 * Fixture registry + refresh policy: docs/yearly-tax-refresh.md → "The
 * checked-answer fixtures".
 *
 * INDEPENDENCE CONTRACT: every `oracle*` helper below re-implements the cited
 * statute/publication from the FIXTURE's own statutory parameters — it never
 * imports production calibration constants or reuses production formulas —
 * and every expected value is fixture-loaded (derived in the fixture's
 * `derivation` from the cited source). Each case first proves the independent
 * formula reproduces the fixture's expected value, then COMPARES that
 * expectation against the real engine entry point.
 *
 * The INVESTMENT-COST / MARKET-STRESS comparisons run against
 * `blendedReturnMonthly` (the production fee/return mean-shift) and
 * `resolveStressHorizonYear` / `STRESS_CASES` — the entry points the Balance
 * Projection stress comparison drives.
 *
 * The FILING-PLAN comparisons (the integrated 30-year workbook and the MFS
 * domain) run against `applyTaxYearForFilingPlan` — the per-tax-unit production
 * entry point — driven by units the production resolver
 * (`resolveFilingPlanForYear`) produces, rather than a hand-picked scalar
 * filing status. The MONTHLY-HEALTH comparisons run the rough ACA benchmark
 * through `defaultHouseholdSlcspByAge` (the per-member adapter `applyTaxYear`
 * calls), and the month-aware IRMAA case additionally asserts the identical
 * surcharge coming out of `applyTaxYear` itself.
 *
 * Tolerances (exact and approximation):
 * - exact statutory table lookups, threshold/filing-status selection,
 *   coverage-month counts, RMD divisors, distribution ordering: exact equality;
 * - currency calculations driven only by exact statutory inputs: within $1
 *   after documented rounding;
 * - explicitly approximate components (the rough ACA benchmark): within
 *   $50/year, with direction and assumptions asserted separately.
 */
import { describe, it, expect } from 'vitest';

import acaMedicareFixture from './__fixtures__/retirement-oracle/aca-medicare.json';
import basisFixture from './__fixtures__/retirement-oracle/basis.json';
import blockerFixture from './__fixtures__/retirement-oracle/blocker.json';
import individualFixture from './__fixtures__/retirement-oracle/individual.json';
import marketStressFixture from './__fixtures__/retirement-oracle/market-stress.json';
import integrated30Fixture from './__fixtures__/retirement-oracle/integrated-30-year.json';
import mfsFixture from './__fixtures__/retirement-oracle/mfs.json';
import rmdFixture from './__fixtures__/retirement-oracle/rmd.json';
import rothFixture from './__fixtures__/retirement-oracle/roth.json';
import survivorFixture from './__fixtures__/retirement-oracle/survivor.json';

import { computeFederalTax, type FilingStatus } from './federal-tax';
import { FEDERAL_TAX_CONFIG } from './federal-tax-config';
import { computeSsTaxation } from './ss-taxation';
import { SS_TAX_THRESHOLDS } from './ss-taxation-thresholds';
import { computeIrmaa, computeMonthAwareIrmaa } from './irmaa';
import { IRMAA_TIERS } from './irmaa-tiers';
import {
  AcaPtcInvalidInputError,
  ROUGH_BENCHMARK_ASSUMPTIONS,
  acaPtcEligibleForFilingStatus,
  computeAcaPtc,
  roughHouseholdAnnualBenchmarkCents,
  roughMonthlyBenchmarkCentsForMember,
} from './aca-ptc';
import { ACA_PTC_PARAMETERS } from './aca-ptc-parameters';
import {
  computeDesignatedRothDistribution,
  orderRothIraDistribution,
  type RothConversionLotCents,
} from './roth-distribution-tax';
import {
  computeRmd,
  resolveRmdFirstYearPlan,
  resolveRmdRule,
  rmdFirstYearDeferralPlan,
  rmdTriggerAge,
  stillWorkingExceptionApplies,
  type RmdAccountProfileFacts,
  type RmdAccountType,
  type AccountTaxTreatment,
} from './rmd';
import { RMD_DIVISORS } from './rmd-divisors';
import {
  RMD_LIFE_EXPECTANCY_TABLES,
  selectRmdTableDivisor,
  type RmdTableRequest,
} from './rmd-life-expectancy-tables';
import { blendedReturnMonthly } from './projection-engine/historical';
import {
  STRESS_CASES,
  STRESS_MAX_AGE,
  resolveStressHorizonYear,
} from './market-stress';
import { computeEarningsTest, SSA_EARNINGS_TEST } from './ss-earnings-test';
import {
  survivorBenefitAnnual,
  type DeceasedMember,
  type SurvivorMember,
} from './ss-spousal-survivor';
import { ownClaimBenefitAnnual, spousalExcessAnnual } from './ss-projection-helpers';
import type { SsContextMember } from './ss-projection-types';
import {
  applyTaxYear,
  applyTaxYearForFilingPlan,
  DEFAULT_TAX_CALIBRATION_BUNDLE,
} from './tax-integration';
import type {
  ApplyFilingPlanYearInput,
  TaxMemberInput,
  TaxYearInput,
} from './tax-integration';
import { defaultHouseholdSlcspByAge } from './tax-integration-helpers';
import { resolveFilingPlanForYear } from './filing-status';

/** The calendar year the rough-benchmark oracle prices its members in.
 *  The age-premium curve is year-independent, so any year works; pinning one
 *  keeps the ISO birthdates the production adapter needs reproducible. */
const BENCHMARK_TAX_YEAR = 2026;

// ---------------------------------------------------------------------------
// Tolerances (cents) + fixture access
// ---------------------------------------------------------------------------

/** Currency from exact statutory inputs: within $1 after documented rounding. */
const DOLLAR_CENTS = 100;
/** Explicitly approximate components: within $50/year. */
const APPROX_50_CENTS = 5000;

// Statutory facts used across domains — named once (independent restatements
// of the cited statutes; deliberately NOT imported from production constants).
/** §408A(d)(2)(B) / §408A(d)(4)(B)(ii): the Roth five-TAX-YEAR
 *  qualification/recapture period. */
const ROTH_FIVE_YEAR_CLOCK = 5;
/** 42 U.S.C. §416(l): FRA is 67 (804 months) for anyone born 1960 or later. */
const FRA_MONTHS_BORN_1960_PLUS = 67 * 12;
/** SECURE 2.0 §107: RMD trigger age 75 for owners born 1960 or later. */
const RMD_TRIGGER_AGE_BORN_1960_PLUS = 75;

const expectWithinCents = (actual: number, expected: number, cents: number): void => {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(cents);
};

interface OracleFixture {
  readonly cases: readonly { readonly id: string }[];
}

/** Typed accessor for one fixture case's inputs/expected (fails loudly on a
 *  missing id so a fixture rename can't silently skip its assertions). */
function fixtureCase<I, E>(fx: OracleFixture, id: string): { inputs: I; expected: E } {
  const found = fx.cases.find((c) => c.id === id);
  if (found === undefined) throw new Error(`oracle fixture case not found: ${id}`);
  const c = found as { inputs?: unknown; expected?: unknown };
  return { inputs: c.inputs as I, expected: c.expected as E };
}

// ---------------------------------------------------------------------------
// Independent oracle formulas — implemented from FIXTURE statutory parameters
// only (never from production configs/formulas).
// ---------------------------------------------------------------------------

interface OracleBracket {
  readonly floor: number;
  readonly rate: number;
}

/** Progressive ordinary tax (dollars) — 26 U.S.C. §1 bracket walk over the
 *  fixture's published floors/rates. */
function oracleBracketTaxDollars(taxable: number, brackets: readonly OracleBracket[]): number {
  let tax = 0;
  for (let i = 0; i < brackets.length; i += 1) {
    const ceiling = i + 1 < brackets.length ? brackets[i + 1].floor : Infinity;
    if (taxable <= brackets[i].floor) break;
    tax += (Math.min(taxable, ceiling) - brackets[i].floor) * brackets[i].rate;
  }
  return tax;
}

interface OracleSeniorDeduction {
  readonly perFilerCap: number;
  readonly nonJointPhaseoutBaseMagi: number;
  readonly phaseoutRatePct: number;
}

/** OBBBA §70103 enhanced senior deduction (one non-joint filer 65+):
 *  cap − rate × max(0, MAGI − base), floored at 0. */
function oracleSeniorDeductionDollars(magi: number, cfg: OracleSeniorDeduction): number {
  return Math.max(
    0,
    cfg.perFilerCap - cfg.phaseoutRatePct * Math.max(0, magi - cfg.nonJointPhaseoutBaseMagi),
  );
}

/** 26 U.S.C. §86 taxable Social Security (dollars) from the fixture's base
 *  amounts (`t1` base, `t2` adjusted base). Provisional income per §86(b)(2)
 *  includes the tax-exempt-interest add-back (§86(b)(2)(B)). */
function oracleSsTaxableDollars(
  gross: number,
  otherAgi: number,
  taxExemptInterest: number,
  t1: number,
  t2: number,
): number {
  const pi = otherAgi + taxExemptInterest + 0.5 * gross;
  if (pi <= t1) return 0;
  if (pi <= t2) return Math.min(0.5 * gross, 0.5 * (pi - t1));
  return Math.min(0.85 * gross, 0.85 * (pi - t2) + Math.min(0.5 * (t2 - t1), 0.5 * gross));
}

interface OracleAcaBand {
  readonly fplFloorPct: number;
  readonly fplCeilingPct: number;
  readonly floorPct: number;
  readonly ceilingPct: number;
}

/** §36B applicable figure per the pre-ARPA Form 8962 Worksheet 2 / Table 2
 *  semantics (2020 instructions — the last pre-ARPA edition, whose rules the
 *  2026 cliff reinstates; fixture source `i8962-2020`):
 *    1. household income is compared DIRECTLY with 4 × FPL — strictly greater
 *       → not eligible for the PTC (`null`), BEFORE any rounding/truncation;
 *    2. an eligible household's income ÷ FPL is then rounded DOWN to a whole
 *       percent (Form 8962 line 5);
 *    3. Table 2's figure for that whole percent is the straight-line value
 *       inside the matching band of the fixture's Rev. Proc. table (last band
 *       upper-inclusive), rounded to 4 decimal places like the published table.
 *  Deliberately NOT the production shape: `computeAcaPtc` floors the percent
 *  only for the cliff test and interpolates the RAW percentage — the ordering
 *  difference is what the cliff-sliver known-bug case documents, and the
 *  raw-vs-whole-percent interpolation difference is what the mid-band 177.5%
 *  case pins as an explicit engine-divergence record. */
function oracleAcaApplicableFigure(
  householdIncomeDollars: number,
  fplDollars: number,
  bands: readonly OracleAcaBand[],
): number | null {
  if (householdIncomeDollars > 4 * fplDollars) return null;
  const wholeFplPct = Math.floor((householdIncomeDollars / fplDollars) * 100);
  const band = bands.find(
    (b, i) =>
      wholeFplPct >= b.fplFloorPct &&
      (i === bands.length - 1 ? wholeFplPct <= b.fplCeilingPct : wholeFplPct < b.fplCeilingPct),
  );
  if (band === undefined) throw new Error(`oracle: no ACA band for ${wholeFplPct}% FPL`);
  const rise = band.ceilingPct - band.floorPct;
  if (rise === 0) return band.floorPct;
  const run = band.fplCeilingPct - band.fplFloorPct;
  return Math.round((band.floorPct + (rise * (wholeFplPct - band.fplFloorPct)) / run) * 10_000) / 10_000;
}

interface OracleReductionSchedule {
  readonly firstBlockPerMonth: number;
  readonly firstBlockMonths: number;
  readonly beyondPerMonth: number;
}

/** 42 U.S.C. §402(q) actuarial reduction factor for `monthsEarly` months
 *  before FRA, from the fixture's per-month rates (worker or spousal). */
function oracleReductionFactor(monthsEarly: number, sched: OracleReductionSchedule): number {
  const first = Math.min(monthsEarly, sched.firstBlockMonths);
  const beyond = Math.max(0, monthsEarly - sched.firstBlockMonths);
  return 1 - first * sched.firstBlockPerMonth - beyond * sched.beyondPerMonth;
}

/** Pub 590-B §408A ordering — independent re-implementation over fixture
 *  facts: regular contributions, then conversion years FIFO (taxable before
 *  nontaxable within a year), then earnings; 10% recapture for taxable
 *  conversion principal inside its own five-tax-year window before 59½. */
function oracleRothIraOrdering(args: {
  regularContributionBasisCents: number;
  conversionLots: readonly RothConversionLotCents[];
  withdrawalCents: number;
  distributionTaxYear: number;
  ownerReached59Half: boolean;
  fiveYearClockMet: boolean;
}): {
  regularContributionCents: number;
  conversionTaxablePrincipalCents: number;
  conversionNontaxablePrincipalCents: number;
  earningsCents: number;
  incomeTaxableCents: number;
  additionalTaxBaseCents: number;
} {
  const qualified = args.ownerReached59Half && args.fiveYearClockMet;
  let remaining = args.withdrawalCents;
  const regularContributionCents = Math.min(remaining, args.regularContributionBasisCents);
  remaining -= regularContributionCents;
  let taxable = 0;
  let nontaxable = 0;
  let recapture = 0;
  const years = [...new Set(args.conversionLots.map((l) => l.taxYear))].sort((a, b) => a - b);
  for (const year of years) {
    // A lot dated AFTER the distribution tax year cannot exist yet — it is no
    // part of this distribution's facts (and would otherwise sit "inside" the
    // recapture window via a negative year difference). Skip it entirely.
    if (year > args.distributionTaxYear) continue;
    const lots = args.conversionLots.filter((l) => l.taxYear === year);
    const yearTaxable = lots.reduce((s, l) => s + l.taxableConvertedPrincipalCents, 0);
    const yearNontaxable = lots.reduce((s, l) => s + l.nontaxableConvertedPrincipalCents, 0);
    const takeTaxable = Math.min(remaining, yearTaxable);
    taxable += takeTaxable;
    remaining -= takeTaxable;
    const inWindow = args.distributionTaxYear - year < ROTH_FIVE_YEAR_CLOCK;
    if (takeTaxable > 0 && !args.ownerReached59Half && inWindow) recapture += takeTaxable;
    const takeNontaxable = Math.min(remaining, yearNontaxable);
    nontaxable += takeNontaxable;
    remaining -= takeNontaxable;
  }
  const earningsCents = remaining;
  return {
    regularContributionCents,
    conversionTaxablePrincipalCents: taxable,
    conversionNontaxablePrincipalCents: nontaxable,
    earningsCents,
    incomeTaxableCents: qualified ? 0 : earningsCents,
    additionalTaxBaseCents: qualified
      ? 0
      : recapture + (args.ownerReached59Half ? 0 : earningsCents),
  };
}

// ---------------------------------------------------------------------------
// Shared engine-input builders
// ---------------------------------------------------------------------------

/** Minimal SsContextMember for the SS composition entry points. */
function ssMember(args: {
  id: string;
  birthdate: string;
  piaMonthlyDollars: number;
  claimAge: { ageYears: number; ageMonths: number };
}): SsContextMember {
  return {
    id: args.id,
    payload: {
      isPrimary: args.id === 'primary',
      firstName: args.id,
      lastName: 'oracle',
      email: `${args.id}@example.test`,
      birthdate: args.birthdate,
    },
    pia: args.piaMonthlyDollars,
    claimAge: args.claimAge,
    lifeExpectancyAge: 95,
  };
}

interface SeniorCaseInputs {
  year: number;
  filingStatus: string;
  ordinaryIncome: number;
  taxpayersAge65Plus: number;
}

/** Shared ordinary-income-only federal-tax engine comparison: runs
 *  `computeFederalTax` on one fixture case's inputs and asserts the total tax
 *  within the $1 currency tolerance. Returns the engine result for any extra
 *  per-case assertions (e.g. the marginal-rate check). */
function computeFederalTaxFromCase(
  inputs: SeniorCaseInputs,
  expectedTotalTaxCents: number,
): ReturnType<typeof computeFederalTax> {
  const engine = computeFederalTax(
    {
      year: inputs.year,
      filingStatus: inputs.filingStatus as FilingStatus,
      ordinaryIncome: inputs.ordinaryIncome,
      ltcgAndQdi: 0,
      taxpayersAge65Plus: inputs.taxpayersAge65Plus,
    },
    FEDERAL_TAX_CONFIG,
  );
  expectWithinCents(engine.totalTax, expectedTotalTaxCents, DOLLAR_CENTS);
  return engine;
}

// ===========================================================================
// Domain: individual — senior-deduction boundaries + §86 tiers + SSA earnings test
// ===========================================================================

describe('retirement oracle — individual (senior deduction, 2026)', () => {
  const { statutory } = individualFixture;

  it.each([
    ['senior-full'],
    ['senior-at-base'],
    ['senior-partial'],
    ['senior-eliminated'],
  ])('%s', (id) => {
    const { inputs, expected } = fixtureCase<
      SeniorCaseInputs,
      { seniorDeductionDollars: number; totalTaxCents: number }
    >(individualFixture, id);

    // Independent recomputation from the fixture's statutory parameters.
    const senior = oracleSeniorDeductionDollars(inputs.ordinaryIncome, statutory.seniorDeduction);
    expect(senior).toBe(expected.seniorDeductionDollars);
    const taxable = Math.max(
      0,
      inputs.ordinaryIncome -
        statutory.standardDeductionSingle2026 -
        statutory.age65AddOnSingle2026 -
        senior,
    );
    const independentCents = Math.round(
      oracleBracketTaxDollars(taxable, statutory.singleBrackets2026) * 100,
    );
    expectWithinCents(independentCents, expected.totalTaxCents, 1);

    // Engine comparison.
    computeFederalTaxFromCase(inputs, expected.totalTaxCents);
  });
});

describe('retirement oracle — individual (SSA retirement earnings test, 2026)', () => {
  const { statutory } = individualFixture;

  it('pre-FRA-year annual test: $1 withheld per $2 over the lower exempt amount', () => {
    const { inputs, expected } = fixtureCase<
      {
        year: number;
        isoBirthdate: string;
        earnedIncomeDollars: number;
        grossBenefitDollars: number;
        inflationRatePct: number;
      },
      {
        withheldDollars: number;
        reducedBenefitDollars: number;
        rateApplied: string;
        withheldMonths: number;
        estimated: boolean;
      }
    >(individualFixture, 'earnings-test-pre-fra-annual');

    // Independent: withholding + whole-check count from the SSA rule.
    const excess = Math.max(
      0,
      inputs.earnedIncomeDollars - statutory.earningsTest2026.lowerExemptDollars,
    );
    const independentWithheld = Math.min(inputs.grossBenefitDollars, excess / 2);
    expect(independentWithheld).toBe(expected.withheldDollars);
    const monthlyCheck = inputs.grossBenefitDollars / 12;
    expect(Math.ceil(independentWithheld / monthlyCheck)).toBe(expected.withheldMonths);

    // Engine comparison.
    const engine = computeEarningsTest(inputs, SSA_EARNINGS_TEST);
    expect(engine.withheldDollars).toBe(expected.withheldDollars);
    expect(engine.reducedBenefitDollars).toBe(expected.reducedBenefitDollars);
    expect(engine.rateApplied).toBe(expected.rateApplied);
    expect(engine.withheldMonths).toBe(expected.withheldMonths);
    expect(engine.estimated).toBe(expected.estimated);
  });

  it('grace-year monthly non-service test: the more favorable test wins', () => {
    const { inputs, expected } = fixtureCase<
      {
        year: number;
        isoBirthdate: string;
        earnedIncomeDollars: number;
        grossBenefitDollars: number;
        inflationRatePct: number;
        monthlyEarningsDollars: number[];
        graceYearMonthly: boolean;
      },
      {
        withheldDollars: number;
        reducedBenefitDollars: number;
        rateApplied: string;
        withheldMonths: number;
      }
    >(individualFixture, 'earnings-test-grace-year-monthly');

    // Independent: monthly limit = 1/12 of the annual exempt amount; a service
    // month (earnings above the limit) loses its whole check.
    const monthlyLimit = statutory.earningsTest2026.lowerExemptDollars / 12;
    const serviceMonths = inputs.monthlyEarningsDollars.filter((m) => m > monthlyLimit).length;
    const monthlyCheck = inputs.grossBenefitDollars / 12;
    const monthlyTestWithheld = serviceMonths * monthlyCheck;
    const annualTestWithheld = Math.min(
      inputs.grossBenefitDollars,
      Math.max(0, inputs.earnedIncomeDollars - statutory.earningsTest2026.lowerExemptDollars) / 2,
    );
    const independentWithheld = Math.min(monthlyTestWithheld, annualTestWithheld);
    expect(independentWithheld).toBe(expected.withheldDollars);
    expect(serviceMonths).toBe(expected.withheldMonths);

    // Engine comparison.
    const engine = computeEarningsTest(inputs, SSA_EARNINGS_TEST);
    expect(engine.withheldDollars).toBe(expected.withheldDollars);
    expect(engine.reducedBenefitDollars).toBe(expected.reducedBenefitDollars);
    expect(engine.rateApplied).toBe(expected.rateApplied);
    expect(engine.withheldMonths).toBe(expected.withheldMonths);
  });

  it('FRA-year test: $1 withheld per $3 of pre-FRA-month earnings over the higher exempt amount', () => {
    const { inputs, expected } = fixtureCase<
      {
        year: number;
        isoBirthdate: string;
        fraMonthsFromSsaTable: number;
        earnedIncomeDollars: number;
        grossBenefitDollars: number;
        inflationRatePct: number;
        monthlyEarningsDollars: number[];
      },
      {
        withheldDollars: number;
        reducedBenefitDollars: number;
        rateApplied: string;
        withheldMonths: number;
        estimated: boolean;
      }
    >(individualFixture, 'earnings-test-fra-year');

    // Independent: the FRA calendar frame from the fixture's own SSA-table
    // facts (born 1959 → FRA 66y10m), then the $1-per-$3 FRA-year rule on the
    // dollars actually earned in the pre-FRA months (20 C.F.R. §404.430).
    const birthYear = Number(inputs.isoBirthdate.slice(0, 4));
    const birthMonth0 = Number(inputs.isoBirthdate.slice(5, 7)) - 1;
    const fraAbsMonths = birthYear * 12 + birthMonth0 + inputs.fraMonthsFromSsaTable;
    expect(Math.floor(fraAbsMonths / 12)).toBe(inputs.year); // 2026 IS the FRA year
    const fraMonth0 = fraAbsMonths % 12;
    const preFraEarnings = inputs.monthlyEarningsDollars
      .slice(0, fraMonth0)
      .reduce((sum, m) => sum + m, 0);
    const excess = Math.max(
      0,
      preFraEarnings - statutory.earningsTest2026.higherExemptDollars,
    );
    const monthlyCheck = inputs.grossBenefitDollars / 12;
    // Only the pre-FRA checks are chargeable (the test stops at the FRA month).
    const independentWithheld = Math.min(monthlyCheck * fraMonth0, excess / 3);
    expect(independentWithheld).toBe(expected.withheldDollars);
    expect(Math.ceil(independentWithheld / monthlyCheck)).toBe(expected.withheldMonths);

    // Engine comparison — including the fra-year rate selection.
    const engine = computeEarningsTest(inputs, SSA_EARNINGS_TEST);
    expect(engine.withheldDollars).toBe(expected.withheldDollars);
    expect(engine.reducedBenefitDollars).toBe(expected.reducedBenefitDollars);
    expect(engine.rateApplied).toBe(expected.rateApplied);
    expect(engine.withheldMonths).toBe(expected.withheldMonths);
    expect(engine.estimated).toBe(expected.estimated);
  });

  it('earnings at/below the exempt amount withhold $0 across 0 months', () => {
    const { inputs, expected } = fixtureCase<
      {
        year: number;
        isoBirthdate: string;
        earnedIncomeDollars: number;
        grossBenefitDollars: number;
        inflationRatePct: number;
      },
      {
        withheldDollars: number;
        reducedBenefitDollars: number;
        rateApplied: string;
        withheldMonths: number;
        estimated: boolean;
      }
    >(individualFixture, 'earnings-test-below-exempt');

    // Independent: no excess over the lower exempt amount → nothing withheld.
    expect(
      Math.max(0, inputs.earnedIncomeDollars - statutory.earningsTest2026.lowerExemptDollars),
    ).toBe(0);

    const engine = computeEarningsTest(inputs, SSA_EARNINGS_TEST);
    expect(engine.withheldDollars).toBe(expected.withheldDollars);
    expect(engine.reducedBenefitDollars).toBe(expected.reducedBenefitDollars);
    expect(engine.rateApplied).toBe(expected.rateApplied);
    expect(engine.withheldMonths).toBe(expected.withheldMonths);
    expect(engine.estimated).toBe(expected.estimated);
  });
});

// ===========================================================================
// Domain: individual — §86 Social Security taxation tiers
// ===========================================================================

describe('retirement oracle — §86 taxation tiers (Single, 2026)', () => {
  const { statutory } = individualFixture;

  interface SsTierCaseInputs {
    taxYear: number;
    filingStatus: string;
    grossSsCents: number;
    otherAgiCents: number;
    taxExemptInterestCents: number;
  }

  const runTierCase = (id: string): void => {
    const { inputs, expected } = fixtureCase<
      SsTierCaseInputs,
      { taxableSsCents: number; tier: string }
    >(individualFixture, id);

    // Independent §86 composition from the fixture's statutory base amounts.
    const independent = oracleSsTaxableDollars(
      inputs.grossSsCents / 100,
      inputs.otherAgiCents / 100,
      inputs.taxExemptInterestCents / 100,
      statutory.ssBaseAmountsSingle.tier1,
      statutory.ssBaseAmountsSingle.tier2,
    );
    expectWithinCents(Math.round(independent * 100), expected.taxableSsCents, 1);

    // Engine comparison — tier selection exact, currency within $1.
    const engine = computeSsTaxation(
      { ...inputs, filingStatus: inputs.filingStatus as FilingStatus },
      SS_TAX_THRESHOLDS,
    );
    expectWithinCents(engine.taxableSsCents, expected.taxableSsCents, DOLLAR_CENTS);
    expect(engine.tier).toBe(expected.tier);
  };

  it.each([
    ['ss-none-tier'],
    ['ss-fifty-tier-excess-binds'],
    ['ss-fifty-tier-half-gross-binds'],
  ])('%s', (id) => {
    runTierCase(id);
  });

  it('tax-exempt interest is added back to provisional income (§86(b)(2)(B))', () => {
    runTierCase('ss-fifty-tier-tax-exempt-addback');

    // Negative control: WITHOUT the add-back this household sits below the
    // base amount ($0 taxable, none tier) — a dropped add-back cannot pass.
    const { inputs } = fixtureCase<
      { grossSsCents: number; otherAgiCents: number; taxExemptInterestCents: number },
      { taxableSsCents: number }
    >(individualFixture, 'ss-fifty-tier-tax-exempt-addback');
    expect(inputs.taxExemptInterestCents).toBeGreaterThan(0);
    const withoutAddback = oracleSsTaxableDollars(
      inputs.grossSsCents / 100,
      inputs.otherAgiCents / 100,
      0,
      statutory.ssBaseAmountsSingle.tier1,
      statutory.ssBaseAmountsSingle.tier2,
    );
    expect(withoutAddback).toBe(0);
  });
});

// ===========================================================================
// Domain: integrated 30-year workbook
// ===========================================================================

describe('retirement oracle — integrated 30-year workbook', () => {
  const fx = integrated30Fixture;
  const { statutory, inputs } = fx;

  /** Independent per-year workbook row (cents), re-derived from the fixture's
   *  statutory parameters exactly as the fixture `derivation` documents. */
  function oracleYearRow(taxYear: number): {
    federalTaxCents: number;
    taxableSsCents: number;
    magiCents: number;
    rmdFloorCents: number;
    irmaaSurchargeCents: number;
  } {
    const taxableSs = oracleSsTaxableDollars(
      inputs.grossSsDollars,
      inputs.preTaxWithdrawalDollars,
      0,
      statutory.ssBaseAmountsSingle.tier1,
      statutory.ssBaseAmountsSingle.tier2,
    );
    const ordinary = inputs.preTaxWithdrawalDollars + taxableSs;
    const magi = ordinary;
    const senior =
      taxYear <= statutory.seniorDeduction.lastTaxYear
        ? oracleSeniorDeductionDollars(magi, statutory.seniorDeduction)
        : 0;
    const taxable = Math.max(
      0,
      ordinary - statutory.standardDeductionSingle2026 - statutory.age65AddOnSingle2026 - senior,
    );
    // Age attained in the tax year, from the fixture's own birthdate (no
    // duplicated birth-year literal that could desync from a fixture edit).
    const age = taxYear - Number(inputs.isoBirthdate.slice(0, 4));
    const divisor = (statutory.uniformLifetimeDivisorsByAge as Record<string, number>)[
      String(age)
    ];
    const rmdFloorCents =
      age >= RMD_TRIGGER_AGE_BORN_1960_PLUS && divisor !== undefined
        ? Math.round((inputs.iraBalancePriorYearDollars / divisor) * 100)
        : 0;
    const tier1 = statutory.irmaa2026IndividualTier1MonthlyDollars;
    const irmaaSurchargeCents =
      taxYear >= inputs.irmaaLookbackSuppliedFromYear
        ? Math.round(tier1.partB * 12 * 100) + Math.round(tier1.partD * 12 * 100)
        : 0;
    return {
      federalTaxCents: Math.round(
        oracleBracketTaxDollars(taxable, statutory.singleBrackets2026) * 100,
      ),
      taxableSsCents: Math.round(taxableSs * 100),
      magiCents: Math.round(magi * 100),
      rmdFloorCents,
      irmaaSurchargeCents,
    };
  }

  it('the independent workbook reproduces every fixture row (double-entry check)', () => {
    for (const row of fx.expectedByYear) {
      const derived = oracleYearRow(row.taxYear);
      expectWithinCents(derived.federalTaxCents, row.expected.federalTaxCents, 1);
      expectWithinCents(derived.taxableSsCents, row.expected.taxableSsCents, 1);
      expectWithinCents(derived.magiCents, row.expected.magiCents, 1);
      expectWithinCents(derived.rmdFloorCents, row.expected.rmdFloorCents, 1);
      expect(derived.irmaaSurchargeCents).toBe(row.expected.irmaaSurchargeCents);
    }
  });

  it('the engine matches the workbook within $1/year across all 30 years', () => {
    expect(fx.expectedByYear).toHaveLength(30);
    for (const row of fx.expectedByYear) {
      // The year's tax units come from the PRODUCTION resolver, not a
      // hand-written status — a one-member household with no filing plan and
      // no legacy scalar must resolve to exactly one `Single` unit.
      const resolution = resolveFilingPlanForYear({
        hasSecondaryMember: false,
        primaryAlive: true,
        secondaryAlive: false,
        taxYear: row.taxYear,
      });
      expect(resolution.kind).toBe('resolved');
      const taxUnits = resolution.kind === 'resolved' ? resolution.taxUnits : [];
      expect(taxUnits).toHaveLength(1);
      expect(taxUnits[0].filingStatus).toBe(inputs.filingStatus);
      const yearInput: ApplyFilingPlanYearInput = {
        taxYear: row.taxYear,
        filingStatus: inputs.filingStatus as FilingStatus,
        taxUnits,
        memberIdByRole: { primary: inputs.memberId },
        grossSsDollars: inputs.grossSsDollars,
        preTaxWithdrawalDollars: inputs.preTaxWithdrawalDollars,
        postTaxNonRothWithdrawalDollars: 0,
        rothWithdrawalDollars: 0,
        otherOrdinaryIncomeDollars: 0,
        taxExemptInterestDollars: 0,
        householdSize: inputs.householdSize,
        members: [
          {
            memberId: inputs.memberId,
            isoBirthdate: inputs.isoBirthdate,
            onMedicare: true,
            hasAcaCoverage: false,
          },
        ],
        accounts: [
          {
            id: 'oracle-ira',
            type: 'RETIREMENT_IRA',
            taxTreatment: 'PRE_TAX',
            ownerId: inputs.memberId,
            balancePriorYearDollars: inputs.iraBalancePriorYearDollars,
            withdrawalDollars: inputs.preTaxWithdrawalDollars,
          },
        ],
        magiTwoYearsPriorDollars:
          row.taxYear >= inputs.irmaaLookbackSuppliedFromYear
            ? inputs.irmaaLookbackMagiDollars
            : undefined,
        taxpayersAge65Plus: 1,
      };
      const engine = applyTaxYearForFilingPlan(yearInput, DEFAULT_TAX_CALIBRATION_BUNDLE);

      expectWithinCents(engine.federalTaxCents, row.expected.federalTaxCents, DOLLAR_CENTS);
      expectWithinCents(engine.taxableSsCents, row.expected.taxableSsCents, DOLLAR_CENTS);
      expectWithinCents(engine.magiCents, row.expected.magiCents, DOLLAR_CENTS);
      expectWithinCents(engine.rmdFloorCents, row.expected.rmdFloorCents, DOLLAR_CENTS);
      expectWithinCents(engine.irmaaSurchargeCents, row.expected.irmaaSurchargeCents, DOLLAR_CENTS);
      // Exact classifications (threshold / tier / applicability selection).
      expect(engine.ssTaxationTier).toBe(row.expected.ssTaxationTier);
      expect(engine.irmaaTier).toBe(row.expected.irmaaTier);
      expect(engine.rmdApplicable).toBe(row.expected.rmdApplicable);
      expect(engine.acaPtcSubsidyCents).toBe(0);
    }
  });
});

// ===========================================================================
// Domain: survivor — dual entitlement + RIB-LIM
// ===========================================================================

describe('retirement oracle — survivor / dual entitlement', () => {
  const { statutory } = survivorFixture;

  it('reproduces the POMS RS 00615.020 Method C worked example (workbook check)', () => {
    const { inputs, expected } = fixtureCase<
      {
        spouseBenefitBeforeReduction: number;
        ribBeforeReduction: number;
        impliedRibFactor: number;
        impliedSpousalFactor: number;
      },
      { totalMonthlyDollars: number }
    >(survivorFixture, 'poms-method-c-worked-example');
    // Independent composition: reduced RIB + separately reduced excess.
    const total =
      inputs.ribBeforeReduction * inputs.impliedRibFactor +
      (inputs.spouseBenefitBeforeReduction - inputs.ribBeforeReduction) *
        inputs.impliedSpousalFactor;
    expect(total).toBe(expected.totalMonthlyDollars);
    // The incorrect larger-of method does NOT reproduce the POMS figure.
    const largerOf = Math.max(
      inputs.ribBeforeReduction * inputs.impliedRibFactor,
      inputs.spouseBenefitBeforeReduction * inputs.impliedSpousalFactor,
    );
    expect(largerOf).not.toBe(expected.totalMonthlyDollars);
  });

  it('dual entitlement: reduced worker benefit plus separately reduced spousal excess', () => {
    const { inputs, expected } = fixtureCase<
      {
        recipient: {
          piaMonthlyDollars: number;
          birthdate: string;
          claimAge: { ageYears: number; ageMonths: number };
        };
        worker: {
          piaMonthlyDollars: number;
          birthdate: string;
          claimAge: { ageYears: number; ageMonths: number };
        };
        effectiveRecipientAgeMonths: number;
      },
      {
        ownAnnualDollars: number;
        spousalExcessAnnualDollars: number;
        totalAnnualDollars: number;
        incorrectLargerOfAnnualDollars: number;
      }
    >(survivorFixture, 'dual-entitlement-separate-reduction');

    // Independent: 60 months early against both fixture reduction schedules
    // (both members born after 1960 → statutory FRA 67).
    const monthsEarly = FRA_MONTHS_BORN_1960_PLUS - inputs.effectiveRecipientAgeMonths;
    const ownIndependent =
      inputs.recipient.piaMonthlyDollars *
      oracleReductionFactor(monthsEarly, statutory.workerReduction) *
      12;
    expectWithinCents(ownIndependent * 100, expected.ownAnnualDollars * 100, 1);
    const excessIndependent =
      Math.max(
        0,
        statutory.spousalPiaFraction * inputs.worker.piaMonthlyDollars -
          inputs.recipient.piaMonthlyDollars,
      ) *
      oracleReductionFactor(monthsEarly, statutory.spousalReduction) *
      12;
    expectWithinCents(excessIndependent * 100, expected.spousalExcessAnnualDollars * 100, 1);

    // Engine comparison.
    const recipient = ssMember({ id: 'primary', ...inputs.recipient });
    const worker = ssMember({ id: 'secondary', ...inputs.worker });
    const ownEngine = ownClaimBenefitAnnual(recipient, 1);
    const excessEngine = spousalExcessAnnual(
      recipient,
      worker,
      1,
      inputs.effectiveRecipientAgeMonths,
    );
    expectWithinCents(ownEngine * 100, expected.ownAnnualDollars * 100, DOLLAR_CENTS);
    expectWithinCents(excessEngine * 100, expected.spousalExcessAnnualDollars * 100, DOLLAR_CENTS);
    expectWithinCents(
      (ownEngine + excessEngine) * 100,
      expected.totalAnnualDollars * 100,
      DOLLAR_CENTS,
    );
    // The incorrect larger-of composition must NOT be what the engine pays.
    expect(
      Math.abs(ownEngine + excessEngine - expected.incorrectLargerOfAnnualDollars),
    ).toBeGreaterThan(1);
  });

  it('RIB-LIM caps the widow(er) benefit at max(82.5% of PIA, deceased reduced RIB)', () => {
    const { inputs, expected } = fixtureCase<
      {
        survivor: SurvivorMember;
        deceased: {
          piaMonthlyDollars: number;
          fraMonths: number;
          scenarioClaimAgeMonths: number;
          deathAgeMonths: number;
          deathYear: number;
          colaAnchorYear: number;
        };
        currentYear: number;
        colaPct: number;
        deceasedWithheldMonths: number;
      },
      { survivorAnnualDollars: number; ribLimCapMonthlyDollars: number }
    >(survivorFixture, 'rib-lim-early-claiming-deceased');

    // Independent: widow base = full PIA (deceased claimed early); no survivor
    // early reduction at survivor FRA; RIB-LIM cap per POMS RS 00615.320.
    const pia = inputs.deceased.piaMonthlyDollars;
    const monthsEarly = inputs.deceased.fraMonths - inputs.deceased.scenarioClaimAgeMonths;
    const deceasedReducedRib = pia * oracleReductionFactor(monthsEarly, statutory.workerReduction);
    const cap = Math.max(statutory.ribLimPiaFraction * pia, deceasedReducedRib);
    expectWithinCents(cap * 100, expected.ribLimCapMonthlyDollars * 100, 1);
    const independentAnnual = Math.min(pia, cap) * 12;
    expectWithinCents(independentAnnual * 100, expected.survivorAnnualDollars * 100, 1);

    // Engine comparison.
    const deceased: DeceasedMember = { ...inputs.deceased, pia };
    const engine = survivorBenefitAnnual(
      inputs.survivor,
      deceased,
      inputs.currentYear,
      inputs.colaPct,
      inputs.deceasedWithheldMonths,
    );
    expect(engine).not.toBeNull();
    expectWithinCents((engine ?? 0) * 100, expected.survivorAnnualDollars * 100, DOLLAR_CENTS);
  });
});

// ===========================================================================
// Domain: MFS
// ===========================================================================

describe('retirement oracle — married filing separately', () => {
  const { statutory } = mfsFixture;

  it('MFS gets NO senior deduction and the married age-65 add-on (§70103)', () => {
    const { inputs, expected } = fixtureCase<SeniorCaseInputs, { totalTaxCents: number }>(
      mfsFixture,
      'mfs-senior-deduction-zero',
    );

    // Independent: senior deduction is $0 by statute for MFS.
    const taxable = Math.max(
      0,
      inputs.ordinaryIncome - statutory.standardDeductionMfs2026 - statutory.age65AddOnMarried2026,
    );
    const independentCents = Math.round(
      oracleBracketTaxDollars(taxable, statutory.mfsBrackets2026) * 100,
    );
    expectWithinCents(independentCents, expected.totalTaxCents, 1);

    computeFederalTaxFromCase(inputs, expected.totalTaxCents);
  });

  it('MFS ordinary brackets are half the joint amounts (§1(j)(2))', () => {
    const { inputs, expected } = fixtureCase<
      SeniorCaseInputs,
      { totalTaxCents: number; marginalOrdinaryRate: number }
    >(mfsFixture, 'mfs-bracket-half-of-joint');

    const taxable = inputs.ordinaryIncome - statutory.standardDeductionMfs2026;
    const independentCents = Math.round(
      oracleBracketTaxDollars(taxable, statutory.mfsBrackets2026) * 100,
    );
    expectWithinCents(independentCents, expected.totalTaxCents, 1);

    const engine = computeFederalTaxFromCase(inputs, expected.totalTaxCents);
    expect(engine.marginalOrdinaryRate).toBe(expected.marginalOrdinaryRate);
  });

  it('MFS lived-with-spouse §86 base amounts are zero (85% tier from the first dollar)', () => {
    const { inputs, expected } = fixtureCase<
      {
        taxYear: number;
        filingStatus: string;
        mfsLivedWithSpouse: boolean;
        grossSsCents: number;
        otherAgiCents: number;
        taxExemptInterestCents: number;
      },
      { taxableSsCents: number; tier: string }
    >(mfsFixture, 'mfs-ss-lived-together-zero-base');

    // Independent: both base amounts $0 per §86(c)(1)(C)(ii).
    const independent = oracleSsTaxableDollars(
      inputs.grossSsCents / 100,
      inputs.otherAgiCents / 100,
      inputs.taxExemptInterestCents / 100,
      0,
      0,
    );
    expectWithinCents(Math.round(independent * 100), expected.taxableSsCents, 1);

    const engine = computeSsTaxation(
      { ...inputs, filingStatus: inputs.filingStatus as FilingStatus },
      SS_TAX_THRESHOLDS,
    );
    expectWithinCents(engine.taxableSsCents, expected.taxableSsCents, DOLLAR_CENTS);
    expect(engine.tier).toBe(expected.tier);
  });

  it.each([['mfs-irmaa-lived-with-spouse'], ['mfs-irmaa-lived-apart']])(
    '%s uses the CMS-published schedule exactly',
    (id) => {
      const { inputs, expected } = fixtureCase<
        {
          taxYear: number;
          filingStatus: string;
          mfsLivedWithSpouse: boolean;
          magiTwoYearsPriorCents: number;
          beneficiariesOnMedicareCount: 0 | 1 | 2;
        },
        {
          totalHouseholdAnnualCents: number;
          partBAnnualCentsPerBeneficiary?: number;
          partDAnnualCentsPerBeneficiary?: number;
        }
      >(mfsFixture, id);

      // Independent: the CMS monthly dollars from the fixture, annualized. The
      // threshold-selection check proves the fixture MAGI is inside the cited
      // band before the surcharge is derived from it.
      const magiDollars = inputs.magiTwoYearsPriorCents / 100;
      const schedule = inputs.mfsLivedWithSpouse
        ? statutory.irmaa2026MfsLivedWith.middleBand
        : statutory.irmaa2026IndividualTier1;
      if (inputs.mfsLivedWithSpouse) {
        expect(magiDollars).toBeGreaterThan(statutory.irmaa2026MfsLivedWith.noSurchargeAtOrBelow);
        expect(magiDollars).toBeLessThan(statutory.irmaa2026MfsLivedWith.topThreshold);
      } else {
        expect(magiDollars).toBeGreaterThan(statutory.irmaa2026IndividualTier1.over);
        expect(magiDollars).toBeLessThanOrEqual(statutory.irmaa2026IndividualTier1.upTo);
      }
      const independent =
        Math.round(schedule.partBMonthly * 12 * 100) +
        Math.round(schedule.partDMonthly * 12 * 100);
      expect(independent * inputs.beneficiariesOnMedicareCount).toBe(
        expected.totalHouseholdAnnualCents,
      );

      // Engine comparison — exact statutory table lookup.
      const engine = computeIrmaa(
        { ...inputs, filingStatus: inputs.filingStatus as FilingStatus },
        IRMAA_TIERS,
      );
      expect(engine.totalHouseholdAnnualCents).toBe(expected.totalHouseholdAnnualCents);
      if (expected.partBAnnualCentsPerBeneficiary !== undefined) {
        expect(engine.partBSurchargeCentsPerBeneficiary).toBe(
          expected.partBAnnualCentsPerBeneficiary,
        );
        expect(engine.partDSurchargeCentsPerBeneficiary).toBe(
          expected.partDAnnualCentsPerBeneficiary,
        );
      }
    },
  );

  it('MFS is ineligible for the ACA PTC and the engine refuses MFS outright', () => {
    const { expected } = fixtureCase<{ filingStatus: string }, { eligible: boolean; annualPtcCents: number }>(
      mfsFixture,
      'mfs-aca-ptc-zero',
    );
    expect(acaPtcEligibleForFilingStatus('MFS')).toBe(expected.eligible);
    expect(expected.annualPtcCents).toBe(0);
    expect(() =>
      computeAcaPtc(
        {
          taxYear: 2026,
          filingStatus: 'MFS',
          householdSize: 2,
          magiCents: 4_000_000,
          benchmarkAnnualSlcspCents: 720_000,
        },
        ACA_PTC_PARAMETERS,
      ),
    ).toThrow(AcaPtcInvalidInputError);
  });

  // -------------------------------------------------------------------------
  // Production entry point: the SAME fixture expectations, compared against
  // `applyTaxYearForFilingPlan` driven by
  // units the production resolver emits for a `separate` filing plan. Nothing
  // about the independent derivations or the tolerances changes — only which
  // engine surface answers.
  // -------------------------------------------------------------------------

  /** Production units for a `separate` (MFS) couple, straight from the
   *  resolver — never a hand-written unit list. */
  function separateMfsUnits(taxYear: number): ReturnType<typeof resolveFilingPlanForYear> {
    return resolveFilingPlanForYear({
      taxFilingPlan: {
        kind: 'separate',
        livedTogether: true,
        units: [
          { memberId: 'primary', filingStatus: 'MFS', householdSize: 1 },
          { memberId: 'secondary', filingStatus: 'MFS', householdSize: 1 },
        ],
      },
      hasSecondaryMember: true,
      primaryAlive: true,
      secondaryAlive: true,
      taxYear,
    });
  }

  it('the production path resolves a separate plan into two MFS tax units', () => {
    const resolution = separateMfsUnits(2026);
    expect(resolution.kind).toBe('resolved');
    const units = resolution.kind === 'resolved' ? resolution.taxUnits : [];
    expect(units).toHaveLength(2);
    expect(units.map((u) => u.filingStatus)).toEqual(['MFS', 'MFS']);
    expect(units.map((u) => u.householdSize)).toEqual([1, 1]);
  });

  it('the production path applies the §86 zero base to a lived-together MFS unit', () => {
    const { inputs, expected } = fixtureCase<
      {
        taxYear: number;
        filingStatus: string;
        mfsLivedWithSpouse: boolean;
        grossSsCents: number;
        otherAgiCents: number;
        taxExemptInterestCents: number;
      },
      { taxableSsCents: number; tier: string }
    >(mfsFixture, 'mfs-ss-lived-together-zero-base');

    // Drive ONE MFS unit through the production entry point with the fixture's
    // own income; the household figures are doubled so the even-split
    // apportionment across the two units hands each unit the fixture case.
    const resolution = separateMfsUnits(inputs.taxYear);
    const units = resolution.kind === 'resolved' ? resolution.taxUnits : [];
    const yearInput: ApplyFilingPlanYearInput = {
      taxYear: inputs.taxYear,
      filingStatus: 'MFJ',
      taxUnits: units,
      memberIdByRole: { primary: 'mfs-primary', secondary: 'mfs-secondary' },
      mfsLivedWithSpouse: inputs.mfsLivedWithSpouse,
      grossSsDollars: (inputs.grossSsCents / 100) * 2,
      grossSsDollarsByMemberId: {
        'mfs-primary': inputs.grossSsCents / 100,
        'mfs-secondary': inputs.grossSsCents / 100,
      },
      preTaxWithdrawalDollars: 0,
      postTaxNonRothWithdrawalDollars: 0,
      rothWithdrawalDollars: 0,
      otherOrdinaryIncomeDollars: (inputs.otherAgiCents / 100) * 2,
      taxExemptInterestDollars: 0,
      householdSize: 2,
      members: [
        { memberId: 'mfs-primary', isoBirthdate: '1970-06-01', onMedicare: false, hasAcaCoverage: false },
        { memberId: 'mfs-secondary', isoBirthdate: '1971-08-01', onMedicare: false, hasAcaCoverage: false },
      ],
      accounts: [],
      taxpayersAge65Plus: 0,
    };
    const engine = applyTaxYearForFilingPlan(yearInput, DEFAULT_TAX_CALIBRATION_BUNDLE);
    // Household taxable SS = both units' zero-base results.
    expectWithinCents(engine.taxableSsCents, expected.taxableSsCents * 2, DOLLAR_CENTS);
    expect(engine.ssTaxationTier).toBe(expected.tier);
  });

  it('the production path emits $0 PTC for an MFS unit instead of throwing', () => {
    const { expected } = fixtureCase<{ filingStatus: string }, { eligible: boolean; annualPtcCents: number }>(
      mfsFixture,
      'mfs-aca-ptc-zero',
    );
    const resolution = separateMfsUnits(2026);
    const units = resolution.kind === 'resolved' ? resolution.taxUnits : [];
    const yearInput: ApplyFilingPlanYearInput = {
      taxYear: 2026,
      filingStatus: 'MFJ',
      taxUnits: units,
      memberIdByRole: { primary: 'mfs-primary', secondary: 'mfs-secondary' },
      mfsLivedWithSpouse: true,
      grossSsDollars: 0,
      preTaxWithdrawalDollars: 0,
      postTaxNonRothWithdrawalDollars: 0,
      rothWithdrawalDollars: 0,
      otherOrdinaryIncomeDollars: 80_000,
      taxExemptInterestDollars: 0,
      householdSize: 2,
      // Both members carry Marketplace coverage AND an explicit benchmark, so
      // only the statutory §36B(c)(1)(C) gate can zero the credit.
      members: [
        { memberId: 'mfs-primary', isoBirthdate: '1970-06-01', onMedicare: false, hasAcaCoverage: true },
        { memberId: 'mfs-secondary', isoBirthdate: '1971-08-01', onMedicare: false, hasAcaCoverage: true },
      ],
      accounts: [],
      acaBenchmarkSlcspDollars: 14_400,
      taxpayersAge65Plus: 0,
    };
    const engine = applyTaxYearForFilingPlan(yearInput, DEFAULT_TAX_CALIBRATION_BUNDLE);
    expect(engine.acaPtcSubsidyCents).toBe(expected.annualPtcCents);
    expect(expected.eligible).toBe(false);
  });

  it('the production path tiers IRMAA on the look-back MFS return and its living arrangement', () => {
    const { inputs, expected } = fixtureCase<
      {
        taxYear: number;
        filingStatus: string;
        mfsLivedWithSpouse: boolean;
        magiTwoYearsPriorCents: number;
        beneficiariesOnMedicareCount: 0 | 1 | 2;
      },
      { totalHouseholdAnnualCents: number }
    >(mfsFixture, 'mfs-irmaa-lived-with-spouse');

    // ONE surviving MFS unit so the household total equals the fixture's
    // single-beneficiary schedule exactly (no even split to undo).
    const yearInput: ApplyFilingPlanYearInput = {
      taxYear: inputs.taxYear,
      filingStatus: 'Single',
      taxUnits: [{ memberIds: ['primary'], filingStatus: 'MFS', householdSize: 1 }],
      memberIdByRole: { primary: 'mfs-primary' },
      irmaaLookbackFilingStatus: 'MFS',
      irmaaLookbackMfsLivedWithSpouse: inputs.mfsLivedWithSpouse,
      grossSsDollars: 0,
      preTaxWithdrawalDollars: 0,
      postTaxNonRothWithdrawalDollars: 0,
      rothWithdrawalDollars: 0,
      otherOrdinaryIncomeDollars: 0,
      taxExemptInterestDollars: 0,
      householdSize: 1,
      members: [
        { memberId: 'mfs-primary', isoBirthdate: '1955-06-01', onMedicare: true, hasAcaCoverage: false },
      ],
      accounts: [],
      magiTwoYearsPriorDollars: inputs.magiTwoYearsPriorCents / 100,
      taxpayersAge65Plus: 1,
    };
    const engine = applyTaxYearForFilingPlan(yearInput, DEFAULT_TAX_CALIBRATION_BUNDLE);
    expect(engine.irmaaSurchargeCents).toBe(expected.totalHouseholdAnnualCents);
  });
});

// ===========================================================================
// Domain: ACA / Medicare
// ===========================================================================

interface AcaPtcCaseInputs {
  taxYear: number;
  filingStatus: string;
  householdSize: number;
  magiCents: number;
  benchmarkAnnualSlcspCents: number;
}

describe('retirement oracle — ACA / Medicare', () => {
  const { statutory } = acaMedicareFixture;

  it.each([
    ['ptc-2026-at-200pct-fpl'],
    ['ptc-2026-at-400pct-fpl'],
  ])('%s follows the Rev. Proc. 2025-25 table', (id) => {
    const { inputs, expected } = fixtureCase<
      AcaPtcCaseInputs,
      { annualPtcCents: number; applicableFigurePct: number; tier: string; fplPercentage: number }
    >(acaMedicareFixture, id);

    // Independent: raw-income eligibility + whole-percent Table 2 figure per
    // the Worksheet 2 semantics, from the fixture FPL + table only.
    const fplPct = (inputs.magiCents / 100 / statutory.fpl2026Single) * 100;
    expect(fplPct).toBeCloseTo(expected.fplPercentage, 6);
    const figure = oracleAcaApplicableFigure(
      inputs.magiCents / 100,
      statutory.fpl2026Single,
      statutory.applicablePercentageTable2026,
    );
    if (figure === null) throw new Error(`oracle: ${id} unexpectedly over the 400% cliff`);
    expect(figure).toBe(expected.applicableFigurePct);
    const independentPtc = Math.max(
      0,
      inputs.benchmarkAnnualSlcspCents - Math.round(inputs.magiCents * figure),
    );
    expectWithinCents(independentPtc, expected.annualPtcCents, 1);

    // Engine comparison.
    const engine = computeAcaPtc(
      { ...inputs, filingStatus: inputs.filingStatus as FilingStatus },
      ACA_PTC_PARAMETERS,
    );
    expectWithinCents(engine.annualPtcCents, expected.annualPtcCents, DOLLAR_CENTS);
    expect(engine.applicableFigurePct).toBe(expected.applicableFigurePct);
    expect(engine.tier).toBe(expected.tier);
  });

  it('mid-band 177.5% FPL: Table 2 truncates to a whole percent BEFORE interpolating — the raw-percentage answer differs and is pinned as a documented engine divergence', () => {
    // The raw FPL percentage must sit MATERIALLY
    // between two whole percents so the correct truncate-then-interpolate
    // answer (floor(177.5) = 177 → 0.0549) and the truncation-skipped
    // raw-percentage answer (177.5 → 0.0552) round to DIFFERENT published-
    // table figures — at 177.00006% both paths would round to
    // 0.0549, so a truncation regression could not be caught. Production
    // `aca-ptc.ts` deliberately interpolates the RAW percentage (a smoothing
    // approximation), so its divergent output is
    // knowingly pinned under `expectedCurrentEngine`; if production ever
    // adopts the whole-percent Table 2 lookup, those pins fail loudly and
    // this case flips to a normal agreement case.
    const found = acaMedicareFixture.cases.find((c) => c.id === 'ptc-2026-mid-band-interpolated');
    if (found === undefined) throw new Error('oracle fixture case not found: ptc-2026-mid-band-interpolated');
    const { inputs, expected, expectedCurrentEngine } = found as unknown as {
      inputs: AcaPtcCaseInputs;
      expected: { annualPtcCents: number; applicableFigurePct: number; tier: string; fplPercentage: number };
      expectedCurrentEngine: { annualPtcCents: number; applicableFigurePct: number; tier: string };
    };

    const fplPct = (inputs.magiCents / 100 / statutory.fpl2026Single) * 100;
    expect(fplPct).toBeCloseTo(expected.fplPercentage, 6);
    // Guard the fixture itself against regressing to a near-whole percent
    // where both approaches agree again.
    expect(fplPct - Math.floor(fplPct)).toBeCloseTo(0.5, 6);

    // Oracle (CORRECT Form 8962 line 5 / Table 2): floor to 177, THEN
    // interpolate inside the fixture's 150-200 band.
    const figure = oracleAcaApplicableFigure(
      inputs.magiCents / 100,
      statutory.fpl2026Single,
      statutory.applicablePercentageTable2026,
    );
    if (figure === null) throw new Error('oracle: mid-band case unexpectedly over the 400% cliff');
    expect(figure).toBe(expected.applicableFigurePct);
    const independentPtc = Math.max(
      0,
      inputs.benchmarkAnnualSlcspCents - Math.round(inputs.magiCents * figure),
    );
    expectWithinCents(independentPtc, expected.annualPtcCents, 1);

    // Negative control — what a truncation-SKIPPED oracle would produce:
    // interpolating the raw 177.5% in the same fixture band. It must equal
    // the engine's figure and DIFFER from the oracle's, proving the `figure`
    // assertion above can only be satisfied by truncate-then-interpolate.
    const rawBand = statutory.applicablePercentageTable2026.find(
      (b) => fplPct >= b.fplFloorPct && fplPct < b.fplCeilingPct,
    );
    if (rawBand === undefined) throw new Error('oracle: no raw-percentage band for the mid-band case');
    const truncationSkippedFigure =
      Math.round(
        (rawBand.floorPct +
          ((rawBand.ceilingPct - rawBand.floorPct) * (fplPct - rawBand.fplFloorPct)) /
            (rawBand.fplCeilingPct - rawBand.fplFloorPct)) *
          10_000,
      ) / 10_000;
    expect(truncationSkippedFigure).toBe(expectedCurrentEngine.applicableFigurePct);
    expect(truncationSkippedFigure).not.toBe(expected.applicableFigurePct);

    // Engine (raw-percentage interpolation, knowingly asserted).
    const engine = computeAcaPtc(
      { ...inputs, filingStatus: inputs.filingStatus as FilingStatus },
      ACA_PTC_PARAMETERS,
    );
    expect(engine.tier).toBe(expectedCurrentEngine.tier);
    expect(engine.applicableFigurePct).toBe(expectedCurrentEngine.applicableFigurePct);
    expect(engine.annualPtcCents).toBe(expectedCurrentEngine.annualPtcCents);
    // The two records MUST disagree by the documented $8.34 (the engine's
    // raw interpolation understates the subsidy here); if they converge, the
    // production behavior changed — retire the pin and merge the records.
    expect(expected.annualPtcCents - expectedCurrentEngine.annualPtcCents).toBe(834);
  });

  it('above 401% FPL the 2026 cliff makes the household ineligible (exact)', () => {
    const { inputs, expected } = fixtureCase<
      AcaPtcCaseInputs,
      { annualPtcCents: number; tier: string; eligible: boolean }
    >(acaMedicareFixture, 'ptc-2026-above-400pct-cliff');

    // Independent: Worksheet 2 — raw income above 4 × FPL → ineligible.
    const figure = oracleAcaApplicableFigure(
      inputs.magiCents / 100,
      statutory.fpl2026Single,
      statutory.applicablePercentageTable2026,
    );
    expect(figure).toBeNull();

    const engine = computeAcaPtc(
      { ...inputs, filingStatus: inputs.filingStatus as FilingStatus },
      ACA_PTC_PARAMETERS,
    );
    expect(engine.annualPtcCents).toBe(expected.annualPtcCents);
    expect(engine.tier).toBe(expected.tier);
    expect(engine.eligible).toBe(expected.eligible);
  });

  it('KNOWN BUG (needs-human): the (400%, 401%) FPL sliver stays subsidized — asserting CURRENT (incorrect) production behavior pending a separate fix', () => {
    // Production `aca-ptc.ts` floors the FPL percent
    // BEFORE the >400% cliff comparison, but Form 8962 Worksheet 2 (fixture
    // source i8962-2020) compares raw household income with 4 × FPL first —
    // truncation happens only for the Table 2 lookup of an ELIGIBLE household.
    // Households at 400.01–400.99% FPL are therefore wrongly subsidized. This
    // is a known limitation of the production engine; this test pins the
    // divergence so it stays visible: it asserts today's INCORRECT engine
    // output against `expectedCurrentEngine` and the oracle's CORRECT
    // Worksheet 2 answer against `expectedCorrect`. When the production bug is
    // fixed, this test fails loudly and the case flips to a normal cliff case.
    const found = acaMedicareFixture.cases.find((c) => c.id === 'ptc-2026-cliff-sliver-known-bug');
    if (found === undefined) throw new Error('oracle fixture case not found: ptc-2026-cliff-sliver-known-bug');
    const { inputs, expectedCorrect, expectedCurrentEngine } = found as unknown as {
      inputs: AcaPtcCaseInputs;
      expectedCorrect: { annualPtcCents: number; eligible: boolean };
      expectedCurrentEngine: {
        annualPtcCents: number;
        applicableFigurePct: number;
        tier: string;
        eligible: boolean;
      };
    };

    // The case must sit strictly inside the divergent sliver (400%, 401%).
    const fplPct = (inputs.magiCents / 100 / statutory.fpl2026Single) * 100;
    expect(fplPct).toBeGreaterThan(400);
    expect(fplPct).toBeLessThan(401);

    // Oracle (CORRECT per Form 8962 Worksheet 2): raw income > 4 × FPL →
    // ineligible, $0 PTC.
    expect(inputs.magiCents / 100).toBeGreaterThan(4 * statutory.fpl2026Single);
    const figure = oracleAcaApplicableFigure(
      inputs.magiCents / 100,
      statutory.fpl2026Single,
      statutory.applicablePercentageTable2026,
    );
    expect(figure).toBeNull();
    expect(expectedCorrect.eligible).toBe(false);
    expect(expectedCorrect.annualPtcCents).toBe(0);

    // Engine (INCORRECT current production behavior, knowingly asserted): the
    // floored cliff test keeps the household eligible at the top band's rate.
    const engine = computeAcaPtc(
      { ...inputs, filingStatus: inputs.filingStatus as FilingStatus },
      ACA_PTC_PARAMETERS,
    );
    expect(engine.eligible).toBe(expectedCurrentEngine.eligible);
    expect(engine.tier).toBe(expectedCurrentEngine.tier);
    expect(engine.applicableFigurePct).toBe(expectedCurrentEngine.applicableFigurePct);
    expect(engine.annualPtcCents).toBe(expectedCurrentEngine.annualPtcCents);
    // The two records MUST disagree — if they ever converge, the bug was fixed
    // and this pin (plus the fixture case) must be retired.
    expect(engine.eligible).not.toBe(expectedCorrect.eligible);
    expect(engine.annualPtcCents).not.toBe(expectedCorrect.annualPtcCents);
  });

  it('one SS household, two MAGIs: federal MAGI carries only §86-taxable SS; ACA MAGI adds back the full benefit (§36B(d)(2)(B))', () => {
    const { inputs, expected } = fixtureCase<
      {
        taxYear: number;
        filingStatus: string;
        householdSize: number;
        memberId: string;
        isoBirthdate: string;
        grossSsDollars: number;
        preTaxWithdrawalDollars: number;
        acaBenchmarkSlcspDollars: number;
      },
      {
        taxableSsCents: number;
        ssTaxationTier: string;
        federalMagiCents: number;
        acaMagiCents: number;
        fplPercentage: number;
        acaPtcSubsidyCents: number;
        acaPtcTier: string;
        conflatedFederalMagiPtcCents: number;
      }
    >(acaMedicareFixture, 'ss-add-back-two-magis');

    // Independent workbook — BOTH MAGIs from the fixture's stated gross SS,
    // via the §86 composition and the §36B(d)(2)(B) nontaxable add-back.
    const taxableSs = oracleSsTaxableDollars(
      inputs.grossSsDollars,
      inputs.preTaxWithdrawalDollars,
      0,
      statutory.ssBaseAmountsSingle.tier1,
      statutory.ssBaseAmountsSingle.tier2,
    );
    expectWithinCents(Math.round(taxableSs * 100), expected.taxableSsCents, 1);
    const federalMagi = inputs.preTaxWithdrawalDollars + taxableSs;
    expectWithinCents(Math.round(federalMagi * 100), expected.federalMagiCents, 1);
    const acaMagi = federalMagi + (inputs.grossSsDollars - taxableSs);
    expectWithinCents(Math.round(acaMagi * 100), expected.acaMagiCents, 1);
    const figure = oracleAcaApplicableFigure(
      acaMagi,
      statutory.fpl2026Single,
      statutory.applicablePercentageTable2026,
    );
    if (figure === null) throw new Error('oracle: dual-MAGI case unexpectedly over the cliff');
    const independentPtc = Math.max(
      0,
      inputs.acaBenchmarkSlcspDollars * 100 - Math.round(expected.acaMagiCents * figure),
    );
    expectWithinCents(independentPtc, expected.acaPtcSubsidyCents, 1);

    // Engine comparison — one applyTaxYear call must produce both figures.
    const engine = applyTaxYear(
      {
        taxYear: inputs.taxYear,
        filingStatus: inputs.filingStatus as FilingStatus,
        grossSsDollars: inputs.grossSsDollars,
        preTaxWithdrawalDollars: inputs.preTaxWithdrawalDollars,
        postTaxNonRothWithdrawalDollars: 0,
        rothWithdrawalDollars: 0,
        otherOrdinaryIncomeDollars: 0,
        taxExemptInterestDollars: 0,
        householdSize: inputs.householdSize,
        members: [
          {
            memberId: inputs.memberId,
            isoBirthdate: inputs.isoBirthdate,
            onMedicare: false,
            hasAcaCoverage: true,
          },
        ],
        accounts: [],
        acaBenchmarkSlcspDollars: inputs.acaBenchmarkSlcspDollars,
        taxpayersAge65Plus: 0,
      },
      DEFAULT_TAX_CALIBRATION_BUNDLE,
    );
    expectWithinCents(engine.taxableSsCents, expected.taxableSsCents, DOLLAR_CENTS);
    expect(engine.ssTaxationTier).toBe(expected.ssTaxationTier);
    // (a) federal/IRMAA MAGI: only the §86-TAXABLE portion of SS.
    expectWithinCents(engine.magiCents, expected.federalMagiCents, DOLLAR_CENTS);
    // (b) ACA MAGI: the engine's FPL% must reflect the FULL-benefit add-back
    // (fplPercentage is computed from the ACA-specific MAGI).
    expect(engine.fplPercentage).toBeCloseTo(expected.fplPercentage, 6);
    expect(engine.fplPercentage).toBeCloseTo(
      ((expected.acaMagiCents / 100) / statutory.fpl2026Single) * 100,
      6,
    );
    expectWithinCents(engine.acaPtcSubsidyCents, expected.acaPtcSubsidyCents, DOLLAR_CENTS);
    expect(engine.acaPtcTier).toBe(expected.acaPtcTier);
    // Conflation guard: a PTC computed from the FEDERAL MAGI (no add-back)
    // would land in a different band and pay a visibly different subsidy.
    const conflatedFigure = oracleAcaApplicableFigure(
      federalMagi,
      statutory.fpl2026Single,
      statutory.applicablePercentageTable2026,
    );
    if (conflatedFigure === null) throw new Error('oracle: conflated MAGI unexpectedly over the cliff');
    const conflatedPtc = Math.max(
      0,
      inputs.acaBenchmarkSlcspDollars * 100 -
        Math.round(expected.federalMagiCents * conflatedFigure),
    );
    expect(conflatedPtc).toBe(expected.conflatedFederalMagiPtcCents);
    expect(Math.abs(engine.acaPtcSubsidyCents - conflatedPtc)).toBeGreaterThan(DOLLAR_CENTS);
  });

  it('the rough ACA benchmark is a per-member per-month sum with disclosed assumptions', () => {
    const { inputs, expected } = fixtureCase<
      { members: { age: number; marketplaceMonths: number }[] },
      {
        householdAnnualCents: number;
        assumptions: { baseMonthlyDollars: number; baseAge: number; ageGrowthRate: number };
      }
    >(acaMedicareFixture, 'rough-benchmark-per-member-sum');

    // Assumptions asserted separately (the approximation's disclosure contract).
    expect(ROUGH_BENCHMARK_ASSUMPTIONS.baseMonthlyDollars).toBe(
      expected.assumptions.baseMonthlyDollars,
    );
    expect(ROUGH_BENCHMARK_ASSUMPTIONS.baseAge).toBe(expected.assumptions.baseAge);
    expect(ROUGH_BENCHMARK_ASSUMPTIONS.ageGrowthRate).toBe(expected.assumptions.ageGrowthRate);
    expect(ROUGH_BENCHMARK_ASSUMPTIONS.disclosure).toContain('not an exchange SLCSP quote');

    // Independent workbook: per-member monthly premium × covered months.
    const a = expected.assumptions;
    const independent = inputs.members.reduce(
      (sum, m) =>
        sum +
        Math.round(a.baseMonthlyDollars * Math.pow(1 + a.ageGrowthRate, m.age - a.baseAge) * 100) *
          m.marketplaceMonths,
      0,
    );
    expectWithinCents(independent, expected.householdAnnualCents, 1);

    // Compare against the PRODUCTION benchmark path `applyTaxYear` now
    // uses (`defaultHouseholdSlcspByAge`, fed the same per-member coverage
    // months), not the module in isolation. Its output is whole
    // dollars, so it is converted back to cents for the shared tolerance.
    const productionMembers: TaxMemberInput[] = inputs.members.map((m, i) => ({
      memberId: `oracle-member-${i}`,
      isoBirthdate: `${BENCHMARK_TAX_YEAR - m.age}-01-01`,
      onMedicare: false,
      hasAcaCoverage: true,
      marketplaceCoverageMonths: m.marketplaceMonths,
    }));
    const engine = Math.round(
      defaultHouseholdSlcspByAge(productionMembers, BENCHMARK_TAX_YEAR) * 100,
    );
    expectWithinCents(engine, expected.householdAnnualCents, APPROX_50_CENTS);
    // The production path and the pure engine must agree exactly — the former
    // is a thin per-member adapter over the latter.
    expect(engine).toBe(roughHouseholdAnnualBenchmarkCents(inputs.members));
    expect(roughMonthlyBenchmarkCentsForMember(62)).toBeGreaterThan(
      roughMonthlyBenchmarkCentsForMember(60),
    );
  });

  it('month-aware IRMAA prorates Part B and Part D independently (exact)', () => {
    const { inputs, expected } = fixtureCase<
      {
        taxYear: number;
        lookback: { magiCents: number; filingStatus: string };
        beneficiaries: { partBMonths: number; partDMonths: number }[];
      },
      {
        tier: string;
        partBProratedHouseholdCents: number;
        partDProratedHouseholdCents: number;
        totalHouseholdAnnualCents: number;
      }
    >(acaMedicareFixture, 'month-aware-irmaa-partial-year');

    // Independent: CMS joint tier-1 monthly dollars, annualized, prorated by
    // each beneficiary's own months.
    const t1 = statutory.irmaa2026JointTier1;
    const magiDollars = inputs.lookback.magiCents / 100;
    expect(magiDollars).toBeGreaterThan(t1.over);
    expect(magiDollars).toBeLessThanOrEqual(t1.upTo);
    const bAnnual = Math.round(t1.partBMonthly * 12 * 100);
    const dAnnual = Math.round(t1.partDMonthly * 12 * 100);
    const independentB = inputs.beneficiaries.reduce(
      (s, b) => s + Math.round((bAnnual * b.partBMonths) / 12),
      0,
    );
    const independentD = inputs.beneficiaries.reduce(
      (s, b) => s + Math.round((dAnnual * b.partDMonths) / 12),
      0,
    );
    expect(independentB).toBe(expected.partBProratedHouseholdCents);
    expect(independentD).toBe(expected.partDProratedHouseholdCents);

    // Engine comparison — exact month counts + exact table lookup.
    const engine = computeMonthAwareIrmaa(
      {
        taxYear: inputs.taxYear,
        lookback: {
          magiCents: inputs.lookback.magiCents,
          filingStatus: inputs.lookback.filingStatus as FilingStatus,
        },
        beneficiaries: inputs.beneficiaries,
      },
      IRMAA_TIERS,
    );
    expect(engine.tier).toBe(expected.tier);
    expect(engine.partBProratedHouseholdCents).toBe(expected.partBProratedHouseholdCents);
    expect(engine.partDProratedHouseholdCents).toBe(expected.partDProratedHouseholdCents);
    expect(engine.totalHouseholdAnnualCents).toBe(expected.totalHouseholdAnnualCents);

    // The same months routed through the PRODUCTION entry point
    // (`applyTaxYear`) must charge the identical surcharge, proving the
    // month-aware engine is the one the projection actually runs.
    const production = applyTaxYear(
      {
        taxYear: inputs.taxYear,
        filingStatus: inputs.lookback.filingStatus as FilingStatus,
        irmaaLookbackFilingStatus: inputs.lookback.filingStatus as FilingStatus,
        grossSsDollars: 0,
        preTaxWithdrawalDollars: 0,
        postTaxNonRothWithdrawalDollars: 0,
        rothWithdrawalDollars: 0,
        otherOrdinaryIncomeDollars: 0,
        taxExemptInterestDollars: 0,
        householdSize: 2,
        members: inputs.beneficiaries.map((b, i) => ({
          memberId: `oracle-beneficiary-${i}`,
          isoBirthdate: `${inputs.taxYear - 70}-01-01`,
          onMedicare: true,
          hasAcaCoverage: false,
          partBEnrollmentMonths: b.partBMonths,
          partDEnrollmentMonths: b.partDMonths,
        })),
        accounts: [],
        magiTwoYearsPriorDollars: inputs.lookback.magiCents / 100,
        taxpayersAge65Plus: 2,
      },
      DEFAULT_TAX_CALIBRATION_BUNDLE,
    );
    expect(production.irmaaTier).toBe(expected.tier);
    expect(production.irmaaSurchargeCents).toBe(expected.totalHouseholdAnnualCents);
  });
});

// ===========================================================================
// Domain: Roth
// ===========================================================================

describe('retirement oracle — Roth distributions', () => {
  it.each([
    ['ira-ordering-nonqualified-mixed-clocks'],
    ['ira-qualified-tax-free'],
    ['ira-ordering-future-dated-lot-excluded'],
  ])(
    '%s follows the Pub 590-B §408A ordering exactly',
    (id) => {
      const { inputs, expected } = fixtureCase<
        {
          facts: {
            regularContributionBasisCents: number;
            firstContributionTaxYear: number;
            conversionLots: RothConversionLotCents[];
          };
          withdrawalCents: number;
          distributionTaxYear: number;
          ownerReached59Half: boolean;
        },
        Record<string, number | boolean>
      >(rothFixture, id);

      // Independent ordering from the fixture facts.
      const independent = oracleRothIraOrdering({
        ...inputs.facts,
        withdrawalCents: inputs.withdrawalCents,
        distributionTaxYear: inputs.distributionTaxYear,
        ownerReached59Half: inputs.ownerReached59Half,
        fiveYearClockMet:
          inputs.distributionTaxYear - inputs.facts.firstContributionTaxYear >=
          ROTH_FIVE_YEAR_CLOCK,
      });
      expect(independent.incomeTaxableCents).toBe(expected.incomeTaxableCents);
      expect(independent.additionalTaxBaseCents).toBe(expected.additionalTaxBaseCents);

      // Engine comparison — exact-equality ordering contract.
      const engine = orderRothIraDistribution({
        facts: inputs.facts,
        withdrawalCents: inputs.withdrawalCents,
        distributionTaxYear: inputs.distributionTaxYear,
        ownerReached59Half: inputs.ownerReached59Half,
      });
      for (const [key, value] of Object.entries(expected)) {
        expect(engine[key as keyof typeof engine]).toBe(value);
      }
      // Cross-check the engine against the full independent bucket breakdown.
      expect(engine.regularContributionCents).toBe(independent.regularContributionCents);
      expect(engine.conversionTaxablePrincipalCents).toBe(
        independent.conversionTaxablePrincipalCents,
      );
      expect(engine.conversionNontaxablePrincipalCents).toBe(
        independent.conversionNontaxablePrincipalCents,
      );
      expect(engine.earningsCents).toBe(independent.earningsCents);
    },
  );

  it.each([
    ['designated-roth-pro-rata'],
    ['designated-roth-457b-penalty-exempt'],
    ['designated-roth-pro-rata-half-cent'],
  ])('%s splits pro rata per the designated-Roth FAQs', (id) => {
    const { inputs, expected } = fixtureCase<
      {
        facts: {
          basisCents: number;
          firstParticipationTaxYear: number;
          isGovernmental457b?: boolean;
        };
        accountBalanceCents: number;
        withdrawalCents: number;
        distributionTaxYear: number;
        ownerReached59Half: boolean;
      },
      Record<string, number | boolean>
    >(rothFixture, id);

    // Independent pro-rata split, half-up on the basis share. The float
    // product here stays far below 2^53 for every fixture magnitude, so
    // `Math.round` is exact — including the deliberate half-cent case, where
    // a truncating split would come out one cent low.
    const basisPortion = Math.min(
      inputs.withdrawalCents,
      Math.round((inputs.withdrawalCents * inputs.facts.basisCents) / inputs.accountBalanceCents),
    );
    expect(basisPortion).toBe(expected.basisCents);
    const earningsPortion = inputs.withdrawalCents - basisPortion;
    expect(earningsPortion).toBe(expected.earningsCents);

    // Independent tax buckets (designated-Roth FAQs + §72(t)/§72(t)(9)):
    // nonqualified earnings are ordinary income; the 10% additional tax
    // reaches pre-59½ earnings EXCEPT ordinary governmental-457(b) earnings.
    const qualifiedIndependent =
      inputs.ownerReached59Half &&
      inputs.distributionTaxYear - inputs.facts.firstParticipationTaxYear >=
        ROTH_FIVE_YEAR_CLOCK;
    expect(qualifiedIndependent).toBe(expected.qualified);
    expect(qualifiedIndependent ? 0 : earningsPortion).toBe(expected.incomeTaxableCents);
    const additionalTaxIndependent =
      qualifiedIndependent ||
      inputs.ownerReached59Half ||
      inputs.facts.isGovernmental457b === true
        ? 0
        : earningsPortion;
    expect(additionalTaxIndependent).toBe(expected.additionalTaxBaseCents);

    // Engine comparison — exact.
    const engine = computeDesignatedRothDistribution(inputs);
    for (const [key, value] of Object.entries(expected)) {
      expect(engine[key as keyof typeof engine]).toBe(value);
    }
  });
});

// ===========================================================================
// Domain: RMD
// ===========================================================================

describe('retirement oracle — RMD', () => {
  it('reproduces the Pub 590-B worked example ($38,400 / 26.5 -> published $1,450)', () => {
    const { inputs, expected } = fixtureCase<
      {
        isoBirthdate: string;
        taxYear: number;
        account: {
          id: string;
          balanceDec31PriorYearCents: number;
          accountType: string;
          taxTreatment: string;
        };
      },
      { publishedRmdDollars: number; divisor: number; applicable: boolean }
    >(rmdFixture, 'pub590b-justin-2025');

    // Independent: balance / divisor vs the IRS-published whole-dollar figure.
    const independentCents = Math.round(
      (inputs.account.balanceDec31PriorYearCents / 100 / expected.divisor) * 100,
    );
    expectWithinCents(independentCents, expected.publishedRmdDollars * 100, DOLLAR_CENTS);

    // Engine comparison — divisor exact, dollars within $1 of the published figure.
    const engine = computeRmd(
      {
        isoBirthdate: inputs.isoBirthdate,
        taxYear: inputs.taxYear,
        accounts: [
          {
            id: inputs.account.id,
            balanceDec31PriorYearCents: inputs.account.balanceDec31PriorYearCents,
            accountType: inputs.account.accountType as RmdAccountType,
            taxTreatment: inputs.account.taxTreatment as AccountTaxTreatment,
          },
        ],
      },
      RMD_DIVISORS,
    );
    expect(engine.applicable).toBe(expected.applicable);
    expect(engine.divisor).toBe(expected.divisor);
    expectWithinCents(engine.ownerRmdCents, expected.publishedRmdDollars * 100, DOLLAR_CENTS);
    expect(engine.ownerRmdCents).toBe(independentCents);

    // The same published IRS figure through the fact-based path.
    // This oracle also exercises the legacy owner/Uniform-Lifetime
    // branch; both engines route accounts carrying `facts` through
    // `resolveRmdRule`, the oracle must pin THAT path against the published figure
    // too. An owner account with no recorded facts resolves to Uniform Lifetime, so
    // the two branches must agree to the cent.
    const factBased = computeRmd(
      {
        isoBirthdate: inputs.isoBirthdate,
        taxYear: inputs.taxYear,
        accounts: [
          {
            id: inputs.account.id,
            balanceDec31PriorYearCents: inputs.account.balanceDec31PriorYearCents,
            accountType: inputs.account.accountType as RmdAccountType,
            taxTreatment: inputs.account.taxTreatment as AccountTaxTreatment,
            facts: {},
          },
        ],
        lifeExpectancyTables: RMD_LIFE_EXPECTANCY_TABLES,
      },
      RMD_DIVISORS,
    );
    expect(factBased.applicable).toBe(expected.applicable);
    expect(factBased.divisor).toBe(expected.divisor);
    expect(factBased.ownerRmdCents).toBe(engine.ownerRmdCents);
    // The activated path reports its disclosure fields (no blockers, no deferral).
    expect(factBased.withheldAccounts).toEqual([]);
    expect(factBased.stillWorkingDeferredAccountIds).toEqual([]);
  });

  it('Appendix B divisor lookups are exact across Tables I, II, and III', () => {
    const { inputs } = fixtureCase<
      { taxYear: number; lookups: { request: Record<string, unknown>; divisor: number }[] },
      Record<string, never>
    >(rmdFixture, 'table-divisor-lookups');
    for (const lookup of inputs.lookups) {
      const request = lookup.request as unknown as RmdTableRequest;
      const selection = selectRmdTableDivisor(request, RMD_LIFE_EXPECTANCY_TABLES, inputs.taxYear);
      expect(selection.kind).toBe('divisor');
      if (selection.kind === 'divisor') {
        if ('mode' in request && request.mode === 'anchoredDecrement') {
          // Computed as base-year divisor − 1.0/elapsed year → float-subtraction
          // guard; still exact to 9 decimal places.
          expect(selection.divisor).toBeCloseTo(lookup.divisor, 9);
        } else {
          expect(selection.divisor).toBe(lookup.divisor);
        }
      }
    }
  });

  it('SECURE 2.0 §107 trigger ages: born 1959 -> 73, born 1960 -> 75 (exact)', () => {
    const { inputs, expected } = fixtureCase<{ birthYears: number[] }, { triggerAges: number[] }>(
      rmdFixture,
      'secure2-trigger-ages',
    );
    expect(inputs.birthYears.map((y) => rmdTriggerAge(y))).toEqual(expected.triggerAges);
  });

  it('the still-working exception requires every affirmative fact (exact)', () => {
    const { inputs, expected } = fixtureCase<
      { affirmative: RmdAccountProfileFacts; missingOwnershipFact: RmdAccountProfileFacts },
      { affirmative401k: boolean; missingOwnershipFact401k: boolean; affirmativeIra: boolean }
    >(rmdFixture, 'still-working-exception');
    // The exception is now year-scoped (it defers only while employment
    // continues), so the fact-only oracle comparison probes a year strictly BEFORE
    // the separation year — the primary-source expectation is about the FACTS.
    const employed = { taxYear: 2025, separationYear: 2030 } as const;
    expect(
      stillWorkingExceptionApplies(inputs.affirmative, 'RETIREMENT_401K', employed),
    ).toBe(expected.affirmative401k);
    expect(
      stillWorkingExceptionApplies(inputs.missingOwnershipFact, 'RETIREMENT_401K', employed),
    ).toBe(expected.missingOwnershipFact401k);
    expect(
      stillWorkingExceptionApplies(inputs.affirmative, 'RETIREMENT_IRA', employed),
    ).toBe(expected.affirmativeIra);
    // …and the same affirmative facts no longer defer once the owner has separated
    // (§401(a)(9)(C) makes the separation year the first distribution year).
    expect(
      stillWorkingExceptionApplies(inputs.affirmative, 'RETIREMENT_401K', {
        taxYear: 2030,
        separationYear: 2030,
      }),
    ).toBe(false);
  });

  it('the first-year April-1 deferral produces two RMDs in the following year (exact)', () => {
    const { inputs, expected } = fixtureCase<
      { ownerAge: number; triggerAge: 73 | 75 },
      { electedRmdsDueFollowingYear: number; notElectedRmdsDueFollowingYear: number }
    >(rmdFixture, 'first-year-april-1-deferral');
    const elected = rmdFirstYearDeferralPlan(inputs.ownerAge, inputs.triggerAge, {
      firstYearDeferralElected: true,
    });
    expect(elected.deferred).toBe(true);
    expect(elected.rmdsDueFollowingYear).toBe(expected.electedRmdsDueFollowingYear);
    const notElected = rmdFirstYearDeferralPlan(inputs.ownerAge, inputs.triggerAge, {});
    expect(notElected.deferred).toBe(false);
    expect(notElected.rmdsDueFollowingYear).toBe(expected.notElectedRmdsDueFollowingYear);
  });

  it('inherited 10-year rule: annual window year with the anchored Table I divisor', () => {
    const { inputs, expected } = fixtureCase<
      {
        facts: RmdAccountProfileFacts;
        accountType: string;
        taxTreatment: string;
        taxYear: number;
      },
      {
        kind: string;
        annualDistributionRequired: boolean;
        fullLiquidationByYear: number;
        divisor: number;
      }
    >(rmdFixture, 'inherited-ten-year-annual-window');
    const resolution = resolveRmdRule({
      facts: inputs.facts,
      accountType: inputs.accountType as RmdAccountType,
      taxTreatment: inputs.taxTreatment as AccountTaxTreatment,
      ages: {},
      taxYear: inputs.taxYear,
      tables: RMD_LIFE_EXPECTANCY_TABLES,
    });
    expect(resolution.kind).toBe(expected.kind);
    if (resolution.kind === 'inheritedTenYearRule') {
      expect(resolution.annualDistributionRequired).toBe(expected.annualDistributionRequired);
      expect(resolution.fullLiquidationByYear).toBe(expected.fullLiquidationByYear);
      expect(resolution.selection?.kind).toBe('divisor');
      if (resolution.selection?.kind === 'divisor') {
        // base-year divisor − elapsed years → float-subtraction guard.
        expect(resolution.selection.divisor).toBeCloseTo(expected.divisor, 9);
      }
    }
  });
});

// ===========================================================================
// Domain: blockers (withhold contract)
// ===========================================================================

describe('retirement oracle — blockers withhold with the missing inputs listed', () => {
  it('an inherited account with incomplete facts withholds and lists them (exact)', () => {
    const { inputs, expected } = fixtureCase<
      {
        facts: RmdAccountProfileFacts;
        accountType: string;
        taxTreatment: string;
        taxYear: number;
      },
      { kind: string; missingFacts: string[] }
    >(blockerFixture, 'inherited-rmd-missing-facts');
    const resolution = resolveRmdRule({
      facts: inputs.facts,
      accountType: inputs.accountType as RmdAccountType,
      taxTreatment: inputs.taxTreatment as AccountTaxTreatment,
      ages: {},
      taxYear: inputs.taxYear,
      tables: RMD_LIFE_EXPECTANCY_TABLES,
    });
    expect(resolution.kind).toBe(expected.kind);
    if (resolution.kind === 'withheld') {
      expect([...resolution.missingFacts]).toEqual(expected.missingFacts);
    }
  });

  it('a still-working owner with an unknown retirement year withholds the first-RMD-year plan', () => {
    const { inputs, expected } = fixtureCase<
      { ownerAge: number; triggerAge: 73 | 75; taxYear: number; stillWorkingExceptionApplied: boolean },
      { kind: string; missingFacts: string[] }
    >(blockerFixture, 'still-working-unknown-retirement-year');
    const resolution = resolveRmdFirstYearPlan({ ...inputs, facts: {} });
    expect(resolution.kind).toBe(expected.kind);
    if (resolution.kind === 'withheld') {
      expect([...resolution.missingFacts]).toEqual(expected.missingFacts);
    }
  });

  it('a survivor with no survivor claim age on file gets a withheld (null) benefit', () => {
    const { inputs, expected } = fixtureCase<
      {
        survivor: SurvivorMember;
        deceased: {
          piaMonthlyDollars: number;
          fraMonths: number;
          scenarioClaimAgeMonths: number;
          deathAgeMonths: number;
          deathYear: number;
          colaAnchorYear: number;
        };
        currentYear: number;
        colaPct: number;
      },
      { withheld: boolean }
    >(blockerFixture, 'survivor-claim-age-withheld');
    const deceased: DeceasedMember = {
      pia: inputs.deceased.piaMonthlyDollars,
      fraMonths: inputs.deceased.fraMonths,
      scenarioClaimAgeMonths: inputs.deceased.scenarioClaimAgeMonths,
      deathAgeMonths: inputs.deceased.deathAgeMonths,
      deathYear: inputs.deceased.deathYear,
      colaAnchorYear: inputs.deceased.colaAnchorYear,
    };
    const engine = survivorBenefitAnnual(
      inputs.survivor,
      deceased,
      inputs.currentYear,
      inputs.colaPct,
    );
    expect(engine === null).toBe(expected.withheld);
  });

  it('a missing owner age withholds the living-owner RMD rule (never defaults)', () => {
    const { inputs, expected } = fixtureCase<
      {
        facts: RmdAccountProfileFacts;
        accountType: string;
        taxTreatment: string;
        taxYear: number;
      },
      { kind: string; missingFacts: string[] }
    >(blockerFixture, 'owner-age-missing-withheld');
    const resolution = resolveRmdRule({
      facts: inputs.facts,
      accountType: inputs.accountType as RmdAccountType,
      taxTreatment: inputs.taxTreatment as AccountTaxTreatment,
      ages: {},
      taxYear: inputs.taxYear,
      tables: RMD_LIFE_EXPECTANCY_TABLES,
    });
    expect(resolution.kind).toBe(expected.kind);
    if (resolution.kind === 'withheld') {
      expect([...resolution.missingFacts]).toEqual(expected.missingFacts);
    }
  });
});

// ===========================================================================
// Domain: basis — taxable interest / yield character
// ===========================================================================

interface BasisCaseInputs {
  taxYear: number;
  filingStatus: string;
  isoBirthdate: string;
  householdSize: number;
  otherOrdinaryIncomeDollars: number;
  postTaxNonRothWithdrawalDollars: number;
  assumedCostBasisFraction: number;
  postTaxCashLikeWithdrawalDollars: number;
  cashInterestDollars: number;
  brokerageLikeStartBalanceDollars: number;
}

describe('retirement oracle — taxable interest and yield character', () => {
  const { statutory } = basisFixture;

  /** Independent recomputation of one basis case (cents), per the fixture
   *  derivation: Topic 403 annual interest + explicit yield split + LTCG proxy;
   *  cash-like principal contributes nothing. */
  function oracleBasisCase(inputs: BasisCaseInputs): {
    federalTaxCents: number;
    magiCents: number;
  } {
    const y = statutory.assumedYield;
    const totalYield = inputs.brokerageLikeStartBalanceDollars * y.totalYieldPct;
    const qdi = totalYield * y.qualifiedDividendFraction;
    const ordinaryYield =
      totalYield * (1 - y.qualifiedDividendFraction - y.taxExemptMunicipalFraction);
    const ltcg =
      inputs.postTaxNonRothWithdrawalDollars * (1 - inputs.assumedCostBasisFraction) + qdi;
    const ordinary = inputs.otherOrdinaryIncomeDollars + ordinaryYield + inputs.cashInterestDollars;
    const magi = ordinary + ltcg;
    const taxableIncome = Math.max(0, magi - statutory.standardDeductionSingle2026);
    const taxableOrdinary = taxableIncome - Math.min(ltcg, taxableIncome);
    // LTCG stacks entirely inside the 0% band for these cases; NIIT below its
    // threshold. Guard both so a fixture edit can't silently invalidate them.
    if (taxableIncome > statutory.ltcgZeroBandCeilingSingle2026) {
      throw new Error('oracle basis case exceeds the 0% LTCG band — extend the helper');
    }
    if (magi > statutory.niitThresholdSingle) {
      throw new Error('oracle basis case exceeds the NIIT threshold — extend the helper');
    }
    return {
      federalTaxCents: Math.round(
        oracleBracketTaxDollars(taxableOrdinary, statutory.singleBrackets2026) * 100,
      ),
      magiCents: Math.round(magi * 100),
    };
  }

  const runEngine = (
    id: string,
  ): {
    inputs: BasisCaseInputs;
    expected: { federalTaxCents: number; magiCents: number; taxableSsCents?: number };
    engine: ReturnType<typeof applyTaxYear>;
  } => {
    const { inputs, expected } = fixtureCase<
      BasisCaseInputs,
      { federalTaxCents: number; magiCents: number; taxableSsCents?: number }
    >(basisFixture, id);
    const yearInput: TaxYearInput = {
      taxYear: inputs.taxYear,
      filingStatus: inputs.filingStatus as FilingStatus,
      grossSsDollars: 0,
      preTaxWithdrawalDollars: 0,
      postTaxNonRothWithdrawalDollars: inputs.postTaxNonRothWithdrawalDollars,
      postTaxCashLikeWithdrawalDollars: inputs.postTaxCashLikeWithdrawalDollars,
      cashInterestDollars: inputs.cashInterestDollars,
      rothWithdrawalDollars: 0,
      otherOrdinaryIncomeDollars: inputs.otherOrdinaryIncomeDollars,
      taxExemptInterestDollars: 0,
      assumedCostBasisFraction: inputs.assumedCostBasisFraction,
      brokerageLikeStartBalanceDollars: inputs.brokerageLikeStartBalanceDollars,
      householdSize: inputs.householdSize,
      members: [
        {
          memberId: 'basis-member',
          isoBirthdate: inputs.isoBirthdate,
          onMedicare: false,
          hasAcaCoverage: false,
        },
      ],
      accounts: [],
      taxpayersAge65Plus: 0,
    };
    return { inputs, expected, engine: applyTaxYear(yearInput, DEFAULT_TAX_CALIBRATION_BUNDLE) };
  };

  it.each([['interest-and-yield-character-2026'], ['interest-direction-no-cash-interest']])(
    '%s matches the independent workbook within $1',
    (id) => {
      const { inputs, expected, engine } = runEngine(id);
      const independent = oracleBasisCase(inputs);
      expectWithinCents(independent.federalTaxCents, expected.federalTaxCents, 1);
      expectWithinCents(independent.magiCents, expected.magiCents, 1);
      expectWithinCents(engine.federalTaxCents, expected.federalTaxCents, DOLLAR_CENTS);
      expectWithinCents(engine.magiCents, expected.magiCents, DOLLAR_CENTS);
      if (expected.taxableSsCents !== undefined) {
        expect(engine.taxableSsCents).toBe(expected.taxableSsCents);
      }
    },
  );

  it('annual cash interest is a real ordinary-income drag (direction + magnitude)', () => {
    const withInterest = runEngine('interest-and-yield-character-2026').engine;
    const withoutInterest = runEngine('interest-direction-no-cash-interest').engine;
    expect(withInterest.federalTaxCents).toBeGreaterThan(withoutInterest.federalTaxCents);
    // Delta = 12% marginal rate on the $3,500 of interest = $420.
    expectWithinCents(
      withInterest.federalTaxCents - withoutInterest.federalTaxCents,
      42_000,
      DOLLAR_CENTS,
    );
  });
});

// ---------------------------------------------------------------------------
// Market stress and investment cost
//
// The Balance Projection comparison surface drives these engines, so these
// comparisons run against the PRODUCTION entry points that surface drives:
// `blendedReturnMonthly`
// (the reference fee/return mean-shift definition) and `resolveStressHorizonYear`
// / `STRESS_CASES` (the approved shock magnitudes and the age-105 cap).
// ---------------------------------------------------------------------------

/** Independent fee/return mean-shift: the gross mix-weighted month less the
 *  annual cost and the mix-weighted annual return reduction, each spread evenly
 *  across twelve months. Re-implemented from the SEC fee bulletin's statement
 *  that an ongoing annual fee reduces the return by that fee — never from the
 *  production formula. */
function oracleNetMonthlyPct(
  mix: { stocksPct: number; bondsPct: number; cashPct: number },
  month: { stockPct: number; bondPct: number; cashPct: number },
  annualCostPct: number,
  returnShock: { stocksPct: number; bondsPct: number; cashPct: number } | null,
  monthsPerYear: number,
): number {
  const w = (v: number, m: number): number => (v / 100) * m;
  const gross = w(mix.stocksPct, month.stockPct) + w(mix.bondsPct, month.bondPct) + w(mix.cashPct, month.cashPct);
  const costShift = annualCostPct / monthsPerYear;
  const shockShift = returnShock
    ? (w(mix.stocksPct, returnShock.stocksPct) +
        w(mix.bondsPct, returnShock.bondsPct) +
        w(mix.cashPct, returnShock.cashPct)) /
      monthsPerYear
    : 0;
  return gross - costShift - shockShift;
}

/** Independent monthly compounding of a starting balance over `months`. */
function oracleCompound(startDollars: number, monthlyPct: number, months: number): number {
  return startDollars * Math.pow(1 + monthlyPct / 100, months);
}

/** The market-stress fixture's heterogeneous `cases` array, narrowed per case
 *  at the point of use — the JSON import widens every optional field to
 *  `| undefined`, which would silently turn a missing fixture value into a
 *  skipped assertion. */
interface StressMixCase {
  readonly mix: { stocksPct: number; bondsPct: number; cashPct: number };
  readonly month: { stockPct: number; bondPct: number; cashPct: number };
  readonly annualInvestmentCostPct: number;
  readonly expectedGrossMonthlyPct?: number;
  readonly expectedNetMonthlyPct: number;
}
interface StressDragCase {
  readonly startingBalanceDollars: number;
  readonly months: number;
  readonly grossMonthlyPct: number;
  readonly annualInvestmentCostPct: number;
  readonly expectedNoCostEndingDollars: number;
  readonly expectedWithCostEndingDollars: number;
  readonly expectedShortfallDollars: number;
  readonly expectedShortfallDirection: string;
}
interface StressHorizonCase {
  readonly longestLivedBirthYear: number;
  readonly cases: ReadonlyArray<{
    readonly baseHorizonYear: number;
    readonly expectedHorizonYear: number;
  }>;
}

describe('retirement oracle — investment cost and market stress', () => {
  const f = marketStressFixture;
  const monthsPerYear = f.statutory.monthsPerYear;
  const shocks = f.statutory.shocks;

  /** Minimal `HistoricalMonth` for the blended-return entry point; only the
   *  three sleeve returns participate in the blend. */
  const monthRow = (m: { stockPct: number; bondPct: number; cashPct: number }) => ({
    date: '2026-01',
    stockPct: m.stockPct,
    bondPct: m.bondPct,
    cashPct: m.cashPct,
    cpiPct: 0,
  });

  it('prices the approved shock magnitudes exactly as the fixture records them', () => {
    // The production case table must not drift from the product-approved
    // magnitudes the fixture (and the UI copy) restate.
    expect(STRESS_CASES.higherFees.investmentCostPctDelta).toBe(shocks.investmentCostPctDelta);
    expect(STRESS_CASES.lowerReturns.returnShockStocksPct).toBe(shocks.returnShockStocksPct);
    expect(STRESS_CASES.lowerReturns.returnShockBondsPct).toBe(shocks.returnShockBondsPct);
    expect(STRESS_CASES.lowerReturns.returnShockCashPct).toBe(shocks.returnShockCashPct);
    expect(STRESS_CASES.higherInflation.inflationShockPct).toBe(shocks.inflationShockPct);
    expect(STRESS_CASES.longerLife.longevityShockYears).toBe(shocks.longevityShockYears);
    expect(STRESS_MAX_AGE).toBe(f.statutory.stressMaxAge);
  });

  it('subtracts an annual investment cost as an even monthly mean-shift (exact)', () => {
    const c = f.cases[0] as unknown as StressMixCase;
    const oracleGross = oracleNetMonthlyPct(c.mix, c.month, 0, null, monthsPerYear);
    const oracleNet = oracleNetMonthlyPct(
      c.mix,
      c.month,
      c.annualInvestmentCostPct,
      null,
      monthsPerYear,
    );
    // (1) the independent formula reproduces the fixture's derived values …
    expect(oracleGross).toBeCloseTo(c.expectedGrossMonthlyPct ?? Number.NaN, 12);
    expect(oracleNet).toBeCloseTo(c.expectedNetMonthlyPct, 12);
    // … (2) and the production entry point agrees.
    expect(blendedReturnMonthly(c.mix, monthRow(c.month))).toBeCloseTo(oracleGross, 12);
    expect(
      blendedReturnMonthly(c.mix, monthRow(c.month), {
        annualInvestmentCostPct: c.annualInvestmentCostPct,
      }),
    ).toBeCloseTo(oracleNet, 12);
  });

  it('composes the fee and per-sleeve return shocks additively (exact)', () => {
    const c = f.cases[1] as unknown as StressMixCase;
    const returnShock = {
      stocksPct: shocks.returnShockStocksPct,
      bondsPct: shocks.returnShockBondsPct,
      cashPct: shocks.returnShockCashPct,
    };
    const oracleNet = oracleNetMonthlyPct(
      c.mix,
      c.month,
      c.annualInvestmentCostPct,
      returnShock,
      monthsPerYear,
    );
    expect(oracleNet).toBeCloseTo(c.expectedNetMonthlyPct, 12);
    expect(
      blendedReturnMonthly(c.mix, monthRow(c.month), {
        annualInvestmentCostPct: c.annualInvestmentCostPct,
        returnShock,
      }),
    ).toBeCloseTo(oracleNet, 12);
    // Isolation: each lever alone equals the composed shift minus the other.
    const feeOnly = blendedReturnMonthly(c.mix, monthRow(c.month), {
      annualInvestmentCostPct: c.annualInvestmentCostPct,
    });
    const returnOnly = blendedReturnMonthly(c.mix, monthRow(c.month), { returnShock });
    const gross = blendedReturnMonthly(c.mix, monthRow(c.month));
    expect(feeOnly + returnOnly - gross).toBeCloseTo(oracleNet, 12);
  });

  it('reproduces the repo-designed 30-year fee-drag illustration within $1, in the stated direction', () => {
    const c = f.cases[2] as unknown as StressDragCase;
    const withCostMonthly = c.grossMonthlyPct - c.annualInvestmentCostPct / monthsPerYear;
    const noCost = oracleCompound(c.startingBalanceDollars, c.grossMonthlyPct, c.months);
    const withCost = oracleCompound(c.startingBalanceDollars, withCostMonthly, c.months);
    // The fixture declares a $1 tolerance, so assert $1 — `toBeCloseTo(x, 1)`
    // is roughly five CENTS and silently over-tightens the stated contract.
    expectWithinCents(noCost * 100, c.expectedNoCostEndingDollars * 100, DOLLAR_CENTS);
    expectWithinCents(withCost * 100, c.expectedWithCostEndingDollars * 100, DOLLAR_CENTS);
    expectWithinCents(
      (noCost - withCost) * 100,
      c.expectedShortfallDollars * 100,
      DOLLAR_CENTS,
    );
    // Direction is asserted separately from magnitude: a cost can only lower
    // the ending balance.
    expect(c.expectedShortfallDirection).toBe('lower');
    expect(withCost).toBeLessThan(noCost);
    // The production mean-shift produces the same with-cost monthly return the
    // roll-forward used (100% stocks isolates the cost lever).
    const allStocks = { stocksPct: 100, bondsPct: 0, cashPct: 0 };
    expect(
      blendedReturnMonthly(
        allStocks,
        monthRow({ stockPct: c.grossMonthlyPct, bondPct: 0, cashPct: 0 }),
        { annualInvestmentCostPct: c.annualInvestmentCostPct },
      ),
    ).toBeCloseTo(withCostMonthly, 12);
  });

  it('extends the horizon by five years but never past age 105, and never shortens it (exact)', () => {
    const c = f.cases[3] as unknown as StressHorizonCase;
    for (const sub of c.cases) {
      const age105Year = c.longestLivedBirthYear + f.statutory.stressMaxAge;
      const oracle = Math.max(
        sub.baseHorizonYear,
        Math.min(sub.baseHorizonYear + shocks.longevityShockYears, age105Year),
      );
      expect(oracle).toBe(sub.expectedHorizonYear);
      expect(
        resolveStressHorizonYear(
          sub.baseHorizonYear,
          c.longestLivedBirthYear,
          shocks.longevityShockYears,
        ),
      ).toBe(sub.expectedHorizonYear);
    }
  });
});
