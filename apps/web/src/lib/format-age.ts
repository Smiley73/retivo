// Canonical age display: whole years as just the number (`"65"`), else both units spelled out (`"65 years 6 months"`);
// never the `y` / `m` shorthand ("Age copy" in docs/ui-conventions.md).

export type AgeYearsMonths = { years: number; months: number };

export function formatAgeYearsMonths(age: AgeYearsMonths): string {
  if (age.months === 0) return `${age.years}`;
  const y = `${age.years} year${age.years === 1 ? '' : 's'}`;
  const m = `${age.months} month${age.months === 1 ? '' : 's'}`;
  return `${y} ${m}`;
}
