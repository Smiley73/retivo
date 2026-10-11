/**
 * Shared pure helper for a working-years (still-employed) Roth conversion leg.
 *
 * A conversion moves the FULL gross from a pre-tax or MIXED source account into
 * a Roth account (a Roth IRA, or the same-account Roth-designated side for
 * same-account MIXED in-plan conversions) — no haircut. The additional
 * income tax it would create is DISPLAYED at an assumed rate, never deducted
 * from any modeled account (the user pays it from working income, which the
 * model does not track). This is the single home for that math so the
 * deterministic runner and the burden display agree to the cent (one domain
 * function, no deterministic/UI drift).
 *
 * Pure, side-effect-free, integer-cents in and out. The clamp of the gross to
 * the available source pre-tax sub-bucket balance is the runner's responsibility;
 * this helper takes the already-clamped `grossCents`.
 *
 * For same-account MIXED in-plan conversions the displayed `taxBurdenCents` is
 * still `actualGross × ratePct`, consistent with Roth IRA conversions — both
 * create ordinary income in the conversion year.
 */

export interface ConversionLeg {
  /** Gross dollars (cents) that move out of the source pre-tax sub-bucket and
   *  into the target Roth account (Roth IRA or same-account MIXED in-plan Roth
   *  side) — the FULL gross, no haircut. */
  readonly grossOutCents: number;
  /** Display-only additional income tax (cents) the conversion would create at
   *  the assumed rate. NEVER deducted from the projection. */
  readonly taxBurdenCents: number;
}

/**
 * Resolve one conversion leg: the full gross moves to Roth and the displayed
 * tax burden is `gross × ratePct / 100`, rounded to the nearest cent.
 *
 * Inputs are hardened defensively (the helper is reachable from import-bundle
 * data via the resolver): a non-finite / negative `grossCents` resolves to a
 * zero leg; `ratePct` is clamped to `[0, 100]` and a non-finite rate is treated
 * as 0 (no burden). The resolver applies the same clamps, but pinning them here
 * keeps the single-math-home contract honest for any caller.
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
