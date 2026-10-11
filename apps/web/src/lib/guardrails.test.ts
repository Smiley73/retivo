/**
 * Unit tests for the pure downturn-guardrail math (`guardrails.ts`).
 */
import { describe, it, expect } from 'vitest';
import {
  fundedRatio,
  applyGuardrailStep,
  initGuardrailState,
  isGuardrailConfigValid,
  DEFAULT_GUARDRAIL_CONFIG,
  GUARDRAIL_LIABILITY_REAL_RATE,
  type GuardrailConfig,
  type FundedRatioInput,
} from './guardrails';

/** Build a funded-ratio input with sensible defaults (flat CPI, no tax). */
function frInput(over: Partial<FundedRatioInput> = {}): FundedRatioInput {
  return {
    portfolioNominal: 1_000_000,
    portfolioCumCpi: 1,
    netNeedNominalByYear: [50_000, 50_000, 50_000],
    cumCpiByYear: [1, 1, 1],
    effectiveTaxRate: 0,
    ...over,
  };
}

const CFG: GuardrailConfig = {
  enabled: true,
  lowerBandPct: 85,
  upperBandPct: 115,
  stepPct: 10,
  maxRaisePct: 120,
};

describe('fundedRatio', () => {
  it('divides real portfolio by the discounted real net-need liability', () => {
    // Flat CPI, no tax, single year of $50k need, $50k portfolio → PV = 50k, ratio 1.0.
    const r = fundedRatio(frInput({ portfolioNominal: 50_000, netNeedNominalByYear: [50_000], cumCpiByYear: [1] }));
    expect(r).toBeCloseTo(1.0, 6);
  });

  it('deflates BOTH the portfolio and the future need by the path CPI (real terms)', () => {
    // Portfolio nominal 110k at cumCpi 1.1 → real 100k. Need nominal 55k at cumCpi 1.1 → real 50k.
    const r = fundedRatio(
      frInput({
        portfolioNominal: 110_000,
        portfolioCumCpi: 1.1,
        netNeedNominalByYear: [55_000],
        cumCpiByYear: [1.1],
      }),
    );
    expect(r).toBeCloseTo(2.0, 6); // 100k / 50k
  });

  it('discounts later years at the conservative real rate (index 0 undiscounted)', () => {
    // Two $50k real years: PV = 50k + 50k/(1+r). Portfolio real = that PV → ratio 1.0.
    const pv = 50_000 + 50_000 / (1 + GUARDRAIL_LIABILITY_REAL_RATE);
    const r = fundedRatio(frInput({ portfolioNominal: pv, netNeedNominalByYear: [50_000, 50_000], cumCpiByYear: [1, 1] }));
    expect(r).toBeCloseTo(1.0, 6);
  });

  it('uses the currently-settled spend path (not the baseline) in the denominator', () => {
    // A cut path passes a smaller net-need series → a larger funded ratio than baseline.
    const baseline = fundedRatio(frInput({ netNeedNominalByYear: [50_000], cumCpiByYear: [1] }));
    const cut = fundedRatio(frInput({ netNeedNominalByYear: [40_000], cumCpiByYear: [1] }));
    expect(cut).not.toBeNull();
    expect(baseline).not.toBeNull();
    expect(cut as number).toBeGreaterThan(baseline as number);
  });

  it('grosses up the liability for taxes owed on the funding withdrawals', () => {
    // 20% effective tax → denominator divided by 0.8 → ratio 0.8× the no-tax ratio.
    const noTax = fundedRatio(frInput({ netNeedNominalByYear: [50_000], cumCpiByYear: [1] })) as number;
    const taxed = fundedRatio(frInput({ netNeedNominalByYear: [50_000], cumCpiByYear: [1], effectiveTaxRate: 0.2 })) as number;
    expect(taxed).toBeCloseTo(noTax * 0.8, 6);
  });

  it('a non-finite / ≥1 tax rate degrades to no gross-up (never divides by zero)', () => {
    const noTax = fundedRatio(frInput({ netNeedNominalByYear: [50_000], cumCpiByYear: [1] })) as number;
    for (const bad of [Number.NaN, 1, 1.5, -0.2]) {
      const r = fundedRatio(frInput({ netNeedNominalByYear: [50_000], cumCpiByYear: [1], effectiveTaxRate: bad })) as number;
      expect(r).toBeCloseTo(noTax, 6);
    }
  });

  it('net-need ≤ 0 → SUPPRESSED (null), never +∞', () => {
    // Guaranteed income covers all remaining spending every year.
    const r = fundedRatio(frInput({ netNeedNominalByYear: [-10_000, -5_000], cumCpiByYear: [1, 1] }));
    expect(r).toBeNull();
  });

  it('negative (surplus) years fund no liability but never offset another year', () => {
    // Year 0 = +50k need, year 1 = -100k surplus → liability = 50k only, not -50k net.
    const r = fundedRatio(frInput({ portfolioNominal: 50_000, netNeedNominalByYear: [50_000, -100_000], cumCpiByYear: [1, 1] }));
    expect(r).toBeCloseTo(1.0, 6);
  });

  it('zero / short horizon → suppressed', () => {
    expect(fundedRatio(frInput({ netNeedNominalByYear: [], cumCpiByYear: [] }))).toBeNull();
  });

  it('non-finite portfolio degrades to a 0 real portfolio (ratio 0, never NaN)', () => {
    const r = fundedRatio(frInput({ portfolioNominal: Number.NaN, netNeedNominalByYear: [50_000], cumCpiByYear: [1] }));
    expect(r).toBe(0);
  });
});

describe('applyGuardrailStep — band behavior', () => {
  it('cuts one step below the lower band', () => {
    const state = initGuardrailState();
    const res = applyGuardrailStep({ state, ratio: 0.8, config: CFG, essentialFloorFactor: 0.5 });
    expect(res.factor).toBeCloseTo(0.9, 6);
    expect(res.changed).toBe(true);
    expect(state.settledFactor).toBeCloseTo(0.9, 6);
  });

  it('raises one step above the upper band', () => {
    const state = initGuardrailState();
    const res = applyGuardrailStep({ state, ratio: 1.2, config: CFG, essentialFloorFactor: 0.5 });
    expect(res.factor).toBeCloseTo(1.1, 6);
    expect(res.changed).toBe(true);
  });

  it('holds inside the no-adjustment zone', () => {
    const state = initGuardrailState();
    const res = applyGuardrailStep({ state, ratio: 1.0, config: CFG, essentialFloorFactor: 0.5 });
    expect(res.factor).toBe(1);
    expect(res.changed).toBe(false);
  });

  it('band edge == lower (ratio exactly at lower band) CUTS (inclusive lower side)', () => {
    const state = initGuardrailState();
    const res = applyGuardrailStep({ state, ratio: 0.85, config: CFG, essentialFloorFactor: 0.5 });
    expect(res.changed).toBe(true);
    expect(res.factor).toBeCloseTo(0.9, 6);
  });

  it('band edge == upper (ratio exactly at upper band) RAISES (inclusive upper side)', () => {
    const state = initGuardrailState();
    const res = applyGuardrailStep({ state, ratio: 1.15, config: CFG, essentialFloorFactor: 0.5 });
    expect(res.changed).toBe(true);
    expect(res.factor).toBeCloseTo(1.1, 6);
  });

  it('just inside the bands (open interval) HOLDS', () => {
    const s1 = initGuardrailState();
    expect(applyGuardrailStep({ state: s1, ratio: 0.8501, config: CFG, essentialFloorFactor: 0.5 }).changed).toBe(false);
    const s2 = initGuardrailState();
    expect(applyGuardrailStep({ state: s2, ratio: 1.1499, config: CFG, essentialFloorFactor: 0.5 }).changed).toBe(false);
  });

  it('suppressed ratio (null) HOLDS regardless of band', () => {
    const state = initGuardrailState();
    state.settledFactor = 0.7;
    const res = applyGuardrailStep({ state, ratio: null, config: CFG, essentialFloorFactor: 0.5 });
    expect(res.factor).toBeCloseTo(0.7, 6);
    expect(res.changed).toBe(false);
  });

  it('suppressed ratio (null) still LIFTS a settled factor below the floor UP to it', () => {
    // A prior downturn cut settled BELOW the floor; a later net-need ≤ 0 year is
    // suppressed. The floor is unconditional, so the factor is lifted to it —
    // guaranteed income covers the full baseline in a suppressed year, so
    // modeling spending below essentials (+ the kept discretionary share) would
    // be wrong.
    const state = initGuardrailState();
    state.settledFactor = 0.5; // cut below the effective floor
    // essentialShare 0.6, discretionaryFloorPct 50 → floor = 0.6 + 0.5×0.4 = 0.8.
    const res = applyGuardrailStep({
      state,
      ratio: null,
      config: { ...CFG, discretionaryFloorPct: 50 },
      essentialFloorFactor: 0.6,
    });
    expect(res.factor).toBeCloseTo(0.8, 6);
    expect(res.changed).toBe(true);
    expect(state.settledFactor).toBeCloseTo(0.8, 6);
  });

  it('suppressed ratio (null) does NOT lower a settled factor already above the floor', () => {
    // The clamp only lifts UP — a suppressed year never cuts. prev 0.95 > floor.
    const state = initGuardrailState();
    state.settledFactor = 0.95;
    const res = applyGuardrailStep({
      state,
      ratio: null,
      config: { ...CFG, discretionaryFloorPct: 50 },
      essentialFloorFactor: 0.6,
    });
    expect(res.factor).toBeCloseTo(0.95, 6);
    expect(res.changed).toBe(false);
  });
});

describe('applyGuardrailStep — floor + cap saturation', () => {
  it('stacked cuts floor EXACTLY at essentials (never below)', () => {
    const state = initGuardrailState(); // 1.0
    const floor = 0.72;
    // 1.0 → 0.9 → 0.8 → floor(0.72, not 0.7)
    applyGuardrailStep({ state, ratio: 0.8, config: CFG, essentialFloorFactor: floor });
    applyGuardrailStep({ state, ratio: 0.8, config: CFG, essentialFloorFactor: floor });
    const third = applyGuardrailStep({ state, ratio: 0.8, config: CFG, essentialFloorFactor: floor });
    expect(third.factor).toBeCloseTo(0.72, 6);
    expect(state.settledFactor).toBeCloseTo(0.72, 6);
  });

  it('a cut when already AT the essential floor is a no-op', () => {
    const state = initGuardrailState();
    state.settledFactor = 0.6;
    const res = applyGuardrailStep({ state, ratio: 0.8, config: CFG, essentialFloorFactor: 0.6 });
    expect(res.factor).toBeCloseTo(0.6, 6);
    expect(res.changed).toBe(false);
  });

  it('stacked raises cap EXACTLY at maxRaisePct × baseline', () => {
    const state = initGuardrailState(); // 1.0, cap 1.2
    applyGuardrailStep({ state, ratio: 1.2, config: CFG, essentialFloorFactor: 0.5 }); // 1.1
    const second = applyGuardrailStep({ state, ratio: 1.2, config: CFG, essentialFloorFactor: 0.5 }); // 1.2 (cap)
    const third = applyGuardrailStep({ state, ratio: 1.2, config: CFG, essentialFloorFactor: 0.5 }); // no-op
    expect(second.factor).toBeCloseTo(1.2, 6);
    expect(third.factor).toBeCloseTo(1.2, 6);
    expect(third.changed).toBe(false);
  });

  it('a raise when already AT the cap is a no-op', () => {
    const state = initGuardrailState();
    state.settledFactor = 1.2;
    const res = applyGuardrailStep({ state, ratio: 1.2, config: CFG, essentialFloorFactor: 0.5 });
    expect(res.changed).toBe(false);
  });

  it('lifts a below-floor settled factor to a LATER year rising essential floor on a HOLD (no band breach)', () => {
    // Essentials rise as a share of total spend across years. An early cut
    // settles the factor below a later year's higher essential floor; that later
    // year's ratio HOLDS (strictly between the bands, no cut/raise). The floor
    // must still bind — spending is never below essentials.
    const state = initGuardrailState(); // 1.0
    // Early year: floor 0.5, cut 1.0 → 0.9.
    applyGuardrailStep({ state, ratio: 0.8, config: CFG, essentialFloorFactor: 0.5 });
    // Cut again to settle below the later floor: 0.9 → 0.8.
    applyGuardrailStep({ state, ratio: 0.8, config: CFG, essentialFloorFactor: 0.5 });
    expect(state.settledFactor).toBeCloseTo(0.8, 6);
    // Later year: essentials have risen to 0.85 of baseline; the ratio HOLDS.
    const held = applyGuardrailStep({ state, ratio: 1.0, config: CFG, essentialFloorFactor: 0.85 });
    expect(held.factor).toBeCloseTo(0.85, 6); // lifted to the later floor
    expect(held.changed).toBe(true); // 0.8 → 0.85 is a change
    expect(state.settledFactor).toBeCloseTo(0.85, 6);
  });

  it('lifts a below-floor settled factor on a RAISE that lands below the risen floor', () => {
    // A raise step alone lands below the later year's higher essential floor; the
    // unconditional floor clamp lifts it the rest of the way.
    const state = initGuardrailState();
    state.settledFactor = 0.6;
    // Raise 0.6 → 0.7, but this year's floor is 0.9 → lifted to 0.9.
    const res = applyGuardrailStep({ state, ratio: 1.2, config: CFG, essentialFloorFactor: 0.9 });
    expect(res.factor).toBeCloseTo(0.9, 6);
    expect(state.settledFactor).toBeCloseTo(0.9, 6);
  });
});

describe('applyGuardrailStep — discretionary floor compose', () => {
  // essentialShare = 0.5. Effective floor = 0.5 + (pct/100) × 0.5.
  const cfgFloor = (discretionaryFloorPct: number): GuardrailConfig => ({
    ...CFG,
    discretionaryFloorPct,
  });

  it('discretionaryFloorPct = 0 reproduces the essentials-only floor (0.5)', () => {
    const state = initGuardrailState();
    // Stack cuts far below the floor; they settle exactly at essentialShare.
    for (let i = 0; i < 10; i += 1) {
      applyGuardrailStep({ state, ratio: 0.8, config: cfgFloor(0), essentialFloorFactor: 0.5 });
    }
    expect(state.settledFactor).toBeCloseTo(0.5, 6);
  });

  it('discretionaryFloorPct = 50 lifts the floor to 0.75 (essentials + half of discretionary)', () => {
    const state = initGuardrailState();
    for (let i = 0; i < 10; i += 1) {
      applyGuardrailStep({ state, ratio: 0.8, config: cfgFloor(50), essentialFloorFactor: 0.5 });
    }
    expect(state.settledFactor).toBeCloseTo(0.75, 6); // 0.5 + 0.5 × (1 − 0.5)
  });

  it('discretionaryFloorPct = 100 floors at the full baseline (1.0 — cuts never touch discretionary)', () => {
    const state = initGuardrailState();
    for (let i = 0; i < 10; i += 1) {
      applyGuardrailStep({ state, ratio: 0.8, config: cfgFloor(100), essentialFloorFactor: 0.5 });
    }
    expect(state.settledFactor).toBeCloseTo(1.0, 6);
  });

  it('essentials are INVIOLATE for every setting (floor ≥ essentialShare always)', () => {
    for (const pct of [0, 25, 50, 75, 100]) {
      const state = initGuardrailState();
      for (let i = 0; i < 10; i += 1) {
        applyGuardrailStep({ state, ratio: 0.8, config: cfgFloor(pct), essentialFloorFactor: 0.6 });
      }
      // Never below essentials (0.6); the dial only lifts UP from there.
      expect(state.settledFactor).toBeGreaterThanOrEqual(0.6 - 1e-9);
    }
  });

  it('adapts per year: when essentials are ~100% of baseline the floor ≈ essentials regardless of the dial', () => {
    // essentialShare = 1.0 → discretionary band ≈ 0 → floor ≈ 1.0 for ANY pct.
    for (const pct of [0, 50, 100]) {
      const state = initGuardrailState();
      const res = applyGuardrailStep({ state, ratio: 0.8, config: cfgFloor(pct), essentialFloorFactor: 1.0 });
      expect(res.factor).toBeCloseTo(1.0, 6);
    }
  });

  it("an absent discretionaryFloorPct falls to applyGuardrailStep's defensive 0 (essentials-only floor; the resolver materializes 50 in production)", () => {
    const state = initGuardrailState();
    for (let i = 0; i < 10; i += 1) {
      applyGuardrailStep({ state, ratio: 0.8, config: CFG, essentialFloorFactor: 0.5 }); // no field
    }
    expect(state.settledFactor).toBeCloseTo(0.5, 6);
  });
});

describe('applyGuardrailStep — no unbounded downward ratchet', () => {
  it('cut → recover → cut lands back at the same real factor (fixed-baseline anchoring)', () => {
    const state = initGuardrailState(); // 1.0
    // Cut once: 1.0 → 0.9
    applyGuardrailStep({ state, ratio: 0.8, config: CFG, essentialFloorFactor: 0.5 });
    expect(state.settledFactor).toBeCloseTo(0.9, 6);
    // Recover (raise): 0.9 → 1.0
    applyGuardrailStep({ state, ratio: 1.2, config: CFG, essentialFloorFactor: 0.5 });
    expect(state.settledFactor).toBeCloseTo(1.0, 6);
    // Cut again: 1.0 → 0.9 (NOT 0.99 — no multiplicative ratchet drift)
    applyGuardrailStep({ state, ratio: 0.8, config: CFG, essentialFloorFactor: 0.5 });
    expect(state.settledFactor).toBeCloseTo(0.9, 6);
  });

  it('many cut/recover oscillations never drift the factor', () => {
    const state = initGuardrailState();
    for (let i = 0; i < 50; i += 1) {
      applyGuardrailStep({ state, ratio: 0.8, config: CFG, essentialFloorFactor: 0.5 }); // cut → 0.9
      applyGuardrailStep({ state, ratio: 1.2, config: CFG, essentialFloorFactor: 0.5 }); // recover → 1.0
    }
    expect(state.settledFactor).toBeCloseTo(1.0, 6);
  });
});

describe('isGuardrailConfigValid', () => {
  it('accepts the shipped defaults', () => {
    expect(isGuardrailConfigValid(DEFAULT_GUARDRAIL_CONFIG)).toBe(true);
  });

  it('rejects inverted bands (lower ≥ upper)', () => {
    expect(isGuardrailConfigValid({ lowerBandPct: 115, upperBandPct: 85, stepPct: 10, maxRaisePct: 120 })).toBe(false);
    expect(isGuardrailConfigValid({ lowerBandPct: 100, upperBandPct: 100, stepPct: 10, maxRaisePct: 120 })).toBe(false);
  });

  it('rejects a negative lower band', () => {
    expect(isGuardrailConfigValid({ lowerBandPct: -1, upperBandPct: 115, stepPct: 10, maxRaisePct: 120 })).toBe(false);
  });

  it('rejects step out of (0, 100]', () => {
    expect(isGuardrailConfigValid({ lowerBandPct: 85, upperBandPct: 115, stepPct: 0, maxRaisePct: 120 })).toBe(false);
    expect(isGuardrailConfigValid({ lowerBandPct: 85, upperBandPct: 115, stepPct: 101, maxRaisePct: 120 })).toBe(false);
  });

  it('rejects maxRaisePct below 100', () => {
    expect(isGuardrailConfigValid({ lowerBandPct: 85, upperBandPct: 115, stepPct: 10, maxRaisePct: 99 })).toBe(false);
  });

  it('accepts step == 100 and maxRaisePct == 100 (boundary)', () => {
    expect(isGuardrailConfigValid({ lowerBandPct: 85, upperBandPct: 115, stepPct: 100, maxRaisePct: 100 })).toBe(true);
  });

  it('rejects non-finite fields', () => {
    expect(isGuardrailConfigValid({ lowerBandPct: Number.NaN, upperBandPct: 115, stepPct: 10, maxRaisePct: 120 })).toBe(false);
  });

  it('accepts an absent discretionaryFloorPct (valid; resolver materializes the default 50)', () => {
    expect(isGuardrailConfigValid({ lowerBandPct: 85, upperBandPct: 115, stepPct: 10, maxRaisePct: 120 })).toBe(true);
  });

  it('accepts discretionaryFloorPct boundaries 0 and 100', () => {
    expect(isGuardrailConfigValid({ lowerBandPct: 85, upperBandPct: 115, stepPct: 10, maxRaisePct: 120, discretionaryFloorPct: 0 })).toBe(true);
    expect(isGuardrailConfigValid({ lowerBandPct: 85, upperBandPct: 115, stepPct: 10, maxRaisePct: 120, discretionaryFloorPct: 100 })).toBe(true);
    expect(isGuardrailConfigValid({ lowerBandPct: 85, upperBandPct: 115, stepPct: 10, maxRaisePct: 120, discretionaryFloorPct: 50 })).toBe(true);
  });

  it('rejects a discretionaryFloorPct out of [0, 100] or non-finite', () => {
    expect(isGuardrailConfigValid({ lowerBandPct: 85, upperBandPct: 115, stepPct: 10, maxRaisePct: 120, discretionaryFloorPct: -1 })).toBe(false);
    expect(isGuardrailConfigValid({ lowerBandPct: 85, upperBandPct: 115, stepPct: 10, maxRaisePct: 120, discretionaryFloorPct: 101 })).toBe(false);
    expect(isGuardrailConfigValid({ lowerBandPct: 85, upperBandPct: 115, stepPct: 10, maxRaisePct: 120, discretionaryFloorPct: Number.NaN })).toBe(false);
  });
});
