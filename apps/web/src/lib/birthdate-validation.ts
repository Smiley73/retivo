import { parseDate } from '@internationalized/date';

const MAX_BIRTHDATE_AGE_YEARS = 120;

export interface BirthdateBounds {
  readonly min: string;
  readonly max: string;
}

/** Inclusive date-only bounds using the same UTC calendar day as the API. */
export function birthdateBounds(
  todayUtc = new Date().toISOString().slice(0, 10),
): BirthdateBounds {
  const max = parseDate(todayUtc);
  return {
    min: max.subtract({ years: MAX_BIRTHDATE_AGE_YEARS }).toString(),
    max: max.toString(),
  };
}

/** Returns an accessible user-facing error, or `null` when valid. */
export function validateBirthdate(
  value: string,
  todayUtc = new Date().toISOString().slice(0, 10),
): string | null {
  let parsed: string;
  try {
    parsed = parseDate(value).toString();
  } catch {
    return 'Enter your date of birth.';
  }
  if (parsed !== value) return 'Enter your date of birth.';
  const { min, max } = birthdateBounds(todayUtc);
  if (value > max) return 'Date of birth cannot be in the future.';
  if (value < min) return 'Date of birth must be within the last 120 years.';
  return null;
}
