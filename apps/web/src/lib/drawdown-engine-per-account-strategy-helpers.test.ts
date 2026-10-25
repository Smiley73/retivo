/** Unit tests for `buildStrategyTiers` and `selectActiveMagiCapWindow`: HSA is held out of every ordinary tier. */
import { describe, it, expect } from 'vitest';
import {
  buildStrategyTiers,
  isPreTaxTargetedDeposit,
  selectActiveMagiCapWindow,
  type AccountRunState,
  type MagiCapRuntimeConfig,
  type MagiCapWindowRuntime,
  type StrategyAwareKind,
} from './drawdown-engine-per-account-strategy-helpers';

function makeState(
  overrides: Partial<AccountRunState> & {
    id: string;
    taxTreatment: AccountRunState['taxTreatment'];
    accountType: string;
  },
): AccountRunState {
  return {
    pre: 0,
    post: 0,
    annualRatePct: 0,
    monthlyRate: 0,
    deposits: new Float64Array(0),
    depositsPost: new Float64Array(0),
    ...overrides,
  };
}

function tierOf(tiers: number[][], a: number): number {
  return tiers.findIndex((tier) => tier.includes(a));
}

describe('buildStrategyTiers — taxEfficient with Roth + HSA mix', () => {
  // taxable(0) → tax-deferred(1) → Roth(2); HSA(3) held out (medical reserve).
  const state: AccountRunState[] = [
    makeState({ id: 'brok', taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }),
    makeState({ id: 'ira', taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }),
    makeState({ id: 'roth', taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }),
    makeState({ id: 'hsa', taxTreatment: 'HSA', accountType: 'HSA' }),
  ];

  it('holds HSA out of every ordinary tier', () => {
    const tiers = buildStrategyTiers(state, 'taxEfficient');
    expect(tierOf(tiers, 3)).toBe(-1);
  });

  it('produces the three-tier taxable → tax-deferred → Roth layout (HSA excluded)', () => {
    const tiers = buildStrategyTiers(state, 'taxEfficient');
    expect(tiers).toEqual([[0], [1], [2]]);
  });
});

describe('buildStrategyTiers — rothFirst with Roth + HSA mix', () => {
  // Roth(0) → tax-deferred(1) → taxable(2); HSA(3) held out (medical reserve).
  const state: AccountRunState[] = [
    makeState({ id: 'roth', taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }),
    makeState({ id: 'ira', taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }),
    makeState({ id: 'brok', taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }),
    makeState({ id: 'hsa', taxTreatment: 'HSA', accountType: 'HSA' }),
  ];

  it('holds HSA out of every ordinary tier', () => {
    const tiers = buildStrategyTiers(state, 'rothFirst');
    expect(tierOf(tiers, 3)).toBe(-1);
  });

  it('produces the three-tier Roth → tax-deferred → taxable layout (HSA excluded)', () => {
    const tiers = buildStrategyTiers(state, 'rothFirst');
    expect(tiers).toEqual([[0], [1], [2]]);
  });
});

describe('buildStrategyTiers — regression layouts', () => {
  it('HSA-only: every ordinary tier is empty, both strategies (HSA held out)', () => {
    const state: AccountRunState[] = [
      makeState({ id: 'hsa', taxTreatment: 'HSA', accountType: 'HSA' }),
    ];
    for (const kind of ['taxEfficient', 'rothFirst'] as StrategyAwareKind[]) {
      const tiers = buildStrategyTiers(state, kind);
      expect(tiers).toEqual([[], [], []]);
    }
  });

  it('Roth-only: Roth lands in tier2 (taxEfficient) / tier0 (rothFirst)', () => {
    const state: AccountRunState[] = [
      makeState({ id: 'roth', taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }),
    ];
    expect(buildStrategyTiers(state, 'taxEfficient')).toEqual([[], [], [0]]);
    expect(buildStrategyTiers(state, 'rothFirst')).toEqual([[0], [], []]);
  });

  it('proportional: one tier with the non-HSA accounts only (HSA held out)', () => {
    const state: AccountRunState[] = [
      makeState({ id: 'brok', taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }),
      makeState({ id: 'roth', taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }),
      makeState({ id: 'hsa', taxTreatment: 'HSA', accountType: 'HSA' }),
    ];
    expect(buildStrategyTiers(state, 'proportional')).toEqual([[0, 1]]);
  });

  it('throws for customOrder (must route through the custom-tier path)', () => {
    const state: AccountRunState[] = [
      makeState({ id: 'brok', taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }),
    ];
    expect(() => buildStrategyTiers(state, 'customOrder')).toThrow();
  });
});

const stubCapConfig: MagiCapRuntimeConfig = {
  capDollars: 0,
  capOffYear: 0,
  capMode: 'minimize',
  capMagiLine: 'irmaa',
  findTargetRothIndex: () => undefined,
  findLaterTaxableIndex: () => undefined,
};

function makeWindow(
  startYear: number,
  endYear: number,
  originalIndex: number,
  brokenAnchor = false,
): MagiCapWindowRuntime {
  return { startYear, endYear, originalIndex, brokenAnchor, config: stubCapConfig };
}

function sorted(windows: MagiCapWindowRuntime[]): MagiCapWindowRuntime[] {
  return [...windows].sort(
    (a, b) =>
      a.startYear - b.startYear ||
      a.endYear - b.endYear ||
      a.originalIndex - b.originalIndex,
  );
}

describe('selectActiveMagiCapWindow', () => {
  const ladder = sorted([makeWindow(2030, 2035, 0), makeWindow(2037, 2040, 1)]);

  it.each([
    ['year before the first window → undefined', 2029, undefined],
    ['first year of a window (inclusive start) → that window', 2030, 0],
    ['mid-window year → that window', 2032, 0],
    ['endYear is exclusive → not the window that ends there', 2035, undefined],
    ['gap year between two windows → undefined', 2036, undefined],
    ['second window active', 2038, 1],
    ['year after the last window → undefined', 2041, undefined],
  ])('%s', (_label, year, expectedIndex) => {
    const active = selectActiveMagiCapWindow(ladder, year as number);
    if (expectedIndex === undefined) {
      expect(active).toBeUndefined();
    } else {
      expect(active?.originalIndex).toBe(expectedIndex);
    }
  });

  it('skips broken-anchor windows even when their (0,0) interval is sorted first', () => {
    const withBroken = sorted([
      makeWindow(0, 0, 2, true), // broken — empty [0,0) interval, sorts first
      makeWindow(2030, 2035, 0),
    ]);
    expect(selectActiveMagiCapWindow(withBroken, 2032)?.originalIndex).toBe(0);
    // A year-0 probe must not select the broken [0,0) window.
    expect(selectActiveMagiCapWindow(withBroken, 0)).toBeUndefined();
  });

  it('residual overlap: earliest START wins (smallest startYear)', () => {
    const overlap = sorted([
      makeWindow(2032, 2040, 0), // later start
      makeWindow(2030, 2038, 1), // earlier start — should win for 2034
    ]);
    expect(selectActiveMagiCapWindow(overlap, 2034)?.startYear).toBe(2030);
  });

  it('same start: smallest END wins, then lowest originalIndex', () => {
    const sameStartDiffEnd = sorted([
      makeWindow(2030, 2040, 1),
      makeWindow(2030, 2035, 0), // same start, smaller end — wins
    ]);
    expect(selectActiveMagiCapWindow(sameStartDiffEnd, 2032)?.endYear).toBe(2035);

    const sameStartSameEnd = sorted([
      makeWindow(2030, 2035, 3),
      makeWindow(2030, 2035, 1), // same start + end, lower originalIndex — wins
    ]);
    expect(selectActiveMagiCapWindow(sameStartSameEnd, 2032)?.originalIndex).toBe(1);
  });
});

describe('isPreTaxTargetedDeposit', () => {
  it.each([
    ['PRE_TAX', true],
    ['MIXED', true],
    ['POST_TAX', false],
    ['ROTH', false],
    ['HSA', false],
  ] as const)('routes a %s account targeted deposit to the pre-tax pocket = %s', (treatment, expected) => {
    const st = makeState({ id: 'a', taxTreatment: treatment, accountType: 'RETIREMENT_IRA' });
    expect(isPreTaxTargetedDeposit(st)).toBe(expected);
  });
});
