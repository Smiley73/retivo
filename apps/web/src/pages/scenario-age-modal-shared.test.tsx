import { describe, expect, it } from 'vitest';
import { formatAge } from './scenario-age-modal-shared';

// Guards the intended user-visible age-text change: the scenario
// summary now reads spelled-out ("65 years 6 months"), never the old
// "65y 6m" shorthand. Exercises the `{ ageYears, ageMonths }` adapter
// end-to-end through the canonical core.
describe('scenario-age-modal-shared formatAge adapter', () => {
  it('emits just the number for a whole-year age', () => {
    expect(formatAge({ ageYears: 65, ageMonths: 0 })).toBe('65');
  });

  it('spells both units out when months are present', () => {
    expect(formatAge({ ageYears: 65, ageMonths: 6 })).toBe(
      '65 years 6 months',
    );
  });

  it('uses singular agreement for one year and one month', () => {
    expect(formatAge({ ageYears: 1, ageMonths: 1 })).toBe('1 year 1 month');
  });

  it('pluralises years while keeping a singular month', () => {
    expect(formatAge({ ageYears: 2, ageMonths: 1 })).toBe('2 years 1 month');
  });
});
