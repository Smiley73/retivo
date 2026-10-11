import { describe, expect, it } from 'vitest';
import { birthdateBounds, validateBirthdate } from './birthdate-validation';

describe('birthdate validation', () => {
  const today = '2026-07-13';

  it('derives inclusive UTC bounds exactly 120 calendar years apart', () => {
    expect(birthdateBounds(today)).toEqual({ min: '1906-07-13', max: today });
  });

  it('clamps a leap-day boundary when the minimum year is not a leap year', () => {
    const leapDayToday = '2020-02-29';

    expect(birthdateBounds(leapDayToday)).toEqual({
      min: '1900-02-28',
      max: leapDayToday,
    });
    expect(validateBirthdate('1900-02-28', leapDayToday)).toBeNull();
    expect(validateBirthdate('1900-02-27', leapDayToday)).toBe(
      'Date of birth must be within the last 120 years.',
    );
  });

  it.each(['1906-07-13', '2026-07-13', '2000-02-29'])(
    'accepts in-range real date %s',
    (value) => expect(validateBirthdate(value, today)).toBeNull(),
  );

  it('rejects one day beyond the 120-year boundary', () => {
    expect(validateBirthdate('1906-07-12', today)).toBe(
      'Date of birth must be within the last 120 years.',
    );
  });

  it('rejects a future date', () => {
    expect(validateBirthdate('2026-07-14', today)).toBe(
      'Date of birth cannot be in the future.',
    );
  });

  it.each(['', 'not-a-date', '2026-02-29'])(
    'rejects missing or malformed value %j',
    (value) => expect(validateBirthdate(value, today)).toBe('Enter your date of birth.'),
  );
});
