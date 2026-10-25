import { describe, it, expect } from 'vitest';
import { QCD_LIMITS } from './qcd-limits';

describe('QCD_LIMITS', () => {
  it('should_have_metadata_with_required_fields', () => {
    expect(typeof QCD_LIMITS.metadata.source).toBe('string');
    expect(QCD_LIMITS.metadata.source.length).toBeGreaterThan(0);
    expect(QCD_LIMITS.metadata.asOfDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(QCD_LIMITS.metadata.jurisdiction).toBe('US-federal');
  });

  it('should_pin_the_Pub_590-B_permalink_substring_and_exact_asOfDate', () => {
    // The Pub. 590-B PDF carries the indexed §408(d)(8) limit.
    expect(QCD_LIMITS.metadata.source).toContain('p590b');
    expect(QCD_LIMITS.metadata.asOfDate).toBe('2026-06-28');
  });

  it('should_have_the_published_years_2024_2025_2026_present', () => {
    expect(QCD_LIMITS.values[2024]).toBeDefined();
    expect(QCD_LIMITS.values[2025]).toBeDefined();
    expect(QCD_LIMITS.values[2026]).toBeDefined();
  });

  it('should_have_strictly_positive_limits_for_every_year', () => {
    for (const [year, entry] of Object.entries(QCD_LIMITS.values)) {
      expect(
        typeof entry.annualLimitDollars,
        `year ${year}: annualLimitDollars must be a number`,
      ).toBe('number');
      expect(
        entry.annualLimitDollars,
        `year ${year}: annualLimitDollars must be > 0`,
      ).toBeGreaterThan(0);
    }
  });
});
