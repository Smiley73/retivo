/**
 * Tests for `pickWinner` — tie-break + alreadyAtOptimum.
 */
import { describe, expect, it } from 'vitest';
import {
  baselineMetricForResolved,
  pickWinner,
  type CandidateResult,
} from './pick-winner';

const result = (
  primaryAgeYears: number,
  secondaryAgeYears: number | null,
  metricValue: number,
): CandidateResult => ({ primaryAgeYears, secondaryAgeYears, metricValue });

describe('pickWinner', () => {
  it('should_return_pair_with_highest_metric', () => {
    const results = [
      result(62, 62, 1_000_000),
      result(70, 68, 1_500_000),
      result(67, 67, 1_200_000),
    ];
    const winner = pickWinner({ results, currentResolvedPair: null });
    expect(winner?.primaryAgeYears).toBe(70);
    expect(winner?.secondaryAgeYears).toBe(68);
    expect(winner?.metricValue).toBe(1_500_000);
  });

  it('should_break_ties_by_lower_primary_then_lower_secondary', () => {
    // Every pair returns 1.0 — engine must pick (62, 62).
    const results: CandidateResult[] = [];
    for (let p = 62; p <= 70; p += 1) {
      for (let s = 62; s <= 70; s += 1) {
        results.push(result(p, s, 1.0));
      }
    }
    const winner = pickWinner({ results, currentResolvedPair: null });
    expect(winner?.primaryAgeYears).toBe(62);
    expect(winner?.secondaryAgeYears).toBe(62);
  });

  it('breaks secondary tie before falling back to insertion order', () => {
    const results = [
      result(65, 70, 1_000),
      result(65, 64, 1_000), // ties on primary, smaller secondary wins.
      result(65, 67, 1_000),
    ];
    const winner = pickWinner({ results, currentResolvedPair: null });
    expect(winner?.primaryAgeYears).toBe(65);
    expect(winner?.secondaryAgeYears).toBe(64);
  });

  it('should_mark_alreadyAtOptimum_when_current_equals_winner', () => {
    const results = [
      result(70, 68, 2_000_000),
      result(62, 62, 1_000_000),
    ];
    const winner = pickWinner({
      results,
      currentResolvedPair: { primaryAgeYears: 70, secondaryAgeYears: 68 },
    });
    expect(winner?.alreadyAtOptimum).toBe(true);
  });

  it('alreadyAtOptimum is false when the resolved pair differs', () => {
    const results = [result(70, 68, 2_000_000)];
    const winner = pickWinner({
      results,
      currentResolvedPair: { primaryAgeYears: 67, secondaryAgeYears: 67 },
    });
    expect(winner?.alreadyAtOptimum).toBe(false);
  });

  it('alreadyAtOptimum is false when resolved primary has non-zero ageMonths', () => {
    // Regression: equality is "ageYears match with ageMonths
    // defaulted to 0 on either side". The winner is always whole-year
    // (ageMonths: 0) per the grid; a resolved override of
    // `{primary: {70, 6}}` does NOT match.
    const results = [result(70, 0, 2_000_000)];
    const winner = pickWinner({
      results,
      currentResolvedPair: {
        primaryAgeYears: 70,
        primaryAgeMonths: 6,
        secondaryAgeYears: 0,
        secondaryAgeMonths: 0,
      },
    });
    expect(winner?.alreadyAtOptimum).toBe(false);
  });

  it('alreadyAtOptimum is false when resolved secondary has non-zero ageMonths', () => {
    const results = [result(70, 68, 2_000_000)];
    const winner = pickWinner({
      results,
      currentResolvedPair: {
        primaryAgeYears: 70,
        primaryAgeMonths: 0,
        secondaryAgeYears: 68,
        secondaryAgeMonths: 3,
      },
    });
    expect(winner?.alreadyAtOptimum).toBe(false);
  });

  it('alreadyAtOptimum stays true when resolved ageMonths are zero or undefined', () => {
    const results = [result(70, 68, 2_000_000)];
    const winner = pickWinner({
      results,
      currentResolvedPair: {
        primaryAgeYears: 70,
        primaryAgeMonths: 0,
        secondaryAgeYears: 68,
        // secondaryAgeMonths intentionally undefined — defaults to 0.
      },
    });
    expect(winner?.alreadyAtOptimum).toBe(true);
  });

  it('returns null when there are no candidate results', () => {
    const winner = pickWinner({ results: [], currentResolvedPair: null });
    expect(winner).toBeNull();
  });
});

describe('baselineMetricForResolved', () => {
  it('returns the metric at the current whole-year claim pair', () => {
    const results = [
      result(70, 68, 2_000_000),
      result(67, 67, 1_200_000),
    ];
    const baseline = baselineMetricForResolved(results, {
      primaryAgeYears: 67,
      secondaryAgeYears: 67,
    });
    expect(baseline).toBe(1_200_000);
  });

  it('returns undefined when no resolved pair is set', () => {
    const results = [result(70, 68, 2_000_000)];
    expect(baselineMetricForResolved(results, null)).toBeUndefined();
  });

  it('returns undefined when the current pair is off-grid', () => {
    const results = [result(70, 68, 2_000_000)];
    const baseline = baselineMetricForResolved(results, {
      primaryAgeYears: 65,
      secondaryAgeYears: 65,
    });
    expect(baseline).toBeUndefined();
  });

  it('returns undefined when the resolved pair carries non-zero months', () => {
    // A current claim age of 70y 6m has no exact whole-year
    // candidate, so there's no baseline to show.
    const results = [result(70, 68, 2_000_000)];
    const baseline = baselineMetricForResolved(results, {
      primaryAgeYears: 70,
      primaryAgeMonths: 6,
      secondaryAgeYears: 68,
      secondaryAgeMonths: 0,
    });
    expect(baseline).toBeUndefined();
  });
});

describe('pickWinner — stored month-level pair', () => {
  const stored = { ...result(66, 67, 1_900_000), primaryAgeMonths: 4 };
  const resolved = {
    primaryAgeYears: 66,
    primaryAgeMonths: 4,
    secondaryAgeYears: 67,
    secondaryAgeMonths: 0,
  };

  it('wins with its months, already at optimum, when it beats every whole year', () => {
    const results = [result(66, 67, 1_800_000), stored, result(70, 67, 1_850_000)];
    const winner = pickWinner({ results, currentResolvedPair: resolved });
    expect(winner).toEqual({
      primaryAgeYears: 66,
      primaryAgeMonths: 4,
      secondaryAgeYears: 67,
      metricValue: 1_900_000,
      alreadyAtOptimum: true,
    });
  });

  it('breaks an exact tie to the lower total-months age', () => {
    const tie = [{ ...result(66, 67, 1), primaryAgeMonths: 4 }, result(66, 67, 1)];
    expect(pickWinner({ results: tie, currentResolvedPair: null })?.primaryAgeMonths).toBeUndefined();
    const reversed = [...tie].reverse();
    expect(pickWinner({ results: reversed, currentResolvedPair: null })?.primaryAgeMonths).toBeUndefined();
    // Secondary months break a primary tie the same way.
    const secondary = [
      { ...result(66, 67, 1), secondaryAgeMonths: 3 },
      result(66, 67, 1),
    ];
    expect(pickWinner({ results: secondary, currentResolvedPair: null })?.secondaryAgeMonths).toBeUndefined();
  });
});
