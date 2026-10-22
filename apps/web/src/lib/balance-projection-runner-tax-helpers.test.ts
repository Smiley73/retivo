/** Unit tests for the deterministic tax post-pass helpers in `balance-projection-runner-tax-helpers.ts`. */
import { describe, it, expect } from 'vitest';
import {
  advanceBrokerageLikeBasis,
  buildMemberInputs,
  buildRothDistributionFacts,
  buildSolverPenaltyAccountsForYear,
  countTaxpayersAge65Plus,
  hasAttainedAgeByYearEnd,
  resolveHouseholdDeathYears,
  solverDesignatedRothBalanceCentsByOwner,
  type BrokerageLikeBasisState,
} from './balance-projection-runner-tax-helpers';
import { buildTaxCashflowHook } from './balance-projection-runner-tax';
import { makeCtx, REAL_BUNDLE } from './balance-projection-runner-tax-test-fixtures';
import { buildMcTaxContext } from './balance-projection-runner-mc';
import { deriveMcSurvivors } from './monte-carlo-tax';
import {
  seedSolverDesignatedRothStates,
  seedSolverInheritedDesignatedRothStates,
  mergeFactBasedRothIraSeeds,
  seedFactBasedRothBasisCarrier,
  applyFactBasedRothIraOrdering,
  type RothBasisCarrier,
} from './balance-projection-runner-roth-basis';
import { classifyCommittedYearDraw } from './drawdown-engine-per-account-strategy-cap';
import type { AccountRunState } from './drawdown-engine-per-account-strategy-helpers';
import { computeEarlyWithdrawalPenalty } from './early-withdrawal-penalty';
import type { PenaltyAccountSnapshot } from './tax-integration-helpers';
import type { DrawdownAccountInput } from './drawdown-engine-types';
import type { PipelineContext } from './balance-projection-runner-types';
import type { AccountBalancePayload, AccountPayload } from '../db/types';

describe('buildMemberInputs — Medicare 65th-birthday month onset', () => {
  it('splits the turning-65 year between Marketplace and Medicare months', () => {
    // Born Mar 15 1960: Medicare Mar-Dec (10 months), Marketplace Jan-Feb (2).
    const ctx = makeCtx({ primaryBirthdate: '1960-03-15', primaryRetirementYear: 2024 });
    const members = buildMemberInputs(ctx, 2025, true, false);
    expect(members).toHaveLength(1);
    expect(members[0].onMedicare).toBe(true);
    expect(members[0].partBEnrollmentMonths).toBe(10);
    expect(members[0].partDEnrollmentMonths).toBe(10);
    expect(members[0].marketplaceCoverageMonths).toBe(2);
    expect(members[0].hasAcaCoverage).toBe(true);
  });

  it('charges a second-half (Jul–Dec) 65th birthday only its own months', () => {
    // Born Sep 10 1960: Medicare Sep-Dec (4 months), Marketplace Jan-Aug (8).
    const ctx = makeCtx({ primaryBirthdate: '1960-09-10', primaryRetirementYear: 2024 });
    const yearN = buildMemberInputs(ctx, 2025, true, false);
    expect(yearN[0].onMedicare).toBe(true);
    expect(yearN[0].partBEnrollmentMonths).toBe(4);
    expect(yearN[0].hasAcaCoverage).toBe(true);
    expect(yearN[0].marketplaceCoverageMonths).toBe(8);
    const yearNplus1 = buildMemberInputs(ctx, 2026, true, false);
    expect(yearNplus1[0].onMedicare).toBe(true);
    expect(yearNplus1[0].partBEnrollmentMonths).toBe(12);
    expect(yearNplus1[0].marketplaceCoverageMonths).toBe(0);
  });

  it('age > 65 is always on Medicare for the whole year regardless of birth month', () => {
    const ctx = makeCtx({ primaryBirthdate: '1958-11-30', primaryRetirementYear: 2024 });
    const members = buildMemberInputs(ctx, 2025, true, false); // age 67
    expect(members[0].onMedicare).toBe(true);
    expect(members[0].partBEnrollmentMonths).toBe(12);
  });

  it('boundary: a June-30 birthday starts Medicare in June (7 months)', () => {
    const ctx = makeCtx({ primaryBirthdate: '1960-06-30', primaryRetirementYear: 2024 });
    const members = buildMemberInputs(ctx, 2025, true, false);
    expect(members[0].partBEnrollmentMonths).toBe(7);
    expect(members[0].marketplaceCoverageMonths).toBe(5);
  });

  it('boundary: a July-1 birthday starts Medicare in JUNE (first-of-month rule)', () => {
    const ctx = makeCtx({ primaryBirthdate: '1960-07-01', primaryRetirementYear: 2024 });
    const members = buildMemberInputs(ctx, 2025, true, false);
    expect(members[0].onMedicare).toBe(true);
    expect(members[0].partBEnrollmentMonths).toBe(7);
    expect(members[0].marketplaceCoverageMonths).toBe(5);
  });

  it('overlays the stored Part B / Part D / Marketplace months for the year', () => {
    const ctx = makeCtx({
      primaryBirthdate: '1960-09-10',
      primaryRetirementYear: 2024,
      healthCoverageMonths: {
        perMember: { 'member-primary': { 2025: { partBMonths: 3, partDMonths: 0, marketplaceMonths: 9 } } },
      },
    });
    const m = buildMemberInputs(ctx, 2025, true, false)[0];
    expect(m.partBEnrollmentMonths).toBe(3);
    expect(m.partDEnrollmentMonths).toBe(0);
    expect(m.marketplaceCoverageMonths).toBe(8); // clamped: 12 − 4 entitled months
  });

  it('leaves a year with no stored entry on the automatic derivation', () => {
    const ctx = makeCtx({
      primaryBirthdate: '1960-09-10',
      primaryRetirementYear: 2024,
      healthCoverageMonths: { perMember: { 'member-primary': { 2030: { partBMonths: 1 } } } },
    });
    const m = buildMemberInputs(ctx, 2025, true, false)[0];
    expect(m.partBEnrollmentMonths).toBe(4);
  });

  it('survives an imported override whose `perMember` is not an object', () => {
    const ctx = makeCtx({
      primaryBirthdate: '1960-09-10',
      primaryRetirementYear: 2024,
      healthCoverageMonths: { perMember: null } as never,
    });
    expect(() => buildMemberInputs(ctx, 2025, true, false)).not.toThrow();
    expect(buildMemberInputs(ctx, 2025, true, false)[0].partBEnrollmentMonths).toBe(4);
  });

  it('drops Marketplace months for a member with an empty birthdate', () => {
    const ctx = makeCtx({
      primaryBirthdate: '',
      primaryRetirementYear: 2024,
      healthCoverageMonths: { perMember: { 'member-primary': { 2025: { marketplaceMonths: 12 } } } },
    });
    const m = buildMemberInputs(ctx, 2025, true, false)[0];
    expect(m.hasAcaCoverage).toBe(false);
    expect(m.marketplaceCoverageMonths).toBe(0);
  });

  // Imported payloads are validated at the envelope only, so an impossible calendar date is reachable.
  it.each([
    ['an impossible month and day', '1961-99-99'],
    ['month 13', '1961-13-01'],
    ['day 32', '1961-01-32'],
    ['February 30', '1961-02-30'],
    ['a non-leap February 29', '1961-02-29'],
  ])('charges no automatic Medicare or Marketplace months for %s', (_label, birthdate) => {
    const ctx = makeCtx({ primaryBirthdate: birthdate, primaryRetirementYear: 2024 });
    const m = buildMemberInputs(ctx, 2030, true, false)[0];
    expect(m.onMedicare).toBe(false);
    expect(m.partBEnrollmentMonths).toBe(0);
    expect(m.partDEnrollmentMonths).toBe(0);
    expect(m.hasAcaCoverage).toBe(false);
    expect(m.marketplaceCoverageMonths).toBe(0);
  });

  it('still honours STATED enrolment months for an impossible birthdate (they need no birthday)', () => {
    const ctx = makeCtx({
      primaryBirthdate: '1961-99-99',
      primaryRetirementYear: 2024,
      healthCoverageMonths: {
        perMember: { 'member-primary': { 2030: { partBMonths: 6, marketplaceMonths: 6 } } },
      },
    });
    const m = buildMemberInputs(ctx, 2030, true, false)[0];
    expect(m.partBEnrollmentMonths).toBe(6);
    // Marketplace months need a real birthdate for the age-priced benchmark.
    expect(m.marketplaceCoverageMonths).toBe(0);
    expect(m.hasAcaCoverage).toBe(false);
  });

  it('a real leap-day birthdate is unaffected (Feb 29 2060 → Medicare from February)', () => {
    const ctx = makeCtx({ primaryBirthdate: '1960-02-29', primaryRetirementYear: 2024 });
    const m = buildMemberInputs(ctx, 2025, true, false)[0];
    expect(m.partBEnrollmentMonths).toBe(11); // February–December
    expect(m.marketplaceCoverageMonths).toBe(1);
  });
});

const coverageOf = (m: {
  memberId: string;
  onMedicare?: boolean;
  hasAcaCoverage?: boolean;
  partBEnrollmentMonths?: number;
  partDEnrollmentMonths?: number;
  marketplaceCoverageMonths?: number;
}): Record<string, unknown> => ({
  memberId: m.memberId,
  onMedicare: m.onMedicare,
  hasAcaCoverage: m.hasAcaCoverage,
  partBEnrollmentMonths: m.partBEnrollmentMonths,
  partDEnrollmentMonths: m.partDEnrollmentMonths,
  marketplaceCoverageMonths: m.marketplaceCoverageMonths,
});

describe('staggered retirement — deterministic vs Monte Carlo coverage parity', () => {
  const PRIMARY_RETIREMENT_YEAR = 2026;
  const SECONDARY_RETIREMENT_YEAR = 2032;

  const staggeredCtx = (): PipelineContext =>
    makeCtx({
      // The secondary is 51 and keeps employer coverage until retiring at 57 in 2032.
      primaryBirthdate: '1958-03-15',
      secondaryBirthdate: '1975-03-15',
      primaryRetirementYear: PRIMARY_RETIREMENT_YEAR,
      secondaryRetirementYear: SECONDARY_RETIREMENT_YEAR,
    });

  const mcSurvivorsFor = (ctx: PipelineContext, taxYear: number) => {
    const taxCtx = buildMcTaxContext(ctx);
    expect(taxCtx).toBeDefined();
    // Every MC entry point passes the primary's year as the household scalar.
    const state = deriveMcSurvivors(taxCtx!, taxYear, ctx.primaryRetirementYear);
    expect(state).not.toBeNull();
    return state!.survivors;
  };

  it('the still-working spouse gets NO Marketplace months on either engine', () => {
    const ctx = staggeredCtx();
    const deterministic = buildMemberInputs(ctx, 2028, true, true);
    const mc = mcSurvivorsFor(ctx, 2028);

    expect(mc.map(coverageOf)).toEqual(deterministic.map(coverageOf));

    const secondary = deterministic.find((m) => m.memberId === 'member-secondary');
    expect(secondary?.marketplaceCoverageMonths).toBe(0);
    expect(secondary?.hasAcaCoverage).toBe(false);
    const primary = deterministic.find((m) => m.memberId === 'member-primary');
    expect(primary?.partBEnrollmentMonths).toBe(12);
  });

  it('the spouse joins the Marketplace in THEIR OWN retirement year, on both engines', () => {
    const ctx = staggeredCtx();
    const working = buildMemberInputs(ctx, 2031, true, true);
    expect(
      working.find((m) => m.memberId === 'member-secondary')?.marketplaceCoverageMonths,
    ).toBe(0);
    expect(mcSurvivorsFor(ctx, 2031).map(coverageOf)).toEqual(working.map(coverageOf));

    // 2032: separates at 57, eight years from Medicare, so a full Marketplace year.
    const retired = buildMemberInputs(ctx, 2032, true, true);
    expect(
      retired.find((m) => m.memberId === 'member-secondary')?.marketplaceCoverageMonths,
    ).toBe(12);
    expect(mcSurvivorsFor(ctx, 2032).map(coverageOf)).toEqual(retired.map(coverageOf));
  });

  it('a SAME-DATE household emits no per-member table at all (byte-identical MC input)', () => {
    const sameDate = makeCtx({
      primaryBirthdate: '1958-03-15',
      secondaryBirthdate: '1965-03-15',
      primaryRetirementYear: PRIMARY_RETIREMENT_YEAR,
      secondaryRetirementYear: PRIMARY_RETIREMENT_YEAR,
    });
    expect(buildMcTaxContext(sameDate)?.retirementYearByMember).toBeUndefined();
    expect(
      buildMcTaxContext(makeCtx({ primaryRetirementYear: PRIMARY_RETIREMENT_YEAR }))
        ?.retirementYearByMember,
    ).toBeUndefined();
    expect(buildMcTaxContext(staggeredCtx())?.retirementYearByMember).toEqual([
      { memberId: 'member-primary', retirementYear: PRIMARY_RETIREMENT_YEAR },
      { memberId: 'member-secondary', retirementYear: SECONDARY_RETIREMENT_YEAR },
    ]);
  });

  it('an unparseable secondary retirement date falls back to the primary year, never NaN', () => {
    const ctx = makeCtx({
      primaryBirthdate: '1958-03-15',
      secondaryBirthdate: '1965-03-15',
      primaryRetirementYear: PRIMARY_RETIREMENT_YEAR,
    });
    (ctx.retirementByMember as Map<string, string>).set('member-secondary', 'not-a-date');
    const secondary = buildMemberInputs(ctx, 2028, true, true).find(
      (m) => m.memberId === 'member-secondary',
    );
    // Not "never retired", which an NaN comparison silently produced.
    expect(secondary?.retirementYear).toBe(PRIMARY_RETIREMENT_YEAR);
    expect(buildMcTaxContext(ctx)?.retirementYearByMember).toBeUndefined();
    expect(mcSurvivorsFor(ctx, 2028).map(coverageOf)).toEqual(
      buildMemberInputs(ctx, 2028, true, true).map(coverageOf),
    );
  });
});

// A non-numeric birthdate was "dead every year" on the deterministic engine and "alive forever" in Monte Carlo.
describe('malformed birthdate — deterministic vs Monte Carlo survivor parity', () => {
  const RETIREMENT_YEAR = 2026;

  // Mirrors the production alive rule: taxYear <= deathYear, an absent year being Infinity.
  const deterministicSurvivors = (ctx: PipelineContext, taxYear: number) => {
    const { primaryDeathYear, secondaryDeathYear } = resolveHouseholdDeathYears(ctx);
    return buildMemberInputs(
      ctx,
      taxYear,
      taxYear <= (primaryDeathYear ?? Infinity),
      ctx.secondary !== undefined && taxYear <= (secondaryDeathYear ?? Infinity),
    );
  };

  const malformedSecondaryCtx = (secondaryBirthdate: string): PipelineContext =>
    makeCtx({
      // Primary retires at 51, so the household is on the Marketplace and its size prices a real subsidy.
      primaryBirthdate: '1975-03-15',
      secondaryBirthdate,
      primaryRetirementYear: RETIREMENT_YEAR,
    });

  it('resolves NO death year for an unusable birthdate, on one shared derivation', () => {
    const valid = makeCtx({ primaryBirthdate: '1975-03-15', secondaryBirthdate: '1978-06-01' });
    // Default life expectancy is 95.
    expect(resolveHouseholdDeathYears(valid)).toEqual({
      primaryDeathYear: 1975 + 95,
      secondaryDeathYear: 1978 + 95,
    });

    for (const bad of ['not-a-date', '1975-99-99', '1975-02-30', '19x5-03-15', '']) {
      const ctx = malformedSecondaryCtx(bad);
      const { secondaryDeathYear } = resolveHouseholdDeathYears(ctx);
      // NaN would read as already dead in every year.
      expect(secondaryDeathYear).toBeUndefined();
      expect(Number.isNaN(secondaryDeathYear as unknown as number)).toBe(false);
    }

    expect(resolveHouseholdDeathYears(makeCtx({})).secondaryDeathYear).toBeUndefined();
  });

  it('keeps the malformed-birthdate spouse ALIVE and in the household on BOTH engines', () => {
    const ctx = malformedSecondaryCtx('1975-99-99');
    const taxCtx = buildMcTaxContext(ctx);
    expect(taxCtx).toBeDefined();
    expect(taxCtx!.secondaryDeathYear).toBeUndefined();

    // Both years are pre-Medicare for the primary (born 1975, 65 in 2040).
    for (const taxYear of [2030, 2035]) {
      const deterministic = deterministicSurvivors(ctx, taxYear);
      const mc = deriveMcSurvivors(taxCtx!, taxYear, ctx.primaryRetirementYear)?.survivors;
      // Household size is the FPL denominator `computeAcaPtc` divides by.
      expect(deterministic).toHaveLength(2);
      expect(mc).toHaveLength(2);
      expect(mc!.map(coverageOf)).toEqual(deterministic.map(coverageOf));
      const primary = deterministic.find((m) => m.memberId === 'member-primary');
      expect(primary?.hasAcaCoverage).toBe(true);
      expect(primary?.marketplaceCoverageMonths).toBe(12);
    }
  });

  it('still retires a genuinely dead member on both engines (the fix is not "everyone lives")', () => {
    const ctx = makeCtx({
      primaryBirthdate: '1975-03-15',
      secondaryBirthdate: '1930-03-15', // dies 2025 (1930 + 95)
      primaryRetirementYear: RETIREMENT_YEAR,
    });
    const taxCtx = buildMcTaxContext(ctx);
    expect(taxCtx!.secondaryDeathYear).toBe(2025);
    const deterministic = deterministicSurvivors(ctx, 2030);
    const mc = deriveMcSurvivors(taxCtx!, 2030, ctx.primaryRetirementYear)?.survivors;
    expect(deterministic).toHaveLength(1);
    expect(mc!.map(coverageOf)).toEqual(deterministic.map(coverageOf));
  });
});

describe('hasAttainedAgeByYearEnd — born-Jan-1 rule', () => {
  it('jan1_1960_attains_65_for_tax_year_2024', () => {
    // IRS rule: born Jan 1 counts as reaching the age on Dec 31 of the prior year.
    expect(hasAttainedAgeByYearEnd('1960-01-01', 2024, 65)).toBe(true);
  });

  it('jan1_1960_does_not_attain_65_for_tax_year_2023', () => {
    expect(hasAttainedAgeByYearEnd('1960-01-01', 2023, 65)).toBe(false);
  });

  it('dec31_1959_attains_65_for_tax_year_2024_control', () => {
    // Control: a Dec-31-1959 birthday already qualified under the year-only formula (2024 - 1959 = 65).
    expect(hasAttainedAgeByYearEnd('1959-12-31', 2024, 65)).toBe(true);
  });

  it('feb1_1960_is_NOT_shifted_earlier', () => {
    expect(hasAttainedAgeByYearEnd('1960-02-01', 2024, 65)).toBe(false);
    expect(hasAttainedAgeByYearEnd('1960-02-01', 2025, 65)).toBe(true);
  });

  it('empty_or_unparseable_birthdate_returns_false', () => {
    expect(hasAttainedAgeByYearEnd(null, 2024, 65)).toBe(false);
    expect(hasAttainedAgeByYearEnd(undefined, 2024, 65)).toBe(false);
    expect(hasAttainedAgeByYearEnd('not-a-date', 2024, 65)).toBe(false);
    expect(hasAttainedAgeByYearEnd('', 2024, 65)).toBe(false);
  });
});

describe('countTaxpayersAge65Plus — born-Jan-1 boundary', () => {
  it('jan1_1960_primary_counts_as_65plus_for_tax_year_2024', () => {
    const ctx = makeCtx({ primaryBirthdate: '1960-01-01' });
    expect(countTaxpayersAge65Plus(ctx, 2024, true, false)).toBe(1);
  });

  it('deceased_member_is_excluded_even_when_age_65plus', () => {
    const ctx = makeCtx({ primaryBirthdate: '1960-01-01' });
    expect(countTaxpayersAge65Plus(ctx, 2024, false, false)).toBe(0);
  });
});

describe('buildMemberInputs onMedicare — born-Jan-1 + birthday-month onset', () => {
  it('jan1_1960_member_is_onMedicare_for_tax_year_2024', () => {
    // Jan 1 is a first-of-month birthday, so entitlement starts the preceding December: 12 months in 2024.
    const ctx = makeCtx({ primaryBirthdate: '1960-01-01', primaryRetirementYear: 2020 });
    const members = buildMemberInputs(ctx, 2024, true, false);
    expect(members[0]?.onMedicare).toBe(true);
  });

  it('jan1_1960_member_is_NOT_onMedicare_for_tax_year_2023', () => {
    const ctx = makeCtx({ primaryBirthdate: '1960-01-01', primaryRetirementYear: 2020 });
    const members = buildMemberInputs(ctx, 2023, true, false);
    expect(members[0]?.onMedicare).toBe(false);
  });

  it('dec31_1959_member_starts_Medicare_in_December_2024', () => {
    // Medicare starts in the birthday month (1 month of 2024) while the age-65 deduction count follows born-Jan-1.
    const ctx = makeCtx({ primaryBirthdate: '1959-12-31', primaryRetirementYear: 2020 });
    const y2024 = buildMemberInputs(ctx, 2024, true, false)[0];
    expect(y2024?.onMedicare).toBe(true);
    expect(y2024?.partBEnrollmentMonths).toBe(1);
    const y2025 = buildMemberInputs(ctx, 2025, true, false)[0];
    expect(y2025?.onMedicare).toBe(true);
    expect(y2025?.partBEnrollmentMonths).toBe(12);
  });
});

describe('advanceBrokerageLikeBasis — zero-start funded account basis (regression)', () => {
  it('does_not_double_count_the_deposit_on_a_zero_start_funded_account', () => {
    // $10k deposit grew $1k to $11k: seedBase = 1_000, basisPrev = 500, basis = 500 + 10_000 = 10_500.
    // Counting the deposit twice (0.5 * 11_000 + 10_000 = 15_500, clamped to 11_000) would hide the gain.
    const state: BrokerageLikeBasisState = {
      basisByAccountId: new Map<string, number>(),
      seedBasisFraction: 0.5,
    };
    const acc = {
      id: 'brokerage-a',
      startBalanceDollars: 0,
      endBalanceDollars: 11_000,
      withdrawnDollars: 0,
      depositDollars: 10_000,
    };

    // totalYieldPct = 0 isolates the deposit/basis logic from reinvested yield.
    advanceBrokerageLikeBasis([acc], state, 0);

    const carriedBasis = state.basisByAccountId.get(acc.id);
    expect(carriedBasis).toBeCloseTo(10_500, 6);
    expect(carriedBasis as number).toBeLessThan(11_000);
  });

  it('zero_start_no_deposit_account_is_unaffected', () => {
    // seedBase = 8_000, so carriedBasis = min(0.5 * 8_000, 8_000) = 4_000.
    const state: BrokerageLikeBasisState = {
      basisByAccountId: new Map<string, number>(),
      seedBasisFraction: 0.5,
    };
    const acc = {
      id: 'brokerage-b',
      startBalanceDollars: 0,
      endBalanceDollars: 8_000,
      withdrawnDollars: 0,
      depositDollars: 0,
    };

    advanceBrokerageLikeBasis([acc], state, 0);

    expect(state.basisByAccountId.get(acc.id)).toBeCloseTo(4_000, 6);
  });
});

const M1 = 'member-primary';
const M2 = 'member-secondary';
const ROTH_IRA = 'RETIREMENT_ROTH_IRA';
const ROTH_401K = 'RETIREMENT_ROTH_401K';
const ROTH_403B = 'RETIREMENT_ROTH_403B';

interface Plan {
  id: string;
  owner: string;
  type?: DrawdownAccountInput['accountType'];
  mixed?: boolean;
  inherited?: boolean;
}

interface PlanFact {
  id: string;
  owner: string;
  basis: number;
  clock?: number;
  lots?: Array<[year: number, taxableCents: number, nontaxableCents?: number]>;
}

type SolverArgs = Parameters<typeof buildSolverPenaltyAccountsForYear>[0];

interface SolverCell {
  name: string;
  taxYear: number;
  birth: [primary: string, secondary?: string];
  plans: Plan[];
  ledgerOrder?: 'forward' | 'reversed' | 'both';
  carrier?: Record<string, [basisCents: number, clock?: number]>;
  facts?: PlanFact[];
  pool?: Array<[owner: string, balanceCents: number]>;
  draw: Omit<SolverArgs['classification'], 'preTaxDollars' | 'postTaxCashLikeDollars'>;
  expect: {
    excess?: number;
    penalty?: Array<[id: string, owner: string, dollars: number]>;
    funded?: number;
    exempt?: [ids: string[], fundedDollars: number];
    carrier?: Record<string, [remainingCents: number, withdrawnCents: number] | null>;
    pool?: Record<
      string,
      { basis?: number; lot?: number; nontaxableLot?: number; balance?: number } | null
    >;
  };
}

const emptySeries = { startYear: 2025, startMonthIndex: 0, values: new Float64Array(12) };
const planType = (p: Plan) => p.type ?? ROTH_IRA;
const ledgerAccount = (p: Plan): DrawdownAccountInput => ({
  id: p.id,
  initialPre: 0,
  initialPost: 100_000,
  annualRatePct: 0,
  taxTreatment: p.mixed ? 'MIXED' : 'ROTH',
  accountType: planType(p),
  depositsByMonth: emptySeries,
});
const rothCtx = (birth: SolverCell['birth'], plans: Plan[]) =>
  makeCtx({
    primaryBirthdate: birth[0],
    ...(birth[1] !== undefined ? { secondaryBirthdate: birth[1] } : {}),
    accountProjections: plans.map((p) => ({
      id: p.id,
      taxTreatment: p.mixed ? 'MIXED' : 'ROTH',
      accountType: planType(p),
      ownerId: p.owner,
    })),
    ...(plans.some((p) => p.inherited)
      ? {
          rmdProfileFactsByAccountId: new Map(
            plans.filter((p) => p.inherited).map((p) => [p.id, { inheritedAccount: true }]),
          ),
        }
      : {}),
  });

// Funded 10% the penalty engine collects: m1 is 59½+ in every compared year, m2 is fully prorated.
const fundedPenaltyDollars = (
  penaltyAccounts: readonly PenaltyAccountSnapshot[],
  taxYear: number,
  exemptAccountIds: readonly string[] = [],
): number => {
  const birthdateByMember = new Map([
    [M1, '1958-01-01'],
    [M2, '1985-06-01'],
  ]);
  return computeEarlyWithdrawalPenalty(
    penaltyAccounts.map((acc) => ({
      id: acc.id,
      type: acc.type,
      penaltyBasisDollars: acc.penaltyPreTaxWithdrawalDollars,
      ownerBirthdate: birthdateByMember.get(acc.ownerId),
      ...(acc.rothOrderedAdditionalTaxBase === true
        ? { rothOrderedAdditionalTaxBase: true }
        : {}),
    })),
    taxYear,
    exemptAccountIds,
  ).ira401kPenaltyDollars;
};

function runSolverCell(cell: SolverCell, reversed: boolean): void {
  const carrier: RothBasisCarrier = new Map(
    Object.entries(cell.carrier ?? {}).map(([owner, [basis, clock]]) => [
      owner,
      {
        rothBasisRemainingCents: basis,
        rothCumulativeWithdrawnCents: 0,
        ...(clock !== undefined ? { firstContributionTaxYear: clock } : {}),
      },
    ]),
  );
  const designatedRoth = seedSolverDesignatedRothStates(
    new Map(
      (cell.facts ?? []).map((f) => [
        f.id,
        {
          accountId: f.id,
          ownerId: f.owner,
          basisCents: f.basis,
          ...(f.clock !== undefined ? { firstParticipationTaxYear: f.clock } : {}),
          inPlanRolloverLots: (f.lots ?? []).map(([taxYear, taxable, nontaxable = 0]) => ({
            taxYear,
            taxableRolloverPrincipalCents: taxable,
            nontaxableRolloverPrincipalCents: nontaxable,
          })),
          isGovernmental457b: false,
        },
      ]),
    ),
    new Map(cell.pool ?? []),
  );
  const ledgerAccounts = cell.plans.map(ledgerAccount);
  const { penaltyAccounts, rothEarningsExcessDollars } = buildSolverPenaltyAccountsForYear({
    ctx: rothCtx(cell.birth, cell.plans),
    taxYear: cell.taxYear,
    ledgerAccounts: reversed ? ledgerAccounts.reverse() : ledgerAccounts,
    classification: { preTaxDollars: 0, postTaxCashLikeDollars: 0, ...cell.draw },
    rothBasisCarrier: carrier,
    designatedRoth,
  });

  const want = cell.expect;
  if (want.excess !== undefined) expect(rothEarningsExcessDollars).toBe(want.excess);
  if (want.penalty !== undefined) {
    expect(penaltyAccounts).toEqual(
      want.penalty.map(([id, ownerId, dollars]) => ({
        id,
        type: planType(cell.plans.find((p) => p.id === id)!),
        ownerId,
        penaltyPreTaxWithdrawalDollars: dollars,
        rothOrderedAdditionalTaxBase: true,
        hsaWithdrawalDollars: 0,
      })),
    );
  }
  if (want.funded !== undefined) {
    expect(fundedPenaltyDollars(penaltyAccounts, cell.taxYear)).toBe(want.funded);
  }
  if (want.exempt !== undefined) {
    expect(fundedPenaltyDollars(penaltyAccounts, cell.taxYear, want.exempt[0])).toBe(
      want.exempt[1],
    );
  }
  for (const [owner, cents] of Object.entries(want.carrier ?? {})) {
    const entry = carrier.get(owner);
    if (cents === null) expect(entry).toBeUndefined();
    else expect([entry?.rothBasisRemainingCents, entry?.rothCumulativeWithdrawnCents]).toEqual(cents);
  }
  for (const [owner, expected] of Object.entries(want.pool ?? {})) {
    const state = designatedRoth.get(owner);
    if (expected === null) {
      expect(state).toBeUndefined();
      continue;
    }
    const lot = state?.entry.inPlanRolloverLots[0];
    expect({
      basis: state?.entry.designatedRothBasisRemainingCents,
      lot: lot?.taxableRolloverPrincipalRemainingCents,
      nontaxableLot: lot?.nontaxableRolloverPrincipalRemainingCents,
      balance: state?.balanceRemainingCents,
    }).toMatchObject(expected);
  }
}

const itSolverCell = (cell: SolverCell): void => {
  const orders = cell.ledgerOrder ?? 'forward';
  if (orders !== 'reversed') runSolverCell(cell, false);
  if (orders !== 'forward') runSolverCell(cell, true);
};

const IRA_M1: Plan = { id: 'roth-ira-m1', owner: M1 };
const IRA_M2: Plan = { id: 'roth-ira-m2', owner: M2 };
const R401K_M1: Plan = { id: 'roth-401k-m1', owner: M1, type: ROTH_401K };
const R403B_M2: Plan = { id: 'roth-403b-m2', owner: M2, type: ROTH_403B };
const ROLLOVER_401K: Plan = { id: 'roth-401k', owner: M1, type: ROTH_401K };
// A $6k basis that is wholly a 2024 taxable in-plan rollover, the usual designated-plan shape.
const ROLLOVER_FACT: PlanFact = {
  id: 'roth-401k',
  owner: M1,
  basis: 600_000,
  clock: 2005,
  lots: [[2024, 600_000]],
};
const twoOwnerCarrier = (m2Clock: number): SolverCell['carrier'] => ({
  [M1]: [1_000_000, 2008],
  [M2]: [0, m2Clock],
});

const ROTH_IRA_CELLS: SolverCell[] = [
  {
    name: 'charges the NON-inherited Roth dollars to the owner who actually holds the basis',
    taxYear: 2030,
    birth: ['1955-01-01', '1956-01-01'],
    plans: [{ id: 'roth-inherited', owner: M1, inherited: true }, { id: 'roth-401k', owner: M2, type: ROTH_401K }],
    carrier: { [M2]: [1_000_000] },
    // $22k tranche less $12k inherited is $10k, exactly the secondary's basis
    draw: { rothDollars: 22_000, rothInheritedTaxFreeDollars: 12_000 },
    expect: { excess: 0, penalty: [], carrier: { [M2]: [0, 1_000_000], [M1]: null } },
  },
  {
    name: 'charges an own-Roth draw only to that owner’s §408A state',
    taxYear: 2030,
    birth: ['1955-01-01', '1956-01-01'],
    plans: [
      { id: 'roth-inherited', owner: M1, inherited: true },
      { id: 'roth-own', owner: M1 },
      { id: 'roth-401k', owner: M2, type: ROTH_401K },
    ],
    carrier: { [M1]: [0], [M2]: [10_000_000] },
    draw: { rothDollars: 62_000, rothInheritedTaxFreeDollars: 12_000 },
    expect: { excess: 50_000, carrier: { [M1]: [0, 5_000_000], [M2]: [10_000_000, 0] } },
  },
  {
    name: 'falls back to a MIXED Roth-designated plan when it is the only non-inherited Roth source',
    taxYear: 2030,
    birth: ['1955-01-01', '1956-01-01'],
    plans: [
      { id: 'roth-inherited', owner: M2, inherited: true },
      { id: 'mixed-401k', owner: M2, type: 'RETIREMENT_401K', mixed: true },
    ],
    carrier: { [M2]: [4_000_000] },
    // $60k tranche less $30k inherited is $30k, covered by the secondary's $40k basis
    draw: { rothDollars: 60_000, rothInheritedTaxFreeDollars: 30_000 },
    expect: { excess: 0, penalty: [], carrier: { [M2]: [1_000_000, 3_000_000], [M1]: null } },
  },
  {
    name: 'funds NO tax on a qualified draw past the derived basis (clock met, owner 59½+)',
    taxYear: 2025,
    birth: ['1958-01-01'],
    plans: [{ id: 'roth-ira', owner: M1 }],
    carrier: { [M1]: [6_000_000, 2010] },
    draw: { rothDollars: 100_000 },
    expect: { excess: 0, penalty: [] },
  },
  {
    name: 'still taxes the earnings excess when the pooled clock is unmet',
    taxYear: 2025,
    birth: ['1958-01-01'],
    plans: [{ id: 'roth-ira', owner: M1 }],
    carrier: { [M1]: [6_000_000] },
    draw: { rothDollars: 100_000 },
    expect: { excess: 40_000, penalty: [] },
  },
  {
    name: 'taxes the pooled draw when ANY Roth-IRA owner is nonqualified, whatever the ledger order',
    taxYear: 2025,
    birth: ['1958-01-01', '1985-06-01'],
    plans: [IRA_M1, IRA_M2],
    carrier: { [M1]: [0, 2010], [M2]: [0, 2024] },
    draw: { rothDollars: 50_000 },
    // $5,000 = 10% of the $50k base, m2's proration 1
    expect: { excess: 50_000, penalty: [['roth-ira-m1', M2, 50_000]], funded: 5_000 },
  },
  {
    name: 'taxes the pooled draw when ANY Roth-IRA owner is nonqualified, whatever the ledger order (reversed ledger)',
    taxYear: 2025,
    birth: ['1958-01-01', '1985-06-01'],
    plans: [IRA_M1, IRA_M2],
    ledgerOrder: 'reversed',
    carrier: { [M1]: [0, 2010], [M2]: [0, 2024] },
    draw: { rothDollars: 50_000 },
    expect: { excess: 50_000, penalty: [['roth-ira-m2', M2, 50_000]], funded: 5_000 },
  },
  {
    name: 'still funds NO tax when EVERY Roth-IRA owner is qualified (no over-reduction)',
    taxYear: 2025,
    birth: ['1958-01-01', '1956-01-01'],
    plans: [IRA_M1, IRA_M2],
    carrier: { [M1]: [0, 2010], [M2]: [0, 2015] },
    draw: { rothDollars: 50_000 },
    expect: { excess: 0, penalty: [] },
  },
  {
    name: 'm2’s draw never consumes m1’s basis, in EITHER ledger order',
    taxYear: 2030,
    birth: ['1955-01-01', '1956-01-01'],
    plans: [IRA_M1, IRA_M2],
    ledgerOrder: 'both',
    carrier: { [M1]: [10_000_000] },
    draw: { rothDollars: 50_000, rothIraDollarsByAccountId: new Map([['roth-ira-m2', 50_000]]) },
    expect: { excess: 50_000, carrier: { [M1]: [10_000_000, 0], [M2]: [0, 5_000_000] } },
  },
  {
    name: 'a year drawing from BOTH owners charges each owner’s own entry, in EITHER ledger order',
    taxYear: 2030,
    birth: ['1955-01-01', '1956-01-01'],
    plans: [IRA_M1, IRA_M2],
    ledgerOrder: 'both',
    carrier: { [M1]: [10_000_000] },
    draw: {
      rothDollars: 50_000,
      rothIraDollarsByAccountId: new Map([
        ['roth-ira-m1', 30_000],
        ['roth-ira-m2', 20_000],
      ]),
    },
    // m1's $30k is sheltered by m1's own basis; m2's $20k is all excess
    expect: { excess: 20_000, carrier: { [M1]: [7_000_000, 3_000_000], [M2]: [0, 2_000_000] } },
  },
  {
    name: 'funds NO tax on m1’s qualified draw when m2 (45, open clock) draws NOTHING, in EITHER ledger order',
    taxYear: 2030,
    birth: ['1958-01-01', '1985-06-01'],
    plans: [IRA_M1, IRA_M2],
    ledgerOrder: 'both',
    carrier: twoOwnerCarrier(2026),
    draw: { rothDollars: 100_000, rothIraDollarsByAccountId: new Map([['roth-ira-m1', 100_000]]) },
    expect: { excess: 0, penalty: [], carrier: { [M1]: [0, 10_000_000], [M2]: [0, 0] } },
  },
  {
    name: 'a clock-only mismatch: a non-drawing 59½+ owner’s open clock never taxes the drawn owner',
    taxYear: 2030,
    birth: ['1958-01-01', '1956-01-01'],
    plans: [IRA_M1, IRA_M2],
    carrier: twoOwnerCarrier(2027),
    draw: { rothDollars: 100_000, rothIraDollarsByAccountId: new Map([['roth-ira-m1', 100_000]]) },
    expect: { excess: 0, penalty: [] },
  },
  {
    name: 'the drawn owner is still taxed on their OWN facts, with the snapshot on the drawn ACCOUNT id',
    taxYear: 2030,
    birth: ['1958-01-01', '1985-06-01'],
    plans: [IRA_M1, IRA_M2],
    ledgerOrder: 'both',
    carrier: twoOwnerCarrier(2026),
    draw: { rothDollars: 50_000, rothIraDollarsByAccountId: new Map([['roth-ira-m2', 50_000]]) },
    expect: {
      excess: 50_000,
      penalty: [['roth-ira-m2', M2, 50_000]],
      funded: 5_000,
      exempt: [['roth-ira-m2'], 0],
      carrier: { [M1]: [1_000_000, 0] },
    },
  },
  {
    name: 'one owner’s base splits per drawn ACCOUNT, so an exempt sibling account waives only its own share',
    taxYear: 2030,
    birth: ['1958-01-01', '1985-06-01'],
    plans: [
      { id: 'roth-ira-m2a', owner: M2 },
      { id: 'roth-ira-m2b', owner: M2 },
    ],
    ledgerOrder: 'both',
    carrier: twoOwnerCarrier(2026),
    draw: {
      rothDollars: 50_000,
      rothIraDollarsByAccountId: new Map([
        ['roth-ira-m2a', 25_000],
        ['roth-ira-m2b', 25_000],
      ]),
    },
    expect: {
      excess: 50_000,
      penalty: [
        ['roth-ira-m2a', M2, 25_000],
        ['roth-ira-m2b', M2, 25_000],
      ],
      funded: 5_000,
      exempt: [['roth-ira-m2a'], 2_500],
    },
  },
];

const DESIGNATED_CELLS: SolverCell[] = [
  {
    name: 'funds the EXACT §402A pro-rata split — never contribution-first, never taxable-first',
    taxYear: 2025,
    birth: ['1985-01-01'],
    plans: [ROLLOVER_401K],
    // $3k taxable + $3k nontaxable rollover in 2024, $6k nonqualified draw: §402A(d)(4) pro rata is $360 basis and
    // $5,640 earnings; the additional-tax base is $5,640 + $360
    facts: [{ ...ROLLOVER_FACT, lots: [[2024, 300_000, 300_000]] }],
    pool: [[M1, 10_000_000]],
    draw: { rothDollars: 6_000, rothDesignatedDollars: 6_000 },
    expect: {
      excess: 5_640,
      penalty: [['roth-401k', M1, 6_000]],
      pool: { [M1]: { lot: 264_000, nontaxableLot: 300_000, balance: 9_400_000 } },
    },
  },
  {
    name: 'an unrelated Roth-IRA draw never consumes the employer plan’s rollover lots',
    taxYear: 2025,
    birth: ['1985-01-01'],
    plans: [{ id: 'roth-ira', owner: M1 }, ROLLOVER_401K],
    carrier: { [M1]: [1_500_000] },
    facts: [ROLLOVER_FACT],
    pool: [[M1, 600_000]],
    draw: { rothDollars: 6_000 },
    expect: {
      excess: 0,
      penalty: [],
      pool: { [M1]: { lot: 600_000, balance: 600_000 } },
      carrier: { [M1]: [900_000, 600_000] },
    },
  },
  {
    name: 'funds the 10% recapture on in-window principal when the DESIGNATED plan is drawn',
    taxYear: 2025,
    birth: ['1985-01-01'],
    plans: [ROLLOVER_401K],
    facts: [ROLLOVER_FACT],
    pool: [[M1, 600_000]],
    draw: { rothDollars: 6_000, rothDesignatedDollars: 6_000 },
    expect: { excess: 0, penalty: [['roth-401k', M1, 6_000]], pool: { [M1]: { lot: 0 } } },
  },
  {
    name: 'funds nothing once the lot is past its five-tax-year window',
    taxYear: 2025,
    birth: ['1985-01-01'],
    plans: [ROLLOVER_401K],
    facts: [{ ...ROLLOVER_FACT, lots: [[2018, 600_000]] }],
    pool: [[M1, 600_000]],
    draw: { rothDollars: 6_000, rothDesignatedDollars: 6_000 },
    expect: { penalty: [] },
  },
  {
    name: 'taxes the pooled designated draw when ANY designated owner is nonqualified, whatever the ledger order',
    taxYear: 2025,
    birth: ['1958-01-01', '1985-06-01'],
    plans: [R401K_M1, R403B_M2],
    facts: [
      { id: 'roth-401k-m1', owner: M1, basis: 0, clock: 2005 },
      { id: 'roth-403b-m2', owner: M2, basis: 0, clock: 2024 },
    ],
    pool: [[M1, 4_000_000], [M2, 4_000_000]],
    draw: { rothDollars: 20_000, rothDesignatedDollars: 20_000 },
    expect: { excess: 20_000, penalty: [['roth-401k-m1', M2, 20_000]], funded: 2_000 },
  },
  {
    name: 'taxes the pooled designated draw when ANY designated owner is nonqualified, whatever the ledger order (reversed ledger)',
    taxYear: 2025,
    birth: ['1958-01-01', '1985-06-01'],
    plans: [R401K_M1, R403B_M2],
    ledgerOrder: 'reversed',
    facts: [
      { id: 'roth-401k-m1', owner: M1, basis: 0, clock: 2005 },
      { id: 'roth-403b-m2', owner: M2, basis: 0, clock: 2024 },
    ],
    pool: [[M1, 4_000_000], [M2, 4_000_000]],
    draw: { rothDollars: 20_000, rothDesignatedDollars: 20_000 },
    expect: { excess: 20_000, penalty: [['roth-403b-m2', M2, 20_000]], funded: 2_000 },
  },
  {
    name: 'still funds NO tax when EVERY designated owner is qualified (no over-reduction)',
    taxYear: 2025,
    birth: ['1958-01-01', '1956-01-01'],
    plans: [R401K_M1, R403B_M2],
    facts: [
      { id: 'roth-401k-m1', owner: M1, basis: 0, clock: 2005 },
      { id: 'roth-403b-m2', owner: M2, basis: 0, clock: 2010 },
    ],
    pool: [[M1, 4_000_000], [M2, 4_000_000]],
    draw: { rothDollars: 20_000, rothDesignatedDollars: 20_000 },
    expect: { excess: 0, penalty: [] },
  },
  {
    name: 'an inherited designated plan never picks the owner the designated slice is charged to',
    taxYear: 2025,
    birth: ['1985-01-01', '1985-06-01'],
    plans: [
      { id: 'roth-401k-inh', owner: M1, type: ROTH_401K, inherited: true },
      { id: 'roth-401k-m2', owner: M2, type: ROTH_401K },
    ],
    facts: [{ id: 'roth-401k-m2', owner: M2, basis: 600_000, clock: 2005, lots: [[2024, 600_000]] }],
    pool: [[M2, 600_000]],
    draw: { rothDollars: 6_000, rothDesignatedDollars: 6_000 },
    expect: {
      excess: 0,
      penalty: [['roth-401k-m2', M2, 6_000]],
      pool: { [M2]: { lot: 0 }, [M1]: null },
    },
  },
  ...[
    {
      name: 'charges a draw from m2’s $0-basis plan to m2 in EITHER ledger order (m1’s basis never borrowed)',
      byAccount: [['roth-403b-m2', 50_000]],
      expect: {
        excess: 50_000,
        penalty: [['roth-403b-m2', M2, 50_000]],
        funded: 5_000,
        exempt: [['roth-403b-m2'], 0],
        pool: {
          [M1]: { basis: 10_000_000, lot: 10_000_000, balance: 20_000_000 },
          [M2]: { balance: 0 },
        },
      },
    },
    {
      name: 'funds NO tax on m1’s own qualified draw while m2 (40, no clock) draws nothing, in EITHER ledger order',
      byAccount: [['roth-401k-m1', 50_000]],
      expect: {
        excess: 0,
        penalty: [],
        pool: { [M1]: { basis: 7_500_000, lot: 7_500_000, balance: 15_000_000 }, [M2]: null },
      },
    },
    {
      name: 'a year drawing from BOTH owners charges and qualifies each owner separately, in EITHER ledger order',
      byAccount: [
        ['roth-401k-m1', 30_000],
        ['roth-403b-m2', 20_000],
      ],
      expect: {
        excess: 20_000,
        penalty: [['roth-403b-m2', M2, 20_000]],
        funded: 2_000,
        exempt: [['roth-403b-m2'], 0],
        pool: {
          [M1]: { basis: 8_500_000, lot: 8_500_000, balance: 17_000_000 },
          [M2]: { balance: 0 },
        },
      },
    },
  ].map(
    ({ name, byAccount, expect }): SolverCell => ({
      name,
      taxYear: 2025,
      birth: ['1958-01-01', '1985-06-01'],
      plans: [R401K_M1, R403B_M2],
      ledgerOrder: 'both',
      // m1's $100k basis is a 2012 rollover, out of its recapture window; m2 has no recorded facts
      facts: [{ id: 'roth-401k-m1', owner: M1, basis: 10_000_000, clock: 2012, lots: [[2012, 10_000_000]] }],
      pool: [[M1, 20_000_000]],
      draw: {
        rothDollars: byAccount.reduce((sum, [, dollars]) => sum + (dollars as number), 0),
        rothDesignatedDollars: byAccount.reduce((sum, [, dollars]) => sum + (dollars as number), 0),
        rothDesignatedDollarsByAccountId: new Map(byAccount as Array<[string, number]>),
      },
      expect: expect as SolverCell['expect'],
    }),
  ),
];

describe('buildSolverPenaltyAccountsForYear — §408A Roth-IRA slice', () => {
  it.each(ROTH_IRA_CELLS.map((cell) => [cell.name, cell] as const))('%s', (_name, cell) =>
    itSolverCell(cell),
  );
});

describe('buildSolverPenaltyAccountsForYear — §402A designated slice', () => {
  it.each(DESIGNATED_CELLS.map((cell) => [cell.name, cell] as const))('%s', (_name, cell) =>
    itSolverCell(cell),
  );
});

describe('buildSolverPenaltyAccountsForYear — carrier edge cases', () => {
  const twoOwnerIraCtx = () =>
    rothCtx(
      ['1985-01-01', '1985-01-01'],
      [
        { id: 'roth-a', owner: M1 },
        { id: 'roth-b', owner: M2 },
      ],
    );
  const ledgerAccounts = [
    ledgerAccount({ id: 'roth-a', owner: M1 }),
    ledgerAccount({ id: 'roth-b', owner: M2 }),
  ];

  it('does not add safe-integer basis across different owners', () => {
    const entry = () => ({
      rothBasisRemainingCents: Number.MAX_SAFE_INTEGER,
      rothCumulativeWithdrawnCents: 0,
    });
    const carrier: RothBasisCarrier = new Map([
      [M1, entry()],
      [M2, entry()],
    ]);
    expect(() =>
      buildSolverPenaltyAccountsForYear({
        ctx: twoOwnerIraCtx(),
        ledgerAccounts,
        classification: { preTaxDollars: 0, postTaxCashLikeDollars: 0, rothDollars: 0.01 },
        rothBasisCarrier: carrier,
        designatedRoth: new Map(),
        taxYear: 2030,
      }),
    ).not.toThrow();
    expect(carrier.get(M1)?.rothBasisRemainingCents).toBe(Number.MAX_SAFE_INTEGER - 1);
    expect(carrier.get(M2)?.rothBasisRemainingCents).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('funds one owner’s in-window conversion recapture without consuming the other owner’s lot', () => {
    const seeds = mergeFactBasedRothIraSeeds(
      new Map(),
      new Map([
        [M1, 2_000_000],
        [M2, 10_000_000],
      ]),
      new Map([
        [M1, new Map([[2024, 2_000_000]])],
        [M2, new Map([[2024, 10_000_000]])],
      ]),
    );
    const fundingCarrier = seedFactBasedRothBasisCarrier(seeds);
    const annotationCarrier = seedFactBasedRothBasisCarrier(seeds);
    const funding = buildSolverPenaltyAccountsForYear({
      ctx: twoOwnerIraCtx(),
      ledgerAccounts,
      classification: { preTaxDollars: 0, postTaxCashLikeDollars: 0, rothDollars: 30_000 },
      rothBasisCarrier: fundingCarrier,
      designatedRoth: new Map(),
      taxYear: 2025,
    });
    const annotation = applyFactBasedRothIraOrdering(annotationCarrier.get(M1)!, {
      withdrawalCents: 3_000_000,
      distributionTaxYear: 2025,
      ownerReached59Half: false,
    });
    expect(funding.rothEarningsExcessDollars).toBe(10_000);
    expect(funding.penaltyAccounts[0].penaltyPreTaxWithdrawalDollars).toBe(30_000);
    expect(funding.rothEarningsExcessDollars * 100).toBe(annotation.incomeTaxableCents);
    expect(funding.penaltyAccounts[0].penaltyPreTaxWithdrawalDollars * 100).toBe(
      annotation.additionalTaxBaseCents,
    );
    expect(fundingCarrier.get(M1)?.conversionLots).toEqual([]);
    expect(fundingCarrier.get(M2)?.conversionLots?.[0].taxableRemainingCents).toBe(10_000_000);
  });
});

describe('buildSolverPenaltyAccountsForYear — §408A + §402A slices in one year', () => {
  const emptySeries = { startYear: 2025, startMonthIndex: 0, values: new Float64Array(12) };

  it('runs each slice against its own state and sums their independent figures', () => {
    // §408A: $6k against $4k basis, clock absent → $2k earnings. §402A: $4k against a $100k pool with $6k basis
    // (2024 lot) → basis $240, earnings $3,760, base $3,760 + $240.
    const ctx = makeCtx({
      primaryBirthdate: '1985-01-01',
      accountProjections: [
        {
          id: 'roth-ira',
          taxTreatment: 'ROTH',
          accountType: 'RETIREMENT_ROTH_IRA',
          ownerId: 'member-primary',
        },
        {
          id: 'roth-401k',
          taxTreatment: 'ROTH',
          accountType: 'RETIREMENT_ROTH_401K',
          ownerId: 'member-primary',
        },
      ],
    });
    const ledgerAccounts: DrawdownAccountInput[] = [
      {
        id: 'roth-ira',
        initialPre: 0,
        initialPost: 50_000,
        annualRatePct: 0,
        taxTreatment: 'ROTH',
        accountType: 'RETIREMENT_ROTH_IRA',
        depositsByMonth: emptySeries,
      },
      {
        id: 'roth-401k',
        initialPre: 0,
        initialPost: 100_000,
        annualRatePct: 0,
        taxTreatment: 'ROTH',
        accountType: 'RETIREMENT_ROTH_401K',
        depositsByMonth: emptySeries,
      },
    ];
    const carrier: RothBasisCarrier = new Map([
      [
        'member-primary',
        { rothBasisRemainingCents: 400_000, rothCumulativeWithdrawnCents: 0 },
      ],
    ]);
    const designatedRoth = seedSolverDesignatedRothStates(
      new Map([
        [
          'roth-401k',
          {
            accountId: 'roth-401k',
            ownerId: 'member-primary',
            basisCents: 600_000,
            firstParticipationTaxYear: 2005,
            inPlanRolloverLots: [
              {
                taxYear: 2024,
                taxableRolloverPrincipalCents: 600_000,
                nontaxableRolloverPrincipalCents: 0,
              },
            ],
            isGovernmental457b: false,
          },
        ],
      ]),
      new Map([['member-primary', 10_000_000]]),
    );
    const { penaltyAccounts, rothEarningsExcessDollars } = buildSolverPenaltyAccountsForYear({
      ctx,
      taxYear: 2025,
      ledgerAccounts,
      classification: {
        preTaxDollars: 0,
        postTaxCashLikeDollars: 0,
        rothDollars: 10_000,
        rothDesignatedDollars: 4_000,
      },
      rothBasisCarrier: carrier,
      designatedRoth,
    });
    // Sum of the two independently computed slices: $2,000 + $3,760.
    expect(rothEarningsExcessDollars).toBe(5_760);
    expect(penaltyAccounts).toEqual([
      {
        id: 'roth-ira',
        type: 'RETIREMENT_ROTH_IRA',
        ownerId: 'member-primary',
        penaltyPreTaxWithdrawalDollars: 2_000,
        rothOrderedAdditionalTaxBase: true,
        hsaWithdrawalDollars: 0,
      },
      {
        id: 'roth-401k',
        type: 'RETIREMENT_ROTH_401K',
        ownerId: 'member-primary',
        penaltyPreTaxWithdrawalDollars: 4_000,
        rothOrderedAdditionalTaxBase: true,
        hsaWithdrawalDollars: 0,
      },
    ]);
    expect(carrier.get('member-primary')).toEqual({
      rothBasisRemainingCents: 0,
      rothCumulativeWithdrawnCents: 600_000,
    });
    // $240 pro-rata basis comes off the lot; the balance rolls forward by $4k.
    const state = designatedRoth.get('member-primary');
    expect(state?.entry.designatedRothBasisRemainingCents).toBe(576_000);
    expect(state?.entry.inPlanRolloverLots[0].taxableRolloverPrincipalRemainingCents).toBe(
      576_000,
    );
    expect(state?.balanceRemainingCents).toBe(9_600_000);
  });
});

describe('seedSolverDesignatedRothStates — pools one owner’s plans conservatively', () => {
  it('sums basis, aggregates lots per tax year ascending, drops the clock when any plan lacks one, and 457(b)-flags only an all-457(b) owner', () => {
    // Lots are listed later year first to prove the sort. An any-accumulated 457(b) flag would waive the 401(k)'s 10%;
    // a dropped anyClockMissing would read the pooled clock as met.
    const states = seedSolverDesignatedRothStates(
      new Map([
        [
          'roth-401k',
          {
            accountId: 'roth-401k',
            ownerId: 'member-primary',
            basisCents: 200_000,
            inPlanRolloverLots: [
              {
                taxYear: 2024,
                taxableRolloverPrincipalCents: 150_000,
                nontaxableRolloverPrincipalCents: 50_000,
              },
            ],
            isGovernmental457b: false,
          },
        ],
        [
          'roth-457b',
          {
            accountId: 'roth-457b',
            ownerId: 'member-primary',
            basisCents: 100_000,
            firstParticipationTaxYear: 2010,
            inPlanRolloverLots: [
              {
                taxYear: 2022,
                taxableRolloverPrincipalCents: 100_000,
                nontaxableRolloverPrincipalCents: 0,
              },
            ],
            isGovernmental457b: true,
          },
        ],
      ]),
      new Map([['member-primary', 1_000_000]]),
    );
    expect(states.size).toBe(1);
    const state = states.get('member-primary');
    expect(state?.entry.designatedRothBasisRemainingCents).toBe(300_000);
    expect(state?.entry.firstParticipationTaxYear).toBeUndefined();
    expect(state?.entry.isGovernmental457b).toBe(false);
    expect(state?.entry.inheritedFromDeceasedOwner).toBeUndefined();
    expect(state?.entry.inPlanRolloverLots).toEqual([
      {
        taxYear: 2022,
        taxableRolloverPrincipalRemainingCents: 100_000,
        nontaxableRolloverPrincipalRemainingCents: 0,
      },
      {
        taxYear: 2024,
        taxableRolloverPrincipalRemainingCents: 150_000,
        nontaxableRolloverPrincipalRemainingCents: 50_000,
      },
    ]);
    expect(state?.balanceRemainingCents).toBe(1_000_000);
  });
});

describe('funding pass — inherited designated-Roth plan (§72(t)(2)(A)(ii))', () => {
  const emptySeries = { startYear: 2025, startMonthIndex: 0, values: new Float64Array(12) };
  // Inherited plans record no rollover, so derived basis is $0 and only the death event qualifies the draw.
  const inheritedFacts = (firstParticipationTaxYear?: number) =>
    new Map([
      [
        'roth-401k-inherited',
        {
          accountId: 'roth-401k-inherited',
          ownerId: 'member-primary',
          basisCents: 0,
          ...(firstParticipationTaxYear !== undefined ? { firstParticipationTaxYear } : {}),
          inPlanRolloverLots: [],
          isGovernmental457b: false,
          inheritedFromDeceasedOwner: true,
        },
      ],
    ]);

  const inheritedHousehold = () => {
    const ctx = makeCtx({
      primaryBirthdate: '1985-01-01',
      accountProjections: [
        {
          id: 'roth-401k-inherited',
          taxTreatment: 'ROTH',
          accountType: 'RETIREMENT_ROTH_401K',
          ownerId: 'member-primary',
        },
      ],
      rmdProfileFactsByAccountId: new Map([
        ['roth-401k-inherited', { inheritedAccount: true }],
      ]),
    });
    const ledgerAccounts = [
      {
        id: 'roth-401k-inherited',
        initialPre: 0,
        initialPost: 700_000,
        annualRatePct: 0,
        taxTreatment: 'ROTH',
        accountType: 'RETIREMENT_ROTH_401K',
        depositsByMonth: emptySeries,
      } as DrawdownAccountInput,
    ];
    return { ctx, ledgerAccounts };
  };

  it('seeds the inherited plan into the INHERITED pooled state only, flag carried', () => {
    // The non-inherited seed must skip an inherited plan, or its basis would shield a sibling's lots.
    const facts = inheritedFacts(2005);
    expect(
      seedSolverDesignatedRothStates(facts, new Map([['member-primary', 70_000_000]])).size,
    ).toBe(0);
    const inherited = seedSolverInheritedDesignatedRothStates(
      facts,
      new Map([['member-primary', 70_000_000]]),
    );
    expect(inherited.size).toBe(1);
    const entry = inherited.get('member-primary')?.entry;
    expect(entry?.inheritedFromDeceasedOwner).toBe(true);
    expect(entry?.firstParticipationTaxYear).toBe(2005);
    expect(inherited.get('member-primary')?.balanceRemainingCents).toBe(70_000_000);
    expect(
      seedSolverInheritedDesignatedRothStates(
        new Map([
          [
            'roth-401k',
            {
              accountId: 'roth-401k',
              ownerId: 'member-primary',
              basisCents: 100_000,
              inPlanRolloverLots: [],
              isGovernmental457b: false,
            },
          ],
        ]),
        new Map(),
      ).size,
    ).toBe(0);
  });

  it('funds NO tax on a met-clock inherited draw even at $0 derived basis (death is the qualifying event)', () => {
    // Death qualifies the draw (§402A(d)(2)(B)(i)): $0 income even at $0 derived basis, where the §408A carrier would fund
    // $40k of income plus a $4k additional tax.
    const { ctx, ledgerAccounts } = inheritedHousehold();
    const { penaltyAccounts, rothEarningsExcessDollars } = buildSolverPenaltyAccountsForYear({
      ctx,
      taxYear: 2025,
      ledgerAccounts,
      classification: {
        preTaxDollars: 0,
        postTaxCashLikeDollars: 0,
        rothDollars: 40_000,
        rothInheritedDesignatedDollars: 40_000,
      },
      rothBasisCarrier: new Map(),
      designatedRoth: new Map(),
      inheritedDesignatedRoth: seedSolverInheritedDesignatedRothStates(
        inheritedFacts(2005),
        new Map([['member-primary', 70_000_000]]),
      ),
    });
    expect(rothEarningsExcessDollars).toBe(0);
    expect(penaltyAccounts).toEqual([]);
  });

  it('taxes an UNMET-clock inherited draw pro rata as income but never funds a 10%', () => {
    // Open 2024 clock, $0 basis: the whole draw is ordinary income but never a 10% snapshot.
    const { ctx, ledgerAccounts } = inheritedHousehold();
    const inheritedDesignatedRoth = seedSolverInheritedDesignatedRothStates(
      inheritedFacts(2024),
      new Map([['member-primary', 70_000_000]]),
    );
    const { penaltyAccounts, rothEarningsExcessDollars } = buildSolverPenaltyAccountsForYear({
      ctx,
      taxYear: 2025,
      ledgerAccounts,
      classification: {
        preTaxDollars: 0,
        postTaxCashLikeDollars: 0,
        rothDollars: 40_000,
        rothInheritedDesignatedDollars: 40_000,
      },
      rothBasisCarrier: new Map(),
      designatedRoth: new Map(),
      inheritedDesignatedRoth,
    });
    expect(rothEarningsExcessDollars).toBe(40_000);
    expect(penaltyAccounts).toEqual([]);
    expect(inheritedDesignatedRoth.get('member-primary')?.balanceRemainingCents).toBe(
      66_000_000,
    );
  });

  it('each beneficiary’s dollars charge their OWN state under their OWN clock, in EITHER ledger order', () => {
    // m1's open 2024 clock must not tax m2's qualified draw (met 2005 clock, $200k basis over a $400k pool), even when m1
    // draws nothing.
    const inheritedTwoOwnerFacts = () =>
      new Map([
        [
          'roth-403b-inh-m1',
          {
            accountId: 'roth-403b-inh-m1',
            ownerId: 'member-primary',
            basisCents: 0,
            firstParticipationTaxYear: 2024,
            inPlanRolloverLots: [],
            isGovernmental457b: false,
            inheritedFromDeceasedOwner: true,
          },
        ],
        [
          'roth-401k-inh-m2',
          {
            accountId: 'roth-401k-inh-m2',
            ownerId: 'member-secondary',
            basisCents: 20_000_000,
            firstParticipationTaxYear: 2005,
            inPlanRolloverLots: [
              {
                taxYear: 2005,
                taxableRolloverPrincipalCents: 20_000_000,
                nontaxableRolloverPrincipalCents: 0,
              },
            ],
            isGovernmental457b: false,
            inheritedFromDeceasedOwner: true,
          },
        ],
      ]);
    const inheritedLedger = (
      id: string,
      accountType: 'RETIREMENT_ROTH_401K' | 'RETIREMENT_ROTH_403B',
    ): DrawdownAccountInput => ({
      id,
      initialPre: 0,
      initialPost: 100_000,
      annualRatePct: 0,
      taxTreatment: 'ROTH',
      accountType,
      depositsByMonth: emptySeries,
    });
    const run = (
      order: 'forward' | 'reversed',
      dollarsByAccountId: ReadonlyArray<readonly [string, number]>,
    ) => {
      const ctx = makeCtx({
        primaryBirthdate: '1985-01-01',
        secondaryBirthdate: '1985-06-01',
        accountProjections: [
          {
            id: 'roth-403b-inh-m1',
            taxTreatment: 'ROTH',
            accountType: 'RETIREMENT_ROTH_403B',
            ownerId: 'member-primary',
          },
          {
            id: 'roth-401k-inh-m2',
            taxTreatment: 'ROTH',
            accountType: 'RETIREMENT_ROTH_401K',
            ownerId: 'member-secondary',
          },
        ],
        rmdProfileFactsByAccountId: new Map([
          ['roth-403b-inh-m1', { inheritedAccount: true }],
          ['roth-401k-inh-m2', { inheritedAccount: true }],
        ]),
      });
      const inheritedDesignatedRoth = seedSolverInheritedDesignatedRothStates(
        inheritedTwoOwnerFacts(),
        new Map([
          ['member-primary', 10_000_000],
          ['member-secondary', 40_000_000],
        ]),
      );
      const accounts = [
        inheritedLedger('roth-403b-inh-m1', 'RETIREMENT_ROTH_403B'),
        inheritedLedger('roth-401k-inh-m2', 'RETIREMENT_ROTH_401K'),
      ];
      const total = dollarsByAccountId.reduce((sum, [, d]) => sum + d, 0);
      const result = buildSolverPenaltyAccountsForYear({
        ctx,
        taxYear: 2026,
        ledgerAccounts: order === 'forward' ? accounts : [...accounts].reverse(),
        classification: {
          preTaxDollars: 0,
          postTaxCashLikeDollars: 0,
          rothDollars: total,
          rothInheritedDesignatedDollars: total,
          rothInheritedDesignatedDollarsByAccountId: new Map(dollarsByAccountId),
        },
        rothBasisCarrier: new Map(),
        designatedRoth: new Map(),
        inheritedDesignatedRoth,
      });
      return { ...result, inheritedDesignatedRoth };
    };

    for (const order of ['forward', 'reversed'] as const) {
      const fromM1 = run(order, [['roth-403b-inh-m1', 30_000]]);
      expect(fromM1.rothEarningsExcessDollars).toBe(30_000);
      expect(fromM1.penaltyAccounts).toEqual([]);
      expect(
        fromM1.inheritedDesignatedRoth.get('member-primary')?.balanceRemainingCents,
      ).toBe(7_000_000);
      expect(
        fromM1.inheritedDesignatedRoth.get('member-secondary')?.entry
          .designatedRothBasisRemainingCents,
      ).toBe(20_000_000);
      expect(
        fromM1.inheritedDesignatedRoth.get('member-secondary')?.balanceRemainingCents,
      ).toBe(40_000_000);

      // m2's met clock and the death event qualify the draw; the 50% basis fraction consumes $15k in either ledger order.
      const fromM2 = run(order, [['roth-401k-inh-m2', 30_000]]);
      expect(fromM2.rothEarningsExcessDollars).toBe(0);
      expect(fromM2.penaltyAccounts).toEqual([]);
      expect(
        fromM2.inheritedDesignatedRoth.get('member-secondary')?.entry
          .designatedRothBasisRemainingCents,
      ).toBe(18_500_000);
      expect(
        fromM2.inheritedDesignatedRoth.get('member-secondary')?.entry.inPlanRolloverLots[0]
          .taxableRolloverPrincipalRemainingCents,
      ).toBe(18_500_000);
      expect(
        fromM2.inheritedDesignatedRoth.get('member-secondary')?.balanceRemainingCents,
      ).toBe(37_000_000);
      expect(
        fromM2.inheritedDesignatedRoth.get('member-primary')?.balanceRemainingCents,
      ).toBe(10_000_000);
    }
  });
});

describe('solver designated-Roth funding — MIXED account routing', () => {
  const emptySeries = { startYear: 2025, startMonthIndex: 0, values: new Float64Array(12) };
  const mixedLedger = (
    id: string,
    initialPre: number,
    initialPost: number,
  ): DrawdownAccountInput => ({
    id,
    initialPre,
    initialPost,
    annualRatePct: 0,
    taxTreatment: 'MIXED',
    accountType: 'RETIREMENT_401K',
    depositsByMonth: emptySeries,
  });

  it('sizes only the MIXED post pocket and partitions inherited plans', () => {
    const ctx = makeCtx({
      secondaryBirthdate: '1985-01-01',
      accountProjections: [
        {
          id: 'mixed-own',
          taxTreatment: 'MIXED',
          accountType: 'RETIREMENT_401K',
          ownerId: 'member-primary',
        },
        {
          id: 'mixed-inherited',
          taxTreatment: 'MIXED',
          accountType: 'RETIREMENT_403B',
          ownerId: 'member-secondary',
        },
      ],
      rmdProfileFactsByAccountId: new Map([
        ['mixed-inherited', { inheritedAccount: true }],
      ]),
    });
    const ledgers: DrawdownAccountInput[] = [
      mixedLedger('mixed-own', 900_000, 10_000),
      {
        ...mixedLedger('mixed-inherited', 800_000, 20_000),
        accountType: 'RETIREMENT_403B',
      },
    ];
    expect([...solverDesignatedRothBalanceCentsByOwner(ctx, ledgers)]).toEqual([
      ['member-primary', 1_000_000],
    ]);
    expect([...solverDesignatedRothBalanceCentsByOwner(ctx, ledgers, true)]).toEqual([
      ['member-secondary', 2_000_000],
    ]);
  });

  it('routes a committed MIXED post draw into the §402A slice and applies its pro-rata split', () => {
    const ctx = makeCtx({
      primaryBirthdate: '1985-01-01',
      accountProjections: [
        {
          id: 'mixed-own',
          taxTreatment: 'MIXED',
          accountType: 'RETIREMENT_401K',
          ownerId: 'member-primary',
        },
      ],
    });
    const ledger = mixedLedger('mixed-own', 900_000, 100_000);
    const runState: AccountRunState = {
      id: 'mixed-own',
      pre: 900_000,
      post: 100_000,
      annualRatePct: 0,
      monthlyRate: 0,
      taxTreatment: 'MIXED',
      accountType: 'RETIREMENT_401K',
      deposits: new Float64Array(0),
      depositsPost: new Float64Array(0),
    };
    const classification = classifyCommittedYearDraw([runState], [0], [10_000]);
    expect(classification).toMatchObject({
      preTaxDollars: 0,
      postTaxNonRothDollars: 0,
      rothDollars: 10_000,
      rothDesignatedDollars: 10_000,
    });

    const designatedRoth = seedSolverDesignatedRothStates(
      new Map([
        [
          'mixed-own',
          {
            accountId: 'mixed-own',
            ownerId: 'member-primary',
            basisCents: 2_000_000,
            firstParticipationTaxYear: 2005,
            inPlanRolloverLots: [
              {
                taxYear: 2024,
                taxableRolloverPrincipalCents: 2_000_000,
                nontaxableRolloverPrincipalCents: 0,
              },
            ],
            isGovernmental457b: false,
          },
        ],
      ]),
      solverDesignatedRothBalanceCentsByOwner(ctx, [ledger]),
    );
    const result = buildSolverPenaltyAccountsForYear({
      ctx,
      taxYear: 2025,
      ledgerAccounts: [ledger],
      classification,
      rothBasisCarrier: new Map(),
      designatedRoth,
    });
    // $20k basis / $100k post pocket × $10k draw = $2k basis, $8k earnings; the in-window lot makes the base the full $10k.
    expect(result.rothEarningsExcessDollars).toBe(8_000);
    expect(result.penaltyAccounts[0].penaltyPreTaxWithdrawalDollars).toBe(10_000);
    const state = designatedRoth.get('member-primary');
    expect(state?.entry.designatedRothBasisRemainingCents).toBe(1_800_000);
    expect(
      state?.entry.inPlanRolloverLots[0].taxableRolloverPrincipalRemainingCents,
    ).toBe(1_800_000);
    expect(state?.balanceRemainingCents).toBe(9_000_000);
  });
});

describe('buildTaxCashflowHook — dated Roth-IRA conversion recapture', () => {
  const emptySeries = { startYear: 2024, startMonthIndex: 0, values: new Float64Array(12) };
  const ledger: DrawdownAccountInput = {
    id: 'roth-own',
    initialPre: 0,
    initialPost: 100_000,
    annualRatePct: 0,
    taxTreatment: 'ROTH',
    accountType: 'RETIREMENT_ROTH_IRA',
    depositsByMonth: emptySeries,
  };
  const classifyAllRoth = (target: number) => ({
    preTaxDollars: 0,
    postTaxNonRothDollars: 0,
    postTaxCashLikeDollars: 0,
    rothDollars: target,
    fundedDollars: target,
  });

  function solveWithCtx(ctx: PipelineContext, taxYear: number) {
    return buildTaxCashflowHook({
      ctx,
      ssRows: [],
      nonSsIncomeRows: [],
      ledgerAccounts: [ledger],
      bundle: REAL_BUNDLE,
      retirementYear: taxYear,
    }).solveForYear(0, 10_000, classifyAllRoth);
  }

  it('funds an engine-generated conversion lot inside its five-tax-year window', () => {
    const base = makeCtx({
      primaryBirthdate: '1985-01-01',
      primaryRetirementYear: 2024,
      accountProjections: [
        {
          id: 'roth-own',
          taxTreatment: 'ROTH',
          accountType: 'RETIREMENT_ROTH_IRA',
          ownerId: 'member-primary',
        },
      ],
      preRetirementConversionBasisCentsByOwner: new Map([
        ['member-primary', 1_000_000],
      ]),
    });
    const inWindow: PipelineContext = {
      ...base,
      preRetirementConversionBasisCentsByOwnerYear: new Map([
        ['member-primary', new Map([[2023, 1_000_000]])],
      ]),
    };
    const outcome = solveWithCtx(inWindow, 2024);
    // The $10k converted principal is income-tax-free but is the full 10% recapture base: $1,000 of federal tax.
    expect(outcome.federalTaxCashNeedCents).toBe(100_000);
    expect(outcome.addedNeedDollars).toBe(1_000);
  });

  it('a recorded conversion funds recapture in-window and drops at the exact five-year boundary', () => {
    const account = {
      id: 'roth-own',
      payload: {
        name: 'Roth IRA',
        type: 'RETIREMENT_ROTH_IRA',
        ownershipType: 'INDIVIDUAL',
        taxTreatment: 'ROTH',
        ownerId: 'member-primary',
        institution: '',
        notes: '',
        planningReturnPct: 0,
        active: true,
        plannedContributionPreTax: 0,
        plannedContributionPostTax: 0,
        assetMix: { stocksPct: 0, bondsPct: 0, cashPct: 100 },
      } as AccountPayload,
    };
    const recordedRow = {
      payload: {
        accountId: 'roth-own',
        year: 2020,
        lastUpdated: '2020-12-31',
        rothConversionTaxableAmount: 10_000,
      } as AccountBalancePayload,
    };
    const rothDistributionFacts = buildRothDistributionFacts([account], [recordedRow]);
    const contextFor = (taxYear: number): PipelineContext =>
      makeCtx({
        primaryBirthdate: '1985-01-01',
        primaryRetirementYear: taxYear,
        accountProjections: [
          {
            id: 'roth-own',
            taxTreatment: 'ROTH',
            accountType: 'RETIREMENT_ROTH_IRA',
            ownerId: 'member-primary',
          },
        ],
        rothDistributionFacts,
      });
    const annotationFor = (taxYear: number) => {
      const carrier = seedFactBasedRothBasisCarrier(
        rothDistributionFacts.rothIraByPool,
      );
      return applyFactBasedRothIraOrdering(carrier.get('member-primary')!, {
        withdrawalCents: 1_000_000,
        distributionTaxYear: taxYear,
        ownerReached59Half: false,
      });
    };

    const inWindowAnnotation = annotationFor(2024);
    const inWindowFunding = solveWithCtx(contextFor(2024), 2024);
    expect(inWindowAnnotation.additionalTaxBaseCents).toBe(1_000_000);
    expect(inWindowFunding.federalTaxCashNeedCents).toBe(
      inWindowAnnotation.additionalTaxBaseCents / 10,
    );

    const boundaryAnnotation = annotationFor(2025);
    const boundaryFunding = solveWithCtx(contextFor(2025), 2025);
    expect(boundaryAnnotation.additionalTaxBaseCents).toBe(0);
    expect(boundaryFunding.federalTaxCashNeedCents).toBe(0);
    expect(boundaryFunding.addedNeedDollars).toBe(0);
  });
});

describe('buildRothDistributionFacts — POST_TAX designated-Roth TSP (accepted gap)', () => {
  // A POST_TAX TSP yields no designated-Roth fact on purpose: accepting it would blank the pooled five-year clock
  // (`resolveRothStartYear` has no evidence path for it; see roth-start-year.test.ts).
  function tspAccount(id: string, over: Partial<AccountPayload> = {}) {
    return {
      id,
      payload: {
        name: 'Roth TSP',
        type: 'RETIREMENT_TSP',
        ownershipType: 'INDIVIDUAL',
        taxTreatment: 'POST_TAX',
        ownerId: 'member-primary',
        institution: '',
        notes: '',
        planningReturnPct: 0,
        active: true,
        plannedContributionPreTax: 0,
        plannedContributionPostTax: 0,
        assetMix: { stocksPct: 0, bondsPct: 0, cashPct: 100 },
        ...over,
      } as AccountPayload,
    };
  }

  function mixed401kAccount(id: string, over: Partial<AccountPayload> = {}) {
    return {
      id,
      payload: {
        name: 'Mixed 401k',
        type: 'RETIREMENT_401K',
        ownershipType: 'INDIVIDUAL',
        taxTreatment: 'MIXED',
        ownerId: 'member-primary',
        institution: '',
        notes: '',
        planningReturnPct: 0,
        active: true,
        plannedContributionPreTax: 0,
        plannedContributionPostTax: 0,
        assetMix: { stocksPct: 0, bondsPct: 0, cashPct: 100 },
        ...over,
      } as AccountPayload,
    };
  }

  it('produces no designated-Roth fact for an active POST_TAX TSP, recorded rollover or not', () => {
    const withRollover = tspAccount('tsp-roth');
    const recordedRow = {
      payload: {
        accountId: 'tsp-roth',
        year: 2020,
        lastUpdated: '2020-12-31',
        rothInPlanRolloverTaxableAmount: 5_000,
      } as AccountBalancePayload,
    };
    const facts = buildRothDistributionFacts([withRollover], [recordedRow]);
    expect(facts.designatedByAccount.get('tsp-roth')).toBeUndefined();

    const withoutRollover = tspAccount('tsp-roth-empty');
    const factsEmpty = buildRothDistributionFacts([withoutRollover], []);
    expect(factsEmpty.designatedByAccount.get('tsp-roth-empty')).toBeUndefined();
  });

  it('leaves a sibling MIXED designated-Roth account fact — clock included — unaffected by a POST_TAX TSP in the same household', () => {
    const tsp = tspAccount('tsp-roth', { designatedRothFirstParticipationTaxYear: 2015 });
    const mixed = mixed401kAccount('mixed-401k', {
      designatedRothFirstParticipationTaxYear: 2010,
    });
    const balances = [
      {
        payload: {
          accountId: 'tsp-roth',
          year: 2020,
          lastUpdated: '2020-12-31',
          rothInPlanRolloverTaxableAmount: 5_000,
        } as AccountBalancePayload,
      },
      {
        payload: {
          accountId: 'mixed-401k',
          year: 2020,
          lastUpdated: '2020-12-31',
          rothInPlanRolloverTaxableAmount: 9_000,
        } as AccountBalancePayload,
      },
    ];
    const facts = buildRothDistributionFacts([tsp, mixed], balances);
    expect(facts.designatedByAccount.get('tsp-roth')).toBeUndefined();
    const mixedFact = facts.designatedByAccount.get('mixed-401k');
    expect(mixedFact).toBeDefined();
    expect(mixedFact!.firstParticipationTaxYear).toBe(2010);
    expect(mixedFact!.basisCents).toBe(900_000);
  });
});
