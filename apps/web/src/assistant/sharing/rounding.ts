/**
 * The one rounding helper and descriptor every sharing surface uses. The view
 * builder applies it to stored amounts; the tools that compute outputs apply it
 * to theirs and quote the same descriptor in their disclosure, so a figure and
 * the sentence that explains it can never disagree.
 */

/** "Round to the nearest $1,000" when exact figures are off. */
const ROUNDING_STEP_DOLLARS = 1000;

/**
 * Rounds to the nearest `ROUNDING_STEP_DOLLARS`, half away from zero (half up on the absolute
 * value, so -1,500 reads -2,000 as 1,500 reads 2,000). `null` stays `null`. A non-finite number is
 * not a dollar figure; it becomes `null` rather than passing through.
 */
export function roundToNearestThousand(value: number): number;
export function roundToNearestThousand(value: number | null): number | null;
export function roundToNearestThousand(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const rounded = Math.floor(Math.abs(value) / ROUNDING_STEP_DOLLARS + 0.5) * ROUNDING_STEP_DOLLARS;
  if (rounded === 0) return 0;
  return value < 0 ? -rounded : rounded;
}

/** How a response's dollar figures were rounded, for the response's own disclosure. */
export interface RoundingDescriptor {
  /** `true`: figures are exact to the cent as stored. */
  exact: boolean;
  /** The rounding step in dollars, or `null` when figures are exact. */
  stepDollars: number | null;
  /** One sentence for the agent and the person; percentages, years and ages are never rounded. */
  statement: string;
}

export const EXACT_ROUNDING: RoundingDescriptor = {
  exact: true,
  stepDollars: null,
  statement: 'Dollar figures are exact.',
};

export const NEAREST_THOUSAND_ROUNDING: RoundingDescriptor = {
  exact: false,
  stepDollars: ROUNDING_STEP_DOLLARS,
  statement: 'Dollar figures are rounded to the nearest $1,000. Percentages, years and ages are not rounded.',
};

export function roundingDescriptor(exactDollars: boolean): RoundingDescriptor {
  return exactDollars ? EXACT_ROUNDING : NEAREST_THOUSAND_ROUNDING;
}

/** Applies the session's rounding choice to one dollar figure. */
export function applyRounding(value: number | null, exactDollars: boolean): number | null {
  if (value === null) return null;
  return exactDollars ? value : roundToNearestThousand(value);
}
