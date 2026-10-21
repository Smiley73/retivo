import { describe, expect, it } from 'vitest';
import { formatSignedDifference } from './signed-difference';

describe('formatSignedDifference', () => {
  it('reads money in both directions with glyph, magnitude and direction word', () => {
    expect(formatSignedDifference('money', 350_000, 200_000)).toBe('+$150k more');
    expect(formatSignedDifference('money', 200_000, 350_000)).toBe('−$150k less');
    expect(formatSignedDifference('money', 2_500_000, 1_000_000)).toBe('+$1.5M more');
  });

  it('reads years in both directions', () => {
    expect(formatSignedDifference('years', 2045, 2042)).toBe('+3 years later');
    expect(formatSignedDifference('years', 2041, 2042)).toBe('−1 year earlier');
  });

  it('reads a count of years as more or less, never later or earlier', () => {
    expect(formatSignedDifference('yearCount', 12, 9)).toBe('+3 years more');
    expect(formatSignedDifference('yearCount', 8, 9)).toBe('−1 year less');
    expect(formatSignedDifference('yearCount', 9, 9)).toBe('No difference');
    expect(formatSignedDifference('yearCount', null, 9)).toBe('Not available');
  });

  it('reads percentage points in both directions from fractions', () => {
    expect(formatSignedDifference('percentagePoints', 0.9, 0.85)).toBe('+5pp higher');
    expect(formatSignedDifference('percentagePoints', 0.7, 0.85)).toBe('−15pp lower');
  });

  it('reads zero and rounds-to-zero as no difference', () => {
    expect(formatSignedDifference('money', 100, 100)).toBe('No difference');
    expect(formatSignedDifference('money', 100.4, 100)).toBe('No difference');
    expect(formatSignedDifference('years', 2040, 2040)).toBe('No difference');
    expect(formatSignedDifference('percentagePoints', 0.903, 0.9)).toBe('No difference');
  });

  it('reads a missing side as not available', () => {
    expect(formatSignedDifference('money', null, 100)).toBe('Not available');
    expect(formatSignedDifference('years', 2040, null)).toBe('Not available');
    expect(formatSignedDifference('percentagePoints', 0.5, Number.NaN)).toBe('Not available');
  });

  it('names the side that runs out and gives no number when only one does', () => {
    expect(formatSignedDifference('runOutYear', null, null)).toBe('Neither runs out');
    expect(formatSignedDifference('runOutYear', 2050, null)).toBe(
      'Only the viewed scenario runs out',
    );
    expect(formatSignedDifference('runOutYear', null, 2050)).toBe(
      'Only the comparison scenario runs out',
    );
    expect(formatSignedDifference('runOutYear', 2052, 2050)).toBe('+2 years later');
    expect(formatSignedDifference('runOutYear', 2050, 2050)).toBe('No difference');
  });

  it('carries both a glyph and a direction word in every non-zero result', () => {
    const results = [
      formatSignedDifference('money', 5_000, 1_000),
      formatSignedDifference('money', 1_000, 5_000),
      formatSignedDifference('years', 2041, 2040),
      formatSignedDifference('years', 2040, 2041),
      formatSignedDifference('percentagePoints', 0.6, 0.5),
      formatSignedDifference('percentagePoints', 0.5, 0.6),
      formatSignedDifference('runOutYear', 2051, 2050),
      formatSignedDifference('runOutYear', 2050, 2051),
    ];
    for (const text of results) {
      expect(text).toMatch(/^[+−]/);
      expect(text).toMatch(/(more|less|later|earlier|higher|lower)$/);
    }
  });
});
