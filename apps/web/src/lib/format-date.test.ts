import { describe, expect, it } from 'vitest';
import { formatDate } from './format-date';

describe('formatDate', () => {
  it('formats a YYYY-MM-DD calendar date as "MMMM d, yyyy"', () => {
    expect(formatDate('2026-05-20')).toBe('May 20, 2026');
  });

  it('does not zero-pad the day', () => {
    expect(formatDate('2026-01-05')).toBe('January 5, 2026');
  });

  it('parses YYYY-MM-DD as UTC (no timezone shift)', () => {
    // `new Date('2026-03-01')` is midnight UTC, i.e. Feb 28 west of GMT; the util must avoid that.
    expect(formatDate('2026-03-01')).toBe('March 1, 2026');
  });

  it('formats a full ISO timestamp using local calendar date', () => {
    expect(formatDate('2026-05-20T12:00:00Z')).toBe('May 20, 2026');
  });

  it('returns empty string for null / undefined / empty input', () => {
    expect(formatDate(null)).toBe('');
    expect(formatDate(undefined)).toBe('');
    expect(formatDate('')).toBe('');
  });

  it('returns empty string for unparseable input', () => {
    expect(formatDate('not-a-date')).toBe('');
    expect(formatDate('2026-13-01')).toBe('');
  });
});
