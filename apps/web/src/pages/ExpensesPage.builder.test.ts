// ExpensesPage's pure `buildProjection`, the list-page counterpart to the form preview's `buildMarkers` (`lib/expense-preview-projection.ts`): both feed `ExpensesProjectionChart` and must surface the teal retirement marker on the same terms.
// The marker is emitted even when an expense starts at retirement (`fromYear === retirementYear`), and not when retirement is off the chart's right edge (`lastFullYear < retirementYear`).
import { describe, expect, it } from 'vitest';
import { buildProjection } from './ExpensesPage';
import type { ExpenseRow } from './expense-group-card';
import {
  resolveInflationForScenario,
  resolveScenario,
} from '../lib/scenario-resolution';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import { resolveMemberRetirementDates } from '../lib/retirement-date-math';
import {
  buildExpenseProjectionContext,
  projectExpensesByCategoryYear,
  projectExpensesByYear,
} from '../lib/expense-projection';
import { buildExpensesByCategoryTableSpec } from '../lib/pdf-export/pdf-tables';
import type { ResolvedExpense } from '../lib/expense-resolution';
import type { ExpensePayload, HouseholdMemberPayload } from '../db/types';
import { CHART_COLORS } from '../lib/tokens';
import type { Aggregate, ExpenseCategoryPayload } from '../db/types';

const member = (): Aggregate<HouseholdMemberPayload> => ({
  id: 'hm-1',
  householdId: 'hh',
  aggregateType: 'householdMember',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-05-01T00:00:00Z',
  deviceId: 'dev-1',
  payload: {
    isPrimary: true,
    firstName: 'Alex',
    lastName: 'P',
    email: 'a@x.test',
    birthdate: '1965-04-15',
  },
});

const scenario = (
  id: string,
  isPrimary: boolean,
  overrides: ScenarioAggregate['payload']['overrides'],
): ScenarioAggregate => ({
  id,
  householdId: 'hh',
  aggregateType: 'scenario',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-05-01T00:00:00Z',
  deviceId: 'dev-1',
  payload: {
    name: id,
    description: '',
    parentScenarioId: null,
    isPrimary,
    notes: '',
    overrides,
  },
});

const categoryWith = (
  id: string,
  name: string,
): Aggregate<ExpenseCategoryPayload> => ({
  id,
  householdId: 'hh',
  aggregateType: 'expenseCategory',
  schemaVersion: 1,
  version: 1,
  updatedAt: '2026-05-01T00:00:00Z',
  deviceId: 'dev-1',
  payload: { name },
});

const category = (): Aggregate<ExpenseCategoryPayload> =>
  categoryWith('cat-1', 'Housing');

const expenseRow = (
  overrides: Partial<ExpensePayload> = {},
): ExpenseRow => ({
  id: 'exp-1',
  version: 1,
  categoryName: 'Housing',
  payload: {
    name: 'Travel',
    amount: 1000,
    frequency: 'monthly',
    classification: 'discretionary',
    categoryId: 'cat-1',
    start: { kind: 'retirementStart' },
    end: { kind: 'lifetime', whose: 'primary' },
    ...overrides,
  },
});

const SCN = scenario('scn-primary', true, {
  retirementAge: { primary: { ageYears: 60, ageMonths: 2 } },
});

describe('ExpensesPage buildProjection — retirement marker gate removal', () => {
  it('emits the teal retirement marker when an expense starts AT retirement (fromYear === retirementYear)', () => {
    // The only expense starts at retirementStart, so `fromYear === retirementYear`; the old `fromYear < retirementYear` gate suppressed the marker.
    const data = buildProjection(
      [expenseRow({ start: { kind: 'retirementStart' } })],
      [category()],
      [member()],
      [SCN],
      SCN.id,
      'light',
      'today',
      0,
    );
    expect(data.rows.length).toBeGreaterThan(0);
    const retirementMarker = data.markers.find((m) =>
      /^Retires /.test(m.label),
    );
    expect(retirementMarker).toBeDefined();
    expect(retirementMarker?.label).toBe('Retires Jun 2025');
    expect(retirementMarker?.color).toBe(
      CHART_COLORS.light.retirementMarker,
    );
  });

  it('sources the retirement-marker color from the theme argument', () => {
    const dark = buildProjection(
      [expenseRow({ start: { kind: 'retirementStart' } })],
      [category()],
      [member()],
      [SCN],
      SCN.id,
      'dark',
      'today',
      0,
    );
    const marker = dark.markers.find((m) => /^Retires /.test(m.label));
    expect(marker?.color).toBe(CHART_COLORS.dark.retirementMarker);
  });

  it('omits the marker (empty projection) when retirement is off the chart right edge (lastFullYear < retirementYear)', () => {
    // Life expectancy below the retirement age puts the last death year before retirement, so the `lastFullYear < retirementYear` guard returns the empty projection.
    const offEdge = scenario('scn-off', true, {
      retirementAge: { primary: { ageYears: 90, ageMonths: 0 } },
      lifeExpectancy: { primary: 70, secondary: 70 },
    });
    const data = buildProjection(
      [expenseRow({ start: { kind: 'retirementStart' } })],
      [category()],
      [member()],
      [offEdge],
      offEdge.id,
      'light',
      'today',
      0,
    );
    expect(data.markers).toHaveLength(0);
    expect(data.rows).toHaveLength(0);
  });
});

// `displayMode='future'` resolves inflation from the chain-merged scenario (`resolved.inflation`) so run-rates compound; `'today'` pins inflation to 0%. The rate must come from the resolved chain, not the raw selected scenario, so a child inheriting its parent's rate still inflates.
describe('ExpensesPage buildProjection — display-unit toggle inflation', () => {
  // A non-glided monthly expense, so only the inflation factor varies the run-rate. Sample by array index: the trailing zero-rate tail is trimmed, so sampling by calendar year is fragile.
  const flatRow = (): ExpenseRow =>
    expenseRow({
      classification: 'essential',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'primary' },
    });

  // The chart can lead with zero months before the expense's start month.
  const firstActiveIdx = (
    rows: ReturnType<typeof buildProjection>['rows'],
  ): number => {
    const idx = rows.findIndex((r) => r.total > 0);
    expect(idx).toBeGreaterThanOrEqual(0);
    return idx;
  };

  const firstTotal = (
    rows: ReturnType<typeof buildProjection>['rows'],
  ): number => rows[firstActiveIdx(rows)].total;

  // About 10 years (120 monthly points) past the first active point, clamped to the last point: far enough that non-zero inflation is unmistakable, near enough to stay in the pre-death window.
  const laterTotal = (
    rows: ReturnType<typeof buildProjection>['rows'],
  ): number => {
    const start = firstActiveIdx(rows);
    const idx = Math.min(start + 120, rows.length - 1);
    return rows[idx].total;
  };

  it('grows the run-rate year-over-year in future mode with an explicit 3% scenario', () => {
    const scn = scenario('scn-3pct', true, {
      retirementAge: { primary: { ageYears: 60, ageMonths: 2 } },
      inflation: { ratePct: 3 },
    });
    const data = buildProjection(
      [flatRow()],
      [category()],
      [member()],
      [scn],
      scn.id,
      'light',
      'future',
      0,
    );
    expect(laterTotal(data.rows)).toBeGreaterThan(firstTotal(data.rows));

    // categoryRows shares the ctx with rows (shared-ctx invariant), so category totals must inflate on the same terms; assert it to guard a future ctx split.
    expect(data.categoryRows.length).toBeGreaterThan(0);
    const catFirstIdx = data.categoryRows.findIndex((r) => r.total > 0);
    expect(catFirstIdx).toBeGreaterThanOrEqual(0);
    const catLaterIdx = Math.min(
      catFirstIdx + 120,
      data.categoryRows.length - 1,
    );
    expect(data.categoryRows[catLaterIdx].total).toBeGreaterThan(
      data.categoryRows[catFirstIdx].total,
    );
  });

  it('inflates in future mode at the parent\'s inherited rate, not the 3% default (chain resolution)', () => {
    // The parent carries 4% and the child overrides nothing. Reading the raw child payload would fall back to DEFAULT_INFLATION_PCT (3%), which also gives `later > first`, so pin the chain by comparing against explicit-4% (must match) and explicit-3% (must differ).
    const parent = scenario('scn-parent', true, {
      retirementAge: { primary: { ageYears: 60, ageMonths: 2 } },
      inflation: { ratePct: 4 },
    });
    const child: ScenarioAggregate = {
      ...scenario('scn-child', false, {}),
      payload: {
        ...scenario('scn-child', false, {}).payload,
        parentScenarioId: parent.id,
      },
    };
    const inherited = buildProjection(
      [flatRow()],
      [category()],
      [member()],
      [parent, child],
      child.id,
      'light',
      'future',
      0,
    );

    // Same retirement age and life expectancy as the parent, so the index-sampled points line up across all three.
    const explicit4 = scenario('scn-explicit-4', true, {
      retirementAge: { primary: { ageYears: 60, ageMonths: 2 } },
      inflation: { ratePct: 4 },
    });
    const explicit3 = scenario('scn-explicit-3', true, {
      retirementAge: { primary: { ageYears: 60, ageMonths: 2 } },
      inflation: { ratePct: 3 },
    });
    const at4 = buildProjection(
      [flatRow()],
      [category()],
      [member()],
      [explicit4],
      explicit4.id,
      'light',
      'future',
      0,
    );
    const at3 = buildProjection(
      [flatRow()],
      [category()],
      [member()],
      [explicit3],
      explicit3.id,
      'light',
      'future',
      0,
    );

    expect(laterTotal(inherited.rows)).toBeGreaterThan(
      firstTotal(inherited.rows),
    );
    expect(laterTotal(inherited.rows)).toBe(laterTotal(at4.rows));
    expect(laterTotal(inherited.rows)).not.toBe(laterTotal(at3.rows));
  });

  it('keeps the run-rate flat in today mode (unchanged from pre-toggle)', () => {
    const scn = scenario('scn-3pct-today', true, {
      retirementAge: { primary: { ageYears: 60, ageMonths: 2 } },
      inflation: { ratePct: 3 },
    });
    const data = buildProjection(
      [flatRow()],
      [category()],
      [member()],
      [scn],
      scn.id,
      'light',
      'today',
      0,
    );
    expect(laterTotal(data.rows)).toBe(firstTotal(data.rows));
  });

  it('keeps the run-rate flat for a 0%-inflation scenario in future mode (== today mode)', () => {
    const scn = scenario('scn-0pct', true, {
      retirementAge: { primary: { ageYears: 60, ageMonths: 2 } },
      inflation: { ratePct: 0 },
    });
    const data = buildProjection(
      [flatRow()],
      [category()],
      [member()],
      [scn],
      scn.id,
      'light',
      'future',
      0,
    );
    expect(laterTotal(data.rows)).toBe(firstTotal(data.rows));
  });

  it('re-renders at the new scenario\'s resolved rate when switching scenarios in future mode', () => {
    const scnA = scenario('scn-a', true, {
      retirementAge: { primary: { ageYears: 60, ageMonths: 2 } },
      inflation: { ratePct: 2 },
    });
    const parentB = scenario('scn-b-parent', false, {
      retirementAge: { primary: { ageYears: 60, ageMonths: 2 } },
      inflation: { ratePct: 5 },
    });
    const childB: ScenarioAggregate = {
      ...scenario('scn-b', false, {}),
      payload: {
        ...scenario('scn-b', false, {}).payload,
        parentScenarioId: parentB.id,
      },
    };
    const scenarios = [scnA, parentB, childB];

    const dataA = buildProjection(
      [flatRow()],
      [category()],
      [member()],
      scenarios,
      scnA.id,
      'light',
      'future',
      0,
    );
    const dataB = buildProjection(
      [flatRow()],
      [category()],
      [member()],
      scenarios,
      childB.id,
      'light',
      'future',
      0,
    );

    // A and B share the same horizon, so index-sampled points align; B's steeper growth means its resolved 5% is in effect, not A's 2%.
    const growthA = laterTotal(dataA.rows) / firstTotal(dataA.rows);
    const growthB = laterTotal(dataB.rows) / firstTotal(dataB.rows);
    expect(growthB).toBeGreaterThan(growthA);
  });
});

// `annualRows` / `annualCategoryRows` for the PDF tables must come straight from the headline annual engine over the same resolved expenses, display-basis ctx and visible window as the monthly chart, not a rollup of the plotted samples: a monthly mean over active months diverges from the engine in a partial (mid-year start) year when inflation ≠ 0, the original 12×-inflation bug.
describe('ExpensesPage buildProjection — annual PDF-table sourcing', () => {
  // Rebuild the engine inputs from the same public context helpers `buildProjection` uses, so the engine call is an independent source of truth rather than an echo.
  const expectedEngineInputs = (
    rows: ExpenseRow[],
    members: Aggregate<HouseholdMemberPayload>[],
    scenarios: ScenarioAggregate[],
    selectedScenarioId: string,
    displayMode: 'today' | 'future',
    todayMonthIndex: number,
    // The head of the window is never trimmed and the tail trims to the last active month, so the visible window can be read off the monthly rows.
    chartRows: ReturnType<typeof buildProjection>['rows'],
  ): {
    resolvedExpenses: ResolvedExpense[];
    ctx: ReturnType<typeof buildExpenseProjectionContext> & {
      todayMonthIndex: number;
    };
    window: { from: number; to: number };
  } => {
    const resolved = resolveScenario(selectedScenarioId, scenarios);
    const primary = members.find((m) => m.payload.isPrimary)!;
    const secondary = members.find((m) => !m.payload.isPrimary) ?? null;
    const retirementMap = resolveMemberRetirementDates(
      resolved.retirementAge,
      members.map((m) => ({
        id: m.id,
        isPrimary: m.payload.isPrimary,
        birthdate: m.payload.birthdate ?? '',
      })),
    );
    const primaryRetirementIso = retirementMap.get(primary.id)!;
    const resolvedInflation =
      displayMode === 'future'
        ? resolveInflationForScenario(selectedScenarioId, scenarios)
        : null;
    const ctx = {
      ...buildExpenseProjectionContext({
        resolved,
        primary: primary.payload,
        secondary: secondary?.payload ?? null,
        primaryRetirementIso,
      }),
      inflation:
        resolvedInflation !== null
          ? {
              ratePct: resolvedInflation.ratePct,
              categoryRates: resolvedInflation.categoryRates,
            }
          : { ratePct: 0 },
      todayMonthIndex,
    };
    const resolvedExpenses: ResolvedExpense[] = rows.map((r) => ({
      id: r.id,
      source: 'canonical' as const,
      payload: r.payload,
    }));
    return {
      resolvedExpenses,
      ctx,
      window: {
        from: chartRows[0].year,
        to: chartRows[chartRows.length - 1].year,
      },
    };
  };

  it('sources annualRows from projectExpensesByYear over the visible window (future dollars, mid-year start)', () => {
    // An age-65 start for a 1965-04-15 member is April 2030, a partial year; with 3% future inflation the engine's partial-year factor differs from a monthly mean over active months.
    const scn = scenario('scn-annual-3pct', true, {
      retirementAge: { primary: { ageYears: 60, ageMonths: 2 } },
      inflation: { ratePct: 3 },
    });
    const rows = [
      expenseRow({
        classification: 'essential',
        start: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
        end: { kind: 'lifetime', whose: 'primary' },
      }),
    ];
    const data = buildProjection(
      rows,
      [category()],
      [member()],
      [scn],
      scn.id,
      'light',
      'future',
      0,
    );

    const { resolvedExpenses, ctx, window } = expectedEngineInputs(
      rows,
      [member()],
      [scn],
      scn.id,
      'future',
      0,
      data.rows,
    );
    const expected = projectExpensesByYear(resolvedExpenses, ctx, window);
    expect(data.annualRows).toEqual(expected);

    // The first active year is the April 2030 start, not window.from (which opens at the earlier retirement year with leading zero years).
    const startYear = data.annualRows.find((r) => r.essential > 0)!.year;
    const partial = data.annualRows.find((r) => r.year === startYear)!;
    const full = data.annualRows.find((r) => r.year === startYear + 1)!;
    expect(partial.essential).toBeGreaterThan(0);
    expect(partial.essential).toBeLessThan(full.essential);
  });

  it('sources annualCategoryRows from projectExpensesByCategoryYear over the same window and emits active categories in sorted order, omitting inactive ones', () => {
    const scn = scenario('scn-annual-cat', true, {
      retirementAge: { primary: { ageYears: 60, ageMonths: 2 } },
      inflation: { ratePct: 3 },
    });
    // Active categories are supplied out of alphabetical order so the A-before-Z order can only come from the builder's sort; the all-zero Medical category must be omitted.
    const categories = [
      categoryWith('cat-z', 'Ztravel'),
      categoryWith('cat-a', 'Apparel'),
      categoryWith('cat-m', 'Medical'),
    ];
    const rows = [
      expenseRow({
        name: 'Travel',
        amount: 1000,
        classification: 'essential',
        categoryId: 'cat-z',
        start: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
        end: { kind: 'lifetime', whose: 'primary' },
      }),
      expenseRow({
        name: 'Clothes',
        amount: 500,
        classification: 'discretionary',
        categoryId: 'cat-a',
        start: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
        end: { kind: 'lifetime', whose: 'primary' },
      }),
      expenseRow({
        name: 'Copays',
        amount: 0,
        classification: 'essential',
        categoryId: 'cat-m',
        start: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
        end: { kind: 'lifetime', whose: 'primary' },
      }),
    ];
    const data = buildProjection(
      rows,
      categories,
      [member()],
      [scn],
      scn.id,
      'light',
      'future',
      0,
    );

    const { resolvedExpenses, ctx, window } = expectedEngineInputs(
      rows,
      [member()],
      [scn],
      scn.id,
      'future',
      0,
      data.rows,
    );
    const expected = projectExpensesByCategoryYear(resolvedExpenses, ctx, window);
    expect(data.annualCategoryRows).toEqual(expected);

    expect(data.categoryMeta.map((c) => c.name)).toEqual([
      'Apparel',
      'Ztravel',
    ]);

    const spec = buildExpensesByCategoryTableSpec(
      data.annualCategoryRows,
      data.categoryMeta,
    );
    expect(spec.head[0]).toEqual(['Year', 'Apparel', 'Ztravel']);

    for (const meta of data.categoryMeta) {
      const anyNonZero = data.annualCategoryRows.some(
        (r) => (r.byCategoryId[meta.id] ?? 0) > 0,
      );
      expect(anyNonZero).toBe(true);
    }
  });

  it('sources annualRows from projectExpensesByYear in today dollars (0% basis, full-year sanity)', () => {
    // A retirementStart start is a full year here; today's dollars pin inflation to 0%, so the annual figures are the flat entered amounts.
    const scn = scenario('scn-annual-today', true, {
      retirementAge: { primary: { ageYears: 60, ageMonths: 2 } },
      inflation: { ratePct: 3 },
    });
    const rows = [
      expenseRow({
        classification: 'essential',
        start: { kind: 'retirementStart' },
        end: { kind: 'lifetime', whose: 'primary' },
      }),
    ];
    const data = buildProjection(
      rows,
      [category()],
      [member()],
      [scn],
      scn.id,
      'light',
      'today',
      0,
    );

    const { resolvedExpenses, ctx, window } = expectedEngineInputs(
      rows,
      [member()],
      [scn],
      scn.id,
      'today',
      0,
      data.rows,
    );
    const expected = projectExpensesByYear(resolvedExpenses, ctx, window);
    expect(data.annualRows).toEqual(expected);

    const fullYears = data.annualRows.filter((r) => r.essential > 0);
    expect(fullYears.length).toBeGreaterThan(1);
    expect(fullYears[1].essential).toBe(12_000);
    expect(fullYears[2]?.essential ?? 12_000).toBe(12_000);
  });

  it('returns empty annual rows when there are no visible chart rows', () => {
    // Retirement off the chart's right edge gives an empty projection, so the annual table source is empty too.
    const offEdge = scenario('scn-annual-offedge', true, {
      retirementAge: { primary: { ageYears: 90, ageMonths: 0 } },
      lifeExpectancy: { primary: 70, secondary: 70 },
    });
    const data = buildProjection(
      [expenseRow({ start: { kind: 'retirementStart' } })],
      [category()],
      [member()],
      [offEdge],
      offEdge.id,
      'light',
      'future',
      0,
    );
    expect(data.rows).toHaveLength(0);
    expect(data.annualRows).toHaveLength(0);
    expect(data.annualCategoryRows).toHaveLength(0);
  });
});
