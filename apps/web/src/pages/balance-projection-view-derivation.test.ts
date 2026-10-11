/**
 * Golden test for the extracted pure derivation. Confirms the extraction is
 * behavior-neutral: the same flat-vs-path-CPI deflation split the hook
 * produces, reproduced by the pure functions.
 */
import { describe, expect, it } from 'vitest';
import {
  buildBasisDeflator,
  buildResolvedDrawdown,
  buildViewDeflatorForExport,
  deriveBalanceProjectionDisplayData,
} from './balance-projection-view-derivation';
import type { PipelineData, RepresentativeRun } from './balance-projection-page-pipeline';
import type { DrawdownYear } from '../lib/drawdown-engine-types';
import { DEFAULT_INFLATION_PCT } from '../db/types';
import type { ProjectionChartRow } from '../components/ProjectionChart';

const FIRST_YEAR = 2040;
// A high-inflation path: real factors fall well below the flat 3%/yr deflator.
const REAL_FACTORS = [1, 0.7, 0.49, 0.34];

function drawdownRow(offset: number): DrawdownYear {
  const balance = 1_000_000 - offset * 100_000;
  return {
    year: FIRST_YEAR + offset,
    balance,
    withdrawn: 30_000,
    netNeed: 30_000,
    growth: 20_000,
    deposit: 0,
    depleted: false,
  };
}

function makeRun(overrides: Partial<RepresentativeRun> = {}): RepresentativeRun {
  const years = REAL_FACTORS.map((_f, i) => drawdownRow(i));
  return {
    firstYear: FIRST_YEAR,
    seed: 1,
    years,
    depletionYear: null,
    perMonthWithdrawal: new Float64Array(),
    realBalanceByYear: years.map((y, i) => y.balance * REAL_FACTORS[i]),
    realGrowthByYear: years.map((y, i) => y.growth * REAL_FACTORS[i]),
    realFactorByYear: [...REAL_FACTORS],
    ...overrides,
  };
}

describe('buildViewDeflatorForExport', () => {
  it('is the identity in Future-dollars', () => {
    const f = buildViewDeflatorForExport('future', 3, 2026, 5);
    expect(f(2040, 11)).toBe(1);
  });

  it('deflates by the flat rate in Today’s-dollars', () => {
    const f = buildViewDeflatorForExport('today', 3, 2026, 11);
    // One year out at 3% → ~0.9709.
    expect(f(2027, 11)).toBeCloseTo(1 / 1.03, 6);
  });

  it('falls back to DEFAULT_INFLATION_PCT when inflationPct is null', () => {
    // When inflationPct is null, the function should behave identically to
    // passing the DEFAULT_INFLATION_PCT (the default inflation rate).
    const fNull = buildViewDeflatorForExport('today', null, 2026, 11);
    const fDefault = buildViewDeflatorForExport('today', DEFAULT_INFLATION_PCT, 2026, 11);
    expect(fNull(2027, 11)).toBeCloseTo(fDefault(2027, 11), 6);
  });
});

describe('buildBasisDeflator (flat vs path-CPI)', () => {
  it('deterministic basis + Today’s → uses the FLAT view deflator', () => {
    const viewDeflator = (): number => 0.5; // sentinel flat factor
    const f = buildBasisDeflator({
      isMcBasisActive: false,
      displayMode: 'today',
      activeRepresentativeRun: null,
      viewDeflator,
    });
    expect(f(FIRST_YEAR)).toBe(0.5);
    expect(f(FIRST_YEAR + 1)).toBe(0.5);
  });

  it('deterministic basis → parity with viewDeflator(year, 11) (the PDF withdrawal-guidance basis)', () => {
    // The PDF withdrawal-guidance table (a deterministic-only section) deflates
    // its rows with `vm.basisDeflator`. Under a deterministic basis that
    // reduces to the flat `viewDeflator(year, 11)` — the SAME value every other
    // PDF table uses — so the section stays document-internally consistent.
    const viewDeflator = (year: number, monthIndex?: number): number => {
      expect(monthIndex).toBe(11);
      return 1 / (1 + 0.03) ** (year - FIRST_YEAR);
    };
    const f = buildBasisDeflator({
      isMcBasisActive: false,
      displayMode: 'today',
      activeRepresentativeRun: null,
      viewDeflator,
    });
    for (const year of [FIRST_YEAR, FIRST_YEAR + 1, FIRST_YEAR + 5]) {
      expect(f(year)).toBe(viewDeflator(year, 11));
    }
  });

  it('MC basis + Today’s → uses the path’s OWN realFactorByYear (NOT flat)', () => {
    const flat = 0.5;
    const viewDeflator = (): number => flat;
    const run = makeRun();
    const f = buildBasisDeflator({
      isMcBasisActive: true,
      displayMode: 'today',
      activeRepresentativeRun: run,
      viewDeflator,
    });
    // Each in-horizon year resolves to the path's own factor (the offset-0
    // factor of 1 is a valid > 0 factor, so it returns 1 — NOT the flat 0.5).
    REAL_FACTORS.forEach((factor, i) => {
      expect(f(FIRST_YEAR + i)).toBe(factor);
    });
    // The high-CPI years are strictly below the flat factor (path compresses
    // real dollars harder than the scenario rate).
    expect(f(FIRST_YEAR + 2)).toBeLessThan(flat);
  });

  it('MC basis + Future-dollars → falls back to the flat view deflator', () => {
    const viewDeflator = (): number => 1; // future = identity
    const f = buildBasisDeflator({
      isMcBasisActive: true,
      displayMode: 'future',
      activeRepresentativeRun: makeRun(),
      viewDeflator,
    });
    expect(f(FIRST_YEAR + 2)).toBe(1);
  });

  it('out-of-range / non-finite factor → flat fallback, never NaN', () => {
    const viewDeflator = (): number => 0.42;
    const f = buildBasisDeflator({
      isMcBasisActive: true,
      displayMode: 'today',
      activeRepresentativeRun: makeRun({ realFactorByYear: [1, 0, 0.5, 0.3] }),
      viewDeflator,
    });
    // Year offset 1 has factor 0 (not > 0) → flat fallback.
    expect(f(FIRST_YEAR + 1)).toBe(0.42);
    // A year past the horizon → flat fallback.
    expect(f(FIRST_YEAR + 99)).toBe(0.42);
    expect(Number.isNaN(f(FIRST_YEAR + 99))).toBe(false);
  });
});

describe('buildResolvedDrawdown', () => {
  it('no MC basis → the deterministic method slice', () => {
    const planned = {
      years: [drawdownRow(0)],
      depletionYear: null,
      perMonthWithdrawal: new Float64Array(),
    };
    const out = buildResolvedDrawdown({
      activeMcBasis: null,
      activeRepresentativeRun: null,
      drawdownByMethod: { planned, twr: null },
      activeMethod: 'planned',
      cashflowFromYear: 2050,
    });
    expect(out).toBe(planned);
  });

  it('MC basis → the run, sliced so years[0] aligns with fromYear', () => {
    const run = makeRun();
    const out = buildResolvedDrawdown({
      activeMcBasis: 'mc-typical',
      activeRepresentativeRun: run,
      drawdownByMethod: null,
      activeMethod: 'planned',
      cashflowFromYear: FIRST_YEAR + 1,
    });
    // Sliced by one year → first row is the run's second year.
    expect(out?.years[0].year).toBe(FIRST_YEAR + 1);
    expect(out?.years).toHaveLength(REAL_FACTORS.length - 1);
  });

  it('MC basis with fromYear ≤ firstYear → the unsliced run', () => {
    const run = makeRun();
    const out = buildResolvedDrawdown({
      activeMcBasis: 'mc-typical',
      activeRepresentativeRun: run,
      drawdownByMethod: null,
      activeMethod: 'planned',
      cashflowFromYear: FIRST_YEAR,
    });
    expect(out).toBe(run);
  });
});

describe('deriveBalanceProjectionDisplayData (structure, null-data path)', () => {
  it('returns the full display bundle keys with a null pipeline', () => {
    const out = deriveBalanceProjectionDisplayData({
      data: null,
      canonicalBalances: [],
      displayMode: 'today',
      cashflowGranularity: 'yearly',
      incomeBreakdownGranularity: 'yearly',
      activeMethod: 'planned',
      activeMcBasis: null,
      nowYear: 2026,
      nowMonthIndex: 5,
      chartRows: [],
      cashflowSeries: null,
      drawdownByMethod: null,
      activeRepresentativeRun: null,
      lastDeathYear: null,
      lastDeathFractional: null,
      retirementYear: null,
    });
    expect(out.isMcBasisActive).toBe(false);
    expect(typeof out.viewDeflator).toBe('function');
    expect(typeof out.basisDeflator).toBe('function');
    expect(out.displayRows).toEqual([]);
    expect(out.resolvedDrawdown).toBeNull();
    expect(out.incomeView).toBeNull();
    expect(out.unifiedYearTableRows).toEqual([]);
    expect(out.portfolioFlowsByYear).toBeNull();
    expect(out.accountStackTimeline).toEqual([]);
  });

  it('derives populated rows from a non-null pipeline', () => {
    // Minimal chart rows: one integer-x year so the unified table emits a row.
    // The deeply-nested PipelineData aggregates (scenarios, members, resolved
    // overrides) are irrelevant to the asserted derivation paths here — only
    // `data.rows` / `data.accounts` are touched (and short-circuit to empty),
    // so they are stubbed with empty collections behind a single cast.
    const chartRows: ProjectionChartRow[] = [
      {
        year: 2040,
        x: 0,
        plannedSolid: 1_000_000,
        plannedDashed: null,
        twrSolid: null,
        twrDashed: null,
        plannedGrowth: 20_000,
        twrGrowth: null,
      },
    ];
    const data = {
      scenarios: [],
      selectedScenarioId: 's1',
      resolved: { inflation: { ratePct: 3 } },
      members: [],
      primaryMember: null,
      memberRetirementById: new Map<string, string | null>(),
      rows: [],
      accounts: [],
      hiddenInactiveCount: 0,
      hiddenZeroHistoryCount: 0,
      hasAnyRealBalance: false,
      primaryRetirementAbsMonth: null,
      pageResult: null,
    } as unknown as PipelineData;
    const drawdown = {
      years: [drawdownRow(0)],
      depletionYear: null,
      perMonthWithdrawal: new Float64Array(),
    };

    const out = deriveBalanceProjectionDisplayData({
      data,
      canonicalBalances: [],
      displayMode: 'today',
      cashflowGranularity: 'yearly',
      incomeBreakdownGranularity: 'yearly',
      activeMethod: 'planned',
      activeMcBasis: null,
      nowYear: 2026,
      nowMonthIndex: 11,
      chartRows,
      cashflowSeries: null,
      drawdownByMethod: { planned: drawdown, twr: null },
      activeRepresentativeRun: null,
      lastDeathYear: null,
      lastDeathFractional: null,
      retirementYear: null,
    });

    expect(out.displayRows.length).toBeGreaterThan(0);
    expect(out.resolvedDrawdown).not.toBeNull();
    expect(out.unifiedYearTableRows.length).toBeGreaterThan(0);
  });

  it('flags isMcBasisActive when an MC basis is passed', () => {
    const out = deriveBalanceProjectionDisplayData({
      data: null,
      canonicalBalances: [],
      displayMode: 'today',
      cashflowGranularity: 'yearly',
      incomeBreakdownGranularity: 'yearly',
      activeMethod: 'planned',
      activeMcBasis: 'mc-typical',
      nowYear: 2026,
      nowMonthIndex: 5,
      chartRows: [],
      cashflowSeries: null,
      drawdownByMethod: null,
      activeRepresentativeRun: makeRun(),
      lastDeathYear: null,
      lastDeathFractional: null,
      retirementYear: null,
    });
    expect(out.isMcBasisActive).toBe(true);
    // MC + Today's basisDeflator reads the path factor, not flat.
    expect(out.basisDeflator(FIRST_YEAR + 2)).toBe(REAL_FACTORS[2]);
  });
});
