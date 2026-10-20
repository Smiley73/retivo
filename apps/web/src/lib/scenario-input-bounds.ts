/**
 * The ranges the scenario editors accept for the settings a person can try as a
 * what-if. One definition: the editors (`pages/`) clamp to these, and the AI
 * assistant's `retivo_run_what_if` tool rejects anything outside them, so a
 * value the tool takes is a value the editor could have set. A bound changes
 * here and nowhere else.
 */
import { MAX_AGE } from '../db/types';

/** Retirement age: whole years from this floor up to the app-wide `MAX_AGE`; months run a full 0 to 11. */
export const RETIREMENT_AGE_MIN = 50;
export const RETIREMENT_AGE_MAX = MAX_AGE;
export const AGE_MONTHS_MAX = 11;

/** Social Security claim age, SSA's legal window: 62 is the earliest, 70 the last that earns delayed credits. */
export const SS_CLAIM_MIN = 62;
export const SS_CLAIM_MAX = 70;
/** A hypothetical across-the-board cut to claimed benefits, in percent. */
export const BENEFIT_REDUCTION_MIN = 0;
export const BENEFIT_REDUCTION_MAX = 50;
/** A fixed cost-of-living adjustment, in percent. */
export const COLA_MIN = 0;
export const COLA_MAX = 5;

/** General inflation, in percent. */
export const INFLATION_MIN = 0;
export const INFLATION_MAX = 10;

/** Planning age, in whole years. */
export const LIFE_MIN = 60;
export const LIFE_MAX = MAX_AGE;

/** Discretionary spending adjustment, in percent, and how many years it lasts. */
export const ADJUSTMENT_MIN = -100;
export const ADJUSTMENT_MAX = 100;
export const DURATION_MIN = 1;
export const DURATION_MAX = 50;

/**
 * Downturn guardrail bands, in percent: a sub-range of what `isGuardrailConfigValid` allows, because a band,
 * step or cap outside these is not a realistic planning choice.
 */
export const GUARDRAIL_LOWER_BAND_MIN = 50;
export const GUARDRAIL_LOWER_BAND_MAX = 100;
export const GUARDRAIL_UPPER_BAND_MIN = 100;
export const GUARDRAIL_UPPER_BAND_MAX = 150;
export const GUARDRAIL_STEP_MIN = 1;
export const GUARDRAIL_STEP_MAX = 50;
export const GUARDRAIL_MAX_RAISE_MIN = 100;
export const GUARDRAIL_MAX_RAISE_MAX = 200;
export const GUARDRAIL_DISCRETIONARY_FLOOR_MIN = 0;
export const GUARDRAIL_DISCRETIONARY_FLOOR_MAX = 100;

/** An account's planning return for a scenario, in percent: the percent field's own range with negatives allowed. */
export const PLANNING_RETURN_MIN = -100;
export const PLANNING_RETURN_MAX = 1000;
