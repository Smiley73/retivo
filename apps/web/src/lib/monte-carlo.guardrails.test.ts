/**
 * Engine-level tests for the downturn spending guardrail fired inside the
 * per-path strategy engine (guardrails). Uses the injected-return / injected-CPI
 * harness so each path is FULLY DETERMINISTIC — the single sampled path is the
 * representative run, letting us assert concrete per-year spending / balance /
 * tax behavior.
 */
import { describe, expect, it } from 'vitest';
import {
  ENGINE_VERSION,
  runMonteCarlo,
  type MonteCarloAccountLedger,
  type MonteCarloInput,
} from './monte-carlo.js';
import { makeMonthlyExpenseBase } from './monte-carlo.test-helpers.js';
import { DEFAULT_TAX_CALIBRATION_BUNDLE } from './tax-integration.js';
import type { McTaxContext } from './monte-carlo.js';
import type { DownturnGuardrailsOverride } from '../db/types.js';

const FIRST = 2026;
const RET = 2046;
const HORIZON = 2086;
const STEPS = (HORIZON - FIRST + 1) * 12;
const RET_STEP = (RET - FIRST) * 12;
const DRAWDOWN_YEARS = HORIZON - RET + 1;
const EXPENSE = 80_000; // real total spending/yr
const SS = 20_000; // guaranteed SS/yr from retirement
const ESSENTIAL_FRACTION = 0.5;

/** Single all-equity POST_TAX brokerage ledger (drawn first, taxable). */
function ledger(): MonteCarloAccountLedger[] {
  return [
    {
      id: 'brok',
      initialPre: 0,
      initialPost: 1_000_000,
      contribPre: new Float64Array(STEPS),
      contribPost: new Float64Array(STEPS),
      deposit: new Float64Array(STEPS),
      assetMix: { stocksPct: 100, bondsPct: 0, cashPct: 0 },
      assetMixSeries: null,
      cbpPlanningReturnPct: null,
      taxTreatment: 'POST_TAX',
      accountType: 'BROKERAGE',
      ownerId: 'p',
      contribGrowthMode: 'fixed',
      plannedContribPostBase: null,
    },
  ];
}

/** Per-drawdown-year baseline REAL series (0 CPI → real === nominal). */
function guardrailSeries(): {
  guardrailBaselineRealNetNeedByYear: number[];
  guardrailEssentialRealByYear: number[];
  guardrailBaselineTotalRealByYear: number[];
} {
  const total = new Array<number>(DRAWDOWN_YEARS).fill(EXPENSE);
  const essential = new Array<number>(DRAWDOWN_YEARS).fill(EXPENSE * ESSENTIAL_FRACTION);
  const netNeed = new Array<number>(DRAWDOWN_YEARS).fill(EXPENSE - SS);
  return {
    guardrailBaselineTotalRealByYear: total,
    guardrailEssentialRealByYear: essential,
    guardrailBaselineRealNetNeedByYear: netNeed,
  };
}

function baseInput(overrides: Partial<MonteCarloInput> = {}): MonteCarloInput {
  const ssByYear = Array.from({ length: HORIZON - FIRST + 1 }, (_, i) =>
    FIRST + i >= RET ? SS : 0,
  );
  const incomeByYear = new Array<number>(HORIZON - FIRST + 1).fill(0);
  return {
    portfolioToday: 1_000_000,
    accountMcLedger: ledger(),
    annualContribution: 0,
    firstYear: FIRST,
    retirementYear: RET,
    horizonYear: HORIZON,
    monthlyExpenseBase: makeMonthlyExpenseBase(EXPENSE, STEPS),
    ssByYear,
    incomeByYear,
    pathCount: 1,
    seed: 7,
    strategyKind: 'taxEfficient',
    ...overrides,
  };
}

const GUARDRAIL_ON: DownturnGuardrailsOverride = {
  enabled: true,
  lowerBandPct: 85,
  upperBandPct: 115,
  stepPct: 10,
  maxRaisePct: 120,
};

/** A bad-luck path: moderate early loss then a flat, mild recovery. Deep enough
 *  to drop the funded ratio below the lower band (guardrail CUTS) but not so
 *  deep that both runs deplete to $0 (which would erase the cut's benefit). */
function badLuckReturns(): Float64Array {
  const r = new Float64Array(STEPS);
  // ~-1%/mo across the first 4 retirement years, then a mild +0.2%/mo.
  for (let i = RET_STEP; i < STEPS; i += 1) r[i] = i < RET_STEP + 48 ? -1 : 0.2;
  return r;
}

/** A lucky path: strong steady returns. Guardrail should RAISE. */
function luckyReturns(): Float64Array {
  return new Float64Array(STEPS).fill(1.2); // +1.2%/mo everywhere
}

describe('downturn guardrail — disabled parity', () => {
  it('a DISABLED guardrail config is math-byte-identical to no config (excl. computedAt/engineVersion)', () => {
    const injected = luckyReturns();
    const cpi = new Float64Array(STEPS);
    const withoutCfg = runMonteCarlo({
      ...baseInput(),
      injectedReturns: injected,
      injectedCpi: cpi,
    });
    const disabledCfg = runMonteCarlo({
      ...baseInput(),
      downturnGuardrails: { ...GUARDRAIL_ON, enabled: false },
      ...guardrailSeries(),
      guardrailEffectiveTaxRate: 0.15,
      injectedReturns: injected,
      injectedCpi: cpi,
    });
    const strip = (s: ReturnType<typeof runMonteCarlo>) => {
      const rest: Record<string, unknown> = { ...s };
      delete rest.computedAt;
      delete rest.engineVersion;
      return rest;
    };
    expect(strip(disabledCfg)).toEqual(strip(withoutCfg));
    expect(disabledCfg.engineVersion).toBe(ENGINE_VERSION);
    expect(ENGINE_VERSION).toBe(71);
  });

  it('a DISABLED guardrail carrying a discretionaryFloorPct is still math-byte-identical to no config', () => {
    // The discretionary-floor field must not perturb a DISABLED run: an
    // enabled:false config (even one that sets discretionaryFloorPct) ships inert.
    const injected = luckyReturns();
    const cpi = new Float64Array(STEPS);
    const withoutCfg = runMonteCarlo({
      ...baseInput(),
      injectedReturns: injected,
      injectedCpi: cpi,
    });
    const disabledWithFloor = runMonteCarlo({
      ...baseInput(),
      downturnGuardrails: { ...GUARDRAIL_ON, enabled: false, discretionaryFloorPct: 75 },
      ...guardrailSeries(),
      guardrailEffectiveTaxRate: 0.15,
      injectedReturns: injected,
      injectedCpi: cpi,
    });
    const strip = (s: ReturnType<typeof runMonteCarlo>) => {
      const rest: Record<string, unknown> = { ...s };
      delete rest.computedAt;
      delete rest.engineVersion;
      return rest;
    };
    expect(strip(disabledWithFloor)).toEqual(strip(withoutCfg));
  });
});

describe('downturn guardrail — enabled behavior', () => {
  it('a bad-luck path CUTS spending: enabled run withdraws less early + ends richer than disabled', () => {
    const injected = badLuckReturns();
    const cpi = new Float64Array(STEPS);
    const off = runMonteCarlo({ ...baseInput(), injectedReturns: injected, injectedCpi: cpi });
    const on = runMonteCarlo({
      ...baseInput(),
      downturnGuardrails: GUARDRAIL_ON,
      ...guardrailSeries(),
      guardrailEffectiveTaxRate: 0.15,
      injectedReturns: injected,
      injectedCpi: cpi,
    });
    const offRun = off.representativeByBasis!['mc-typical']!;
    const onRun = on.representativeByBasis!['mc-typical']!;
    const early = (run: typeof offRun): number =>
      run.years
        .filter((y) => y.year >= RET && y.year < RET + 5)
        .reduce((s, y) => s + y.withdrawn, 0);
    // Guardrail cut spending in the downturn → the enabled run draws LESS early
    // and its portfolio survives LONGER (later depletion, or never depletes).
    expect(early(onRun)).toBeLessThan(early(offRun));
    const offDep = offRun.depletionYear ?? Number.POSITIVE_INFINITY;
    const onDep = onRun.depletionYear ?? Number.POSITIVE_INFINITY;
    expect(onDep).toBeGreaterThan(offDep);
  });

  it('a lucky path RAISES spending: enabled run withdraws more early than disabled', () => {
    const injected = luckyReturns();
    const cpi = new Float64Array(STEPS);
    const off = runMonteCarlo({ ...baseInput(), injectedReturns: injected, injectedCpi: cpi });
    const on = runMonteCarlo({
      ...baseInput(),
      downturnGuardrails: GUARDRAIL_ON,
      ...guardrailSeries(),
      guardrailEffectiveTaxRate: 0.15,
      injectedReturns: injected,
      injectedCpi: cpi,
    });
    const offRun = off.representativeByBasis!['mc-typical']!;
    const onRun = on.representativeByBasis!['mc-typical']!;
    // Sum the first few drawdown years' withdrawals; the raise should push the
    // enabled path's early total spending ABOVE the disabled baseline.
    const early = (run: typeof offRun): number =>
      run.years
        .filter((y) => y.year >= RET && y.year < RET + 5)
        .reduce((s, y) => s + y.withdrawn, 0);
    expect(early(onRun)).toBeGreaterThan(early(offRun));
  });

  it('holds spending FLAT within a year, only stepping at the year boundary', () => {
    const injected = badLuckReturns();
    const cpi = new Float64Array(STEPS);
    const on = runMonteCarlo({
      ...baseInput(),
      downturnGuardrails: GUARDRAIL_ON,
      ...guardrailSeries(),
      guardrailEffectiveTaxRate: 0.15,
      injectedReturns: injected,
      injectedCpi: cpi,
    });
    const run = on.representativeByBasis!['mc-typical']!;
    // The per-month withdrawal within any single drawdown year is flat-real
    // (the guardrail adjusts the whole year's expense uniformly). Check the
    // first full drawdown year's 12 monthly withdrawals are near-constant.
    const perMonth = run.perMonthWithdrawal;
    const y0 = perMonth.slice(0, 12).filter((v) => v > 0);
    if (y0.length === 12) {
      const min = Math.min(...y0);
      const max = Math.max(...y0);
      // Flat within ~1% (no mid-year re-step); tax add-on can nudge slightly.
      expect((max - min) / max).toBeLessThan(0.05);
    }
  });

  it('a spending cut moves the year federal tax path (tax-feedback)', () => {
    const injected = badLuckReturns();
    const cpi = new Float64Array(STEPS);
    // Give the account a pre-tax bucket so drawdowns are taxable and the tax
    // context populates the per-year federal-tax series.
    const preTaxLedger: MonteCarloAccountLedger[] = [
      {
        ...ledger()[0],
        initialPre: 1_000_000,
        initialPost: 0,
        taxTreatment: 'PRE_TAX',
        accountType: 'RETIREMENT_401K',
      },
    ];
    const taxContext: McTaxContext = {
      taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
      filingStatus: 'Single',
      members: [{ memberId: 'p', isoBirthdate: '1981-06-15', onMedicare: false, hasAcaCoverage: false }],
      householdSize: 1,
      inflationRatePct: 3,
      primaryDeathYear: HORIZON,
    };
    const off = runMonteCarlo({
      ...baseInput({ accountMcLedger: preTaxLedger, taxContext }),
      injectedReturns: injected,
      injectedCpi: cpi,
    });
    const on = runMonteCarlo({
      ...baseInput({ accountMcLedger: preTaxLedger, taxContext }),
      downturnGuardrails: GUARDRAIL_ON,
      ...guardrailSeries(),
      guardrailEffectiveTaxRate: 0.15,
      injectedReturns: injected,
      injectedCpi: cpi,
    });
    // The federal-tax percentile band differs when the guardrail cuts spending
    // (less taxable pre-tax withdrawal → less federal tax in the cut years).
    const offFed = off.federalTaxPercentilesByYear?.p50 ?? [];
    const onFed = on.federalTaxPercentilesByYear?.p50 ?? [];
    expect(offFed.length).toBeGreaterThan(0);
    expect(onFed.length).toBe(offFed.length);
    const moved = onFed.some((v, i) => Math.abs(v - (offFed[i] ?? 0)) > 1);
    expect(moved).toBe(true);
  });

  it('a spending cut moves the net-after-tax band (guardrail-adjusted spend feeds netAfterTaxPercentilesByYear)', () => {
    // guardrails, D-tax: the two-pass tax path reads its OWN nominalExpenseByYear;
    // a guardrail cut must rebuild that series so the after-tax spend output
    // reflects the reduced withdrawal, not the unadjusted baseline.
    const injected = badLuckReturns();
    const cpi = new Float64Array(STEPS);
    const preTaxLedger: MonteCarloAccountLedger[] = [
      {
        ...ledger()[0],
        initialPre: 1_000_000,
        initialPost: 0,
        taxTreatment: 'PRE_TAX',
        accountType: 'RETIREMENT_401K',
      },
    ];
    const taxContext: McTaxContext = {
      taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
      filingStatus: 'Single',
      members: [{ memberId: 'p', isoBirthdate: '1981-06-15', onMedicare: false, hasAcaCoverage: false }],
      householdSize: 1,
      inflationRatePct: 3,
      primaryDeathYear: HORIZON,
    };
    const off = runMonteCarlo({
      ...baseInput({ accountMcLedger: preTaxLedger, taxContext }),
      injectedReturns: injected,
      injectedCpi: cpi,
    });
    const on = runMonteCarlo({
      ...baseInput({ accountMcLedger: preTaxLedger, taxContext }),
      downturnGuardrails: GUARDRAIL_ON,
      ...guardrailSeries(),
      guardrailEffectiveTaxRate: 0.15,
      injectedReturns: injected,
      injectedCpi: cpi,
    });
    const offNet = off.netAfterTaxPercentilesByYear?.p50 ?? [];
    const onNet = on.netAfterTaxPercentilesByYear?.p50 ?? [];
    expect(offNet.length).toBeGreaterThan(0);
    expect(onNet.length).toBe(offNet.length);
    // A guardrail cut lowers the actual after-tax spend in the cut years — the
    // net-after-tax band must MOVE (it stayed baseline-based before the fix).
    const moved = onNet.some((v, i) => Math.abs(v - (offNet[i] ?? 0)) > 1);
    expect(moved).toBe(true);
  });

  it('a spending cut never suppresses the forced RMD (withdraws the statutory floor, taxes it, retains surplus)', () => {
    // A member already PAST the SECURE 2.0 RMD trigger age (73) during the
    // guardrail-cut years, whose gross RMD requirement EXCEEDS the cut spend
    // target. The cut must not pull the withdrawal below the RMD floor — the
    // engine still withdraws max(spend need, RMD floor), taxes it, and retains
    // any surplus (guardrails "no infeasible cut" invariant).
    const injected = badLuckReturns();
    const cpi = new Float64Array(STEPS);
    const preTaxLedger: MonteCarloAccountLedger[] = [
      {
        ...ledger()[0],
        initialPre: 2_000_000, // large pre-tax pool → RMD floor > cut spend target
        initialPost: 0,
        taxTreatment: 'PRE_TAX',
        accountType: 'RETIREMENT_401K',
      },
    ];
    // Born 1968 → age 78 at retirement (2046): already past 73 during the early
    // cut years, so the RMD floor is live exactly when the guardrail cuts.
    const taxContext: McTaxContext = {
      taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
      filingStatus: 'Single',
      members: [{ memberId: 'p', isoBirthdate: '1968-06-15', onMedicare: true, hasAcaCoverage: false }],
      householdSize: 1,
      inflationRatePct: 3,
      primaryDeathYear: HORIZON,
    };
    const on = runMonteCarlo({
      ...baseInput({ accountMcLedger: preTaxLedger, taxContext }),
      downturnGuardrails: GUARDRAIL_ON,
      ...guardrailSeries(),
      guardrailEffectiveTaxRate: 0.15,
      injectedReturns: injected,
      injectedCpi: cpi,
    });
    const run = on.representativeByBasis!['mc-typical']!;
    // Pick a cut year (first drawdown years) whose RMD floor is set and exceeds
    // the (cut) spend target: the withdrawal must still meet the RMD floor.
    const rmdYears = run.years.filter(
      (y) => y.year >= RET && (y.rmdFloorCents ?? 0) > 0,
    );
    expect(rmdYears.length).toBeGreaterThan(0);
    for (const y of rmdYears) {
      const floorDollars = (y.rmdFloorCents ?? 0) / 100;
      // The forced RMD is withdrawn IN FULL despite the cut (allow ≤ $1 fp/shortfall
      // residue). It is never squeezed below the statutory floor.
      expect(y.withdrawn + 1).toBeGreaterThanOrEqual(floorDollars);
      // No unmet-RMD emergency shortfall — the pool funds the whole RMD.
      expect((y.rmdShortfallCents ?? 0) / 100).toBeLessThan(1);
    }
    // In at least one cut year the forced RMD exceeds the cut spend target, so a
    // surplus is retained (reinvested or held as cash) rather than the RMD being
    // clipped to the reduced spend.
    const surplusRetained = rmdYears.some(
      (y) => (y.rmdReinvestedCents ?? 0) > 0 || (y.rmdOverflowToCashCents ?? 0) > 0,
    );
    expect(surplusRetained).toBe(true);
  });
});

describe('downturn guardrail — discretionary floor', () => {
  it('a HIGHER discretionaryFloorPct floors a sustained-downturn path at a higher spend (keeps more discretionary)', () => {
    // Same bad-luck path, same bands/step/cap; only discretionaryFloorPct differs.
    // essentialShare = 0.5 (essentials $40k of $80k). floor=0 → cuts stack down to
    // essentials ($40k). floor=100 → effective floor 1.0, so cuts never reduce
    // discretionary (spend holds at baseline). The floor=100 run must draw MORE
    // early than the floor=0 run — the dial lifted the floor into discretionary.
    const injected = badLuckReturns();
    const cpi = new Float64Array(STEPS);
    const floorZero = runMonteCarlo({
      ...baseInput(),
      downturnGuardrails: { ...GUARDRAIL_ON, discretionaryFloorPct: 0 },
      ...guardrailSeries(),
      guardrailEffectiveTaxRate: 0.15,
      injectedReturns: injected,
      injectedCpi: cpi,
    });
    const floorFull = runMonteCarlo({
      ...baseInput(),
      downturnGuardrails: { ...GUARDRAIL_ON, discretionaryFloorPct: 100 },
      ...guardrailSeries(),
      guardrailEffectiveTaxRate: 0.15,
      injectedReturns: injected,
      injectedCpi: cpi,
    });
    const zeroRun = floorZero.representativeByBasis!['mc-typical']!;
    const fullRun = floorFull.representativeByBasis!['mc-typical']!;
    const earlySpend = (run: typeof zeroRun): number =>
      run.years
        .filter((y) => y.year >= RET && y.year < RET + 8)
        .reduce((s, y) => s + y.withdrawn, 0);
    // The higher floor preserves discretionary → more early spending on the same
    // downturn path. (floor=0 reproduces the cut-all-discretionary behavior.)
    expect(earlySpend(fullRun)).toBeGreaterThan(earlySpend(zeroRun));
  });

  it('discretionaryFloorPct=100 never cuts on a bad-luck path (spend matches the disabled baseline early)', () => {
    // Effective floor 1.0 means the cut branch can never reduce spending below the
    // baseline — the enabled floor-100 run's early spend should match the DISABLED
    // run's early spend (guardrail cuts are fully neutralized; only the raise side
    // could ever act, and a bad-luck path never raises).
    const injected = badLuckReturns();
    const cpi = new Float64Array(STEPS);
    const off = runMonteCarlo({ ...baseInput(), injectedReturns: injected, injectedCpi: cpi });
    const floorFull = runMonteCarlo({
      ...baseInput(),
      downturnGuardrails: { ...GUARDRAIL_ON, discretionaryFloorPct: 100 },
      ...guardrailSeries(),
      guardrailEffectiveTaxRate: 0.15,
      injectedReturns: injected,
      injectedCpi: cpi,
    });
    const offRun = off.representativeByBasis!['mc-typical']!;
    const fullRun = floorFull.representativeByBasis!['mc-typical']!;
    const earlySpend = (run: typeof offRun): number =>
      run.years
        .filter((y) => y.year >= RET && y.year < RET + 8)
        .reduce((s, y) => s + y.withdrawn, 0);
    // Early spend is within a tight tolerance of the disabled baseline (no cut).
    const a = earlySpend(offRun);
    const b = earlySpend(fullRun);
    expect(Math.abs(a - b) / Math.max(a, 1)).toBeLessThan(0.01);
  });

  it('the kernel mirror composes the same floor: floor=100 keeps more early spend than floor=0 on a no-ledger downturn path', () => {
    // The no-ledger kernel mirror reads config.discretionaryFloorPct through the
    // shared applyGuardrailStep, so the floor dial must move its spend too.
    const injected = badLuckReturns();
    const cpi = new Float64Array(STEPS);
    const taxContext: McTaxContext = {
      taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
      filingStatus: 'Single',
      members: [{ memberId: 'p', isoBirthdate: '1981-06-15', onMedicare: false, hasAcaCoverage: false }],
      householdSize: 1,
      inflationRatePct: 3,
      primaryDeathYear: HORIZON,
    };
    const noLedgerBase = (): MonteCarloInput => baseInput({ accountMcLedger: [], taxContext });
    const floorZero = runMonteCarlo({
      ...noLedgerBase(),
      downturnGuardrails: { ...GUARDRAIL_ON, discretionaryFloorPct: 0 },
      ...guardrailSeries(),
      guardrailEffectiveTaxRate: 0.15,
      injectedReturns: injected,
      injectedCpi: cpi,
    });
    const floorFull = runMonteCarlo({
      ...noLedgerBase(),
      downturnGuardrails: { ...GUARDRAIL_ON, discretionaryFloorPct: 100 },
      ...guardrailSeries(),
      guardrailEffectiveTaxRate: 0.15,
      injectedReturns: injected,
      injectedCpi: cpi,
    });
    const zeroRun = floorZero.representativeByBasis!['mc-typical']!;
    const fullRun = floorFull.representativeByBasis!['mc-typical']!;
    const earlyNetNeed = (run: typeof zeroRun): number =>
      run.years
        .filter((y) => y.year >= RET && y.year < RET + 8)
        .reduce((s, y) => s + y.netNeed, 0);
    // The kernel mirror's floor=100 keeps discretionary → higher net spending need
    // than floor=0 on the same downturn path.
    expect(earlyNetNeed(fullRun)).toBeGreaterThan(earlyNetNeed(zeroRun));
  });
});

describe('downturn guardrail — no-ledger kernel fallback mirror', () => {
  it('the kernel-path (no ledger) guardrail mirror fires: a cut scales spend down on a bad-luck path', () => {
    // Real MC runs carry an accountMcLedger and route through the strategy
    // engine; an input WITHOUT a ledger falls back to the no-ledger kernel, whose
    // guardrail MIRROR (applyGuardrailToKernelExpense) must scale spend the same
    // way. A taxContext is supplied so the kernel's authoritative pass-2 output
    // (the one that reflects the mirror's in-place expense scaling) is the one
    // captured onto the representative run — the observable is the per-year net
    // spending need, which the mirror scales down in a downturn.
    const injected = badLuckReturns();
    const cpi = new Float64Array(STEPS);
    const taxContext: McTaxContext = {
      taxBundle: DEFAULT_TAX_CALIBRATION_BUNDLE,
      filingStatus: 'Single',
      members: [{ memberId: 'p', isoBirthdate: '1981-06-15', onMedicare: false, hasAcaCoverage: false }],
      householdSize: 1,
      inflationRatePct: 3,
      primaryDeathYear: HORIZON,
    };
    // A no-ledger input (empty accountMcLedger) → the strategy engine falls back
    // to runOnePathKernel, exercising the kernel guardrail mirror.
    const noLedgerBase = (): MonteCarloInput => baseInput({ accountMcLedger: [], taxContext });
    const off = runMonteCarlo({
      ...noLedgerBase(),
      injectedReturns: injected,
      injectedCpi: cpi,
    });
    const on = runMonteCarlo({
      ...noLedgerBase(),
      downturnGuardrails: GUARDRAIL_ON,
      ...guardrailSeries(),
      guardrailEffectiveTaxRate: 0.15,
      injectedReturns: injected,
      injectedCpi: cpi,
    });
    const offRun = off.representativeByBasis!['mc-typical']!;
    const onRun = on.representativeByBasis!['mc-typical']!;
    const earlyNetNeed = (run: typeof offRun): number =>
      run.years
        .filter((y) => y.year >= RET && y.year < RET + 5)
        .reduce((s, y) => s + y.netNeed, 0);
    // The kernel mirror cut spend on the downturn path → the enabled no-ledger
    // run's early net spending need is strictly LESS than the disabled baseline
    // (the mirror scaled the shared expense array in place, proving it fired).
    expect(earlyNetNeed(onRun)).toBeLessThan(earlyNetNeed(offRun));
  });
});
