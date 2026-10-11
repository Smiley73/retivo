/**
 * Unit tests for the BETR math library.
 * Hand-computed fixtures for all four tax-payment sources, bracket-headroom
 * boundaries, per-bracket tranches, and T_future derivation from a seeded
 * DrawdownYear set. Federal lookups use the real FEDERAL_TAX_CONFIG + the
 * default calibration bundle.
 */

import { describe, it, expect } from 'vitest';
import {
  computeBETR,
  computeBracketHeadroom,
  computeConversionTranches,
  computeWorkingYearsBETRSummary,
  computeRetirementYearsBETR,
  type BETRScenarioContext,
} from './betr-calculator';
import { EARLY_WITHDRAWAL_PENALTY_RATE } from './early-withdrawal-penalty';
import { FEDERAL_TAX_CONFIG } from './federal-tax-config';
import {
  DEFAULT_TAX_CALIBRATION_BUNDLE,
  resolveFederalTaxSnapshotForYear,
} from './tax-integration-helpers';
import type { DrawdownYear } from './drawdown-engine-types';

const SNAPSHOT = FEDERAL_TAX_CONFIG;
const BUNDLE = DEFAULT_TAX_CALIBRATION_BUNDLE;

// ---------------------------------------------------------------------------
// computeBETR — four sources
// ---------------------------------------------------------------------------

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
    // Under 59½ the withheld-tax dollars take the 10% §72(t) penalty, so the
    // from-IRA BETR is T_now × 1.10. IEEE-754: 0.22 × 1.1 !== 0.242 exactly, so
    // compare against the same expression (the file's toBeCloseTo(…, 12) convention).
    const expected = 0.22 * (1 + EARLY_WITHDRAWAL_PENALTY_RATE);
    expect(computeBETR('ira', 0.22, 15, 0.07, { under59Penalty: true })).toBeCloseTo(expected, 12);
    // n-independent: the penalty applies at any n, including n = 0 (the IRA
    // branch returns before the `n <= 0` guard, so the penalty is not skipped).
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

// ---------------------------------------------------------------------------
// computeBracketHeadroom
// ---------------------------------------------------------------------------

describe('computeBracketHeadroom', () => {
  it('should_compute_room_to_the_next_ceiling_without_re_subtracting_deduction', () => {
    // MFJ 2025: 22% band 96,950–206,700. Income $150,000 post-deduction; no
    // existing conversion. Room to the 24% ceiling = 206,700 − 150,000 = 56,700.
    const result = computeBracketHeadroom(150_000_00, 0, 2025, 'MFJ', SNAPSHOT);
    expect(result.ceilingCents).toBe(206_700_00);
    expect(result.headroomCents).toBe(56_700_00);
    expect(result.currentRate).toBe(0.22);
  });

  it('should_subtract_an_existing_conversion_from_headroom', () => {
    const result = computeBracketHeadroom(150_000_00, 10_000_00, 2025, 'MFJ', SNAPSHOT);
    expect(result.headroomCents).toBe(46_700_00);
  });

  it('should_return_0_when_income_plus_conversion_already_reaches_the_ceiling', () => {
    const result = computeBracketHeadroom(200_000_00, 10_000_00, 2025, 'MFJ', SNAPSHOT);
    expect(result.headroomCents).toBe(0);
  });

  it('should_report_infinite_headroom_in_the_top_bracket', () => {
    const result = computeBracketHeadroom(900_000_00, 0, 2025, 'MFJ', SNAPSHOT);
    expect(result.ceilingCents).toBe(Infinity);
    expect(result.headroomCents).toBe(Infinity);
    expect(result.currentRate).toBe(0.37);
  });

  it('should_handle_a_post_2026_year_via_a_caller_resolved_snapshot', () => {
    // The standalone helper requires the caller to pass a snapshot that
    // contains `year` (same contract as marginalOrdinaryRate). For a post-2026
    // row the caller resolves the extrapolating snapshot first.
    const { lookupYear, snapshot } = resolveFederalTaxSnapshotForYear(SNAPSHOT, 2035, 2.5);
    const run = (): ReturnType<typeof computeBracketHeadroom> =>
      computeBracketHeadroom(150_000_00, 0, lookupYear, 'MFJ', snapshot);
    expect(run).not.toThrow();
    expect(Number.isFinite(run().ceilingCents)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeConversionTranches
// ---------------------------------------------------------------------------

describe('computeConversionTranches', () => {
  it('should_split_a_conversion_at_the_bracket_boundary_with_distinct_rates', () => {
    // MFJ 2025: income at 90,000 (12% band, ceiling 96,950). Convert $50k:
    //   tranche 1: 6,950 at 12%
    //   tranche 2: 43,050 at 22% (next ceiling 206,700)
    const tranches = computeConversionTranches(
      90_000_00,
      50_000_00,
      0.30, // T_future high → both convert
      15,
      0.07,
      'ira',
      {},
      2025,
      'MFJ',
      SNAPSHOT,
    );
    expect(tranches).toHaveLength(2);
    expect(tranches[0].amountCents).toBe(6_950_00);
    expect(tranches[0].T_now).toBe(0.12);
    expect(tranches[1].amountCents).toBe(43_050_00);
    expect(tranches[1].T_now).toBe(0.22);
  });

  it('should_mark_convert_when_T_future_exceeds_betr_and_hold_otherwise', () => {
    // From-IRA betr == T_now. T_future 0.20: 12% tranche converts (0.20>0.12),
    // 22% tranche holds (0.20<0.22).
    const tranches = computeConversionTranches(
      90_000_00,
      50_000_00,
      0.20,
      15,
      0.07,
      'ira',
      {},
      2025,
      'MFJ',
      SNAPSHOT,
    );
    expect(tranches[0].verdict).toBe('convert');
    expect(tranches[1].verdict).toBe('hold');
  });

  it('should_return_empty_for_a_zero_proposed_amount', () => {
    expect(
      computeConversionTranches(90_000_00, 0, 0.3, 15, 0.07, 'ira', {}, 2025, 'MFJ', SNAPSHOT),
    ).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario context fixtures + T_future / row analysis
// ---------------------------------------------------------------------------

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
    // Owner born 1958 → trigger age 73 → RMD era starts 2031. Rows before that
    // are excluded. RMD-era rows at $200k MAGI (MFJ, post-deduction ~22% band).
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
    // Apply's write-back amount is the from-IRA convert-verdict tranche SUM at
    // the UNPENALIZED rate (betr == T_now). This pins convertTotalCents and the
    // tranche betr so an accidental under59Penalty leak into
    // computeWorkingYearsBETRSummary (which must keep passing `{}`) fails loudly.
    const rows = [drawdownYear(2031, 300_000_00), drawdownYear(2032, 300_000_00)];
    const summary = computeWorkingYearsBETRSummary(ctx(), rows, BUNDLE);
    // MFJ 2025, $150k post-deduction income: room to the 22% ceiling (206,700) is
    // 56,700; T_future (RMD-era, 24% band at ~$270k taxable) = 0.24 > the from-IRA
    // BETR (0.22), so the whole tranche converts. A leaked penalty would push the
    // tranche BETR to 0.242 > 0.24 → hold → convertTotalCents collapses to 0.
    expect(summary.bracketHeadroomCents).toBe(56_700_00);
    expect(summary.T_future).toBe(0.24);
    expect(summary.convertTotalCents).toBe(56_700_00);
    expect(summary.tranches).toHaveLength(1);
    for (const t of summary.tranches) {
      // The from-IRA identity: betr == T_now, NOT T_now × 1.10.
      expect(t.betr).toBe(t.T_now);
    }
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
    // A working year past the latest published federal table (2027) must route
    // through the extrapolating snapshot, not throw UnsupportedTaxYearError on
    // the raw config. retirementYear 2032 keeps n > 0; RMD-era rows still derive
    // T_future. The summary should come back populated, not crash.
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
    // Exercises the senior-bonus phase-out arithmetic in deriveTaxableIncomeCents
    // (never hit by the other fixtures, which all use taxpayersAge65Plus: 0).
    // Single 2025: std $15,750, age-65 add-on $2,000, senior-bonus cap $6,000,
    // phase-out base $75,000 @ 6%. Row year 2025 (senior bonus active), MAGI
    // $120,000 — INSIDE the phase-out band (> $75k base):
    //   age65=0 → deduction $15,750 → taxable $104,250 → 24% band (> $103,350).
    //   age65=1 → phaseout 0.06×($120k−$75k)=$2,700 → bonus $3,300 → deduction
    //             $21,050 → taxable $98,950 → 22% band. T_now drops 24% → 22%.
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
    // The phased-out senior bonus lowers taxable income across the 24% → 22%
    // boundary, so the deduction is provably changing the math.
    expect(withSenior[0].T_now).toBe(0.22);
    expect(withSenior[0].T_now).not.toBe(baseline[0].T_now);
  });
});
