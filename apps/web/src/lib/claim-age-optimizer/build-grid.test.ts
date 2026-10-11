/**
 * Boundary tests for the candidate-age grid. Pins the `ceil`
 * clamp so a future `floor` regression (admitting past claim ages)
 * fails red.
 */
import { describe, expect, it } from 'vitest';
import { buildCandidateGrid, buildSurvivorCandidateGrid } from './build-grid';

describe('buildCandidateGrid', () => {
  it('should_clamp_lower_bound_with_ceil_at_age_62_5', () => {
    // 62.5 years today → next reachable whole-year birthday is 63.
    // A `floor` regression would return 62 + admit a past claim age.
    const grid = buildCandidateGrid({ memberAgeYearsToday: 62.5, hasPia: true });
    expect(grid[0]).toBe(63);
    expect(grid).toEqual([63, 64, 65, 66, 67, 68, 69, 70]);
  });

  it('should_clamp_lower_bound_with_ceil_at_age_69_99', () => {
    const grid = buildCandidateGrid({ memberAgeYearsToday: 69.99, hasPia: true });
    expect(grid).toEqual([70]);
  });

  it('should_return_empty_grid_when_member_past_70', () => {
    const grid = buildCandidateGrid({ memberAgeYearsToday: 70.01, hasPia: true });
    expect(grid).toEqual([]);
  });

  it('should_return_full_grid_for_member_under_62', () => {
    const grid = buildCandidateGrid({ memberAgeYearsToday: 50, hasPia: true });
    expect(grid).toEqual([62, 63, 64, 65, 66, 67, 68, 69, 70]);
  });

  it('should_skip_member_in_grid_when_pia_null', () => {
    // No PIA → engine treats SS as $0 at every age, so search would be
    // wasted work. An empty grid signals the caller to skip this member.
    const grid = buildCandidateGrid({ memberAgeYearsToday: 60, hasPia: false });
    expect(grid).toEqual([]);
  });

  it('should_keep_exact_whole_year_lower_bound', () => {
    // Birthday landing exactly on today: ceil(62) === 62, so the grid
    // starts at 62 (the upcoming birthday is reachable).
    const grid = buildCandidateGrid({ memberAgeYearsToday: 62, hasPia: true });
    expect(grid[0]).toBe(62);
  });
});

describe('buildSurvivorCandidateGrid (supported worker/survivor candidates)', () => {
  it('should_return_empty_when_no_survivor_age_is_stored_withhold', () => {
    // The optimizer never synthesizes a survivor age — absent → candidates
    // run the withheld-survivor state.
    const grid = buildSurvivorCandidateGrid({
      resolvedSurvivorAge: undefined,
      deceasedHasPia: true,
    });
    expect(grid).toEqual([]);
  });

  it('should_return_empty_when_the_prospective_deceased_has_no_pia', () => {
    // A survivor benefit derives from the deceased's record.
    const grid = buildSurvivorCandidateGrid({
      resolvedSurvivorAge: { ageYears: 62, ageMonths: 0 },
      deceasedHasPia: false,
    });
    expect(grid).toEqual([]);
  });

  it('should_emit_the_stored_age_inside_the_60_to_70_window', () => {
    const grid = buildSurvivorCandidateGrid({
      resolvedSurvivorAge: { ageYears: 62, ageMonths: 0 },
      deceasedHasPia: true,
    });
    expect(grid).toEqual([{ ageYears: 62, ageMonths: 0 }]);
  });

  it('should_pass_a_nonzero_ageMonths_component_through_verbatim', () => {
    // A stored 62y6m must be SIMULATED as 62y6m — Apply preserves the
    // stored map verbatim, so truncating to 62y0m would rank a projection
    // Apply never reproduces.
    const grid = buildSurvivorCandidateGrid({
      resolvedSurvivorAge: { ageYears: 62, ageMonths: 6 },
      deceasedHasPia: true,
    });
    expect(grid).toEqual([{ ageYears: 62, ageMonths: 6 }]);
  });

  it('should_pass_the_minimum_survivor_claim_age_60y0m_through_unchanged', () => {
    const grid = buildSurvivorCandidateGrid({
      resolvedSurvivorAge: { ageYears: 60, ageMonths: 0 },
      deceasedHasPia: true,
    });
    expect(grid).toEqual([{ ageYears: 60, ageMonths: 0 }]);
  });

  it('should_pass_the_maximum_survivor_claim_age_70y0m_through_unchanged', () => {
    const grid = buildSurvivorCandidateGrid({
      resolvedSurvivorAge: { ageYears: 70, ageMonths: 0 },
      deceasedHasPia: true,
    });
    expect(grid).toEqual([{ ageYears: 70, ageMonths: 0 }]);
  });

  it('should_pass_an_in_window_age_earlier_than_a_forward_looking_start_verbatim', () => {
    // A stored 62 is passed through VERBATIM even when it lies before
    // the member's current age — the survivor benefit legitimately starts
    // at max(claim month, death boundary), and Apply preserves the stored
    // 62, so rounding it up (the earlier next-whole-age normalization)
    // ranked a projection Apply never reproduces.
    const grid = buildSurvivorCandidateGrid({
      resolvedSurvivorAge: { ageYears: 62, ageMonths: 0 },
      deceasedHasPia: true,
    });
    expect(grid).toEqual([{ ageYears: 62, ageMonths: 0 }]);
    expect(grid).not.toEqual([{ ageYears: 65, ageMonths: 0 }]);
  });

  it('should_return_empty_for_a_stored_age_below_the_widow_floor_inert', () => {
    // Out-of-window (below 60) → INERT, never clamped to 60: every
    // downstream consumer falls back to the same resolved stored section,
    // so ranking and Apply still agree.
    const grid = buildSurvivorCandidateGrid({
      resolvedSurvivorAge: { ageYears: 58, ageMonths: 0 },
      deceasedHasPia: true,
    });
    expect(grid).toEqual([]);
  });

  it('should_return_empty_for_a_stored_age_above_70_inert', () => {
    // Out-of-window (above 70) → INERT, never a
    // clamped [70] that diverges from the stored value Apply preserves.
    const grid = buildSurvivorCandidateGrid({
      resolvedSurvivorAge: { ageYears: 72, ageMonths: 0 },
      deceasedHasPia: true,
    });
    expect(grid).toEqual([]);
  });

  it('should_apply_the_window_test_month_precise', () => {
    // 70y6m is 70.5 → outside the window → inert; 59y11m is 59.917 →
    // outside → inert. A whole-year comparison would mis-window both.
    expect(
      buildSurvivorCandidateGrid({
        resolvedSurvivorAge: { ageYears: 70, ageMonths: 6 },
        deceasedHasPia: true,
      }),
    ).toEqual([]);
    expect(
      buildSurvivorCandidateGrid({
        resolvedSurvivorAge: { ageYears: 59, ageMonths: 11 },
        deceasedHasPia: true,
      }),
    ).toEqual([]);
  });
});
