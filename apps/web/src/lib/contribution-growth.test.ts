import {
  contributionGrowthFactor,
  isValidContributionGrowthPct,
  MAX_CONTRIBUTION_GROWTH_PCT,
} from './contribution-growth';

const asOfMonth = 2026 * 12 + 0; // Jan 2026

describe('contributionGrowthFactor', () => {
  it('should_return_one_at_the_as_of_month', () => {
    expect(contributionGrowthFactor(5, asOfMonth, asOfMonth)).toBe(1);
  });

  it('should_use_percent_unit_one_year_forward', () => {
    const oneYearLater = asOfMonth + 12;
    expect(contributionGrowthFactor(3, oneYearLater, asOfMonth)).toBeCloseTo(
      1.03,
      12,
    );
  });

  it('should_NOT_treat_the_percent_as_a_raw_multiplier', () => {
    // Regression guard: a literal-percent bug (3 → 4^n) would explode.
    const oneYearLater = asOfMonth + 12;
    expect(contributionGrowthFactor(3, oneYearLater, asOfMonth)).not.toBeCloseTo(
      4,
      6,
    );
  });

  it('should_be_month_precise_not_whole_year_stepped', () => {
    const sixMonths = asOfMonth + 6;
    expect(contributionGrowthFactor(10, sixMonths, asOfMonth)).toBeCloseTo(
      Math.pow(1.1, 0.5),
      12,
    );
  });

  it('should_compound_multiple_years_forward', () => {
    const threeYears = asOfMonth + 36;
    expect(contributionGrowthFactor(4, threeYears, asOfMonth)).toBeCloseTo(
      Math.pow(1.04, 3),
      12,
    );
  });

  it('should_deflate_for_a_month_before_the_anchor', () => {
    const oneYearEarlier = asOfMonth - 12;
    expect(contributionGrowthFactor(5, oneYearEarlier, asOfMonth)).toBeCloseTo(
      Math.pow(1.05, -1),
      12,
    );
  });

  it('should_pass_through_a_negative_rate_without_clamping', () => {
    const oneYearLater = asOfMonth + 12;
    expect(contributionGrowthFactor(-2, oneYearLater, asOfMonth)).toBeCloseTo(
      0.98,
      12,
    );
  });

  it('should_return_one_for_an_explicit_zero_rate', () => {
    const oneYearLater = asOfMonth + 12;
    expect(contributionGrowthFactor(0, oneYearLater, asOfMonth)).toBe(1);
  });

  describe('finite/range guard', () => {
    it.each([
      ['NaN', NaN],
      ['Infinity', Infinity],
      ['-Infinity', -Infinity],
      ['at -100 (boundary excluded)', -100],
      ['below -100', -150],
      ['above the 25 cap', 26],
      ['absurdly large', 1000],
    ])('should_return_one_for_an_out_of_band_rate (%s)', (_label, pct) => {
      const oneYearLater = asOfMonth + 12;
      expect(contributionGrowthFactor(pct, oneYearLater, asOfMonth)).toBe(1);
    });

    it('should_honor_the_inclusive_upper_bound', () => {
      const oneYearLater = asOfMonth + 12;
      expect(
        contributionGrowthFactor(
          MAX_CONTRIBUTION_GROWTH_PCT,
          oneYearLater,
          asOfMonth,
        ),
      ).toBeCloseTo(1 + MAX_CONTRIBUTION_GROWTH_PCT / 100, 12);
    });
  });
});

describe('isValidContributionGrowthPct', () => {
  it.each([0, -50, 3.5, 25, 24.99, -99.99])(
    'should_accept_finite_in_band (%s)',
    (pct) => {
      expect(isValidContributionGrowthPct(pct)).toBe(true);
    },
  );

  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-100 boundary', -100],
    ['below -100', -101],
    ['above 25', 25.01],
    ['string', '3'],
    ['undefined', undefined],
    ['null', null],
  ])('should_reject (%s)', (_label, pct) => {
    expect(isValidContributionGrowthPct(pct)).toBe(false);
  });
});
