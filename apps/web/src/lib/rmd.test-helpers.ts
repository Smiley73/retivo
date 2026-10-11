/**
 * Shared test fixtures and helpers for RMD engine tests.
 */

import type { CalibrationSnapshot } from './calibration';
import type { RmdTable } from './rmd';
import { RMD_DIVISORS } from './rmd-divisors';

/** Canonical test snapshot — the live RMD_DIVISORS seed (2024 entry). */
export const SNAPSHOT: CalibrationSnapshot<RmdTable> = RMD_DIVISORS;

/** Owner fixture: born 1950, age 75 in 2025, trigger 73 — always applicable. */
export const OWNER_1950_2025 = {
  isoBirthdate: '1950-01-01',
  taxYear: 2025,
} as const;
