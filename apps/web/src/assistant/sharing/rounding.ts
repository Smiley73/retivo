/**
 * The one rounding helper and descriptor every sharing surface uses. The view
 * builder applies it to stored amounts; the tools that compute outputs apply it
 * to theirs and quote the same descriptor in their disclosure, so a figure and
 * the sentence that explains it can never disagree.
 */

/** "Round to the nearest $1,000" when exact figures are off. */
const ROUNDING_STEP_DOLLARS = 1000;
/**
 * Monthly figures (a Social Security benefit, a pension payment) sit beside annual ones. A $1,000 step would
 * turn a $700 benefit into $1,000 and a $400 one into nothing, so they round to the nearest $100.
 */
const MONTHLY_ROUNDING_STEP_DOLLARS = 100;

/**
 * Rounds to the nearest `ROUNDING_STEP_DOLLARS`, half away from zero (half up on the absolute
 * value, so -1,500 reads -2,000 as 1,500 reads 2,000). `null` stays `null`. A non-finite number is
 * not a dollar figure; it becomes `null` rather than passing through.
 */
function roundToNearestThousand(value: number | null): number | null {
  return roundToStep(value, ROUNDING_STEP_DOLLARS);
}

/** Same rule as `roundToNearestThousand`, for a monthly figure: the nearest $100. */
function roundToNearestHundred(value: number | null): number | null {
  return roundToStep(value, MONTHLY_ROUNDING_STEP_DOLLARS);
}

function roundToStep(value: number | null, step: number): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const rounded = Math.floor(Math.abs(value) / step + 0.5) * step;
  if (rounded === 0) return 0;
  return value < 0 ? -rounded : rounded;
}

/** How a response's dollar figures were rounded, for the response's own disclosure. */
export interface RoundingDescriptor {
  /** `true`: figures are exact to the cent as stored. */
  exact: boolean;
  /** The rounding step for annual dollar figures, or `null` when figures are exact. */
  stepDollars: number | null;
  /** The rounding step for monthly dollar figures, or `null` when figures are exact. */
  monthlyStepDollars: number | null;
  /** One sentence for the agent and the person; percentages, years and ages are never rounded. */
  statement: string;
}

const EXACT_ROUNDING: RoundingDescriptor = {
  exact: true,
  stepDollars: null,
  monthlyStepDollars: null,
  statement: 'Dollar figures are exact.',
};

const NEAREST_THOUSAND_ROUNDING: RoundingDescriptor = {
  exact: false,
  stepDollars: ROUNDING_STEP_DOLLARS,
  monthlyStepDollars: MONTHLY_ROUNDING_STEP_DOLLARS,
  statement:
    'Annual dollar figures are rounded to the nearest $1,000 and monthly ones to the nearest $100. Percentages, years and ages are not rounded.',
};

export function roundingDescriptor(exactDollars: boolean): RoundingDescriptor {
  return exactDollars ? EXACT_ROUNDING : NEAREST_THOUSAND_ROUNDING;
}

/** Applies the session's rounding choice to one annual dollar figure. */
export function applyRounding(value: number | null, exactDollars: boolean): number | null {
  if (value === null) return null;
  return exactDollars ? value : roundToNearestThousand(value);
}

/** Applies the session's rounding choice to one monthly dollar figure. */
export function applyMonthlyRounding(value: number | null, exactDollars: boolean): number | null {
  if (value === null) return null;
  return exactDollars ? value : roundToNearestHundred(value);
}
