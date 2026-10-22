/**
 * Pure downturn-guardrail helpers: `fundedRatio` (the real-terms risk ruler) and `applyGuardrailStep` (the symmetric
 * fixed-step spending rule). Fires per Monte Carlo path per year at the year-start boundary; engine-free.
 */

/** Resolved guardrail configuration, mirroring `DownturnGuardrailsOverride` (db/types.ts; percents). `enabled` gates the whole feature. */
export interface GuardrailConfig {
  readonly enabled: boolean;
  readonly lowerBandPct: number;
  readonly upperBandPct: number;
  readonly stepPct: number;
  readonly maxRaisePct: number;
  /**
   * Share of a year's discretionary spending preserved at the deepest cut, percent in [0, 100]: the cut floor is
   * `essentialShare + (pct/100) × (1 − essentialShare)`, so 0 floors at essentials and 100 at the full baseline.
   * The resolver materializes the default 50 when omitted.
   */
  readonly discretionaryFloorPct?: number;
}

/**
 * Conservative planning defaults the editor seeds, mirroring DEFAULT_DOWNTURN_GUARDRAILS in db/types.ts;
 * `enabled: false` keeps the feature inert for a scenario with no config. Behavioral parameters, not calibration values.
 */
export const DEFAULT_GUARDRAIL_CONFIG: GuardrailConfig = {
  enabled: false,
  lowerBandPct: 85,
  upperBandPct: 115,
  stepPct: 10,
  // 100 recovers to the baseline but never spends above it, so enabling guardrails can only protect against depletion.
  maxRaisePct: 100,
  // 50 keeps half of each year's discretionary spending at the deepest cut; essentials are never cut for any value.
  discretionaryFloorPct: 50,
};

/**
 * Conservative bond-like real discount rate per year for the funded-ratio liability, not the scenario's equity-tilted
 * return, so the ratio does not under-cut in the early-sequence tail the guardrail protects.
 */
export const GUARDRAIL_LIABILITY_REAL_RATE = 0.01;

/**
 * Effective-tax gross-up proxy: the liability is divided by `(1 − this)` to reflect pre-tax withdrawals funding after-tax
 * spending. One blended rate keeps the pure helper from coupling to the engine's two-pass tax; it makes the ratio more
 * conservative (cuts sooner).
 */
export const GUARDRAIL_EFFECTIVE_TAX_PROXY = 0.15;

/**
 * Editor-boundary validation: `0 ≤ lowerBandPct < upperBandPct`, `0 < stepPct ≤ 100`, `maxRaisePct ≥ 100`, all finite.
 * `discretionaryFloorPct` may be absent but, if present, must be finite and in [0, 100].
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
  if (discretionaryFloorPct !== undefined) {
    if (!Number.isFinite(discretionaryFloorPct)) return false;
    if (discretionaryFloorPct < 0 || discretionaryFloorPct > 100) return false;
  }
  return true;
}

/** Inputs to a single-year funded-ratio computation; dollar figures are nominal and the helper deflates both legs by the path's cumulative CPI. */
export interface FundedRatioInput {
  readonly portfolioNominal: number;
  readonly portfolioCumCpi: number;
  /**
   * Remaining net need per year (index 0 = current): nominal spending minus guaranteed income (survivor-adjusted
   * SS, lifetime pension or annuity). Negative entries clamp to 0, so a surplus year never offsets another year's need.
   */
  readonly netNeedNominalByYear: readonly number[];
  /** Cumulative CPI at the start of each remaining year, index-aligned with `netNeedNominalByYear`. */
  readonly cumCpiByYear: readonly number[];
  /** Gross-up fraction in [0, 1); a value >= 1 or non-finite degrades to 0 rather than dividing by zero. */
  readonly effectiveTaxRate: number;
}

/** `null` when the remaining net-need liability is <= 0 (guaranteed income covers all spending): suppressed, so it cannot be compared against a band as a number. */
export type FundedRatio = number | null;

/**
 * Real portfolio ÷ tax-grossed-up present value of the remaining real net need, discounted at
 * `GUARDRAIL_LIABILITY_REAL_RATE`. Returns `null` when the discounted liability is <= 0, since +∞ would force a raise to the cap every year.
 */
export function fundedRatio(input: FundedRatioInput): FundedRatio {
  const { portfolioNominal, portfolioCumCpi, netNeedNominalByYear, cumCpiByYear } = input;
  const realPortfolio =
    Number.isFinite(portfolioNominal) && portfolioCumCpi > 0
      ? Math.max(0, portfolioNominal) / portfolioCumCpi
      : 0;

  // Year k discounts by (1 + r)^k; index 0 is the current year.
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

  const rate = input.effectiveTaxRate;
  const grossUpDivisor = Number.isFinite(rate) && rate > 0 && rate < 1 ? 1 - rate : 1;
  const grossedLiability = realLiability / grossUpDivisor;

  if (grossedLiability <= 0) return null; // net-need ≤ 0 → guardrail suppressed
  return realPortfolio / grossedLiability;
}

/** Per-path guardrail state; resets at path entry. */
export interface GuardrailPathState {
  /** Settled real spend factor against the fixed real baseline (1.0 = baseline); a fixed baseline, not a multiplicative ratchet, keeps a cut → recover → cut round trip from drifting spending down. */
  settledFactor: number;
}

/** Fresh per-path guardrail state (settled at the 100% real baseline). */
export function initGuardrailState(): GuardrailPathState {
  return { settledFactor: 1 };
}

/** `factor` is the spend multiplier for this year against the fixed real baseline; `changed` records whether it differs from the prior settled factor. */
export interface GuardrailStepResult {
  readonly factor: number;
  readonly changed: boolean;
}

/**
 * One year of the symmetric fixed-step guardrail, mutating `state.settledFactor`. A ratio at or below the lower band
 * cuts one step (`stepPct/100`), at or above the upper band raises one step capped at `maxRaisePct/100` of the fixed
 * real baseline, and between the bands (or `null`, suppressed) holds. `essentialFloorFactor` is the year's essential
 * spending over the baseline, clamped to [0, 1].
 *
 * The floor is `essentialShare + (discretionaryFloorPct/100) × (1 − essentialShare)`, so essentials are inviolate for
 * every setting; an absent `discretionaryFloorPct` counts as 0 here (the resolver supplies the default). The settled
 * factor is clamped up to the floor after every decision, because the floor can rise across years and a factor an
 * earlier cut left below it must be lifted even in a hold or suppressed year.
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
  // Essentials never exceed the baseline, so the share clamps to [0, 1].
  const essentialShare = Math.min(1, Math.max(0, essentialFloorFactor));
  // A non-finite or out-of-range floor percent clamps to [0, 100] defensively. Computed before the suppressed branch so it binds there too.
  const rawFloorPct = config.discretionaryFloorPct ?? 0;
  const floorPct = Number.isFinite(rawFloorPct) ? Math.min(100, Math.max(0, rawFloorPct)) : 0;
  const floor = Math.min(1, essentialShare + (floorPct / 100) * (1 - essentialShare));

  if (ratio === null) {
    // Suppressed: hold, but still clamp up to the floor, since guaranteed income covers the baseline in a net-need <= 0 year.
    const suppressed = Math.max(prev, floor);
    state.settledFactor = suppressed;
    return { factor: suppressed, changed: suppressed !== prev };
  }

  let next = prev;
  const lower = config.lowerBandPct;
  const upper = config.upperBandPct;
  const pct = ratio * 100;
  // Band edges are inclusive; the epsilon absorbs fp error in `ratio * 100` (1.15 * 100 = 114.999…).
  const EDGE_EPS = 1e-9;

  if (pct <= lower + EDGE_EPS) {
    next = prev - step;
  } else if (pct >= upper - EDGE_EPS) {
    next = Math.min(cap, prev + step);
  }

  next = Math.max(next, floor);

  state.settledFactor = next;
  return { factor: next, changed: next !== prev };
}
