import { describe, it, expect } from 'vitest';
import { RMD_DIVISORS } from './rmd-divisors';
import { splitRolloverByRmd } from './rmd-rollover-split';

const SNAPSHOT = RMD_DIVISORS;

describe('splitRolloverByRmd', () => {
  it('should_carve_the_rollover_year_rmd_for_an_owner_past_trigger_age', () => {
    // Born 1950 (trigger 73), event year 2025 → age 75, divisor 24.6.
    // Basis $246,000 → RMD = 246000 / 24.6 = $10,000.
    const result = splitRolloverByRmd({
      basisCents: 24_600_000,
      ownerBirthdate: '1950-03-15',
      eventYear: 2025,
      sourceTaxTreatment: 'PRE_TAX',
      rmdSnapshot: SNAPSHOT,
    });
    expect(result.rmdPortionCents).toBe(1_000_000);
    expect(result.rolloverExcessCents).toBe(23_600_000);
  });

  it('should_conserve_dollars_so_rmd_plus_excess_equals_basis', () => {
    const basisCents = 13_337_711;
    const result = splitRolloverByRmd({
      basisCents,
      ownerBirthdate: '1948-11-02',
      eventYear: 2026,
      sourceTaxTreatment: 'PRE_TAX',
      rmdSnapshot: SNAPSHOT,
    });
    expect(result.rmdPortionCents + result.rolloverExcessCents).toBe(basisCents);
    expect(result.rmdPortionCents).toBeGreaterThan(0);
  });

  it('should_roll_the_whole_amount_before_the_trigger_year', () => {
    // Born 1960 (trigger 75), event year 2030 → age 70, no RMD.
    const result = splitRolloverByRmd({
      basisCents: 50_000_000,
      ownerBirthdate: '1960-06-01',
      eventYear: 2030,
      sourceTaxTreatment: 'PRE_TAX',
      rmdSnapshot: SNAPSHOT,
    });
    expect(result.rmdPortionCents).toBe(0);
    expect(result.rolloverExcessCents).toBe(50_000_000);
  });

  it('should_fall_back_to_no_split_on_a_missing_owner_birthdate', () => {
    for (const missing of [null, undefined, '']) {
      const result = splitRolloverByRmd({
        basisCents: 50_000_000,
        ownerBirthdate: missing,
        eventYear: 2025,
        sourceTaxTreatment: 'PRE_TAX',
        rmdSnapshot: SNAPSHOT,
      });
      expect(result.rmdPortionCents).toBe(0);
      expect(result.rolloverExcessCents).toBe(50_000_000);
    }
  });

  it('should_not_throw_on_an_unparseable_calendar_birthdate', () => {
    const result = splitRolloverByRmd({
      basisCents: 50_000_000,
      ownerBirthdate: '1948-02-30',
      eventYear: 2025,
      sourceTaxTreatment: 'PRE_TAX',
      rmdSnapshot: SNAPSHOT,
    });
    expect(result.rmdPortionCents).toBe(0);
    expect(result.rolloverExcessCents).toBe(50_000_000);
  });

  it('should_subtract_the_roth_portion_on_a_mixed_source_cbp', () => {
    // Born 1950, event 2025 → divisor 24.6. Basis $246,000, Roth-designated
    // $123,000 → qualifying $123,000 → RMD = 123000 / 24.6 = $5,000.
    const result = splitRolloverByRmd({
      basisCents: 24_600_000,
      ownerBirthdate: '1950-03-15',
      eventYear: 2025,
      sourceTaxTreatment: 'MIXED',
      rothPortionCents: 12_300_000,
      rmdSnapshot: SNAPSHOT,
    });
    expect(result.rmdPortionCents).toBe(500_000);
    expect(result.rmdPortionCents + result.rolloverExcessCents).toBe(24_600_000);
  });

  it('should_keep_rmd_portion_within_zero_and_basis', () => {
    const result = splitRolloverByRmd({
      basisCents: 100,
      ownerBirthdate: '1905-01-01',
      eventYear: 2025,
      sourceTaxTreatment: 'PRE_TAX',
      rmdSnapshot: SNAPSHOT,
    });
    expect(result.rmdPortionCents).toBeGreaterThanOrEqual(0);
    expect(result.rmdPortionCents).toBeLessThanOrEqual(100);
    expect(result.rolloverExcessCents).toBeGreaterThanOrEqual(0);
  });

  it('should_roll_the_whole_amount_when_basis_is_zero_or_negative', () => {
    const result = splitRolloverByRmd({
      basisCents: 0,
      ownerBirthdate: '1950-03-15',
      eventYear: 2025,
      sourceTaxTreatment: 'PRE_TAX',
      rmdSnapshot: SNAPSHOT,
    });
    expect(result.rmdPortionCents).toBe(0);
    expect(result.rolloverExcessCents).toBe(0);
  });
});
