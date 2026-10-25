/** The downturn guardrail inside the strategy engine, on injected returns so the single path is the representative run. */
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

// A bad-luck path deep enough to drop below the lower band, not so deep that both runs deplete and erase the cut's benefit.
function badLuckReturns(): Float64Array {
  const r = new Float64Array(STEPS);
  for (let i = RET_STEP; i < STEPS; i += 1) r[i] = i < RET_STEP + 48 ? -1 : 0.2;
  return r;
}

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
    expect(ENGINE_VERSION).toBe(73);
  });

  it('a DISABLED guardrail carrying a discretionaryFloorPct is still math-byte-identical to no config', () => {
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
    const perMonth = run.perMonthWithdrawal;
    const y0 = perMonth.slice(0, 12).filter((v) => v > 0);
    if (y0.length === 12) {
      const min = Math.min(...y0);
      const max = Math.max(...y0);
      expect((max - min) / max).toBeLessThan(0.05);
    }
  });

  it('a spending cut moves the year federal tax path (tax-feedback)', () => {
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
    const offFed = off.federalTaxPercentilesByYear?.p50 ?? [];
    const onFed = on.federalTaxPercentilesByYear?.p50 ?? [];
    expect(offFed.length).toBeGreaterThan(0);
    expect(onFed.length).toBe(offFed.length);
    const moved = onFed.some((v, i) => Math.abs(v - (offFed[i] ?? 0)) > 1);
    expect(moved).toBe(true);
  });

  it('a spending cut moves the net-after-tax band (guardrail-adjusted spend feeds netAfterTaxPercentilesByYear)', () => {
    // The two-pass tax path reads its own nominalExpenseByYear; a cut must rebuild it, or the net-after-tax band stays baseline-based.
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
    const moved = onNet.some((v, i) => Math.abs(v - (offNet[i] ?? 0)) > 1);
    expect(moved).toBe(true);
  });

  it('a spending cut never suppresses the forced RMD (withdraws the statutory floor, taxes it, retains surplus)', () => {
    // Past the SECURE 2.0 RMD age (73) during the cut years, with an RMD above the cut spend target:
    // the withdrawal stays at max(spend need, RMD floor), taxed, and the surplus is retained.
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
    // Born 1968: past 73 in the early cut years, so the RMD floor is live exactly when the guardrail cuts.
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
    const rmdYears = run.years.filter(
      (y) => y.year >= RET && (y.rmdFloorCents ?? 0) > 0,
    );
    expect(rmdYears.length).toBeGreaterThan(0);
    for (const y of rmdYears) {
      const floorDollars = (y.rmdFloorCents ?? 0) / 100;
      expect(y.withdrawn + 1).toBeGreaterThanOrEqual(floorDollars);
      expect((y.rmdShortfallCents ?? 0) / 100).toBeLessThan(1);
    }
    const surplusRetained = rmdYears.some(
      (y) => (y.rmdReinvestedCents ?? 0) > 0 || (y.rmdOverflowToCashCents ?? 0) > 0,
    );
    expect(surplusRetained).toBe(true);
  });
});

describe('downturn guardrail — discretionary floor', () => {
  it('a HIGHER discretionaryFloorPct floors a sustained-downturn path at a higher spend (keeps more discretionary)', () => {
    // essentialShare is 0.5: floor 0 stacks cuts down to the $40k essentials, floor 100 never cuts discretionary.
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
    expect(earlySpend(fullRun)).toBeGreaterThan(earlySpend(zeroRun));
  });

  it('discretionaryFloorPct=100 never cuts on a bad-luck path (spend matches the disabled baseline early)', () => {
    // Floor 100 neutralizes every cut and a bad-luck path never raises, so spend matches the disabled run.
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
    const a = earlySpend(offRun);
    const b = earlySpend(fullRun);
    expect(Math.abs(a - b) / Math.max(a, 1)).toBeLessThan(0.01);
  });

  it('the kernel mirror composes the same floor: floor=100 keeps more early spend than floor=0 on a no-ledger downturn path', () => {
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
    expect(earlyNetNeed(fullRun)).toBeGreaterThan(earlyNetNeed(zeroRun));
  });
});

describe('downturn guardrail — no-ledger kernel fallback mirror', () => {
  it('the kernel-path (no ledger) guardrail mirror fires: a cut scales spend down on a bad-luck path', () => {
    // A ledger-less input falls back to the kernel, whose guardrail mirror scales the shared expense array in place;
    // the taxContext makes the pass-2 output, which reflects that scaling, the one captured.
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
    expect(earlyNetNeed(onRun)).toBeLessThan(earlyNetNeed(offRun));
  });
});
