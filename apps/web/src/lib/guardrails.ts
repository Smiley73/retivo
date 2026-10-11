/**
 * Pure, engine-dependency-free downturn-guardrail helpers.
 *
 * Two responsibilities, each independently unit-testable:
 *  - `fundedRatio(...)` — the real-terms risk ruler: portfolio (deflated to
 *    today's dollars) ÷ present value of the remaining NET spending need
 *    (essential + discretionary minus guaranteed income), discounted at a
 *    conservative real liability rate and grossed up for the taxes owed on the
 *    withdrawals that fund it. Net need ≤ 0 → the guardrail is SUPPRESSED
 *    (nothing to fund; never NaN/∞).
 *  - `applyGuardrailStep(...)` — the symmetric fixed-step spending rule: cut a
 *    fixed step below the lower band, raise a fixed step above the upper band,
 *    hold between the bands. Cuts are floored at that year's essential spending;
 *    raises are capped at `maxRaisePct × a FIXED REAL baseline` (never a
 *    multiplicative ratchet), so a cut → recover → cut round-trip cannot drift
 *    spending unboundedly downward.
 *
 * The guardrail fires PER MONTE CARLO PATH, PER YEAR, at the year-start
 * (pre-withdrawal) boundary. The call site lives in the per-account strategy
 * engine (see `drawdown-engine-per-account-strategy.ts`); this module carries
 * no engine, ledger, or scenario imports.
 */

/**
 * Resolved, engine-facing guardrail configuration. Mirrors
 * `DownturnGuardrailsOverride` in `db/types.ts` (bands/step/cap in percent).
 * `enabled` gates the whole feature — when false the caller never invokes the
 * helpers and the projection is byte-identical to the pre-feature engine.
 */
export interface GuardrailConfig {
  readonly enabled: boolean;
  /** Funded-ratio percent at/below which spending is CUT one step. */
  readonly lowerBandPct: number;
  /** Funded-ratio percent at/above which spending is RAISED one step. */
  readonly upperBandPct: number;
  /** Fixed adjustment step, percent of the fixed real baseline spend. */
  readonly stepPct: number;
  /** Raise ceiling as a percent of the FIXED REAL baseline (≥ 100). */
  readonly maxRaisePct: number;
  /**
   * Share of a year's DISCRETIONARY spending the guardrail PRESERVES even at its
   * deepest cut, percent in `[0, 100]`. Essentials are never cut; this
   * dial only lifts the cut floor UP within the discretionary band. The
   * effective per-year floor becomes
   * `essentialShare + (discretionaryFloorPct/100) × (1 − essentialShare)`, so
   * `0` reproduces the cut-all-discretionary floor (essentials only) and `100`
   * floors at the full baseline (cuts never touch discretionary). Optional in the
   * type, but the RESOLVER (`resolveDownturnGuardrailsForScenario`) materializes
   * the product default `50` for any config that omits it, so an enabled
   * guardrail always reaches the engine with an explicit value here. The `?? 0`
   * fallback in `applyGuardrailStep` is only a defensive default for a raw,
   * unresolved config (reproduces the pre-feature cut-all-discretionary floor).
   */
  readonly discretionaryFloorPct?: number;
}

/**
 * Default guardrail knobs. `enabled: false` ships the feature pure-
 * additive / inert: a scenario with no explicit config never fires the
 * guardrail. Bands/step/cap are the conservative planning defaults the editor
 * seeds; they are behavioral parameters, NOT calibration-snapshot values.
 */
export const DEFAULT_GUARDRAIL_CONFIG: GuardrailConfig = {
  enabled: false,
  lowerBandPct: 85,
  upperBandPct: 115,
  stepPct: 10,
  // 100 = recover to the planned baseline but never spend above it by default,
  // so enabling guardrails can only protect against depletion (a raise cap > 100
  // predominantly spends MORE on a healthy plan and can lower success). Mirrors
  // DEFAULT_DOWNTURN_GUARDRAILS in db/types.ts.
  maxRaisePct: 100,
  // 50 = a freshly-enabled guardrail keeps HALF of each year's discretionary
  // spending at its deepest cut (gentler than the cut-all-discretionary floor).
  // Essentials are never cut for any value; 0 reproduces the pre-feature floor,
  // 100 protects discretionary entirely. Mirrors DEFAULT_DOWNTURN_GUARDRAILS in
  // db/types.ts.
  discretionaryFloorPct: 50,
};

/**
 * Conservative real (inflation-adjusted) discount rate for the funded-ratio
 * liability, per year. Deliberately bond-like — NOT the scenario's
 * equity-tilted assumed return — so the funded ratio does not optimistically
 * under-cut in the early-sequence (sequence-of-returns-risk) tail the guardrail
 * exists to protect. A code constant, not user config.
 */
export const GUARDRAIL_LIABILITY_REAL_RATE = 0.01;

/**
 * Effective-tax gross-up proxy for the funded-ratio liability. The
 * denominator is divided by `(1 − this)` so it reflects the PRE-tax withdrawals
 * needed to fund the AFTER-tax spending. A single conservative blended rate — a
 * middle-of-the-road retiree effective federal rate on ordinary drawdowns —
 * rather than a per-path re-solve of the two-pass tax (which would couple the
 * pure helper to the engine). Grossing up makes the ratio MORE conservative
 * (larger liability → lower ratio → cut sooner), matching the guardrail's
 * sequence-of-returns-risk protective intent. It is a behavioral proxy, NOT a
 * calibration-snapshot value.
 */
export const GUARDRAIL_EFFECTIVE_TAX_PROXY = 0.15;

/**
 * Editor-boundary validation. Rejects an inverted / out-of-range config:
 *  - `0 ≤ lowerBandPct < upperBandPct`
 *  - `0 < stepPct ≤ 100`
 *  - `maxRaisePct ≥ 100`
 *  - `0 ≤ discretionaryFloorPct ≤ 100` (optional — an ABSENT field is valid (the
 *    resolver materializes the default `50`); a PRESENT non-finite / out-of-range
 *    value is rejected)
 * Returns `true` only when every field is finite and in range. `enabled` is not
 * constrained (either value is valid).
 */
export function isGuardrailConfigValid(cfg: {
  lowerBandPct: number;
  upperBandPct: number;
  stepPct: number;
  maxRaisePct: number;
  discretionaryFloorPct?: number;
}): boolean {
  const { lowerBandPct, upperBandPct, stepPct, maxRaisePct, discretionaryFloorPct } = cfg;
  if (![lowerBandPct, upperBandPct, stepPct, maxRaisePct].every(Number.isFinite)) {
    return false;
  }
  if (lowerBandPct < 0) return false;
  if (lowerBandPct >= upperBandPct) return false;
  if (stepPct <= 0 || stepPct > 100) return false;
  if (maxRaisePct < 100) return false;
  // Optional discretionary floor: absent is VALID here (the resolver later
  // materializes the default 50); a present value must be finite and in [0, 100].
  if (discretionaryFloorPct !== undefined) {
    if (!Number.isFinite(discretionaryFloorPct)) return false;
    if (discretionaryFloorPct < 0 || discretionaryFloorPct > 100) return false;
  }
  return true;
}

/**
 * Inputs to a single-year funded-ratio computation. Every dollar
 * figure is NOMINAL for the year it applies to; the helper deflates both legs
 * by the path's own cumulative CPI so the ratio is computed entirely in real
 * terms.
 */
export interface FundedRatioInput {
  /** Year-start (pre-withdrawal) portfolio total, NOMINAL dollars. */
  readonly portfolioNominal: number;
  /** Cumulative CPI factor from the run's first year to THIS year's start
   *  (1.0 at the first year). Deflates the portfolio to today's dollars. */
  readonly portfolioCumCpi: number;
  /**
   * Remaining net-need liability, one entry per remaining projection year
   * INCLUSIVE of the current year (index 0 = current year). Each entry is the
   * NOMINAL total spending (essential + discretionary) for that year MINUS the
   * year's guaranteed income (survivor-adjusted SS + lifetime pension/annuity),
   * on the currently-settled spend path. Negative entries (guaranteed
   * income exceeds spending that year) are clamped to 0 before discounting — a
   * surplus year funds no liability but never offsets another year's need.
   */
  readonly netNeedNominalByYear: readonly number[];
  /**
   * Cumulative CPI factor at the START of each remaining year, index-aligned
   * with `netNeedNominalByYear` (index 0 = current year's start = same as
   * `portfolioCumCpi`). Deflates each year's nominal net need to today's
   * dollars before discounting.
   */
  readonly cumCpiByYear: readonly number[];
  /**
   * Effective-tax gross-up fraction applied to the real net-need liability:
   * the denominator is divided by `(1 − effectiveTaxRate)` so it reflects
   * the pre-tax withdrawals needed to fund the after-tax spending. In `[0, 1)`;
   * a value ≥ 1 or non-finite degrades to 0 (no gross-up) rather than dividing
   * by zero.
   */
  readonly effectiveTaxRate: number;
}

/**
 * The funded ratio is SUPPRESSED for a year when the remaining net-need
 * liability is ≤ 0 (guaranteed income covers all remaining spending) — the
 * caller then applies NO adjustment. Represented as `null` so a suppressed
 * ratio can never be compared against a band as if it were a real number.
 */
export type FundedRatio = number | null;

/**
 * Real-terms funded ratio: real portfolio ÷ tax-grossed-up PV of
 * the remaining real net need, discounted at `GUARDRAIL_LIABILITY_REAL_RATE`.
 *
 * Returns `null` (suppressed) when the discounted liability is ≤ 0 — a `+∞`
 * ratio would otherwise force a raise-to-cap every year. Never returns
 * NaN/∞: a non-finite portfolio degrades to 0, and the ≤ 0 liability short-
 * circuits before any division.
 */
export function fundedRatio(input: FundedRatioInput): FundedRatio {
  const { portfolioNominal, portfolioCumCpi, netNeedNominalByYear, cumCpiByYear } = input;
  const realPortfolio =
    Number.isFinite(portfolioNominal) && portfolioCumCpi > 0
      ? Math.max(0, portfolioNominal) / portfolioCumCpi
      : 0;

  // Discount each remaining year's REAL net need at the conservative real rate.
  // Index 0 is the current year (discount factor 1); year k discounts by
  // (1 + r)^k. Negative (surplus) years fund no liability (clamped to 0).
  let realLiability = 0;
  const n = netNeedNominalByYear.length;
  for (let k = 0; k < n; k += 1) {
    const nominalNeed = netNeedNominalByYear[k];
    const cum = cumCpiByYear[k];
    if (!Number.isFinite(nominalNeed) || !Number.isFinite(cum) || cum <= 0) continue;
    const realNeed = nominalNeed / cum;
    if (realNeed <= 0) continue;
    const discount = Math.pow(1 + GUARDRAIL_LIABILITY_REAL_RATE, k);
    realLiability += realNeed / discount;
  }

  // Tax gross-up: fund the AFTER-tax liability with PRE-tax withdrawals.
  const rate = input.effectiveTaxRate;
  const grossUpDivisor = Number.isFinite(rate) && rate > 0 && rate < 1 ? 1 - rate : 1;
  const grossedLiability = realLiability / grossUpDivisor;

  if (grossedLiability <= 0) return null; // net-need ≤ 0 → guardrail suppressed
  return realPortfolio / grossedLiability;
}

/** Per-path guardrail state carried across a path's years. RESETS at
 *  path entry — never leaks across paths. */
export interface GuardrailPathState {
  /**
   * The currently-settled REAL spend factor relative to the fixed real baseline
   * (1.0 = baseline). The no-adjustment zone holds this flat; a cut steps it
   * down (floored at the essential-spend factor), a raise steps it up (capped at
   * `maxRaisePct / 100`). Measured against the FIXED REAL baseline so a
   * cut → recover round-trip cannot ratchet.
   */
  settledFactor: number;
}

/** Fresh per-path guardrail state (settled at the 100% real baseline). */
export function initGuardrailState(): GuardrailPathState {
  return { settledFactor: 1 };
}

/**
 * Result of a single-year guardrail step. `factor` is the spend multiplier to
 * apply to THIS year's total spending relative to the fixed real baseline;
 * `changed` records whether the returned `factor` differs from the prior settled
 * factor — a band-driven cut/raise OR an unconditional floor lift on a hold /
 * suppressed year. Advisory only; no caller branches on it.
 */
export interface GuardrailStepResult {
  readonly factor: number;
  readonly changed: boolean;
}

/**
 * Apply the symmetric fixed-step guardrail for one year,
 * MUTATING `state.settledFactor` to the new settled factor and returning it.
 *
 * Rule:
 *  - `ratio === null` (suppressed) → HOLD, then clamped UP to this year's
 *    floor (the clamp is unconditional — see below — so it binds here too).
 *  - `ratio ≤ lowerBand` → CUT one step: `settledFactor −= stepPct/100`, floored
 *    at `essentialFloorFactor` (never below that year's essential spending).
 *  - `ratio ≥ upperBand` → RAISE one step: `settledFactor += stepPct/100`, capped
 *    at `maxRaisePct/100` of the fixed real baseline.
 *  - otherwise (strictly between the bands) → HOLD (no-adjustment zone).
 *
 * Band edges are INCLUSIVE on the cut/raise side (`≤ lower` cuts, `≥ upper`
 * raises); the strictly-interior open interval `(lower, upper)` is the hold
 * zone. A cut when already at the essential floor, or a raise when already at
 * the cap, is a no-op (`changed: false`).
 *
 * `essentialFloorFactor` is that year's essential spending expressed as a factor
 * of the fixed real baseline (`essentialRealSpend / baselineRealSpend`), clamped
 * to `[0, 1]` — essentials never exceed the baseline in the model. It is the
 * `essentialShare` the effective floor is built on.
 *
 * The EFFECTIVE floor lifts the essential share UP into the discretionary band by
 * `config.discretionaryFloorPct`: the discretionary band for the year is
 * `[essentialShare, 1]`, and the floor becomes
 * `essentialShare + (discretionaryFloorPct/100) × (1 − essentialShare)`, clamped
 * to `[0, 1]`. `discretionaryFloorPct = 0` leaves the floor at
 * essentials (cut-all-discretionary, the pre-feature behavior); `= 100` floors at
 * the full baseline (cuts never touch discretionary). An **absent** field defaults
 * to `0` HERE only as a defensive fallback — `resolveDownturnGuardrailsForScenario`
 * materializes the product default `50` before a config reaches this helper, so a
 * resolved (production) config never relies on the `?? 0`. Because the formula starts
 * at `essentialShare`, essentials are inviolate for EVERY setting — the dial only
 * ever moves the floor up. It adapts per year: when essentials are ~100% of
 * baseline the band ≈ 0 and the floor ≈ essentials regardless of the setting.
 *
 * The settled factor is clamped UP to this effective floor UNCONDITIONALLY after
 * the cut/raise/hold decision: whenever the (possibly previously-cut) settled
 * factor sits below the year's floor, it is lifted even when no band breach fired
 * this year — spending is never allowed below the floor, regardless of which
 * branch (suppressed/cut/raise/hold) is active. Because the floor can rise
 * across years, a factor an earlier cut left below a later year's higher floor is
 * re-floored the year that floor climbs past it.
 */
export function applyGuardrailStep(args: {
  readonly state: GuardrailPathState;
  readonly ratio: FundedRatio;
  readonly config: GuardrailConfig;
  readonly essentialFloorFactor: number;
}): GuardrailStepResult {
  const { state, ratio, config, essentialFloorFactor } = args;
  const prev = state.settledFactor;

  const step = config.stepPct / 100;
  const cap = config.maxRaisePct / 100;
  // Essential share of the fixed baseline (essentials ≤ baseline → clamped to
  // [0, 1]). This is the HARD floor the discretionary dial builds up from.
  const essentialShare = Math.min(1, Math.max(0, essentialFloorFactor));
  // Effective floor lifts the essential share up into the discretionary band by
  // `discretionaryFloorPct`. Absent / non-finite → 0
  // (essentials only, the pre-feature floor); clamped to [0, 100] defensively.
  // Because it starts at `essentialShare`, essentials are never cut for any
  // setting — the floor only ever moves UP. The factor is clamped up to this
  // floor unconditionally below, so a settled factor below the floor is raised to
  // it. Computed BEFORE the suppressed branch
  // so the floor binds there too (a suppressed net-need ≤ 0 year is a HOLD, and
  // the clamp is unconditional across every branch).
  const rawFloorPct = config.discretionaryFloorPct ?? 0;
  const floorPct = Number.isFinite(rawFloorPct) ? Math.min(100, Math.max(0, rawFloorPct)) : 0;
  const floor = Math.min(1, essentialShare + (floorPct / 100) * (1 - essentialShare));

  if (ratio === null) {
    // Suppressed: no funded ratio to act on → HOLD, but STILL clamp up to
    // this year's floor. Guaranteed income covers the full baseline in a
    // net-need ≤ 0 year, so a factor an earlier cut left below the floor must be
    // lifted — the household would obviously spend at least essentials (plus the
    // kept discretionary share) there. Skipping the clamp modeled spending below
    // essentials and contradicted this helper's own unconditional-floor contract.
    const suppressed = Math.max(prev, floor);
    state.settledFactor = suppressed;
    return { factor: suppressed, changed: suppressed !== prev };
  }

  let next = prev;
  const lower = config.lowerBandPct;
  const upper = config.upperBandPct;
  const pct = ratio * 100;
  // Band edges are INCLUSIVE on the cut/raise side. A tiny epsilon absorbs the
  // fp representation error of `ratio * 100` (e.g. 1.15 * 100 = 114.999…) so a
  // ratio configured to land exactly ON a band reads as at-or-past it.
  const EDGE_EPS = 1e-9;

  if (pct <= lower + EDGE_EPS) {
    // CUT — one step down.
    next = prev - step;
  } else if (pct >= upper - EDGE_EPS) {
    // RAISE — capped at maxRaise × baseline.
    next = Math.min(cap, prev + step);
  }
  // else: hold zone — next stays prev.

  // Floor the settled factor at this year's effective floor UNCONDITIONALLY —
  // not only inside the cut branch. The floor (essentials plus the
  // kept-discretionary share) can rise across years, so a factor a prior cut
  // settled below a LATER year's higher floor must be lifted even when THIS year
  // holds or raises (no band breach to re-floor it otherwise). Applied after the
  // cut/raise/hold decision so it binds every year regardless of which branch
  // fired.
  next = Math.max(next, floor);

  state.settledFactor = next;
  return { factor: next, changed: next !== prev };
}
