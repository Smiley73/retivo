import {
  fraMonthsForBirthdate,
  birthMonthForBenefitPurposes,
  adjustmentFactor,
  spousalAdjustmentFactor,
  monthlyBenefitAtAge,
  survivorFraMonthsForBirthdate,
  InvalidBirthYearError,
} from '../lib/ssa-formulas';

// A mid-year birthdate keeps the SSA day-1 rule from shifting the cohort.
const fraForYear = (year: number) => fraMonthsForBirthdate(`${year}-06-15`);
const survivorFraForYear = (year: number) => survivorFraMonthsForBirthdate(`${year}-06-15`);

describe('ssa-formulas', () => {
  describe('fraMonthsForBirthdate — SSA day-1 rule', () => {
    it('Jan 1 1960 → 1959 cohort → FRA 66yr 10mo (802 months)', () => {
      expect(fraMonthsForBirthdate('1960-01-01')).toBe(66 * 12 + 10);
    });

    it('Jan 2 1960 → 1960 cohort → FRA 67yr (804 months)', () => {
      expect(fraMonthsForBirthdate('1960-01-02')).toBe(67 * 12);
    });

    it('Dec 1 1959 → Nov 1959 cohort → 1959 cohort → FRA 66yr 10mo (802 months)', () => {
      expect(fraMonthsForBirthdate('1959-12-01')).toBe(66 * 12 + 10);
    });

    it('Mar 1 1957 → Feb 1957 cohort → 1957 cohort → FRA 66yr 6mo (798 months)', () => {
      expect(fraMonthsForBirthdate('1957-03-01')).toBe(66 * 12 + 6);
    });

    it('Mar 2 1957 → 1957 cohort → FRA 66yr 6mo (798 months)', () => {
      expect(fraMonthsForBirthdate('1957-03-02')).toBe(66 * 12 + 6);
    });
  });

  describe('birthMonthForBenefitPurposes — SSA day-1 rule', () => {
    it('Mar 1 → treated as Feb → zero-indexed month 1', () => {
      expect(birthMonthForBenefitPurposes('1957-03-01')).toBe(1);
    });

    it('Jan 1 → treated as Dec → zero-indexed month 11', () => {
      expect(birthMonthForBenefitPurposes('1960-01-01')).toBe(11);
    });

    it('Mar 15 → March → zero-indexed month 2 (no shift)', () => {
      expect(birthMonthForBenefitPurposes('1960-03-15')).toBe(2);
    });
  });

  describe('spousalAdjustmentFactor', () => {
    it.each([
      // 36 months × 25/36% + 24 months × 5/12% = 25% + 10% = 35%.
      [67, 62, 0.65],
      [67, 64, 0.75],
      [67, 67, 1.0],
      [67, 70, 1.0], // capped at 1.0: no DRC transfer
      // FRA 66, age 62 = 48 months early: 36 × 25/36% + 12 × 5/12% = 30%.
      [66, 62, 0.7],
      [66, 63, 0.75],
    ])('FRA %i, claim age %i → %f', (fra, claimAge, factor) => {
      expect(spousalAdjustmentFactor(fra * 12, claimAge * 12)).toBeCloseTo(factor, 4);
    });
  });

  describe('fraMonthsForBirthdate — cohort table', () => {
    it.each([
      [1943, 66 * 12],
      [1954, 66 * 12],
      [1955, 66 * 12 + 2],
      [1956, 66 * 12 + 4],
      [1957, 66 * 12 + 6],
      [1958, 66 * 12 + 8],
      [1959, 66 * 12 + 10],
      [1960, 67 * 12],
      [1990, 67 * 12],
    ])('birth year %d -> %d months', (year, expected) => {
      expect(fraForYear(year)).toBe(expected);
    });

    it('throws InvalidBirthYearError for year < 1943', () => {
      expect(() => fraForYear(1942)).toThrow(InvalidBirthYearError);
      expect(() => fraForYear(1900)).toThrow(InvalidBirthYearError);
    });
  });

  describe('adjustmentFactor', () => {
    it('returns 1.0 at FRA', () => {
      expect(adjustmentFactor(67 * 12, 67 * 12)).toBeCloseTo(1.0, 10);
      expect(adjustmentFactor(66 * 12, 66 * 12)).toBeCloseTo(1.0, 10);
    });

    it.each([
      [67, 62, 0.7],
      [66, 62, 0.75],
      [67, 70, 1.24],
      [66, 70, 1.32],
    ])('FRA %i, claim age %i → %f', (fra, claimAge, factor) => {
      expect(adjustmentFactor(fra * 12, claimAge * 12)).toBeCloseTo(factor, 4);
    });

    it('clamps DRCs at age 70', () => {
      const at70 = adjustmentFactor(67 * 12, 70 * 12);
      const at72 = adjustmentFactor(67 * 12, 72 * 12);
      const at100 = adjustmentFactor(67 * 12, 100 * 12);
      expect(at72).toBeCloseTo(at70, 10);
      expect(at100).toBeCloseTo(at70, 10);
    });
  });

  describe('monthlyBenefitAtAge', () => {
    it('returns 0 when pia is 0', () => {
      expect(monthlyBenefitAtAge(0, 67 * 12, 67 * 12)).toBe(0);
    });

    it('produces SSA-published values for pia=1000 across all FRA brackets', () => {
      const cases: Array<[number, number, [number, number, number]]> = [
        [1954, 66 * 12, [750.0, 1000.0, 1320.0]],
        [1955, 66 * 12 + 2, [741.67, 1000.0, 1306.67]],
        [1956, 66 * 12 + 4, [733.33, 1000.0, 1293.33]],
        [1957, 66 * 12 + 6, [725.0, 1000.0, 1280.0]],
        [1958, 66 * 12 + 8, [716.67, 1000.0, 1266.67]],
        [1959, 66 * 12 + 10, [708.33, 1000.0, 1253.33]],
        [1960, 67 * 12, [700.0, 1000.0, 1240.0]],
      ];
      for (const [, fra, [at62, atFra, at70]] of cases) {
        expect(monthlyBenefitAtAge(1000, fra, 62 * 12)).toBeCloseTo(at62, 0);
        expect(monthlyBenefitAtAge(1000, fra, fra)).toBeCloseTo(atFra, 0);
        expect(monthlyBenefitAtAge(1000, fra, 70 * 12)).toBeCloseTo(at70, 0);
      }
    });
  });

  // The widow(er) FRA table (POMS RS 00615.003) runs two birth years behind the retirement table for 1943–1961 and converges at 67 for 1962+.
  describe('survivorFraMonthsForBirthdate — widow(er) cohort table', () => {
    it('follows the statutory widow(er) schedule per cohort', () => {
      const cases: Array<[number, number]> = [
        [1943, 65 * 12 + 8],
        [1944, 65 * 12 + 10],
        [1945, 66 * 12],
        [1956, 66 * 12],
        [1957, 66 * 12 + 2],
        [1958, 66 * 12 + 4],
        [1959, 66 * 12 + 6],
        [1960, 66 * 12 + 8],
        [1961, 66 * 12 + 10],
        [1962, 67 * 12],
        [1970, 67 * 12],
      ];
      for (const [year, expected] of cases) {
        expect(survivorFraForYear(year)).toBe(expected);
      }
    });

    it('is at most 4 months earlier than the retirement FRA (two-cohort shift, not a 2-year age gap)', () => {
      for (let year = 1943; year <= 1961; year += 1) {
        expect(survivorFraForYear(year)).toBeLessThanOrEqual(fraForYear(year));
      }
      let maxGapMonths = 0;
      for (let year = 1943; year <= 1975; year += 1) {
        maxGapMonths = Math.max(maxGapMonths, fraForYear(year) - survivorFraForYear(year));
      }
      expect(maxGapMonths).toBe(4);
      expect(survivorFraForYear(1958)).toBe(66 * 12 + 4);
      expect(fraForYear(1958)).toBe(66 * 12 + 8);
    });

    it('throws below the supported cohort floor (mirrors the retirement table)', () => {
      expect(() => survivorFraForYear(1942)).toThrow(InvalidBirthYearError);
    });

    it('applies the SSA day-1 rule from an ISO birthdate', () => {
      // Jan 1 1962 → 1961 cohort → survivor FRA 66y10m, not 67.
      expect(survivorFraMonthsForBirthdate('1962-01-01')).toBe(66 * 12 + 10);
      expect(survivorFraMonthsForBirthdate('1962-01-02')).toBe(67 * 12);
    });
  });
});
