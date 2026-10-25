/**
 * RMD Uniform Lifetime Table, ages 73 (SECURE 2.0 trigger age) to 120: IRS Pub 590-B Appendix B
 * Table III, Treasury Regulation TD 9930 effective 2022-01-01. Refresh: docs/yearly-tax-refresh.md.
 */

import type { CalibrationSnapshot } from './calibration';

/**
 * Maps attained age (by Dec 31 of the RMD year) to the Uniform Lifetime divisor. Defined here, the
 * leaf calibration module, so rmd.ts and rmd-life-expectancy-tables.ts share it without a cycle.
 */
export interface RmdTable {
  readonly uniformLifetime: Readonly<Record<number, number>>;
}

export const RMD_DIVISORS: CalibrationSnapshot<RmdTable> = {
  values: {
    2024: {
      uniformLifetime: {
        73: 26.5,
        74: 25.5,
        75: 24.6,
        76: 23.7,
        77: 22.9,
        78: 22.0,
        79: 21.1,
        80: 20.2,
        81: 19.4,
        82: 18.5,
        83: 17.7,
        84: 16.8,
        85: 16.0,
        86: 15.2,
        87: 14.4,
        88: 13.7,
        89: 12.9,
        90: 12.2,
        91: 11.5,
        92: 10.8,
        93: 10.1,
        94: 9.5,
        95: 8.9,
        96: 8.4,
        97: 7.8,
        98: 7.3,
        99: 6.8,
        100: 6.4,
        101: 6.0,
        102: 5.6,
        103: 5.2,
        104: 4.9,
        105: 4.6,
        106: 4.3,
        107: 4.1,
        108: 3.9,
        109: 3.7,
        110: 3.5,
        111: 3.4,
        112: 3.3,
        113: 3.1,
        114: 3.0,
        115: 2.9,
        116: 2.8,
        117: 2.7,
        118: 2.5,
        119: 2.3,
        120: 2.0,
      },
    },
  },
  metadata: {
    source:
      'https://www.irs.gov/pub/irs-prior/p590b--2023.pdf, ' +
      'https://www.federalregister.gov/documents/2020/11/12/2020-24723/updated-life-expectancy-and-distribution-period-tables-used-for-purposes-of-determining-minimum',
    asOfDate: '2022-01-01',
    jurisdiction: 'US-federal',
  },
} as const;

/** Clamps an attained age into `[minAge, 120]` (IRS "age 120 and older"). */
export function clampAge(age: number, minAge: number): number {
  return Math.max(minAge, Math.min(120, age));
}

const SNAPSHOT_YEAR_KEYS_CACHE = new WeakMap<object, number[]>();

/**
 * Resolves a snapshot entry by clamp-to-latest: the value at the largest year key <= `taxYear`, or
 * `undefined` when there is none (callers that need a throw wrap it).
 */
export function resolveSnapshotValueForYear<T>(
  snapshot: CalibrationSnapshot<T>,
  taxYear: number,
): T | undefined {
  let keys = SNAPSHOT_YEAR_KEYS_CACHE.get(snapshot);
  if (keys === undefined) {
    keys = Object.keys(snapshot.values).map(Number).sort((a, b) => a - b);
    SNAPSHOT_YEAR_KEYS_CACHE.set(snapshot, keys);
  }
  if (keys.length === 0 || taxYear < keys[0]) return undefined;
  let resolved = keys[0];
  for (const k of keys) {
    if (k <= taxYear) resolved = k;
  }
  return snapshot.values[resolved];
}
