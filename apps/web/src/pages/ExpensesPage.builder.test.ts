/**
 * Unit tests for ExpensesPage's pure `buildProjection` builder — the
 * list-page counterpart to the form preview's `buildMarkers`
 * (`lib/expense-preview-projection.ts`). Both feed the same
 * `ExpensesProjectionChart`, so both must surface the teal retirement
 * marker on the SAME terms.
 *
 * Focus: the gate-removal behaviour. The teal
 * `Retires <Mon YYYY>` marker (`CHART_COLORS[theme].retirementMarker`)
 * must be EMITTED even when an expense starts AT retirement
 * (`fromYear === retirementYear`), where the prior
 * `fromYear < retirementYear` gate suppressed it. Also covers the
 * negative `lastFullYear < retirementYear` guard (retirement off the
 * chart's right edge → no marker, empty projection).
 */
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

// Primary scenario carrying a resolvable retirement age (60y2m on a
// 1965-04-15 birthdate → June 2025) and a default life expectancy that
// lands the death year well past retirement.
const SCN = scenario('scn-primary', true, {
  retirementAge: { primary: { ageYears: 60, ageMonths: 2 } },
});

describe('ExpensesPage buildProjection — retirement marker gate removal', () => {
  it('emits the teal retirement marker when an expense starts AT retirement (fromYear === retirementYear)', () => {
    // Only expense starts at retirementStart → earliest start == retirement,
    // so fromYear === retirementYear. The prior `fromYear < retirementYear`
    // gate would suppress the marker; it must now render.
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
    // Life expectancy below the retirement age forces the last death year
    // before retirement → the `lastFullYear < retirementYear` guard returns
    // the empty projection (no markers at all).
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

/**
 * Display-unit toggle behaviour. `displayMode='future'` resolves the
 * inflation rate from the chain-merged scenario (`resolved.inflation`),
 * so the chart's monthly run-rate compounds forward; `displayMode='today'`
 * pins inflation to 0% (flat, unchanged from the pre-toggle behaviour).
 * The rate must come from the resolved chain, not the raw selected
 * scenario, so a child inheriting its parent's rate still inflates.
 */
describe('ExpensesPage buildProjection — display-unit toggle inflation', () => {
  // A non-glided monthly expense so the only thing varying the run-rate
  // across years is the inflation factor. The first emitted point and a
  // point well into the horizon are compared so the delta is the pure
  // inflation step (the trailing zero-rate tail is trimmed by
  // buildProjection, so sampling by explicit calendar year is fragile;
  // sample by array index instead).
  const flatRow = (): ExpenseRow =>
    expenseRow({
      classification: 'essential',
      start: { kind: 'retirementStart' },
      end: { kind: 'lifetime', whose: 'primary' },
    });

  /** Index of the first non-zero run-rate point (the chart can lead with
   *  zero months before the expense's start month). */
  const firstActiveIdx = (
    rows: ReturnType<typeof buildProjection>['rows'],
  ): number => {
    const idx = rows.findIndex((r) => r.total > 0);
    expect(idx).toBeGreaterThanOrEqual(0);
    return idx;
  };

  /** First active (non-zero) run-rate point's total. */
  const firstTotal = (
    rows: ReturnType<typeof buildProjection>['rows'],
  ): number => rows[firstActiveIdx(rows)].total;

  /** A run-rate point's total ~10 years (120 monthly points) past the
   *  first active point, clamped to the last available point. Far enough
   *  that a non-zero inflation rate is unmistakable, near enough to stay
   *  inside the active (pre-death) window. */
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
    // Strictly increasing across the horizon → inflation applied.
    expect(laterTotal(data.rows)).toBeGreaterThan(firstTotal(data.rows));

    // categoryRows shares the same ctx as rows (shared-ctx invariant), so the
    // category totals must inflate on the same terms. Assert explicitly to
    // protect the invariant against a future ctx split. Same first/later
    // sampling pattern as the rows helpers, applied to categoryRows.total.
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
    // Parent carries a non-default 4% rate; the child overrides nothing
    // for inflation. Reading the raw child payload would miss the parent
    // rate and fall back to DEFAULT_INFLATION_PCT (3%) — which also
    // produces `later > first`, so a bare growth assertion can't tell
    // chain-resolved 4% apart from a 3% fallback. Pin the chain by
    // comparing the inherited-4% curve against an explicit-4% scenario
    // (must match) AND against an explicit-3% scenario (must differ).
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

    // Explicit standalone 4% and 3% scenarios (no parent chain). Same
    // retirement age + life expectancy as the parent → identical horizon,
    // so the index-sampled `laterTotal` points line up across all three.
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

    // Inflation applied at all (sanity).
    expect(laterTotal(inherited.rows)).toBeGreaterThan(
      firstTotal(inherited.rows),
    );
    // Chain resolved the parent's 4%: inherited curve == explicit 4%.
    expect(laterTotal(inherited.rows)).toBe(laterTotal(at4.rows));
    // ...and is NOT the 3% default fallback (DEFAULT_INFLATION_PCT).
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
    // scn-A: explicit 2% direct override. scn-B: child inheriting 5%
    // from its parent (parent-chain). While in future mode, switching
    // from A's id to B's id produces a steeper curve (5% > 2%).
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

    // Both A and B share the same horizon (same retirement age + life
    // expectancy), so the index-sampled points align. B's later-point
    // growth from the shared first-point base is steeper → B's resolved
    // 5% rate is in effect, not A's 2%.
    const growthA = laterTotal(dataA.rows) / firstTotal(dataA.rows);
    const growthB = laterTotal(dataB.rows) / firstTotal(dataB.rows);
    expect(growthB).toBeGreaterThan(growthA);
  });
});

/**
 * Annual (headline) PDF-table sourcing. `buildProjection` exposes
 * `annualRows` / `annualCategoryRows` for the exported PDF's expense
 * overview / by-category tables. The correctness-critical contract is that
 * those rows come STRAIGHT from the headline annual engine
 * (`projectExpensesByYear` / `projectExpensesByCategoryYear`) over the same
 * resolved expenses, the same display-basis `ctx`, and the same visible
 * year window as the monthly chart — NOT a rollup of the plotted monthly
 * run-rate samples (a monthly mean-over-active-months diverges from the
 * engine's active-months × year-mean-factor in a partial / mid-year-start
 * year when inflation ≠ 0, which is the original 12×-inflation bug this
 * fix closed). These tests rebuild the exact engine call from the same
 * public context helpers `buildProjection` uses (so they are not circular)
 * and assert the builder's rows tie out to it.
 */
describe('ExpensesPage buildProjection — annual PDF-table sourcing', () => {
  // Rebuild the resolved expenses + display-basis ctx + visible window the
  // SAME way `buildProjection` does, so the engine call below is an
  // independent source of truth rather than an echo of the builder.
  const expectedEngineInputs = (
    rows: ExpenseRow[],
    members: Aggregate<HouseholdMemberPayload>[],
    scenarios: ScenarioAggregate[],
    selectedScenarioId: string,
    displayMode: 'today' | 'future',
    todayMonthIndex: number,
    // The visible window is read off the builder's own monthly chart rows:
    // the head is never trimmed (so rows[0].year === fromYear) and the tail
    // trims to the last active month (so rows.at(-1).year === lastVisibleYear).
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
    // Age-65 start for a 1965-04-15 member → April 2030: a PARTIAL year.
    // 3% future inflation on → the engine's partial-year factor differs from
    // a monthly mean-over-active-months rollup. This is the case the bug hid.
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

    // The mid-year start really makes the expense's first active year partial
    // (less than the following full year), so this is the divergence-prone
    // case, not a trivial full-year row. The first active year is the April
    // 2030 age-65 start — not window.from (the window opens at the earlier
    // retirement year, with leading zero years).
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
    // Two ACTIVE categories supplied OUT OF alphabetical order (Ztravel
    // before Apparel) so the asserted A-before-Z order can only come from the
    // builder's sort, not the input order. Plus one all-zero (inactive)
    // category (Medical, $0/mo) that must be omitted entirely. Each expense is
    // keyed to its own category via categoryId (how byCategoryId buckets).
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
      // Inactive: zero amount → no non-zero data in any year.
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

    // (a) categoryMeta is the ACTIVE categories in alphabetical order —
    // Apparel before Ztravel despite the reversed input order, and the
    // all-zero Medical category is omitted.
    expect(data.categoryMeta.map((c) => c.name)).toEqual([
      'Apparel',
      'Ztravel',
    ]);

    // (b) The rendered PDF table header row follows the same active-only,
    // sorted order ('Year' + each active category name).
    const spec = buildExpensesByCategoryTableSpec(
      data.annualCategoryRows,
      data.categoryMeta,
    );
    expect(spec.head[0]).toEqual(['Year', 'Apparel', 'Ztravel']);

    // Every category the builder kept in categoryMeta carries non-zero annual
    // data; an all-zero category never sneaks into the table source.
    for (const meta of data.categoryMeta) {
      const anyNonZero = data.annualCategoryRows.some(
        (r) => (r.byCategoryId[meta.id] ?? 0) > 0,
      );
      expect(anyNonZero).toBe(true);
    }
  });

  it('sources annualRows from projectExpensesByYear in today dollars (0% basis, full-year sanity)', () => {
    // retirementStart start → the start year is a full year here; today's
    // dollars pins inflation to 0% so the annual figures are the flat
    // entered amounts. Confirms the basis pass-through and window for the
    // common case.
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

    // 0% basis: a full active year is the flat entered annual amount
    // ($1,000/mo × 12). The next full year is identical (no inflation drift).
    const fullYears = data.annualRows.filter((r) => r.essential > 0);
    expect(fullYears.length).toBeGreaterThan(1);
    expect(fullYears[1].essential).toBe(12_000);
    expect(fullYears[2]?.essential ?? 12_000).toBe(12_000);
  });

  it('returns empty annual rows when there are no visible chart rows', () => {
    // Retirement off the chart's right edge → empty projection (no monthly
    // rows), so the annual table source is empty too (the null-guard path).
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
