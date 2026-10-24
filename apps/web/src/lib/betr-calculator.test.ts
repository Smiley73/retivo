import { describe, it, expect } from 'vitest';
import {
  computeBETR,
  computeWorkingYearsBETRSummary,
  computeRetirementYearsBETR,
  type BETRScenarioContext,
} from './betr-calculator';
import { EARLY_WITHDRAWAL_PENALTY_RATE } from './early-withdrawal-penalty';
import { DEFAULT_TAX_CALIBRATION_BUNDLE } from './tax-integration-helpers';
import type { DrawdownYear } from './drawdown-engine-types';

const BUNDLE = DEFAULT_TAX_CALIBRATION_BUNDLE;

describe('computeBETR', () => {
  it('should_equal_T_now_for_the_from_IRA_source_regardless_of_n_and_r', () => {
    expect(computeBETR('ira', 0.22, 15, 0.07, {})).toBe(0.22);
    expect(computeBETR('ira', 0.22, 0, 0.07, {})).toBe(0.22);
    expect(computeBETR('ira', 0.35, 30, 0.05, {})).toBe(0.35);
  });

  it('should_match_the_hand_computed_tax_efficient_formula', () => {
    // 0.22 × ((1 + 0.07×0.90) / 1.07)^15
    const expected = 0.22 * Math.pow((1 + 0.07 * 0.9) / 1.07, 15);
    expect(computeBETR('taxEfficient', 0.22, 15, 0.07, { rSrc: 0.07, dragPct: 0.1 })).toBeCloseTo(
      expected,
      12,
    );
  });

  it('should_match_the_hand_computed_tax_inefficient_formula', () => {
    const expected = 0.22 * Math.pow((1 + 0.07 * 0.75) / 1.07, 15);
    expect(computeBETR('taxInefficient', 0.22, 15, 0.07, { rSrc: 0.07, dragPct: 0.25 })).toBeCloseTo(
      expected,
      12,
    );
  });

  it('should_drag_cash_interest_at_T_now', () => {
    // cash after-drag = rate × (1 − T_now) = 0.04 × 0.78
    const expected = 0.22 * Math.pow((1 + 0.04 * (1 - 0.22)) / 1.07, 15);
    expect(computeBETR('cash', 0.22, 15, 0.07, { cashRatePct: 0.04 })).toBeCloseTo(expected, 12);
  });

  it('should_collapse_every_source_to_T_now_when_n_is_0', () => {
    for (const source of ['ira', 'taxEfficient', 'taxInefficient', 'cash'] as const) {
      expect(computeBETR(source, 0.24, 0, 0.07, { rSrc: 0.07, dragPct: 0.1 })).toBe(0.24);
    }
  });

  it('should_stay_finite_for_degenerate_rates_and_large_n', () => {
    expect(Number.isFinite(computeBETR('taxEfficient', 0.22, 30, -0.999, { rSrc: 0.07 }))).toBe(
      true,
    );
    expect(Number.isFinite(computeBETR('cash', 0.22, 30, 0.07, { cashRatePct: -0.999 }))).toBe(true);
  });

  it('should_apply_the_10pct_early_withdrawal_penalty_to_the_from_IRA_source_when_under59Penalty', () => {
    // Under 59½ the withheld-tax dollars take the 10% §72(t) penalty: from-IRA BETR is T_now × 1.10.
    const expected = 0.22 * (1 + EARLY_WITHDRAWAL_PENALTY_RATE);
    expect(computeBETR('ira', 0.22, 15, 0.07, { under59Penalty: true })).toBeCloseTo(expected, 12);
    // The IRA branch returns before the n <= 0 guard, so the penalty applies at n = 0 too.
    expect(computeBETR('ira', 0.22, 0, 0.07, { under59Penalty: true })).toBeCloseTo(expected, 12);
    expect(computeBETR('ira', 0.35, 30, 0.05, { under59Penalty: true })).toBeCloseTo(
      0.35 * (1 + EARLY_WITHDRAWAL_PENALTY_RATE),
      12,
    );
  });

  it('should_ignore_under59Penalty_on_the_from_IRA_source_when_false_or_absent', () => {
    expect(computeBETR('ira', 0.22, 15, 0.07, { under59Penalty: false })).toBe(0.22);
    expect(computeBETR('ira', 0.22, 15, 0.07, {})).toBe(0.22);
  });

  it('should_treat_under59Penalty_as_a_no_op_on_the_non_IRA_sources', () => {
    for (const source of ['taxEfficient', 'taxInefficient', 'cash'] as const) {
      const withFlag = computeBETR(source, 0.22, 15, 0.07, {
        rSrc: 0.07,
        dragPct: 0.1,
        under59Penalty: true,
      });
      const withoutFlag = computeBETR(source, 0.22, 15, 0.07, { rSrc: 0.07, dragPct: 0.1 });
      expect(withFlag).toBe(withoutFlag);
    }
  });
});

function ctx(overrides: Partial<BETRScenarioContext> = {}): BETRScenarioContext {
  return {
    filingStatus: 'MFJ',
    ownerBirthYear: 1958, // born ≤1959 → trigger age 73
    taxpayersAge65Plus: 0,
    lifeExpectancyAnchorYear: 2050,
    currentCalendarYear: 2025,
    retirementYear: 2030,
    preRetirementTaxableIncomeDollars: 150_000,
    existingAnnualConversionDollars: 0,
    rIra: 0.07,
    grossSsAnnualCents: 0,
    beneficiariesOnMedicareCount: 0,
    householdSize: 2,
    benchmarkAnnualSlcspCents: 0,
    inflationRatePct: 2.5,
    taxExemptInterestCents: 0,
    ...overrides,
  };
}

function drawdownYear(year: number, magiCents?: number, taxableSsCents?: number): DrawdownYear {
  return {
    year,
    balance: 0,
    withdrawn: 0,
    netNeed: 0,
    growth: 0,
    deposit: 0,
    depleted: false,
    ...(magiCents !== undefined ? { magiCents } : {}),
    ...(taxableSsCents !== undefined ? { taxableSsCents } : {}),
  };
}

describe('computeWorkingYearsBETRSummary', () => {
  it('should_derive_T_future_from_RMD_era_rows_only', () => {
    // Owner born 1958: trigger age 73, so RMD-era rows start 2031.
    const rows = [
      drawdownYear(2030, 90_000_00), // pre-RMD, excluded
      drawdownYear(2031, 200_000_00),
      drawdownYear(2032, 200_000_00),
    ];
    const summary = computeWorkingYearsBETRSummary(ctx(), rows, BUNDLE);
    expect(summary.rmdTriggerAge).toBe(73);
    expect(summary.T_future).toBeGreaterThan(0);
    expect(summary.bracketHeadroomCents).toBeGreaterThan(0);
  });

  it('should_never_leak_the_under59Penalty_into_the_working_years_Apply_tranche_path', () => {
    // Apply's amount is the from-IRA convert tranche sum at the unpenalized rate; pins against an under59Penalty leak into computeWorkingYearsBETRSummary.
    const rows = [drawdownYear(2031, 300_000_00), drawdownYear(2032, 300_000_00)];
    const summary = computeWorkingYearsBETRSummary(ctx(), rows, BUNDLE);
    // Room 56,700; T_future 0.24 > betr 0.22 converts the tranche. A leaked penalty (0.242) would hold it and collapse convertTotalCents to 0.
    expect(summary.bracketHeadroomCents).toBe(56_700_00);
    expect(summary.T_future).toBe(0.24);
    expect(summary.convertTotalCents).toBe(56_700_00);
    expect(summary.tranches).toHaveLength(1);
    for (const t of summary.tranches) {
      expect(t.betr).toBe(t.T_now);
    }
    expect(summary.tranches[0].T_now).toBe(0.22);
  });

  it('should_hold_the_tranche_when_T_future_is_below_the_from_IRA_rate', () => {
    const rows = [drawdownYear(2031, 90_000_00), drawdownYear(2032, 90_000_00)];
    const summary = computeWorkingYearsBETRSummary(ctx(), rows, BUNDLE);
    expect(summary.T_future).toBeLessThan(0.22);
    expect(summary.tranches).toHaveLength(1);
    expect(summary.tranches[0].verdict).toBe('hold');
    expect(summary.convertTotalCents).toBe(0);
  });

  it('should_subtract_an_existing_conversion_from_the_headroom', () => {
    const rows = [drawdownYear(2031, 300_000_00)];
    const summary = computeWorkingYearsBETRSummary(
      ctx({ existingAnnualConversionDollars: 10_000 }),
      rows,
      BUNDLE,
    );
    expect(summary.bracketHeadroomCents).toBe(46_700_00);
  });

  it('should_have_no_headroom_once_income_plus_conversion_reaches_the_ceiling', () => {
    const summary = computeWorkingYearsBETRSummary(
      ctx({ preRetirementTaxableIncomeDollars: 200_000, existingAnnualConversionDollars: 10_000 }),
      [drawdownYear(2031, 300_000_00)],
      BUNDLE,
    );
    expect(summary.bracketHeadroomCents).toBe(0);
    expect(summary.tranches).toHaveLength(0);
  });

  it('should_convert_nothing_in_the_top_bracket_where_headroom_is_unbounded', () => {
    const summary = computeWorkingYearsBETRSummary(
      ctx({ preRetirementTaxableIncomeDollars: 900_000 }),
      [drawdownYear(2031, 300_000_00)],
      BUNDLE,
    );
    expect(summary.bracketHeadroomCents).toBe(0);
    expect(summary.tranches).toHaveLength(0);
  });

  it('should_return_a_needs_input_summary_when_taxable_income_is_absent', () => {
    const rows = [drawdownYear(2031, 200_000_00)];
    const summary = computeWorkingYearsBETRSummary(
      ctx({ preRetirementTaxableIncomeDollars: undefined }),
      rows,
      BUNDLE,
    );
    expect(summary.bracketHeadroomCents).toBe(0);
    expect(summary.tranches).toHaveLength(0);
    expect(summary.convertTotalCents).toBe(0);
  });

  it('should_use_trigger_age_75_for_a_born_1960_owner', () => {
    const summary = computeWorkingYearsBETRSummary(
      ctx({ ownerBirthYear: 1962 }),
      [drawdownYear(2031, 200_000_00)],
      BUNDLE,
    );
    expect(summary.rmdTriggerAge).toBe(75);
  });

  it('should_yield_T_future_0_when_no_RMD_era_rows_exist', () => {
    const summary = computeWorkingYearsBETRSummary(
      ctx(),
      [drawdownYear(2030, 90_000_00)],
      BUNDLE,
    );
    expect(summary.T_future).toBe(0);
  });

  it('should_not_throw_for_a_post_2026_current_calendar_year', () => {
    // A working year past the latest published federal table must use the extrapolating snapshot, not throw UnsupportedTaxYearError.
    const run = (): ReturnType<typeof computeWorkingYearsBETRSummary> =>
      computeWorkingYearsBETRSummary(
        ctx({ currentCalendarYear: 2027, retirementYear: 2032 }),
        [drawdownYear(2031, 200_000_00), drawdownYear(2032, 200_000_00)],
        BUNDLE,
      );
    expect(run).not.toThrow();
    const summary = run();
    expect(summary.bracketHeadroomCents).toBeGreaterThan(0);
    expect(summary.tranches.length).toBeGreaterThan(0);
    for (const t of summary.tranches) {
      expect(Number.isFinite(t.T_now)).toBe(true);
      expect(Number.isFinite(t.betr)).toBe(true);
    }
  });
});

describe('computeRetirementYearsBETR', () => {
  it('should_emit_one_row_per_eligible_drawdown_year_with_an_all_in_rate', () => {
    const rows = [
      drawdownYear(2032, 120_000_00, 0),
      drawdownYear(2035, 130_000_00, 0),
    ];
    const result = computeRetirementYearsBETR(rows, ctx(), BUNDLE);
    expect(result).toHaveLength(2);
    for (const r of result) {
      expect(Number.isFinite(r.allInRate)).toBe(true);
      expect(r.n).toBeGreaterThan(0);
      expect(r.T_now).toBeGreaterThanOrEqual(0);
    }
  });

  it('should_skip_rows_missing_magiCents_or_taxableSsCents_and_the_anchor_year', () => {
    const rows = [
      drawdownYear(2032, undefined, 0), // missing magi → skip
      drawdownYear(2033, 120_000_00, undefined), // missing taxableSs → skip
      drawdownYear(2050, 120_000_00, 0), // n = 0 anchor-year → skip
      drawdownYear(2035, 120_000_00, 0), // emitted
    ];
    const result = computeRetirementYearsBETR(rows, ctx(), BUNDLE);
    expect(result).toHaveLength(1);
    expect(result[0].drawdownYear.year).toBe(2035);
  });

  it('should_produce_an_empty_result_for_an_empty_drawdown_set', () => {
    expect(computeRetirementYearsBETR([], ctx(), BUNDLE)).toHaveLength(0);
  });

  it('should_apply_the_OBBBA_senior_bonus_phaseout_to_T_now_inside_the_window', () => {
    // Senior-bonus phase-out: Single 2025, MAGI $120,000 inside the band. age65=0 gives taxable $104,250 (24%); age65=1 gives bonus $3,300, taxable $98,950 (22%).
    const single2025 = (age65: 0 | 1): BETRScenarioContext =>
      ctx({
        filingStatus: 'Single',
        taxpayersAge65Plus: age65,
        lifeExpectancyAnchorYear: 2050,
        householdSize: 1,
      });
    const row = [drawdownYear(2025, 120_000_00, 0)];
    const baseline = computeRetirementYearsBETR(row, single2025(0), BUNDLE);
    const withSenior = computeRetirementYearsBETR(row, single2025(1), BUNDLE);
    expect(baseline).toHaveLength(1);
    expect(withSenior).toHaveLength(1);
    expect(baseline[0].T_now).toBe(0.24);
    expect(withSenior[0].T_now).toBe(0.22);
    expect(withSenior[0].T_now).not.toBe(baseline[0].T_now);
  });
});
