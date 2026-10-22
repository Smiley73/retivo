/**
 * Working-years Roth conversion leg: the full gross moves to Roth and the tax burden is displayed
 * at an assumed rate, never deducted. Integer cents; the caller clamps gross to the source balance.
 */

export interface ConversionLeg {
  readonly grossOutCents: number;
  /** Display-only additional income tax (cents); never deducted from the projection. */
  readonly taxBurdenCents: number;
}

/**
 * The full gross moves to Roth; the burden is `gross × ratePct / 100` rounded to the cent. A
 * non-finite or negative gross gives a zero leg; `ratePct` is clamped to [0, 100], non-finite is 0.
 */
export function resolveConversionLeg(
  grossCents: number,
  ratePct: number,
): ConversionLeg {
  const gross =
    Number.isFinite(grossCents) && grossCents > 0 ? grossCents : 0;
  const rate = Number.isFinite(ratePct)
    ? Math.min(100, Math.max(0, ratePct))
    : 0;
  return {
    grossOutCents: gross,
    taxBurdenCents: Math.round((gross * rate) / 100),
  };
}
