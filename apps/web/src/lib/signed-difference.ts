/**
 * The one formatter every viewed-vs-comparison difference renders through.
 *
 * Sign is fixed here so no caller can disagree: a difference is always
 * `viewed - comparison`. The text is a sign glyph (`+`, or U+2212 minus), the
 * magnitude, then a direction word ("more"/"less", "later"/"earlier",
 * "higher"/"lower"). The direction word is the accessible carrier of the sign.
 * It never returns a tone or colour and never says whether "more" is good: a
 * cost being more is worse, a credit being more is better, and that is the
 * caller's to word.
 *
 * A magnitude that rounds to zero at the kind's own precision reads as no
 * difference, the rule the guardrail badge applies to 0pp.
 */
import { formatCurrencyShort } from './format-currency';

export type SignedDifferenceKind =
  /** Dollars. Magnitude via `formatCurrencyShort`. */
  | 'money'
  /** A count of years or a calendar year; `null` means not available. */
  | 'years'
  /** The year the money runs out; `null` means it never does. */
  | 'runOutYear'
  /** Probabilities as FRACTIONS (0.9 = 90%); magnitude in whole points. */
  | 'percentagePoints';

const MINUS = '−';

const NO_DIFFERENCE_TEXT = 'No difference';
const NOT_AVAILABLE_TEXT = 'Not available';

function signed(diff: number, magnitude: string, up: string, down: string): string {
  return `${diff > 0 ? '+' : MINUS}${magnitude} ${diff > 0 ? up : down}`;
}

function runOutText(viewed: number | null, comparison: number | null): string {
  if (viewed === null && comparison === null) return 'Neither runs out';
  if (viewed === null) return 'Only the comparison scenario runs out';
  if (comparison === null) return 'Only the viewed scenario runs out';
  return yearsText(viewed - comparison);
}

function yearsText(diff: number): string {
  if (!Number.isFinite(diff)) return NOT_AVAILABLE_TEXT;
  const rounded = Number(Math.abs(diff).toFixed(1));
  if (rounded === 0) return NO_DIFFERENCE_TEXT;
  return signed(diff, `${rounded} ${rounded === 1 ? 'year' : 'years'}`, 'later', 'earlier');
}

/** `viewed - comparison` as text. `null` / non-finite values read as not
 *  available, except for `runOutYear` where `null` is "never runs out". */
export function formatSignedDifference(
  kind: SignedDifferenceKind,
  viewed: number | null,
  comparison: number | null,
): string {
  if (kind === 'runOutYear') return runOutText(viewed, comparison);
  if (viewed === null || comparison === null) return NOT_AVAILABLE_TEXT;
  const diff = viewed - comparison;
  if (!Number.isFinite(diff)) return NOT_AVAILABLE_TEXT;
  if (kind === 'years') return yearsText(diff);
  if (kind === 'percentagePoints') {
    const points = Math.round(Math.abs(diff) * 100);
    if (points === 0) return NO_DIFFERENCE_TEXT;
    return signed(diff, `${points}pp`, 'higher', 'lower');
  }
  const magnitude = formatCurrencyShort(Math.abs(diff));
  if (magnitude === '$0') return NO_DIFFERENCE_TEXT;
  return signed(diff, magnitude, 'more', 'less');
}
