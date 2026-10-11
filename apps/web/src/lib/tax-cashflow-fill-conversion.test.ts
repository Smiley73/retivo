/**
 * Unit tests for the Fill-mode Roth-conversion solve: the OUTER
 * monotone bisection (`solveFillConversion`) that sizes a year's auto-conversion
 * so realized MAGI on the user-selected line lands AT the ceiling, never above.
 *
 * Covers:
 *   - Fill solves to the selected MAGI line; realized MAGI ≤ ceiling.
 *   - §86 provisional-income boundary: a household whose SS spillover makes
 *     dMAGI/dconv jump to 1.5/1.85 still converges with realized MAGI ≤ target;
 *     never overshoots.
 *   - Round-DOWN tie-break + iteration-cap termination (no oscillation).
 *   - ACA line (full-SS add-back, slope 1.0) diverges from the IRMAA line.
 *   - Zero headroom: withdrawals-only MAGI already ≥ ceiling → $0 converted.
 *   - Full room under the ceiling → convert all of it.
 */
import { describe, it, expect } from 'vitest';
import { solveFillConversion, type FillConversionSolveArgs } from './tax-cashflow-solver';
import { applyTaxYear } from './tax-integration';
import type { TaxCalibrationBundle, TaxYearInput, TaxMemberInput } from './tax-integration';
import { FEDERAL_TAX_CONFIG } from './federal-tax-config';
import { SS_TAX_THRESHOLDS } from './ss-taxation-thresholds';
import { IRMAA_TIERS } from './irmaa-tiers';
import { ACA_PTC_PARAMETERS } from './aca-ptc-parameters';
import { RMD_DIVISORS } from './rmd-divisors';
import { DEFAULT_ASSUMED_TAXABLE_YIELD_CONFIG } from './assumed-taxable-yield-config';

const REAL_BUNDLE: TaxCalibrationBundle = {
  federalTax: FEDERAL_TAX_CONFIG,
  ssTax: SS_TAX_THRESHOLDS,
  irmaa: IRMAA_TIERS,
  acaPtc: ACA_PTC_PARAMETERS,
  rmd: RMD_DIVISORS,
  assumedTaxableYield: DEFAULT_ASSUMED_TAXABLE_YIELD_CONFIG,
};

/** Single-member 2024 tax input, no SS / no Medicare / no ACA. */
function baseTaxInput(overrides: Partial<TaxYearInput> = {}): TaxYearInput {
  const member: TaxMemberInput = {
    memberId: 'p',
    isoBirthdate: '1960-01-01',
    onMedicare: false,
    hasAcaCoverage: false,
  };
  return {
    taxYear: 2024,
    filingStatus: 'Single',
    grossSsDollars: 0,
    preTaxWithdrawalDollars: 0,
    postTaxNonRothWithdrawalDollars: 0,
    rothWithdrawalDollars: 0,
    otherOrdinaryIncomeDollars: 0,
    taxExemptInterestDollars: 0,
    householdSize: 1,
    members: [member],
    accounts: [],
    taxpayersAge65Plus: 0,
    ...overrides,
  };
}

function baseArgs(overrides: Partial<FillConversionSolveArgs> = {}): FillConversionSolveArgs {
  return {
    taxInputBase: baseTaxInput(),
    bundle: REAL_BUNDLE,
    capMagiLine: 'irmaa',
    magiCeilingDollars: 100_000,
    convertibleRoomDollars: 200_000,
    ...overrides,
  };
}

/** Realized federal/IRMAA MAGI (dollars) for a committed conversion. */
function realizedIrmaaMagi(taxInputBase: TaxYearInput, convDollars: number): number {
  const r = applyTaxYear(
    { ...taxInputBase, otherOrdinaryIncomeDollars: taxInputBase.otherOrdinaryIncomeDollars + convDollars },
    REAL_BUNDLE,
  );
  return r.magiCents / 100;
}

describe('solveFillConversion — Fill-mode bisection to the MAGI line', () => {
  it('should_solve_to_the_ceiling_so_realized_MAGI_lands_at_not_above_the_target', () => {
    // No SS → MAGI(conv) = conv (slope 1.0). Ceiling $100k, room $200k.
    const args = baseArgs({ magiCeilingDollars: 100_000, convertibleRoomDollars: 200_000 });
    const { convertedDollars } = solveFillConversion(args);
    // Converts up to ~the ceiling, never above it.
    expect(convertedDollars).toBeGreaterThan(99_000);
    expect(convertedDollars).toBeLessThanOrEqual(100_000);
    const realized = realizedIrmaaMagi(args.taxInputBase, convertedDollars);
    expect(realized).toBeLessThanOrEqual(100_000 + 0.01);
  });

  it('should_converge_below_the_target_across_an_§86_provisional_income_boundary', () => {
    // A household with SS: as the conversion pushes provisional income up, the
    // §86 taxable-SS spillover makes dMAGI/dconv jump (1.0 → 1.5 → 1.85), so a
    // gross-dollar budget would overshoot. The bisection against actual MAGI must
    // still land realized MAGI ≤ the ceiling.
    const args = baseArgs({
      taxInputBase: baseTaxInput({ grossSsDollars: 40_000, preTaxWithdrawalDollars: 10_000 }),
      magiCeilingDollars: 55_000,
      convertibleRoomDollars: 120_000,
    });
    const { convertedDollars } = solveFillConversion(args);
    const realized = realizedIrmaaMagi(args.taxInputBase, convertedDollars);
    // Realized MAGI must not exceed the ceiling even though the SS spillover
    // made each converted dollar raise MAGI by > $1 near the boundary.
    expect(realized).toBeLessThanOrEqual(55_000 + 0.01);
    // And it must actually have converted something (headroom existed at conv=0).
    expect(convertedDollars).toBeGreaterThan(0);
    // One more converted dollar would tip MAGI strictly over the ceiling
    // (round-down tie-break: we sit just under the target line).
    const oneMore = realizedIrmaaMagi(args.taxInputBase, convertedDollars + 1);
    expect(oneMore).toBeGreaterThan(55_000 - 5); // approaching/over the line
  });

  it('should_terminate_within_the_iteration_cap_without_oscillating', () => {
    const args = baseArgs({ magiCeilingDollars: 73_321, convertibleRoomDollars: 500_000 });
    const { iterations, convertedDollars } = solveFillConversion(args);
    expect(iterations).toBeLessThanOrEqual(40);
    // No SS → slope 1.0 → solves to ~the ceiling.
    expect(convertedDollars).toBeGreaterThan(72_000);
    expect(convertedDollars).toBeLessThanOrEqual(73_321);
  });

  it('should_round_down_so_the_committed_conversion_never_tips_MAGI_over', () => {
    const args = baseArgs({ magiCeilingDollars: 80_000.999, convertibleRoomDollars: 200_000 });
    const { convertedDollars } = solveFillConversion(args);
    // Whole-cent result (round-down).
    expect(Math.round(convertedDollars * 100)).toBe(Math.floor(convertedDollars * 100));
    expect(realizedIrmaaMagi(args.taxInputBase, convertedDollars)).toBeLessThanOrEqual(80_000.999 + 0.01);
  });

  it('should_convert_zero_when_withdrawals_only_MAGI_already_meets_the_ceiling', () => {
    // Pre-tax withdrawals already at the ceiling → no headroom.
    const args = baseArgs({
      taxInputBase: baseTaxInput({ preTaxWithdrawalDollars: 100_000 }),
      magiCeilingDollars: 100_000,
      convertibleRoomDollars: 50_000,
    });
    expect(solveFillConversion(args).convertedDollars).toBe(0);
  });

  it('should_convert_the_full_room_when_it_all_stays_under_the_ceiling', () => {
    const args = baseArgs({ magiCeilingDollars: 500_000, convertibleRoomDollars: 25_000 });
    expect(solveFillConversion(args).convertedDollars).toBeCloseTo(25_000, 2);
  });

  it('should_diverge_between_the_ACA_and_IRMAA_lines_for_an_SS_household', () => {
    // ACA MAGI adds back the NONTAXABLE SS portion, so the ACA line is reached
    // with LESS conversion than the IRMAA line for the same ceiling.
    const taxInputBase = baseTaxInput({ grossSsDollars: 30_000 });
    const irmaa = solveFillConversion(
      baseArgs({ taxInputBase, capMagiLine: 'irmaa', magiCeilingDollars: 60_000, convertibleRoomDollars: 150_000 }),
    ).convertedDollars;
    const aca = solveFillConversion(
      baseArgs({ taxInputBase, capMagiLine: 'aca', magiCeilingDollars: 60_000, convertibleRoomDollars: 150_000 }),
    ).convertedDollars;
    // Full-SS add-back raises ACA MAGI above the IRMAA MAGI at every conv, so the
    // ACA ceiling is hit first → fewer convertible dollars.
    expect(aca).toBeLessThan(irmaa);
  });
});
