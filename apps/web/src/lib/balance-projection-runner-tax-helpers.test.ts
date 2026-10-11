/**
 * Unit tests for `balance-projection-runner-tax-helpers.ts` pure helpers
 * (the deterministic tax post-pass helpers).
 *
 * Covers two interacting age-65 rules:
 *  - Born-Jan-1: hasAttainedAgeByYearEnd treats a Jan-1 birthday as
 *    reaching the age on Dec 31 of the prior year; feeds the senior /
 *    standard-deduction age-65 count.
 *  - Medicare 65th-birthday MONTH onset: entitlement
 *    begins in the month the member turns 65 — the month BEFORE for a
 *    first-of-month birthday — so the turning-65 year is split between
 *    Marketplace and Medicare months rather than being all-or-nothing. This
 *    decouples the member's Medicare months from the age-65 standard-deduction
 *    count, which still follows the born-Jan-1 rule.
 *
 * The Roth §408A basis-carrier tests (`applyRothBasisOrdering` /
 * `creditRothConversionToBasisCarrier`) moved to
 * `balance-projection-runner-roth-basis.test.ts` alongside the source split.
 */
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

// Medicare timing is month-exact, not a whole-year rule (12 Medicare months for a
// January-June birthday, 0 for July-December): entitlement starts in the birthday
// MONTH, or the PRECEDING month for a first-of-month birthday. The deterministic
// runner and the Monte Carlo twin both resolve it through
// `resolveMemberHealthCoverage`.
describe('buildMemberInputs — Medicare 65th-birthday month onset', () => {
  it('splits the turning-65 year between Marketplace and Medicare months', () => {
    // Born March 15 1960 → Medicare March-December 2025 (10 months), Marketplace
    // January-February (2 months).
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
    // Born September 10 1960 → Medicare September-December 2025 (4 months),
    // Marketplace January-August (8). The superseded rule charged ZERO Medicare
    // months here and gave a full 12-month Marketplace year.
    const ctx = makeCtx({ primaryBirthdate: '1960-09-10', primaryRetirementYear: 2024 });
    const yearN = buildMemberInputs(ctx, 2025, true, false);
    expect(yearN[0].onMedicare).toBe(true);
    expect(yearN[0].partBEnrollmentMonths).toBe(4);
    expect(yearN[0].hasAcaCoverage).toBe(true);
    expect(yearN[0].marketplaceCoverageMonths).toBe(8);
    // The following whole tax year (N+1 = 2026): age 66 → 12 Medicare months.
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

  // The deterministic half of the twin, mirroring the three MC cases.
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

  // An IMPORTED member payload is validated at the
  // envelope only, so a structurally-numeric but IMPOSSIBLE calendar date is
  // reachable. It used to default month/day and charge a full Medicare year
  // (with real IRMAA surcharges) for a date that does not exist.
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
    // Stated Medicare months are recorded facts and survive …
    expect(m.partBEnrollmentMonths).toBe(6);
    // … but the age-priced Marketplace benchmark cannot be computed without a
    // real birthdate, so those months are still dropped.
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

// ---------------------------------------------------------------------------
// Twin-engine coverage parity: the comparable shape both engines emit per
// member (shared by the staggered-retirement and
// malformed-birthdate blocks below).
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Staggered retirement: deterministic vs Monte Carlo
// ---------------------------------------------------------------------------

/**
 * The twin contract in its sharpest form. A household whose members retire in
 * DIFFERENT years must resolve the same coverage on both engines: the still
 * WORKING spouse has employer coverage, so they get no automatic Marketplace
 * months until the year THEY separate.
 *
 * Monte Carlo used to pass ONE household `retirementYear` scalar (the
 * primary's) to both members, so the secondary was switched onto the
 * Marketplace as soon as the PRIMARY retired — six years early here, with a
 * premium tax credit, a different tax bill and different path balances than the
 * deterministic engine reported for the same plan.
 *
 * Both sides are driven from the SAME `PipelineContext` through the production
 * builders, so nothing about the divergence can hide in test scaffolding.
 */
describe('staggered retirement — deterministic vs Monte Carlo coverage parity', () => {
  const PRIMARY_RETIREMENT_YEAR = 2026;
  const SECONDARY_RETIREMENT_YEAR = 2032;

  const staggeredCtx = (): PipelineContext =>
    makeCtx({
      // Primary is 68 in 2026 (already on Medicare); the secondary is 51 and
      // keeps working — and their employer coverage — until 2032, retiring at
      // 57, well before Medicare age.
      primaryBirthdate: '1958-03-15',
      secondaryBirthdate: '1975-03-15',
      primaryRetirementYear: PRIMARY_RETIREMENT_YEAR,
      secondaryRetirementYear: SECONDARY_RETIREMENT_YEAR,
    });

  const mcSurvivorsFor = (ctx: PipelineContext, taxYear: number) => {
    const taxCtx = buildMcTaxContext(ctx);
    expect(taxCtx).toBeDefined();
    // The household scalar every MC entry point passes IS the primary's year.
    const state = deriveMcSurvivors(taxCtx!, taxYear, ctx.primaryRetirementYear);
    expect(state).not.toBeNull();
    return state!.survivors;
  };

  it('the still-working spouse gets NO Marketplace months on either engine', () => {
    const ctx = staggeredCtx();
    // 2028: the primary has been retired two years, the secondary works on.
    const deterministic = buildMemberInputs(ctx, 2028, true, true);
    const mc = mcSurvivorsFor(ctx, 2028);

    expect(mc.map(coverageOf)).toEqual(deterministic.map(coverageOf));

    // …and the agreed answer is the CORRECT one, not merely a matching pair.
    const secondary = deterministic.find((m) => m.memberId === 'member-secondary');
    expect(secondary?.marketplaceCoverageMonths).toBe(0);
    expect(secondary?.hasAcaCoverage).toBe(false);
    // The retired primary is past 65, so they are on Medicare all year.
    const primary = deterministic.find((m) => m.memberId === 'member-primary');
    expect(primary?.partBEnrollmentMonths).toBe(12);
  });

  it('the spouse joins the Marketplace in THEIR OWN retirement year, on both engines', () => {
    const ctx = staggeredCtx();
    // 2031 — the secondary's last working year: employer coverage, no ACA.
    const working = buildMemberInputs(ctx, 2031, true, true);
    expect(
      working.find((m) => m.memberId === 'member-secondary')?.marketplaceCoverageMonths,
    ).toBe(0);
    expect(mcSurvivorsFor(ctx, 2031).map(coverageOf)).toEqual(working.map(coverageOf));

    // 2032 — they separate at 57, still eight years from Medicare, so the whole
    // year is Marketplace coverage. Both engines flip in the SAME year.
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
    // A single-member household never staggers either.
    expect(
      buildMcTaxContext(makeCtx({ primaryRetirementYear: PRIMARY_RETIREMENT_YEAR }))
        ?.retirementYearByMember,
    ).toBeUndefined();
    // The staggered household DOES carry it, sorted by member id.
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
    // `retirementByMember` carries a malformed ISO date for the secondary.
    (ctx.retirementByMember as Map<string, string>).set('member-secondary', 'not-a-date');
    const secondary = buildMemberInputs(ctx, 2028, true, true).find(
      (m) => m.memberId === 'member-secondary',
    );
    // Retired since 2026 (the primary's year) — NOT "never retired", which is
    // what an `NaN` comparison silently produced.
    expect(secondary?.retirementYear).toBe(PRIMARY_RETIREMENT_YEAR);
    expect(buildMcTaxContext(ctx)?.retirementYearByMember).toBeUndefined();
    expect(mcSurvivorsFor(ctx, 2028).map(coverageOf)).toEqual(
      buildMemberInputs(ctx, 2028, true, true).map(coverageOf),
    );
  });
});

// ---------------------------------------------------------------------------
// Malformed birthdate: who is still ALIVE?
// ---------------------------------------------------------------------------

/**
 * The same twin contract applied to survivor membership. An imported member
 * payload is validated at the envelope only, so a non-numeric or impossible
 * birthdate reaches both engines. They used to answer differently:
 *
 *  - deterministic: `parseInt('not-a-date')` → `NaN`, and every
 *    `taxYear <= NaN` is `false`, so the member was DEAD IN EVERY YEAR;
 *  - Monte Carlo: `undefined`, i.e. ALIVE INDEFINITELY.
 *
 * With a Marketplace-covered spouse that is a real money difference: household
 * size is the FPL denominator `computeAcaPtc` divides by, so the two engines
 * priced different premium tax credits for the same plan. Both now resolve the
 * SAME death years through `resolveHouseholdDeathYears`, and an unusable
 * birthdate yields NO death year (alive) on both — the direction that never
 * silently deletes a member from the projection.
 */
describe('malformed birthdate — deterministic vs Monte Carlo survivor parity', () => {
  const RETIREMENT_YEAR = 2026;

  /** The production deterministic alive rule, verbatim from
   *  `buildTaxLoopShared` / `buildTaxYearInputs` (`taxYear <= deathYear`, with
   *  the absent year carried as `Infinity`). */
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
      // Primary retires at 51 in 2026 — well before Medicare — so the household
      // IS on the Marketplace and household size prices a real subsidy.
      primaryBirthdate: '1975-03-15',
      secondaryBirthdate,
      primaryRetirementYear: RETIREMENT_YEAR,
      // Same-date anchor: no `secondaryRetirementYear`, so the malformed
      // birthdate alone drives the divergence.
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
      // `undefined`, never `NaN` — `NaN` read as "already dead" in every year.
      expect(secondaryDeathYear).toBeUndefined();
      expect(Number.isNaN(secondaryDeathYear as unknown as number)).toBe(false);
    }

    // A single-member household simply has no secondary year.
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
      // Household SIZE is the FPL denominator `computeAcaPtc` divides by — the
      // two engines must count the same people.
      expect(deterministic).toHaveLength(2);
      expect(mc).toHaveLength(2);
      expect(mc!.map(coverageOf)).toEqual(deterministic.map(coverageOf));
      // …and the Marketplace-covered primary really is priced, so the household
      // size difference would have moved a subsidy.
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

// ---------------------------------------------------------------------------
// hasAttainedAgeByYearEnd — the shared born-Jan-1 boundary helper
// ---------------------------------------------------------------------------

describe('hasAttainedAgeByYearEnd — born-Jan-1 rule', () => {
  it('jan1_1960_attains_65_for_tax_year_2024', () => {
    // IRS rule: born Jan 1 → treated as reaching the age on Dec 31 of the prior
    // year, so a Jan-1-1960 person is 65 for tax year 2024 (naive formula gives
    // 64).
    expect(hasAttainedAgeByYearEnd('1960-01-01', 2024, 65)).toBe(true);
  });

  it('jan1_1960_does_not_attain_65_for_tax_year_2023', () => {
    // The shift is exactly one year — not unbounded.
    expect(hasAttainedAgeByYearEnd('1960-01-01', 2023, 65)).toBe(false);
  });

  it('dec31_1959_attains_65_for_tax_year_2024_control', () => {
    // Control: a Dec-31-1959 person turns 65 in 2024 by birthday — the naive
    // year-only formula already qualified them (2024 − 1959 = 65), so the fix
    // leaves this unchanged.
    expect(hasAttainedAgeByYearEnd('1959-12-31', 2024, 65)).toBe(true);
  });

  it('feb1_1960_is_NOT_shifted_earlier', () => {
    // Only Jan 1 is shifted; a Feb-1-1960 person attains 65 in 2025, not 2024.
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

// ---------------------------------------------------------------------------
// countTaxpayersAge65Plus — deterministic twin. Standard-deduction age-65
// count follows the pure born-Jan-1 rule, independent of the member's Medicare
// months.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// buildMemberInputs onMedicare — born-Jan-1 boundary combined with the
// birthday-MONTH entitlement. A first-of-month birthday starts entitlement the
// PRECEDING month, so a Jan-1 birthday is entitled for all of the attainment
// year; a late-December birthday gets exactly its own month rather than a
// deferral to the following whole year, while the standard-deduction count still
// recognizes them under the pure born-Jan-1 rule (above).
// ---------------------------------------------------------------------------

describe('buildMemberInputs onMedicare — born-Jan-1 + birthday-month onset', () => {
  it('jan1_1960_member_is_onMedicare_for_tax_year_2024', () => {
    // Jan-1 is a first-of-month birthday → entitlement starts the preceding
    // December, so 2024 is a full 12 Medicare months.
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
    // Medicare entitlement starts in the BIRTHDAY MONTH, so a Dec-31-1959
    // member is entitled for exactly one month of 2024 and all of 2025. The
    // age-65 standard-deduction COUNT recognizes them in 2024 under the pure
    // born-Jan-1 rule (asserted in the countTaxpayersAge65Plus block above); the two rules
    // remain deliberately decoupled, and Medicare is month-exact rather than
    // deferred to the following whole year.
    const ctx = makeCtx({ primaryBirthdate: '1959-12-31', primaryRetirementYear: 2020 });
    const y2024 = buildMemberInputs(ctx, 2024, true, false)[0];
    expect(y2024?.onMedicare).toBe(true);
    expect(y2024?.partBEnrollmentMonths).toBe(1);
    const y2025 = buildMemberInputs(ctx, 2025, true, false)[0];
    expect(y2025?.onMedicare).toBe(true);
    expect(y2025?.partBEnrollmentMonths).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// advanceBrokerageLikeBasis — zero-start funded account basis (regression)
// ---------------------------------------------------------------------------

describe('advanceBrokerageLikeBasis — zero-start funded account basis (regression)', () => {
  it('does_not_double_count_the_deposit_on_a_zero_start_funded_account', () => {
    // Account first appears this year funded entirely from a $10k deposit that
    // grew $1k in-year (end balance $11k). The deposit is its own cost basis and
    // must be added exactly once; the seed fraction should only apply to the
    // in-year appreciation, so some gain is recognized and basis < market value.
    //
    // With the fix: seedBase = 11_000 - 10_000 = 1_000; basisPrev = 1_000*0.5 =
    // 500; basisPreWithdrawal = 500 + 10_000 + 0 = 10_500; no withdrawal so
    // basisNext = 10_500; carriedBasis = min(10_500, 11_000) = 10_500.
    //
    // BEFORE the fix this would have been basisPreWithdrawal = 0.5*11_000 +
    // 10_000 = 15_500 → clamped carriedBasis = 11_000 (100%, no gain — the $1k
    // appreciation hidden and carried forward → later withdrawal under-taxed).
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
    // Year-0 account with start===0 and depositDollars===0: seedBase =
    // preWithdrawalValue - 0 = preWithdrawalValue, identical to old behavior.
    // carriedBasis = min(0.5*8_000, 8_000) = 4_000.
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

// ---------------------------------------------------------------------------
// buildSolverPenaltyAccountsForYear — whose §408A carrier the funding pass
// charges the Roth tranche to
// ---------------------------------------------------------------------------

describe('buildSolverPenaltyAccountsForYear — inherited Roth IRA never picks the carrier owner', () => {
  const emptySeries = { startYear: 2030, startMonthIndex: 0, values: new Float64Array(12) };
  const ledger = (o: Partial<DrawdownAccountInput> & { id: string }): DrawdownAccountInput => ({
    initialPre: 0,
    initialPost: 100_000,
    annualRatePct: 0,
    taxTreatment: 'ROTH',
    accountType: 'RETIREMENT_ROTH_IRA',
    depositsByMonth: emptySeries,
    ...o,
  });

  /** Two Roth owners: the primary holds the INHERITED Roth IRA, the secondary
   *  holds the designated Roth 401(k) the year's non-inherited Roth dollars
   *  actually come from (and the only recorded basis). */
  const twoOwnerHousehold = () => {
    const ctx = makeCtx({
      primaryBirthdate: '1955-01-01',
      secondaryBirthdate: '1956-01-01',
      accountProjections: [
        {
          id: 'roth-inherited',
          taxTreatment: 'ROTH',
          accountType: 'RETIREMENT_ROTH_IRA',
          ownerId: 'member-primary',
        },
        {
          id: 'roth-401k',
          taxTreatment: 'ROTH',
          accountType: 'RETIREMENT_ROTH_401K',
          ownerId: 'member-secondary',
        },
      ],
      rmdProfileFactsByAccountId: new Map([['roth-inherited', { inheritedAccount: true }]]),
    });
    // The inherited account is FIRST in the ledger, so a scan that does not skip
    // it reaches it before the employer-Roth fallback.
    const ledgerAccounts = [
      ledger({ id: 'roth-inherited' }),
      ledger({ id: 'roth-401k', accountType: 'RETIREMENT_ROTH_401K' }),
    ];
    const carrier: RothBasisCarrier = new Map([
      ['member-secondary', { rothBasisRemainingCents: 1_000_000, rothCumulativeWithdrawnCents: 0 }],
    ]);
    return { ctx, ledgerAccounts, carrier };
  };

  it('charges the NON-inherited Roth dollars to the owner who actually holds the basis', () => {
    const { ctx, ledgerAccounts, carrier } = twoOwnerHousehold();
    // $22k Roth tranche, $12k of it from the inherited account → $10k of
    // non-inherited dollars, exactly covered by the secondary's $10k basis.
    const { penaltyAccounts, rothEarningsExcessDollars } = buildSolverPenaltyAccountsForYear({
      ctx,
      ledgerAccounts,
      classification: {
        preTaxDollars: 0,
        postTaxCashLikeDollars: 0,
        rothDollars: 22_000,
        rothInheritedTaxFreeDollars: 12_000,
      },
      rothBasisCarrier: carrier,
      designatedRoth: new Map(),
      taxYear: 2030,
    });
    // Pre-fix the inherited account won the ledger scan, so the dollars were
    // charged to the PRIMARY — who holds no §408A pool at all — and the
    // whole $10k was scored as pre-59½ earnings excess (ordinary income the
    // annotation post-pass then shields, moving the funded draw for no reason).
    expect(rothEarningsExcessDollars).toBe(0);
    expect(penaltyAccounts).toEqual([]);
    // The secondary's real basis is what got consumed...
    expect(carrier.get('member-secondary')).toEqual({
      rothBasisRemainingCents: 0,
      rothCumulativeWithdrawnCents: 1_000_000,
    });
    // ...and no phantom entry was materialised for the inherited account's owner.
    expect(carrier.has('member-primary')).toBe(false);
  });

  it('charges an own-Roth draw only to that owner’s §408A state', () => {
    const { ctx, ledgerAccounts, carrier } = twoOwnerHousehold();
    const ownRothIra = ledger({ id: 'roth-own' });
    carrier.set('member-primary', {
      rothBasisRemainingCents: 0,
      rothCumulativeWithdrawnCents: 0,
    });
    carrier.get('member-secondary')!.rothBasisRemainingCents = 10_000_000;
    const result = buildSolverPenaltyAccountsForYear({
      ctx,
      // The custom-order ledger puts the primary's own IRA first among eligible
      // Roth sources, so the entire non-inherited slice came from that owner.
      ledgerAccounts: [ledgerAccounts[0], ownRothIra, ledgerAccounts[1]],
      classification: {
        preTaxDollars: 0,
        postTaxCashLikeDollars: 0,
        rothDollars: 62_000,
        rothInheritedTaxFreeDollars: 12_000,
      },
      rothBasisCarrier: carrier,
      designatedRoth: new Map(),
      taxYear: 2030,
    });
    expect(result.rothEarningsExcessDollars).toBe(50_000);
    expect(carrier.get('member-primary')).toEqual({
      rothBasisRemainingCents: 0,
      rothCumulativeWithdrawnCents: 5_000_000,
    });
    // The secondary never contributed to this distribution. Their $100,000 of
    // basis cannot shelter it and remains available for their own later draw.
    expect(carrier.get('member-secondary')?.rothBasisRemainingCents).toBe(10_000_000);
  });

  it('does not add safe-integer basis across different owners', () => {
    const ctx = makeCtx({
      primaryBirthdate: '1985-01-01',
      secondaryBirthdate: '1985-01-01',
      accountProjections: [
        { id: 'roth-a', taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' },
        {
          id: 'roth-b',
          taxTreatment: 'ROTH',
          accountType: 'RETIREMENT_ROTH_IRA',
          ownerId: 'member-secondary',
        },
      ],
    });
    const carrier: RothBasisCarrier = new Map([
      [
        'member-primary',
        {
          rothBasisRemainingCents: Number.MAX_SAFE_INTEGER,
          rothCumulativeWithdrawnCents: 0,
        },
      ],
      [
        'member-secondary',
        {
          rothBasisRemainingCents: Number.MAX_SAFE_INTEGER,
          rothCumulativeWithdrawnCents: 0,
        },
      ],
    ]);
    expect(() =>
      buildSolverPenaltyAccountsForYear({
        ctx,
        ledgerAccounts: [ledger({ id: 'roth-a' }), ledger({ id: 'roth-b' })],
        classification: {
          preTaxDollars: 0,
          postTaxCashLikeDollars: 0,
          rothDollars: 0.01,
        },
        rothBasisCarrier: carrier,
        designatedRoth: new Map(),
        taxYear: 2030,
      }),
    ).not.toThrow();
    expect(carrier.get('member-primary')?.rothBasisRemainingCents).toBe(
      Number.MAX_SAFE_INTEGER - 1,
    );
    expect(carrier.get('member-secondary')?.rothBasisRemainingCents).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it('funds one owner’s in-window conversion recapture without consuming the other owner’s lot', () => {
    const seeds = mergeFactBasedRothIraSeeds(
      new Map(),
      new Map([
        ['member-primary', 2_000_000],
        ['member-secondary', 10_000_000],
      ]),
      new Map([
        ['member-primary', new Map([[2024, 2_000_000]])],
        ['member-secondary', new Map([[2024, 10_000_000]])],
      ]),
    );
    const fundingCarrier = seedFactBasedRothBasisCarrier(seeds);
    const annotationCarrier = seedFactBasedRothBasisCarrier(seeds);
    const ctx = makeCtx({
      primaryBirthdate: '1985-01-01',
      secondaryBirthdate: '1985-01-01',
      accountProjections: [
        { id: 'roth-a', taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' },
        {
          id: 'roth-b',
          taxTreatment: 'ROTH',
          accountType: 'RETIREMENT_ROTH_IRA',
          ownerId: 'member-secondary',
        },
      ],
    });
    const funding = buildSolverPenaltyAccountsForYear({
      ctx,
      ledgerAccounts: [ledger({ id: 'roth-a' }), ledger({ id: 'roth-b' })],
      classification: {
        preTaxDollars: 0,
        postTaxCashLikeDollars: 0,
        rothDollars: 30_000,
      },
      rothBasisCarrier: fundingCarrier,
      designatedRoth: new Map(),
      taxYear: 2025,
    });
    const annotation = applyFactBasedRothIraOrdering(
      annotationCarrier.get('member-primary')!,
      {
        withdrawalCents: 3_000_000,
        distributionTaxYear: 2025,
        ownerReached59Half: false,
      },
    );
    expect(funding.rothEarningsExcessDollars).toBe(10_000);
    expect(funding.penaltyAccounts[0].penaltyPreTaxWithdrawalDollars).toBe(30_000);
    expect(funding.rothEarningsExcessDollars * 100).toBe(annotation.incomeTaxableCents);
    expect(funding.penaltyAccounts[0].penaltyPreTaxWithdrawalDollars * 100).toBe(
      annotation.additionalTaxBaseCents,
    );
    expect(fundingCarrier.get('member-primary')?.conversionLots).toEqual([]);
    expect(
      fundingCarrier.get('member-secondary')?.conversionLots?.[0].taxableRemainingCents,
    ).toBe(10_000_000);
  });

  it('falls back to a MIXED Roth-designated plan when it is the only non-inherited Roth source', () => {
    // The SECONDARY owns the inherited Roth IRA AND a MIXED 401(k) whose
    // Roth-designated post bucket supplies every non-inherited Roth dollar;
    // the PRIMARY owns no Roth account at all. The secondary's carrier entry
    // holds the merged MIXED designated-Roth basis. Pre-fix the skip fell past
    // the MIXED plan (neither a Roth IRA nor a pure employer-Roth type) to the
    // PRIMARY — who holds no carrier entry — scoring the whole basis-covered
    // tranche as earnings excess every year.
    const ctx = makeCtx({
      primaryBirthdate: '1955-01-01',
      secondaryBirthdate: '1956-01-01',
      accountProjections: [
        {
          id: 'roth-inherited',
          taxTreatment: 'ROTH',
          accountType: 'RETIREMENT_ROTH_IRA',
          ownerId: 'member-secondary',
        },
        {
          id: 'mixed-401k',
          taxTreatment: 'MIXED',
          accountType: 'RETIREMENT_401K',
          ownerId: 'member-secondary',
        },
      ],
      rmdProfileFactsByAccountId: new Map([['roth-inherited', { inheritedAccount: true }]]),
    });
    const ledgerAccounts = [
      ledger({ id: 'roth-inherited' }),
      ledger({ id: 'mixed-401k', taxTreatment: 'MIXED', accountType: 'RETIREMENT_401K' }),
    ];
    const carrier: RothBasisCarrier = new Map([
      ['member-secondary', { rothBasisRemainingCents: 4_000_000, rothCumulativeWithdrawnCents: 0 }],
    ]);

    // $60k Roth tranche, $30k of it inherited → $30k of non-inherited dollars,
    // fully covered by the secondary's $40k designated-Roth basis.
    const { penaltyAccounts, rothEarningsExcessDollars } = buildSolverPenaltyAccountsForYear({
      ctx,
      ledgerAccounts,
      classification: {
        preTaxDollars: 0,
        postTaxCashLikeDollars: 0,
        rothDollars: 60_000,
        rothInheritedTaxFreeDollars: 30_000,
      },
      rothBasisCarrier: carrier,
      designatedRoth: new Map(),
      taxYear: 2030,
    });

    expect(rothEarningsExcessDollars).toBe(0);
    expect(penaltyAccounts).toEqual([]);
    // The secondary's designated-Roth basis is what got consumed...
    expect(carrier.get('member-secondary')).toEqual({
      rothBasisRemainingCents: 1_000_000,
      rothCumulativeWithdrawnCents: 3_000_000,
    });
    // ...and no phantom entry was materialised for the (Roth-less) primary.
    expect(carrier.has('member-primary')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildSolverPenaltyAccountsForYear — the funding pass must FUND the same
// §402A pro-rata figures (in-plan-rollover recapture included) the annotation
// post-pass reports, on the designated SLICE of the Roth bucket only
// ---------------------------------------------------------------------------

describe('buildSolverPenaltyAccountsForYear — §402A designated slice', () => {
  const emptySeries = { startYear: 2030, startMonthIndex: 0, values: new Float64Array(12) };

  /** One under-59½ owner holding one designated-Roth plan whose whole basis is a
   *  recorded taxable in-plan rollover — the common shape, because a designated
   *  account's basis IS its rollover principal.
   *  Optionally a Roth IRA beside it, with §408A contribution basis on the
   *  funding carrier. */
  const rolloverHousehold = (args: {
    rolloverTaxYear: number;
    taxableCents?: number;
    nontaxableCents?: number;
    /** Designated pocket balance (cents). Default: the lot principal. */
    balanceCents?: number;
    /** §408A Roth-IRA carrier basis (cents); adds a Roth IRA ledger account. */
    iraBasisCents?: number;
  }) => {
    const taxableCents = args.taxableCents ?? 600_000;
    const nontaxableCents = args.nontaxableCents ?? 0;
    const balanceCents = args.balanceCents ?? taxableCents + nontaxableCents;
    const ctx = makeCtx({
      primaryBirthdate: '1985-01-01',
      accountProjections: [
        ...(args.iraBasisCents !== undefined
          ? [
              {
                id: 'roth-ira',
                taxTreatment: 'ROTH',
                accountType: 'RETIREMENT_ROTH_IRA',
                ownerId: 'member-primary',
              } as const,
            ]
          : []),
        {
          id: 'roth-401k',
          taxTreatment: 'ROTH',
          accountType: 'RETIREMENT_ROTH_401K',
          ownerId: 'member-primary',
        },
      ],
    });
    const ledgerAccounts = [
      ...(args.iraBasisCents !== undefined
        ? [
            {
              id: 'roth-ira',
              initialPre: 0,
              initialPost: 100_000,
              annualRatePct: 0,
              taxTreatment: 'ROTH',
              accountType: 'RETIREMENT_ROTH_IRA',
              depositsByMonth: emptySeries,
            } as DrawdownAccountInput,
          ]
        : []),
      {
        id: 'roth-401k',
        initialPre: 0,
        initialPost: balanceCents / 100,
        annualRatePct: 0,
        taxTreatment: 'ROTH',
        accountType: 'RETIREMENT_ROTH_401K',
        depositsByMonth: emptySeries,
      } as DrawdownAccountInput,
    ];
    const carrier: RothBasisCarrier = new Map([
      [
        'member-primary',
        {
          rothBasisRemainingCents: args.iraBasisCents ?? 0,
          rothCumulativeWithdrawnCents: 0,
        },
      ],
    ]);
    const designatedRoth = seedSolverDesignatedRothStates(
      new Map([
        [
          'roth-401k',
          {
            accountId: 'roth-401k',
            ownerId: 'member-primary',
            basisCents: taxableCents + nontaxableCents,
            // Clock met — under 59½ the distribution is nonqualified anyway, so
            // the pro-rata regime (not qualification) decides the figures.
            firstParticipationTaxYear: 2005,
            inPlanRolloverLots: [
              {
                taxYear: args.rolloverTaxYear,
                taxableRolloverPrincipalCents: taxableCents,
                nontaxableRolloverPrincipalCents: nontaxableCents,
              },
            ],
            isGovernmental457b: false,
          },
        ],
      ]),
      new Map([['member-primary', balanceCents]]),
    );
    return { ctx, ledgerAccounts, carrier, designatedRoth };
  };

  it('funds the EXACT §402A pro-rata split — never contribution-first, never taxable-first', () => {
    // The discriminating shape: $100k Roth 401(k), a 2024 in-window rollover of
    // $3k taxable + $3k nontaxable, a $6k nonqualified draw in 2025. §402A(d)(4)
    // splits the draw pro rata — $360 basis, $5,640 earnings — and the ordered
    // allocation (`allocateDesignatedRothBasis`) routes the $360 to the taxable
    // lot half first, all of it in-window. Additional-tax base: $5,640 + $360 =
    // $6,000; ordinary income: $5,640. Pre-fix the funding pass consumed the
    // whole $6k from its owner-pooled carrier contribution-first (income $0) and
    // recaptured the $3k taxable half taxable-first — a $300 penalty and no
    // income tax, understating the committed withdrawal.
    const { ctx, ledgerAccounts, carrier, designatedRoth } = rolloverHousehold({
      rolloverTaxYear: 2024,
      taxableCents: 300_000,
      nontaxableCents: 300_000,
      balanceCents: 10_000_000,
    });
    const { penaltyAccounts, rothEarningsExcessDollars } = buildSolverPenaltyAccountsForYear({
      ctx,
      taxYear: 2025,
      ledgerAccounts,
      classification: {
        preTaxDollars: 0,
        postTaxCashLikeDollars: 0,
        rothDollars: 6_000,
        rothDesignatedDollars: 6_000,
      },
      rothBasisCarrier: carrier,
      designatedRoth,
    });
    expect(rothEarningsExcessDollars).toBe(5_640);
    expect(penaltyAccounts).toEqual([
      {
        id: 'roth-401k',
        type: 'RETIREMENT_ROTH_401K',
        ownerId: 'member-primary',
        penaltyPreTaxWithdrawalDollars: 6_000,
        rothOrderedAdditionalTaxBase: true,
        hsaWithdrawalDollars: 0,
      },
    ]);
    // The shared allocation decremented exactly what it recaptured (taxable
    // before nontaxable), and the pooled balance rolled forward.
    const state = designatedRoth.get('member-primary');
    expect(state?.entry.inPlanRolloverLots[0].taxableRolloverPrincipalRemainingCents).toBe(
      264_000,
    );
    expect(state?.entry.inPlanRolloverLots[0].nontaxableRolloverPrincipalRemainingCents).toBe(
      300_000,
    );
    expect(state?.balanceRemainingCents).toBe(9_400_000);
  });

  it('an unrelated Roth-IRA draw never consumes the employer plan’s rollover lots', () => {
    // The owner holds BOTH a Roth IRA with ample contribution basis and an
    // untouched Roth 401(k) with an in-window taxable rollover lot. The year's
    // Roth draw comes solely from the IRA (`rothDesignatedDollars` absent), so
    // NO designated-plan principal was distributed: §408A(d)(4)(B) returns the
    // contribution basis tax/penalty-free and §402A recaptures nothing. Pre-fix
    // the funding pass handed the sheltered basis to the recapture leg, consumed
    // the 401(k)'s lot and funded a $600 additional tax on the IRA's account id.
    const { ctx, ledgerAccounts, carrier, designatedRoth } = rolloverHousehold({
      rolloverTaxYear: 2024,
      iraBasisCents: 1_500_000,
    });
    const { penaltyAccounts, rothEarningsExcessDollars } = buildSolverPenaltyAccountsForYear({
      ctx,
      taxYear: 2025,
      ledgerAccounts,
      classification: { preTaxDollars: 0, postTaxCashLikeDollars: 0, rothDollars: 6_000 },
      rothBasisCarrier: carrier,
      designatedRoth,
    });
    expect(rothEarningsExcessDollars).toBe(0);
    expect(penaltyAccounts).toEqual([]);
    // The employer plan's lot is untouched — the recapture it really owes when
    // that plan IS drawn has not been spent on someone else's dollars.
    const state = designatedRoth.get('member-primary');
    expect(state?.entry.inPlanRolloverLots[0].taxableRolloverPrincipalRemainingCents).toBe(
      600_000,
    );
    expect(state?.balanceRemainingCents).toBe(600_000);
    // The IRA basis is what got consumed.
    expect(carrier.get('member-primary')?.rothBasisRemainingCents).toBe(900_000);
  });

  it('funds the 10% recapture on in-window principal when the DESIGNATED plan is drawn', () => {
    // Basis == balance (the usual shape), so the pro-rata basis
    // portion is the whole draw and every recaptured cent is in-window rollover
    // principal: a $6,000 base, exactly what the annotation post-pass reports.
    const { ctx, ledgerAccounts, carrier, designatedRoth } = rolloverHousehold({
      rolloverTaxYear: 2024,
    });
    const { penaltyAccounts, rothEarningsExcessDollars } = buildSolverPenaltyAccountsForYear({
      ctx,
      taxYear: 2025,
      ledgerAccounts,
      classification: {
        preTaxDollars: 0,
        postTaxCashLikeDollars: 0,
        rothDollars: 6_000,
        rothDesignatedDollars: 6_000,
      },
      rothBasisCarrier: carrier,
      designatedRoth,
    });
    expect(rothEarningsExcessDollars).toBe(0);
    expect(penaltyAccounts).toEqual([
      {
        id: 'roth-401k',
        type: 'RETIREMENT_ROTH_401K',
        ownerId: 'member-primary',
        penaltyPreTaxWithdrawalDollars: 6_000,
        rothOrderedAdditionalTaxBase: true,
        hsaWithdrawalDollars: 0,
      },
    ]);
    // The lot is decremented, so a later year cannot recapture the same dollars.
    expect(
      designatedRoth.get('member-primary')?.entry.inPlanRolloverLots[0]
        .taxableRolloverPrincipalRemainingCents,
    ).toBe(0);
  });

  it('funds nothing once the lot is past its five-tax-year window', () => {
    const { ctx, ledgerAccounts, carrier, designatedRoth } = rolloverHousehold({
      rolloverTaxYear: 2018,
    });
    const { penaltyAccounts } = buildSolverPenaltyAccountsForYear({
      ctx,
      taxYear: 2025,
      ledgerAccounts,
      classification: {
        preTaxDollars: 0,
        postTaxCashLikeDollars: 0,
        rothDollars: 6_000,
        rothDesignatedDollars: 6_000,
      },
      rothBasisCarrier: carrier,
      designatedRoth,
    });
    expect(penaltyAccounts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildSolverPenaltyAccountsForYear — the §408A slice honors qualification
// (five-year clock + whole-year 59½), like the annotation and MC paths
// ---------------------------------------------------------------------------

describe('buildSolverPenaltyAccountsForYear — §408A qualified distribution', () => {
  const emptySeries = { startYear: 2025, startMonthIndex: 0, values: new Float64Array(12) };
  const household = (entry: {
    rothBasisRemainingCents: number;
    firstContributionTaxYear?: number;
  }) => {
    const ctx = makeCtx({
      primaryBirthdate: '1958-01-01',
      accountProjections: [
        {
          id: 'roth-ira',
          taxTreatment: 'ROTH',
          accountType: 'RETIREMENT_ROTH_IRA',
          ownerId: 'member-primary',
        },
      ],
    });
    const ledgerAccounts = [
      {
        id: 'roth-ira',
        initialPre: 0,
        initialPost: 500_000,
        annualRatePct: 0,
        taxTreatment: 'ROTH',
        accountType: 'RETIREMENT_ROTH_IRA',
        depositsByMonth: emptySeries,
      } as DrawdownAccountInput,
    ];
    const carrier: RothBasisCarrier = new Map([
      ['member-primary', { rothCumulativeWithdrawnCents: 0, ...entry }],
    ]);
    return { ctx, ledgerAccounts, carrier };
  };
  const run = (carrierArgs: Parameters<typeof household>[0]) => {
    const { ctx, ledgerAccounts, carrier } = household(carrierArgs);
    return buildSolverPenaltyAccountsForYear({
      ctx,
      taxYear: 2025,
      ledgerAccounts,
      classification: { preTaxDollars: 0, postTaxCashLikeDollars: 0, rothDollars: 100_000 },
      rothBasisCarrier: carrier,
      designatedRoth: new Map(),
    });
  };

  it('funds NO tax on a qualified draw past the derived basis (clock met, owner 59½+)', () => {
    // Owner 67, first contribution 2010, $60k derived basis against a $100k
    // draw. The distribution is QUALIFIED (§408A(d)(2)), so the annotation pass
    // reports $0 taxable and Monte Carlo funds $0 — pre-fix the funding pass
    // taxed the $40k past the carrier basis as phantom ordinary income anyway,
    // permanently inflating the committed withdrawal.
    const { penaltyAccounts, rothEarningsExcessDollars } = run({
      rothBasisRemainingCents: 6_000_000,
      firstContributionTaxYear: 2010,
    });
    expect(rothEarningsExcessDollars).toBe(0);
    expect(penaltyAccounts).toEqual([]);
  });

  it('still taxes the earnings excess when the pooled clock is unmet', () => {
    // Same owner and draw, clock ABSENT (conservatively unmet): the $40k
    // past the basis stays ordinary income; past 59½ there is no 10% leg.
    const { penaltyAccounts, rothEarningsExcessDollars } = run({
      rothBasisRemainingCents: 6_000_000,
    });
    expect(rothEarningsExcessDollars).toBe(40_000);
    expect(penaltyAccounts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildSolverPenaltyAccountsForYear — §408A qualification is decided
// household-conservatively across every Roth-IRA owner, never by ledger order
// ---------------------------------------------------------------------------

/** The funded 10% the penalty engine actually collects from the emitted
 *  snapshots — the same `PenaltyAccountInput` mapping `applyTaxYear` builds
 *  (`tax-integration.ts`), so assertions cover the age proration the snapshot's
 *  OWNER attribution drives, not just the base. m1 born 1958 (59½ for every
 *  compared year), m2 born 1985 (fully prorated). */
const fundedPenaltyDollars = (
  penaltyAccounts: readonly PenaltyAccountSnapshot[],
  taxYear: number,
  exemptAccountIds: readonly string[] = [],
): number => {
  const birthdateByMember = new Map([
    ['member-primary', '1958-01-01'],
    ['member-secondary', '1985-06-01'],
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

describe('buildSolverPenaltyAccountsForYear — two-owner §408A qualification is household-conservative', () => {
  const emptySeries = { startYear: 2025, startMonthIndex: 0, values: new Float64Array(12) };
  const ledger = (id: string): DrawdownAccountInput => ({
    id,
    initialPre: 0,
    initialPost: 500_000,
    annualRatePct: 0,
    taxTreatment: 'ROTH',
    accountType: 'RETIREMENT_ROTH_IRA',
    depositsByMonth: emptySeries,
  });
  /** m1 (primary, born 1958 → 67 in 2025) holds a QUALIFIED Roth IRA (clock
   *  2010); m2 (secondary, born 1985 → 40) holds a NONQUALIFIED one (clock
   *  2024, five-year window open through 2028). Both at $0 remaining basis. */
  const household = (clocks: { m1?: number; m2?: number } = { m1: 2010, m2: 2024 }) => {
    const ctx = makeCtx({
      primaryBirthdate: '1958-01-01',
      secondaryBirthdate: '1985-06-01',
      accountProjections: [
        {
          id: 'roth-ira-m1',
          taxTreatment: 'ROTH',
          accountType: 'RETIREMENT_ROTH_IRA',
          ownerId: 'member-primary',
        },
        {
          id: 'roth-ira-m2',
          taxTreatment: 'ROTH',
          accountType: 'RETIREMENT_ROTH_IRA',
          ownerId: 'member-secondary',
        },
      ],
    });
    const carrier: RothBasisCarrier = new Map([
      [
        'member-primary',
        {
          rothBasisRemainingCents: 0,
          rothCumulativeWithdrawnCents: 0,
          ...(clocks.m1 !== undefined ? { firstContributionTaxYear: clocks.m1 } : {}),
        },
      ],
      [
        'member-secondary',
        {
          rothBasisRemainingCents: 0,
          rothCumulativeWithdrawnCents: 0,
          ...(clocks.m2 !== undefined ? { firstContributionTaxYear: clocks.m2 } : {}),
        },
      ],
    ]);
    return { ctx, carrier };
  };
  const run = (
    ledgerAccounts: ReadonlyArray<DrawdownAccountInput>,
    clocks?: { m1?: number; m2?: number },
  ) => {
    const { ctx, carrier } = household(clocks);
    return buildSolverPenaltyAccountsForYear({
      ctx,
      taxYear: 2025,
      ledgerAccounts,
      classification: { preTaxDollars: 0, postTaxCashLikeDollars: 0, rothDollars: 50_000 },
      rothBasisCarrier: carrier,
      designatedRoth: new Map(),
    });
  };

  it('taxes the pooled draw when ANY Roth-IRA owner is nonqualified, whatever the ledger order', () => {
    // Pre-fix the qualification test read the clock and 59½ flag from whichever
    // Roth IRA the ledger scan found FIRST: with m1's qualified IRA first the
    // whole household draw funded $0 tax, with m2's first the same draw funded
    // $50k of ordinary income plus the 10% base — account order, not §408A,
    // decided the answer. Household-conservatively the slice is NONQUALIFIED
    // (m2's clock is unmet and m2 is 40) in BOTH orders, and the snapshot is
    // attributed to m2 — the owner whose failing 59½ test made the base
    // penalizable — in BOTH orders. Attributing it to the ledger-picked owner
    // instead let the penalty engine's per-owner age proration zero the funded
    // 10% whenever the qualified owner's IRA happened to be first: the same
    // base funded $0 in one order and $5,000 in the other.
    const forward = run([ledger('roth-ira-m1'), ledger('roth-ira-m2')]);
    expect(forward.rothEarningsExcessDollars).toBe(50_000);
    expect(forward.penaltyAccounts).toEqual([
      {
        id: 'roth-ira-m1',
        type: 'RETIREMENT_ROTH_IRA',
        ownerId: 'member-secondary',
        penaltyPreTaxWithdrawalDollars: 50_000,
        rothOrderedAdditionalTaxBase: true,
        hsaWithdrawalDollars: 0,
      },
    ]);

    // Reversed ledger: identical funded figures (the snapshot's account id
    // follows the scan; its OWNER is the conservative attribution either way).
    const reversed = run([ledger('roth-ira-m2'), ledger('roth-ira-m1')]);
    expect(reversed.rothEarningsExcessDollars).toBe(50_000);
    expect(reversed.penaltyAccounts.map((p) => p.penaltyPreTaxWithdrawalDollars)).toEqual([
      50_000,
    ]);
    expect(reversed.penaltyAccounts[0].ownerId).toBe('member-secondary');

    // The DOLLARS the penalty engine funds off those snapshots — $5,000 (10% of
    // the $50k base, m2's proration fraction 1) in BOTH orders.
    expect(fundedPenaltyDollars(forward.penaltyAccounts, 2025)).toBe(5_000);
    expect(fundedPenaltyDollars(reversed.penaltyAccounts, 2025)).toBe(5_000);
  });

  it('still funds NO tax when EVERY Roth-IRA owner is qualified (no over-reduction)', () => {
    // Control: a secondary born 1956 (69) with a 2015 clock — both clocks met
    // and both owners 59½+ for the whole year ⇒ the conservative reduction
    // changes nothing and the pooled draw stays tax-free.
    const ctx = makeCtx({
      primaryBirthdate: '1958-01-01',
      secondaryBirthdate: '1956-01-01',
      accountProjections: [
        {
          id: 'roth-ira-m1',
          taxTreatment: 'ROTH',
          accountType: 'RETIREMENT_ROTH_IRA',
          ownerId: 'member-primary',
        },
        {
          id: 'roth-ira-m2',
          taxTreatment: 'ROTH',
          accountType: 'RETIREMENT_ROTH_IRA',
          ownerId: 'member-secondary',
        },
      ],
    });
    const carrier: RothBasisCarrier = new Map([
      [
        'member-primary',
        { rothBasisRemainingCents: 0, rothCumulativeWithdrawnCents: 0, firstContributionTaxYear: 2010 },
      ],
      [
        'member-secondary',
        { rothBasisRemainingCents: 0, rothCumulativeWithdrawnCents: 0, firstContributionTaxYear: 2015 },
      ],
    ]);
    const { penaltyAccounts, rothEarningsExcessDollars } = buildSolverPenaltyAccountsForYear({
      ctx,
      taxYear: 2025,
      ledgerAccounts: [ledger('roth-ira-m1'), ledger('roth-ira-m2')],
      classification: { preTaxDollars: 0, postTaxCashLikeDollars: 0, rothDollars: 50_000 },
      rothBasisCarrier: carrier,
      designatedRoth: new Map(),
    });
    expect(rothEarningsExcessDollars).toBe(0);
    expect(penaltyAccounts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// buildSolverPenaltyAccountsForYear — §402A qualification is decided
// household-conservatively across every designated-plan owner, never by ledger
// order (the mirror of the §408A block above)
// ---------------------------------------------------------------------------

describe('buildSolverPenaltyAccountsForYear — two-owner §402A qualification is household-conservative', () => {
  const emptySeries = { startYear: 2025, startMonthIndex: 0, values: new Float64Array(12) };
  const ledger = (id: string, accountType: 'RETIREMENT_ROTH_401K' | 'RETIREMENT_ROTH_403B'): DrawdownAccountInput => ({
    id,
    initialPre: 0,
    initialPost: 40_000,
    annualRatePct: 0,
    taxTreatment: 'ROTH',
    accountType,
    depositsByMonth: emptySeries,
    });
  /** m1 (primary, born 1958 → 67 in 2025) holds a Roth 401(k) whose pooled
   *  clock (2005) is met; m2 (secondary, born 1985 → 40) holds a Roth 403(b)
   *  with a 2024 clock (five-year window open through 2028). Both at $0 basis,
   *  so qualification alone decides whether anything is funded. */
  const household = (clocks: { m1: number; m2: number } = { m1: 2005, m2: 2024 }) => {
    const ctx = makeCtx({
      primaryBirthdate: '1958-01-01',
      secondaryBirthdate: '1985-06-01',
      accountProjections: [
        {
          id: 'roth-401k-m1',
          taxTreatment: 'ROTH',
          accountType: 'RETIREMENT_ROTH_401K',
          ownerId: 'member-primary',
        },
        {
          id: 'roth-403b-m2',
          taxTreatment: 'ROTH',
          accountType: 'RETIREMENT_ROTH_403B',
          ownerId: 'member-secondary',
        },
      ],
    });
    const designatedRoth = seedSolverDesignatedRothStates(
      new Map([
        [
          'roth-401k-m1',
          {
            accountId: 'roth-401k-m1',
            ownerId: 'member-primary',
            basisCents: 0,
            firstParticipationTaxYear: clocks.m1,
            inPlanRolloverLots: [],
            isGovernmental457b: false,
          },
        ],
        [
          'roth-403b-m2',
          {
            accountId: 'roth-403b-m2',
            ownerId: 'member-secondary',
            basisCents: 0,
            firstParticipationTaxYear: clocks.m2,
            inPlanRolloverLots: [],
            isGovernmental457b: false,
          },
        ],
      ]),
      new Map([
        ['member-primary', 4_000_000],
        ['member-secondary', 4_000_000],
      ]),
    );
    return { ctx, designatedRoth };
  };
  const run = (
    ledgerAccounts: ReadonlyArray<DrawdownAccountInput>,
    clocks?: { m1: number; m2: number },
  ) => {
    const { ctx, designatedRoth } = household(clocks);
    return buildSolverPenaltyAccountsForYear({
      ctx,
      taxYear: 2025,
      ledgerAccounts,
      classification: {
        preTaxDollars: 0,
        postTaxCashLikeDollars: 0,
        rothDollars: 20_000,
        rothDesignatedDollars: 20_000,
      },
      rothBasisCarrier: new Map(),
      designatedRoth,
    });
  };

  it('taxes the pooled designated draw when ANY designated owner is nonqualified, whatever the ledger order', () => {
    // Pre-fix the qualification test read the 59½ flag and the participation
    // clock from whichever designated plan the ledger scan found FIRST: with
    // m1's qualified 401(k) first the whole household's designated draw funded
    // $0 tax, with m2's 403(b) first the same draw funded $20k of ordinary
    // income plus the 10% base — account order, not §402A, decided the answer
    // (the same defect the §408A slice is guarded against). Household-conservatively
    // the slice is NONQUALIFIED in BOTH
    // orders (m2 is 40 and the LATEST clock, 2024, is unmet), and the snapshot
    // is attributed to m2 so the penalty engine's proration funds the 10% the
    // conservative base assumes.
    const forward = run([
      ledger('roth-401k-m1', 'RETIREMENT_ROTH_401K'),
      ledger('roth-403b-m2', 'RETIREMENT_ROTH_403B'),
    ]);
    expect(forward.rothEarningsExcessDollars).toBe(20_000);
    expect(forward.penaltyAccounts).toEqual([
      {
        id: 'roth-401k-m1',
        type: 'RETIREMENT_ROTH_401K',
        ownerId: 'member-secondary',
        penaltyPreTaxWithdrawalDollars: 20_000,
        rothOrderedAdditionalTaxBase: true,
        hsaWithdrawalDollars: 0,
      },
    ]);

    const reversed = run([
      ledger('roth-403b-m2', 'RETIREMENT_ROTH_403B'),
      ledger('roth-401k-m1', 'RETIREMENT_ROTH_401K'),
    ]);
    expect(reversed.rothEarningsExcessDollars).toBe(20_000);
    expect(reversed.penaltyAccounts.map((p) => p.penaltyPreTaxWithdrawalDollars)).toEqual([
      20_000,
    ]);
    expect(reversed.penaltyAccounts[0].ownerId).toBe('member-secondary');

    // The DOLLARS the penalty engine funds off those snapshots — $2,000 in
    // BOTH orders (m2's fraction 1); ledger-picked attribution funded $0 in
    // forward order (m1 is past 59½) and $2,000 reversed.
    expect(fundedPenaltyDollars(forward.penaltyAccounts, 2025)).toBe(2_000);
    expect(fundedPenaltyDollars(reversed.penaltyAccounts, 2025)).toBe(2_000);
  });

  it('still funds NO tax when EVERY designated owner is qualified (no over-reduction)', () => {
    // Control: secondary born 1956 (69 in 2025) with a met 2010 clock — the
    // conservative reduction changes nothing and the pooled draw stays
    // tax-free, exactly as the annotation reports it per account.
    const ctx = makeCtx({
      primaryBirthdate: '1958-01-01',
      secondaryBirthdate: '1956-01-01',
      accountProjections: [
        {
          id: 'roth-401k-m1',
          taxTreatment: 'ROTH',
          accountType: 'RETIREMENT_ROTH_401K',
          ownerId: 'member-primary',
        },
        {
          id: 'roth-403b-m2',
          taxTreatment: 'ROTH',
          accountType: 'RETIREMENT_ROTH_403B',
          ownerId: 'member-secondary',
        },
      ],
    });
    const designatedRoth = seedSolverDesignatedRothStates(
      new Map([
        [
          'roth-401k-m1',
          {
            accountId: 'roth-401k-m1',
            ownerId: 'member-primary',
            basisCents: 0,
            firstParticipationTaxYear: 2005,
            inPlanRolloverLots: [],
            isGovernmental457b: false,
          },
        ],
        [
          'roth-403b-m2',
          {
            accountId: 'roth-403b-m2',
            ownerId: 'member-secondary',
            basisCents: 0,
            firstParticipationTaxYear: 2010,
            inPlanRolloverLots: [],
            isGovernmental457b: false,
          },
        ],
      ]),
      new Map([
        ['member-primary', 4_000_000],
        ['member-secondary', 4_000_000],
      ]),
    );
    const { penaltyAccounts, rothEarningsExcessDollars } = buildSolverPenaltyAccountsForYear({
      ctx,
      taxYear: 2025,
      ledgerAccounts: [
        ledger('roth-401k-m1', 'RETIREMENT_ROTH_401K'),
        ledger('roth-403b-m2', 'RETIREMENT_ROTH_403B'),
      ],
      classification: {
        preTaxDollars: 0,
        postTaxCashLikeDollars: 0,
        rothDollars: 20_000,
        rothDesignatedDollars: 20_000,
      },
      rothBasisCarrier: new Map(),
      designatedRoth,
    });
    expect(rothEarningsExcessDollars).toBe(0);
    expect(penaltyAccounts).toEqual([]);
  });

  it('an inherited designated plan never picks the owner the designated slice is charged to', () => {
    // The classifier keeps inherited designated dollars OUT of
    // `rothDesignatedDollars`, so an inherited plan holds none of this slice's
    // dollars by construction. Pre-fix the ledger scan had no inherited filter
    // (unlike its §408A twin): m1's INHERITED Roth 401(k), first in the
    // ledger, captured the whole slice, fabricated a $0-basis no-clock state
    // for m1 and taxed the fully-sheltered draw as $6k of earnings — while
    // m2's real state (basis == balance, in-window 2024 lot) sat unread.
    const ctx = makeCtx({
      primaryBirthdate: '1985-01-01',
      secondaryBirthdate: '1985-06-01',
      accountProjections: [
        {
          id: 'roth-401k-inh',
          taxTreatment: 'ROTH',
          accountType: 'RETIREMENT_ROTH_401K',
          ownerId: 'member-primary',
        },
        {
          id: 'roth-401k-m2',
          taxTreatment: 'ROTH',
          accountType: 'RETIREMENT_ROTH_401K',
          ownerId: 'member-secondary',
        },
      ],
      rmdProfileFactsByAccountId: new Map([['roth-401k-inh', { inheritedAccount: true }]]),
    });
    const designatedRoth = seedSolverDesignatedRothStates(
      new Map([
        [
          'roth-401k-m2',
          {
            accountId: 'roth-401k-m2',
            ownerId: 'member-secondary',
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
      new Map([['member-secondary', 600_000]]),
    );
    const { penaltyAccounts, rothEarningsExcessDollars } = buildSolverPenaltyAccountsForYear({
      ctx,
      taxYear: 2025,
      // The inherited plan FIRST, so a scan without the inherited filter picks it.
      ledgerAccounts: [
        ledger('roth-401k-inh', 'RETIREMENT_ROTH_401K'),
        ledger('roth-401k-m2', 'RETIREMENT_ROTH_401K'),
      ],
      classification: {
        preTaxDollars: 0,
        postTaxCashLikeDollars: 0,
        rothDollars: 6_000,
        rothDesignatedDollars: 6_000,
      },
      rothBasisCarrier: new Map(),
      designatedRoth,
    });
    // Basis == balance, so the pro-rata basis portion is the whole draw and
    // every recaptured cent is m2's in-window rollover principal: $0 ordinary
    // income, a $6,000 recapture base on m2's real account.
    expect(rothEarningsExcessDollars).toBe(0);
    expect(penaltyAccounts).toEqual([
      {
        id: 'roth-401k-m2',
        type: 'RETIREMENT_ROTH_401K',
        ownerId: 'member-secondary',
        penaltyPreTaxWithdrawalDollars: 6_000,
        rothOrderedAdditionalTaxBase: true,
        hsaWithdrawalDollars: 0,
      },
    ]);
    // m2's lot was decremented — and no phantom $0-basis state was fabricated
    // and cached for the inherited plan's owner.
    expect(
      designatedRoth.get('member-secondary')?.entry.inPlanRolloverLots[0]
        .taxableRolloverPrincipalRemainingCents,
    ).toBe(0);
    expect(designatedRoth.has('member-primary')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildSolverPenaltyAccountsForYear — §402A qualification is household-
// conservative, while dollars remain scoped to the owner whose plan is drawn
// ---------------------------------------------------------------------------

describe('buildSolverPenaltyAccountsForYear — two-owner §402A dollars charge the DRAWN owner (attribution)', () => {
  const emptySeries = { startYear: 2025, startMonthIndex: 0, values: new Float64Array(12) };
  const ledger = (
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
  /** m1 (primary, born 1958 → 67 in 2025) holds a Roth 401(k) whose whole
   *  $100k basis is a recorded 2012 in-plan rollover (out of its recapture
   *  window) over a $200k pooled pocket; m2 (secondary, born 1985 → 40) holds
   *  a Roth 403(b) with NO recorded facts at all — $0 basis, no state, absent
   *  clock. */
  const household = () => {
    const ctx = makeCtx({
      primaryBirthdate: '1958-01-01',
      secondaryBirthdate: '1985-06-01',
      accountProjections: [
        {
          id: 'roth-401k-m1',
          taxTreatment: 'ROTH',
          accountType: 'RETIREMENT_ROTH_401K',
          ownerId: 'member-primary',
        },
        {
          id: 'roth-403b-m2',
          taxTreatment: 'ROTH',
          accountType: 'RETIREMENT_ROTH_403B',
          ownerId: 'member-secondary',
        },
      ],
    });
    const designatedRoth = seedSolverDesignatedRothStates(
      new Map([
        [
          'roth-401k-m1',
          {
            accountId: 'roth-401k-m1',
            ownerId: 'member-primary',
            basisCents: 10_000_000,
            firstParticipationTaxYear: 2012,
            inPlanRolloverLots: [
              {
                taxYear: 2012,
                taxableRolloverPrincipalCents: 10_000_000,
                nontaxableRolloverPrincipalCents: 0,
              },
            ],
            isGovernmental457b: false,
          },
        ],
      ]),
      new Map([['member-primary', 20_000_000]]),
    );
    return { ctx, designatedRoth };
  };
  /** The classifier now attributes each designated draw to the ACCOUNT it left
   *  (`rothDesignatedDollarsByAccountId`), so the funding pass charges each
   *  owner's own state — ledger order must never move any figure. */
  const run = (
    order: 'forward' | 'reversed',
    dollarsByAccountId: ReadonlyArray<readonly [string, number]>,
  ) => {
    const { ctx, designatedRoth } = household();
    const accounts = [
      ledger('roth-401k-m1', 'RETIREMENT_ROTH_401K'),
      ledger('roth-403b-m2', 'RETIREMENT_ROTH_403B'),
    ];
    const total = dollarsByAccountId.reduce((sum, [, d]) => sum + d, 0);
    const result = buildSolverPenaltyAccountsForYear({
      ctx,
      taxYear: 2025,
      ledgerAccounts: order === 'forward' ? accounts : [...accounts].reverse(),
      classification: {
        preTaxDollars: 0,
        postTaxCashLikeDollars: 0,
        rothDollars: total,
        rothDesignatedDollars: total,
        rothDesignatedDollarsByAccountId: new Map(dollarsByAccountId),
      },
      rothBasisCarrier: new Map(),
      designatedRoth,
    });
    return { ...result, designatedRoth };
  };

  it('charges a draw from m2’s $0-basis plan to m2 in EITHER ledger order (m1’s basis never borrowed)', () => {
    // Pre-attribution, the forward order picked m1 (first designated plan in the
    // ledger) and let m1's $100k basis shelter half of m2's $50k draw. Now both
    // orders fund the identical figure: the whole draw is m2's nonqualified
    // earnings, and m1's basis/lot/denominator are untouched.
    for (const order of ['forward', 'reversed'] as const) {
      const r = run(order, [['roth-403b-m2', 50_000]]);
      expect(r.rothEarningsExcessDollars).toBe(50_000);
      expect(r.penaltyAccounts[0].penaltyPreTaxWithdrawalDollars).toBe(50_000);
      expect(r.penaltyAccounts[0].ownerId).toBe('member-secondary');
      // The snapshot rides the DRAWN plan's real id (never a ledger pick), so
      // a scenario exempting exactly this plan waives exactly this base.
      expect(r.penaltyAccounts[0].id).toBe('roth-403b-m2');
      expect(fundedPenaltyDollars(r.penaltyAccounts, 2025)).toBe(5_000);
      expect(fundedPenaltyDollars(r.penaltyAccounts, 2025, ['roth-403b-m2'])).toBe(0);
      expect(
        r.designatedRoth.get('member-primary')?.entry.designatedRothBasisRemainingCents,
      ).toBe(10_000_000);
      expect(
        r.designatedRoth.get('member-primary')?.entry.inPlanRolloverLots[0]
          .taxableRolloverPrincipalRemainingCents,
      ).toBe(10_000_000);
      expect(r.designatedRoth.get('member-primary')?.balanceRemainingCents).toBe(
        20_000_000,
      );
      // m2 gets the conservative $0-basis default for its own plan.
      expect(r.designatedRoth.get('member-secondary')?.balanceRemainingCents).toBe(0);
    }
  });

  it('funds NO tax on m1’s own qualified draw while m2 (40, no clock) draws nothing, in EITHER ledger order', () => {
    // Under attribution m1's OWN facts decide: 67 all year with a met 2012
    // participation clock ⇒ QUALIFIED — $0 ordinary income and no 10% — while
    // m1's pro-rata basis bookkeeping still rolls forward. Pre-fix
    // qualification was reduced household-conservatively across BOTH owners,
    // so m2 — 40, clockless, drawing NOTHING this year — made m1's draw
    // nonqualified: $25k of phantom ordinary income plus a $2,500 funded 10%
    // prorated by m2's birthdate, tax the annotation post-pass never reports.
    for (const order of ['forward', 'reversed'] as const) {
      const r = run(order, [['roth-401k-m1', 50_000]]);
      expect(r.rothEarningsExcessDollars).toBe(0);
      expect(r.penaltyAccounts).toEqual([]);
      expect(
        r.designatedRoth.get('member-primary')?.entry.designatedRothBasisRemainingCents,
      ).toBe(7_500_000);
      expect(
        r.designatedRoth.get('member-primary')?.entry.inPlanRolloverLots[0]
          .taxableRolloverPrincipalRemainingCents,
      ).toBe(7_500_000);
      expect(r.designatedRoth.get('member-primary')?.balanceRemainingCents).toBe(
        15_000_000,
      );
      expect(r.designatedRoth.has('member-secondary')).toBe(false);
    }
  });

  it('a year drawing from BOTH owners charges and qualifies each owner separately, in EITHER ledger order', () => {
    // $30k from m1 — QUALIFIED on m1's own facts (67, met 2012 clock), $0
    // income, pro-rata basis bookkeeping still rolling forward — plus $20k
    // from m2 (40, clockless, $0 basis → all nonqualified earnings). Only
    // m2's base is funded, on m2's OWN plan id, so exempting 'roth-403b-m2'
    // waives exactly that share. Pre-attribution the whole $50k ran against
    // the single first-in-ledger owner's state under one pooled qualification
    // (which also taxed m1's qualified $15k of earnings).
    for (const order of ['forward', 'reversed'] as const) {
      const r = run(order, [
        ['roth-401k-m1', 30_000],
        ['roth-403b-m2', 20_000],
      ]);
      expect(r.rothEarningsExcessDollars).toBe(20_000);
      expect(r.penaltyAccounts).toEqual([
        {
          id: 'roth-403b-m2',
          type: 'RETIREMENT_ROTH_403B',
          ownerId: 'member-secondary',
          penaltyPreTaxWithdrawalDollars: 20_000,
          rothOrderedAdditionalTaxBase: true,
          hsaWithdrawalDollars: 0,
        },
      ]);
      expect(fundedPenaltyDollars(r.penaltyAccounts, 2025)).toBe(2_000);
      expect(fundedPenaltyDollars(r.penaltyAccounts, 2025, ['roth-403b-m2'])).toBe(0);
      expect(
        r.designatedRoth.get('member-primary')?.entry.designatedRothBasisRemainingCents,
      ).toBe(8_500_000);
      expect(
        r.designatedRoth.get('member-primary')?.entry.inPlanRolloverLots[0]
          .taxableRolloverPrincipalRemainingCents,
      ).toBe(8_500_000);
      expect(r.designatedRoth.get('member-primary')?.balanceRemainingCents).toBe(
        17_000_000,
      );
      expect(r.designatedRoth.get('member-secondary')?.balanceRemainingCents).toBe(0);
    }
  });
});

describe('buildSolverPenaltyAccountsForYear — two-owner §408A dollars charge the DRAWN owner (attribution)', () => {
  const emptySeries = { startYear: 2025, startMonthIndex: 0, values: new Float64Array(12) };
  const iraLedger = (id: string): DrawdownAccountInput => ({
    id,
    initialPre: 0,
    initialPost: 100_000,
    annualRatePct: 0,
    taxTreatment: 'ROTH',
    accountType: 'RETIREMENT_ROTH_IRA',
    depositsByMonth: emptySeries,
  });

  /** Both owners are past 59½ with NO recorded clock (nonqualified → the
   *  basis-first ordering decides the taxable excess, no 10%). m1 holds $100k
   *  of §408A contribution basis; m2 holds none. */
  const run = (
    order: 'forward' | 'reversed',
    dollarsByAccountId: ReadonlyArray<readonly [string, number]>,
  ) => {
    const ctx = makeCtx({
      primaryBirthdate: '1955-01-01',
      secondaryBirthdate: '1956-01-01',
      accountProjections: [
        {
          id: 'roth-ira-m1',
          taxTreatment: 'ROTH',
          accountType: 'RETIREMENT_ROTH_IRA',
          ownerId: 'member-primary',
        },
        {
          id: 'roth-ira-m2',
          taxTreatment: 'ROTH',
          accountType: 'RETIREMENT_ROTH_IRA',
          ownerId: 'member-secondary',
        },
      ],
    });
    const carrier: RothBasisCarrier = new Map([
      [
        'member-primary',
        { rothBasisRemainingCents: 10_000_000, rothCumulativeWithdrawnCents: 0 },
      ],
    ]);
    const accounts = [iraLedger('roth-ira-m1'), iraLedger('roth-ira-m2')];
    const total = dollarsByAccountId.reduce((sum, [, d]) => sum + d, 0);
    const result = buildSolverPenaltyAccountsForYear({
      ctx,
      taxYear: 2030,
      ledgerAccounts: order === 'forward' ? accounts : [...accounts].reverse(),
      classification: {
        preTaxDollars: 0,
        postTaxCashLikeDollars: 0,
        rothDollars: total,
        rothIraDollarsByAccountId: new Map(dollarsByAccountId),
      },
      rothBasisCarrier: carrier,
      designatedRoth: new Map(),
    });
    return { ...result, carrier };
  };

  it('m2’s draw never consumes m1’s basis, in EITHER ledger order', () => {
    // Pre-attribution, the forward order's ledger pick was m1's IRA (first
    // non-inherited Roth IRA), so m1's $100k basis absorbed m2's whole $50k
    // draw and the funding pass funded $0 — while the annotation post-pass
    // reported m2's $50k as ordinary income against m2's real $0-basis pool.
    for (const order of ['forward', 'reversed'] as const) {
      const r = run(order, [['roth-ira-m2', 50_000]]);
      expect(r.rothEarningsExcessDollars).toBe(50_000);
      expect(r.carrier.get('member-primary')).toEqual({
        rothBasisRemainingCents: 10_000_000,
        rothCumulativeWithdrawnCents: 0,
      });
      expect(r.carrier.get('member-secondary')).toEqual({
        rothBasisRemainingCents: 0,
        rothCumulativeWithdrawnCents: 5_000_000,
      });
    }
  });

  it('a year drawing from BOTH owners charges each owner’s own entry, in EITHER ledger order', () => {
    for (const order of ['forward', 'reversed'] as const) {
      const r = run(order, [
        ['roth-ira-m1', 30_000],
        ['roth-ira-m2', 20_000],
      ]);
      // m1's $30k is fully sheltered by m1's own basis; m2's $20k is all excess.
      expect(r.rothEarningsExcessDollars).toBe(20_000);
      expect(r.carrier.get('member-primary')).toEqual({
        rothBasisRemainingCents: 7_000_000,
        rothCumulativeWithdrawnCents: 3_000_000,
      });
      expect(r.carrier.get('member-secondary')).toEqual({
        rothBasisRemainingCents: 0,
        rothCumulativeWithdrawnCents: 2_000_000,
      });
    }
  });
});

describe('buildSolverPenaltyAccountsForYear — §408A qualification follows the DRAWN owner (attribution)', () => {
  const emptySeries = { startYear: 2030, startMonthIndex: 0, values: new Float64Array(12) };
  const iraLedger = (id: string): DrawdownAccountInput => ({
    id,
    initialPre: 0,
    initialPost: 100_000,
    annualRatePct: 0,
    taxTreatment: 'ROTH',
    accountType: 'RETIREMENT_ROTH_IRA',
    depositsByMonth: emptySeries,
  });
  /** Mixed-age / mixed-clock two-owner household, tax year 2030. Each owner
   *  holds their OWN Roth IRA(s); the carrier seeds each owner's entry with
   *  their own basis and five-year clock. Qualification must follow the DRAWN
   *  owner's facts alone — a housemate who drew NOTHING must never move the
   *  funded figure. */
  const run = (args: {
    order: 'forward' | 'reversed';
    secondaryBirthdate: string;
    accounts: ReadonlyArray<{ id: string; ownerId: string }>;
    carrier: RothBasisCarrier;
    dollarsByAccountId: ReadonlyArray<readonly [string, number]>;
  }) => {
    const ctx = makeCtx({
      primaryBirthdate: '1958-01-01',
      secondaryBirthdate: args.secondaryBirthdate,
      accountProjections: args.accounts.map((a) => ({
        id: a.id,
        taxTreatment: 'ROTH',
        accountType: 'RETIREMENT_ROTH_IRA',
        ownerId: a.ownerId,
      })),
    });
    const ledger = args.accounts.map((a) => iraLedger(a.id));
    const total = args.dollarsByAccountId.reduce((sum, [, d]) => sum + d, 0);
    const result = buildSolverPenaltyAccountsForYear({
      ctx,
      taxYear: 2030,
      ledgerAccounts: args.order === 'forward' ? ledger : [...ledger].reverse(),
      classification: {
        preTaxDollars: 0,
        postTaxCashLikeDollars: 0,
        rothDollars: total,
        rothIraDollarsByAccountId: new Map(args.dollarsByAccountId),
      },
      rothBasisCarrier: args.carrier,
      designatedRoth: new Map(),
    });
    return { ...result, carrier: args.carrier };
  };
  const twoOwnerAccounts = [
    { id: 'roth-ira-m1', ownerId: 'member-primary' },
    { id: 'roth-ira-m2', ownerId: 'member-secondary' },
  ];
  const twoOwnerCarrier = (m2Clock: number): RothBasisCarrier =>
    new Map([
      [
        'member-primary',
        {
          rothBasisRemainingCents: 1_000_000,
          rothCumulativeWithdrawnCents: 0,
          firstContributionTaxYear: 2008,
        },
      ],
      [
        'member-secondary',
        {
          rothBasisRemainingCents: 0,
          rothCumulativeWithdrawnCents: 0,
          firstContributionTaxYear: m2Clock,
        },
      ],
    ]);

  it('funds NO tax on m1’s qualified draw when m2 (45, open clock) draws NOTHING, in EITHER ledger order', () => {
    // m1 (72, clock 2008 met) draws $100k, $10k of own basis remaining; m2
    // (45, clock 2026 open through 2030) draws nothing. m1's own facts decide
    // under attribution ⇒ QUALIFIED, $0 income, no snapshot — matching the
    // annotation post-pass. Pre-fix the pooled reduction read m2's age AND
    // clock into m1's draw (59½ false, clock max(2008, 2026) unmet), funding
    // $90k of phantom ordinary income plus a $9,000 10% prorated by m2's
    // birthdate — every year until m2's own facts caught up.
    for (const order of ['forward', 'reversed'] as const) {
      const r = run({
        order,
        secondaryBirthdate: '1985-06-01',
        accounts: twoOwnerAccounts,
        carrier: twoOwnerCarrier(2026),
        dollarsByAccountId: [['roth-ira-m1', 100_000]],
      });
      expect(r.rothEarningsExcessDollars).toBe(0);
      expect(r.penaltyAccounts).toEqual([]);
      // m1's own basis bookkeeping still rolls forward; m2's is untouched.
      expect(r.carrier.get('member-primary')).toEqual({
        rothBasisRemainingCents: 0,
        rothCumulativeWithdrawnCents: 10_000_000,
        firstContributionTaxYear: 2008,
      });
      expect(r.carrier.get('member-secondary')?.rothCumulativeWithdrawnCents).toBe(0);
    }
  });

  it('a clock-only mismatch: a non-drawing 59½+ owner’s open clock never taxes the drawn owner', () => {
    // Both owners are past 59½ (m2 born 1956), so only the five-year clocks
    // differ: m1's 2008 is met, m2's 2027 is open through 2031 — and m2 draws
    // nothing. Pre-fix the pooled clock was max(2008, 2027) = 2027, unmet in
    // 2030, funding m1's $90k of qualified earnings as phantom ordinary income
    // (no 10% — both owners 59½+).
    const r = run({
      order: 'forward',
      secondaryBirthdate: '1956-01-01',
      accounts: twoOwnerAccounts,
      carrier: twoOwnerCarrier(2027),
      dollarsByAccountId: [['roth-ira-m1', 100_000]],
    });
    expect(r.rothEarningsExcessDollars).toBe(0);
    expect(r.penaltyAccounts).toEqual([]);
  });

  it('the drawn owner is still taxed on their OWN facts, with the snapshot on the drawn ACCOUNT id', () => {
    // The mirror: m2 (45, open 2026 clock, $0 basis) draws $50k while
    // qualified m1 draws nothing ⇒ the whole $50k is m2's nonqualified
    // earnings and the 10% base rides m2's OWN account id and owner — so the
    // penalty engine prorates by m2's birthdate (fraction 1 → $5,000) and a
    // scenario exempting 'roth-ira-m2' waives exactly this base.
    for (const order of ['forward', 'reversed'] as const) {
      const r = run({
        order,
        secondaryBirthdate: '1985-06-01',
        accounts: twoOwnerAccounts,
        carrier: twoOwnerCarrier(2026),
        dollarsByAccountId: [['roth-ira-m2', 50_000]],
      });
      expect(r.rothEarningsExcessDollars).toBe(50_000);
      expect(r.penaltyAccounts).toEqual([
        {
          id: 'roth-ira-m2',
          type: 'RETIREMENT_ROTH_IRA',
          ownerId: 'member-secondary',
          penaltyPreTaxWithdrawalDollars: 50_000,
          rothOrderedAdditionalTaxBase: true,
          hsaWithdrawalDollars: 0,
        },
      ]);
      expect(fundedPenaltyDollars(r.penaltyAccounts, 2030)).toBe(5_000);
      expect(fundedPenaltyDollars(r.penaltyAccounts, 2030, ['roth-ira-m2'])).toBe(0);
      // m1's basis never shelters m2's draw.
      expect(r.carrier.get('member-primary')?.rothBasisRemainingCents).toBe(1_000_000);
    }
  });

  it('one owner’s base splits per drawn ACCOUNT, so an exempt sibling account waives only its own share', () => {
    // m2 draws $25k from EACH of two of her own Roth IRAs ($0 basis → $50k of
    // base). The base is emitted per real account id in proportion to the
    // attributed draw, so exempting 'roth-ira-m2a' alone waives exactly half:
    // $2,500 funded, not the all-or-nothing $0/$5,000 an aggregate snapshot
    // under one ledger-picked id produced (pre-fix the whole base skipped or
    // charged on whichever account the ledger scan found first).
    for (const order of ['forward', 'reversed'] as const) {
      const r = run({
        order,
        secondaryBirthdate: '1985-06-01',
        accounts: [
          { id: 'roth-ira-m2a', ownerId: 'member-secondary' },
          { id: 'roth-ira-m2b', ownerId: 'member-secondary' },
        ],
        carrier: twoOwnerCarrier(2026),
        dollarsByAccountId: [
          ['roth-ira-m2a', 25_000],
          ['roth-ira-m2b', 25_000],
        ],
      });
      expect(r.rothEarningsExcessDollars).toBe(50_000);
      expect(
        r.penaltyAccounts.map((p) => [p.id, p.penaltyPreTaxWithdrawalDollars, p.ownerId]),
      ).toEqual([
        ['roth-ira-m2a', 25_000, 'member-secondary'],
        ['roth-ira-m2b', 25_000, 'member-secondary'],
      ]);
      expect(fundedPenaltyDollars(r.penaltyAccounts, 2030)).toBe(5_000);
      expect(fundedPenaltyDollars(r.penaltyAccounts, 2030, ['roth-ira-m2a'])).toBe(2_500);
    }
  });
});

// ---------------------------------------------------------------------------
// buildSolverPenaltyAccountsForYear — a year whose Roth bucket splits into
// BOTH the §408A and §402A slices (the ordinary mixed-draw case)
// ---------------------------------------------------------------------------

describe('buildSolverPenaltyAccountsForYear — §408A + §402A slices in one year', () => {
  const emptySeries = { startYear: 2025, startMonthIndex: 0, values: new Float64Array(12) };

  it('runs each slice against its own state and sums their independent figures', () => {
    // One owner (born 1985 → 40 in 2025) drawing $10k of Roth: $4k committed
    // from the Roth 401(k) (`rothDesignatedDollars`), $6k from the Roth IRA.
    // Each slice must consume ONLY its own dollars and its own state; the
    // taxable total is the SUM of the two slices computed independently:
    //   - §408A: $6k against $4k contribution basis, clock absent → $2k
    //     nonqualified earnings (income + 10% base);
    //   - §402A: $4k against a $100k pooled balance with $6k basis (all of it
    //     a 2024 in-window taxable lot) → pro-rata basis $240, earnings
    //     $3,760 of income, base $3,760 + $240 recapture = $4,000.
    // Charging the whole tranche to either slice, or double-counting the
    // excess across both, moves every asserted figure.
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
    // The §408A carrier consumed exactly the IRA slice's $6k…
    expect(carrier.get('member-primary')).toEqual({
      rothBasisRemainingCents: 0,
      rothCumulativeWithdrawnCents: 600_000,
    });
    // …and the pooled designated state exactly the designated slice's $4k:
    // pro-rata basis $240 off the lot/basis, balance rolled forward by $4k.
    const state = designatedRoth.get('member-primary');
    expect(state?.entry.designatedRothBasisRemainingCents).toBe(576_000);
    expect(state?.entry.inPlanRolloverLots[0].taxableRolloverPrincipalRemainingCents).toBe(
      576_000,
    );
    expect(state?.balanceRemainingCents).toBe(9_600_000);
  });
});

// ---------------------------------------------------------------------------
// seedSolverDesignatedRothStates — cross-plan pooling reductions for one owner
// ---------------------------------------------------------------------------

describe('seedSolverDesignatedRothStates — pools one owner’s plans conservatively', () => {
  it('sums basis, aggregates lots per tax year ascending, drops the clock when any plan lacks one, and 457(b)-flags only an all-457(b) owner', () => {
    // One owner, two plans, listed with the LATER lot year first so the
    // ascending sort is proven rather than inherited from insertion order:
    //   - a Roth 401(k) with NO participation clock and a 2024 lot;
    //   - a governmental Roth 457(b) WITH a clock and a 2022 lot.
    // Wrong-direction failures this pins: an `any`-accumulated 457(b) flag
    // waives the 401(k) slice's genuine 10% (§72(t)(9) carve-out claimed for a
    // non-457(b) sibling); a dropped `anyClockMissing` reads the pooled clock
    // as met and funds $0 on a draw the annotation reports as taxable.
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

// ---------------------------------------------------------------------------
// Inherited designated-Roth plan — the funding pass holds no recapture state
// for it (§72(t)(2)(A)(ii)) and runs its dollars through the dedicated
// INHERITED slice, where the original owner's death is the qualifying event
// ---------------------------------------------------------------------------

describe('funding pass — inherited designated-Roth plan (§72(t)(2)(A)(ii))', () => {
  const emptySeries = { startYear: 2025, startMonthIndex: 0, values: new Float64Array(12) };
  /** A beneficiary's inherited Roth 401(k) with NO recorded in-plan rollover —
   *  the ordinary case (nobody records a rollover on a plan they inherited), so
   *  its derived basis is $0 and only the death
   *  qualifying event stands between the draw and full phantom taxation. */
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
    // The non-inherited seed must skip it: delete the skip and its state would
    // let an inherited plan's basis shield a sibling plan's lots (and its
    // in-window lot charge a beneficiary the 10% the statute forbids).
    const facts = inheritedFacts(2005);
    expect(
      seedSolverDesignatedRothStates(facts, new Map([['member-primary', 70_000_000]])).size,
    ).toBe(0);
    // The INHERITED seed pools it, `inheritedFromDeceasedOwner` carried so the
    // primitive applies the death qualifying event and waives the 10%.
    const inherited = seedSolverInheritedDesignatedRothStates(
      facts,
      new Map([['member-primary', 70_000_000]]),
    );
    expect(inherited.size).toBe(1);
    const entry = inherited.get('member-primary')?.entry;
    expect(entry?.inheritedFromDeceasedOwner).toBe(true);
    expect(entry?.firstParticipationTaxYear).toBe(2005);
    expect(inherited.get('member-primary')?.balanceRemainingCents).toBe(70_000_000);
    // And the mirror: the inherited seed skips a NON-inherited plan.
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
    // Beneficiary aged 40, participation clock 2005 met, derived basis $0. The
    // annotation reports the draw QUALIFIED (§402A(d)(2)(B)(i)); routed through
    // the §408A carrier instead (the pre-fix wiring), the same draw funded the
    // whole $40k as ordinary income PLUS a $4k additional tax nobody owes —
    // permanently inflating every committed withdrawal.
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
    // Clock 2024 (five-year window open through 2028), $0 basis → the whole
    // draw is nonqualified earnings: ordinary income the annotation also
    // reports, but NO penalty snapshot at any beneficiary age.
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
    // The pooled pro-rata denominator rolled forward.
    expect(inheritedDesignatedRoth.get('member-primary')?.balanceRemainingCents).toBe(
      66_000_000,
    );
  });

  it('each beneficiary’s dollars charge their OWN state under their OWN clock, in EITHER ledger order', () => {
    // m1 inherited a Roth 403(b) with a 2024 participation clock (five-taxable-
    // year period UNMET through 2028) and $0 derived basis over a $100k pocket;
    // m2 inherited a Roth 401(k) with a MET 2005 clock and $200k of recorded
    // in-plan-rollover basis over a $400k pocket. Under the classifier's
    // attribution each beneficiary's drawn dollars run against that
    // beneficiary's own denominator, basis AND participation clock — in EITHER
    // ledger order. Pre-fix the clock was reduced household-conservatively to
    // the LATEST across both beneficiaries (2024, unmet), so m1's open clock
    // funded phantom ordinary income on m2's met-clock qualified draw even in
    // a year m1 drew nothing.
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

      // m2's own 2005 clock is met, and the death event qualifies the draw
      // (§402A(d)(2)(B)(i)) — $0 ordinary income, m1's open 2024 clock
      // irrelevant because m1 drew nothing. The pro-rata bookkeeping still
      // rolls forward against m2's OWN state (50% basis fraction: $15k basis
      // consumed), whatever the ledger order.
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

// ---------------------------------------------------------------------------
// MIXED employer plans — only the post sub-bucket is designated Roth, and the
// inherited selector partitions its denominator before the funding pass.
// ---------------------------------------------------------------------------

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
    // $20k basis / $100k post pocket × $10k draw = $2k basis and $8k
    // earnings. The basis is an in-window taxable rollover lot, so recapture
    // plus earnings make the additional-tax base the full $10k.
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

// ---------------------------------------------------------------------------
// Funding carrier integration — dated §408A conversion lots must reach the
// real tax-cashflow hook, both from engine-generated and recorded conversions.
// ---------------------------------------------------------------------------

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
    // The $10k converted principal is income-tax-free but is the full 10%
    // recapture base, so the funding pass adds exactly $1,000 of federal tax.
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
  // `RETIREMENT_TSP` stored `POST_TAX` is a valid 100% designated-Roth TSP
  // under the account-type rules, but the designated branch only recognises
  // pure-Roth types and `MIXED` taxTreatment. Widening it to also accept
  // `POST_TAX` (tried and reverted) blanks the household's pooled five-year
  // clock, because `resolveRothStartYear` has no evidence path for this shape
  // — see roth-start-year.test.ts's "supports designated-Roth plan rollover
  // evidence but excludes regular post-tax TSP". The omission below is
  // therefore intentional, not a regression: a POST_TAX TSP produces no
  // designated-Roth fact at all, and a sibling MIXED plan's own fact — clock
  // included — is unaffected by its presence.
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
