/**
 * Canonical years-months age display — single source of truth for
 * every user-facing age string in the app.
 *
 * When the age is a whole number of years the unit is implied by
 * "age" in the surrounding sentence, so we emit just the number
 * (`"65"`). Once months are present we spell BOTH units out with
 * singular/plural agreement (`"65 years 6 months"`, `"1 year 1
 * month"`, `"2 years 1 month"`). The `y` / `m` shorthand is never
 * used — see "Age copy" in docs/ui-conventions.md. (Code identifiers /
 * JSON literals like `ageYears` / `ageMonths` stay exempt; this is
 * rendered copy only.)
 */

export type AgeYearsMonths = { years: number; months: number };

export function formatAgeYearsMonths(age: AgeYearsMonths): string {
  if (age.months === 0) return `${age.years}`;
  const y = `${age.years} year${age.years === 1 ? '' : 's'}`;
  const m = `${age.months} month${age.months === 1 ? '' : 's'}`;
  return `${y} ${m}`;
}
