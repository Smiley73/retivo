/** /expenses: the canonical expense list with a projection chart (Today's dollars pins inflation to 0%, Future dollars uses the scenario rate). */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PlusIcon } from '../components/icons';
import { useNavigate, useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { useConfirm } from '../components/ConfirmDialog';
import { useSync } from '../sync/SyncContext';
import type { TooltipMember } from '../components/ExpensesProjectionChart';
import { PageHeader } from '../components/PageHeader';
import { LoadingState } from '../components/Skeleton';
import { Alert } from '../components/Alert';
import { Muted } from '../components/Muted';
import { ExpensesProjectionSection } from './expenses-projection-section';
import { ExpensesCategorySection } from './expenses-category-section';
import { SegmentedRadioGroup } from '../components/SegmentedRadioGroup';
import {
  type DisplayMode,
  parseDisplayMode,
} from '../lib/view-deflator';
import {
  btnPrimarySmClass,
  btnSecondarySmClass,
} from './scenarios-page-chrome';
import type { CashflowChartMarker } from '../components/CashflowProjectionChart';
import { readSelectedScenario } from '../db/store';
import { queueLocalMutation } from '../sync/mutation-queue';
import { useAggregates } from '../lib/use-aggregates';
import { useSelectedScenarioRevision } from '../lib/use-selected-scenario-revision';
import {
  buildExpenseProjectionContext,
  findEarliestExpenseStartMonth,
  projectExpensesByCategoryMonth,
  projectExpensesByCategoryYear,
  projectExpensesByMonth,
  projectExpensesByYear,
  type ExpenseCategoryMonthlyPoint,
  type ExpenseCategoryYearPoint,
  type ExpenseProjectionMonthlyPoint,
  type ExpenseProjectionPoint,
} from '../lib/expense-projection';
import {
  formatShortIsoMonth,
  isoToFractionalYear,
  projectedDeathFractionalYear,
} from '../lib/expense-preview-projection';
import {
  resolveInflationForScenario,
  resolveScenario,
} from '../lib/scenario-resolution';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import {
  medicalCategoryIdsFrom,
  medicalCategoryIdSet,
} from '../lib/expense-category-resolvers';
import { resolveMemberRetirementDates } from '../lib/retirement-date-math';
import { CHART_COLORS, lifeMarkerColors } from '../lib/tokens';
import {
  assembleCategoryMeta,
  type CategoryMeta,
} from '../lib/category-palette';
import { useTheme } from '../contexts/ThemeContext';
import {
  DEFAULT_LIFE_EXPECTANCY_AGE,
  type Aggregate,
  type ExpenseCategoryPayload,
  type ExpensePayload,
  type HouseholdMemberPayload,
} from '../db/types';

import {
  ExpenseGroupCard,
  type CategoryGroup,
  type ExpenseRow,
} from './expense-group-card';
import { MedicarePremiumsDialog } from './MedicarePremiumsDialog';
import {
  MEDICARE_PREMIUMS_PARAM,
  premiumCheckExpenses,
} from './medicare-premium-helper';

function emptyProjectionData(): ProjectionData {
  return {
    rows: [],
    categoryRows: [],
    annualRows: [],
    annualCategoryRows: [],
    categoryMeta: [],
    markers: [],
    members: [],
  };
}

/** Per-year canonical-expense rows and life-expectancy markers for the chart; empty without a usable primary birthdate or retirement age. */
export function buildProjection(
  rows: ExpenseRow[],
  categories: Aggregate<ExpenseCategoryPayload>[],
  members: Aggregate<HouseholdMemberPayload>[],
  scenarios: ScenarioAggregate[],
  selectedScenarioId: string | null,
  theme: 'light' | 'dark',
  displayMode: DisplayMode,
  todayMonthIndex: number,
): ProjectionData {
  if (rows.length === 0) return emptyProjectionData();
  // Colors resolve against the passed theme; the page rebuilds this when resolvedTheme flips so markers re-theme without reading the .dark class.
  const markerColors = lifeMarkerColors(theme);
  const baseScenario = scenarios.find((s) => s.payload.isPrimary) ?? null;
  const effectiveId =
    selectedScenarioId && scenarios.some((s) => s.id === selectedScenarioId)
      ? selectedScenarioId
      : (baseScenario?.id ?? null);
  if (!effectiveId) return emptyProjectionData();

  const resolved = resolveScenario(effectiveId, scenarios);
  const primary = members.find((m) => m.payload.isPrimary) ?? null;
  const secondary = members.find((m) => !m.payload.isPrimary) ?? null;
  if (!primary?.payload.birthdate) return emptyProjectionData();

  const retirementMap = resolveMemberRetirementDates(
    resolved.retirementAge,
    members.map((m) => ({
      id: m.id,
      isPrimary: m.payload.isPrimary,
      birthdate: m.payload.birthdate ?? '',
    })),
  );
  const primaryRetirementIso = retirementMap.get(primary.id);
  if (!primaryRetirementIso) return emptyProjectionData();
  const retirementYear = new Date(primaryRetirementIso).getUTCFullYear();
  if (!Number.isFinite(retirementYear)) return emptyProjectionData();

  const markers: CashflowChartMarker[] = [];
  const addDeathMarker = (
    member: Aggregate<HouseholdMemberPayload> | null,
    slot: 'primary' | 'secondary',
  ): number | null => {
    if (!member?.payload.birthdate) return null;
    const age = resolved.lifeExpectancy?.[slot] ?? DEFAULT_LIFE_EXPECTANCY_AGE;
    const deathYear = projectedDeathFractionalYear(member.payload.birthdate, age);
    if (deathYear === null) return null;
    const fallback = slot === 'primary' ? 'Primary' : 'Secondary';
    const firstName = member.payload.firstName.trim() || fallback;
    markers.push({
      fractionalYear: deathYear,
      label: `${firstName} life expectancy ${age}`,
      color: markerColors[slot],
      kind: 'death',
    });
    return deathYear;
  };
  addDeathMarker(primary, 'primary');
  addDeathMarker(secondary, 'secondary');
  if (markers.length === 0) return emptyProjectionData();

  const lastDeathFractional = Math.max(
    ...markers.map((m) => m.fractionalYear),
  );
  const lastFullYear = Math.floor(lastDeathFractional);
  if (lastFullYear < retirementYear) return emptyProjectionData();

  // Shares the builder with the single-expense form preview; this page overrides inflation per the display toggle
  // (Today's pins 0%, Future uses the resolved rate and per-category rates, Medical = general + 2pp).
  const resolvedInflation =
    displayMode === 'future'
      ? resolveInflationForScenario(
          effectiveId,
          scenarios,
          medicalCategoryIdSet(medicalCategoryIdsFrom(categories)),
        )
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

  // Widen the left edge to the earliest expense start so a pre-retirement expense is visible from its real start.
  const resolvedExpenses = rows.map((r) => ({
    id: r.id,
    source: 'canonical' as const,
    payload: r.payload,
  }));
  const earliestStart = findEarliestExpenseStartMonth(resolvedExpenses, ctx);
  const fromYear = earliestStart
    ? Math.min(earliestStart.year, retirementYear)
    : retirementYear;
  const retirementFractional = isoToFractionalYear(primaryRetirementIso);
  if (retirementFractional !== null) {
    markers.push({
      fractionalYear: retirementFractional,
      label: `Retires ${formatShortIsoMonth(primaryRetirementIso)}`,
      color: CHART_COLORS[theme].retirementMarker,
    });
  }

  const projected = projectExpensesByMonth(resolvedExpenses, ctx, {
    from: fromYear,
    to: lastFullYear,
  });

  // Trim the trailing zero tail: months past the lifetime end are zero and would draw a misleading drop to 0.
  let lastNonZero = projected.length - 1;
  while (lastNonZero >= 0 && projected[lastNonZero].total === 0) {
    lastNonZero--;
  }
  const trimmedLen = lastNonZero >= 0 ? lastNonZero + 1 : 0;
  const trimmed = projected.slice(0, trimmedLen);

  const categoryProjected = projectExpensesByCategoryMonth(
    resolvedExpenses,
    ctx,
    { from: fromYear, to: lastFullYear },
  );
  const categoryRows = categoryProjected.slice(0, trimmedLen);

  // Annual PDF rows come from the annual engine (projectExpensesByYear), not from rolling up monthly samples, which diverge in partial years when inflation is non-zero.
  const lastVisibleYear = trimmed.length > 0 ? trimmed[trimmed.length - 1].year : null;
  const annualRows: ExpenseProjectionPoint[] =
    lastVisibleYear !== null
      ? projectExpensesByYear(resolvedExpenses, ctx, {
          from: fromYear,
          to: lastVisibleYear,
        })
      : [];
  const annualCategoryRows: ExpenseCategoryYearPoint[] =
    lastVisibleYear !== null
      ? projectExpensesByCategoryYear(resolvedExpenses, ctx, {
          from: fromYear,
          to: lastVisibleYear,
        })
      : [];

  // Alphabetical by name so palette assignment is stable across reloads.
  const catTotals = new Map<string, number>();
  for (const r of categoryRows) {
    for (const [cid, v] of Object.entries(r.byCategoryId)) {
      if (v !== 0) catTotals.set(cid, (catTotals.get(cid) ?? 0) + v);
    }
  }
  const activeIds = new Set(
    categories.filter((c) => (catTotals.get(c.id) ?? 0) > 0).map((c) => c.id),
  );
  const categoryMeta: CategoryMeta[] = assembleCategoryMeta(
    categories.map((c) => ({ id: c.id, name: c.payload.name })),
    activeIds,
    theme,
  );

  const tooltipMembers: TooltipMember[] = [];
  const pushMember = (member: Aggregate<HouseholdMemberPayload> | null): void => {
    if (!member?.payload.birthdate) return;
    const birthYear = Number(member.payload.birthdate.slice(0, 4));
    if (!Number.isFinite(birthYear)) return;
    const firstName =
      member.payload.firstName.trim() ||
      (member.payload.isPrimary ? 'Primary' : 'Secondary');
    tooltipMembers.push({ firstName, birthYear });
  };
  pushMember(primary);
  pushMember(secondary);

  return {
    rows: trimmed,
    categoryRows,
    annualRows,
    annualCategoryRows,
    categoryMeta,
    markers,
    members: tooltipMembers,
  };
}

interface ProjectionData {
  rows: ExpenseProjectionMonthlyPoint[];
  categoryRows: ExpenseCategoryMonthlyPoint[];
  /** Annual essential/discretionary totals for the PDF report, from projectExpensesByYear. */
  annualRows: ExpenseProjectionPoint[];
  /** Annual per-category totals for the PDF report, from projectExpensesByCategoryYear. */
  annualCategoryRows: ExpenseCategoryYearPoint[];
  categoryMeta: CategoryMeta[];
  markers: CashflowChartMarker[];
  members: TooltipMember[];
}

interface LoadedData {
  rows: ExpenseRow[];
  cats: Aggregate<ExpenseCategoryPayload>[];
  members: Aggregate<HouseholdMemberPayload>[];
  scenarios: ScenarioAggregate[];
  selectedScenarioId: string | null;
}

function groupExpenses(
  rows: ExpenseRow[],
  catName: Map<string, string>,
): CategoryGroup[] {
  const byCat = new Map<string, ExpenseRow[]>();
  for (const r of rows) {
    const key = r.payload.categoryId;
    if (!byCat.has(key)) byCat.set(key, []);
    byCat.get(key)!.push(r);
  }
  const groupArr: CategoryGroup[] = [];
  for (const [categoryId, list] of byCat) {
    list.sort((a, b) =>
      a.payload.name.localeCompare(b.payload.name, undefined, {
        sensitivity: 'base',
      }),
    );
    groupArr.push({
      categoryId,
      categoryName: catName.get(categoryId) ?? '(unknown category)',
      rows: list,
    });
  }
  groupArr.sort((a, b) =>
    a.categoryName.localeCompare(b.categoryName, undefined, {
      sensitivity: 'base',
    }),
  );
  return groupArr;
}

/** localStorage key for the display-unit toggle; separate from the Balance Projection page's key so the preferences stay independent. */
export const EXPENSES_DISPLAY_MODE_STORAGE_KEY = 'retivo.expenses.displayMode';

export const ExpensesPage: React.FC = () => {
  const { householdId } = useAuth();
  const { notifyPending } = useSync();
  const { confirm, dialog } = useConfirm();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { resolvedTheme } = useTheme();
  const expenseQuery = useAggregates('expense');
  const categoryQuery = useAggregates('expenseCategory');
  const memberQuery = useAggregates('householdMember');
  const scenarioQuery = useAggregates('scenario');
  const selectedScenarioRevision = useSelectedScenarioRevision();
  const dataReady =
    expenseQuery.ready &&
    categoryQuery.ready &&
    memberQuery.ready &&
    scenarioQuery.ready;
  const loadError =
    expenseQuery.error ||
    categoryQuery.error ||
    memberQuery.error ||
    scenarioQuery.error
      ? 'Failed to load expenses.'
      : null;
  const focusRestoredRef = useRef(false);
  const [premiumsOpen, setPremiumsOpen] = useState(false);
  const premiumsEntryReadRef = useRef(false);
  const [selectedScenarioId, setSelectedScenarioId] = useState<string | null>(
    null,
  );
  const [chartTab, setChartTab] = useState<'total' | 'category'>('total');
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [displayMode, setDisplayMode] = useState<DisplayMode>(() => {
    if (typeof window === 'undefined') return 'today';
    return parseDisplayMode(
      window.localStorage.getItem(EXPENSES_DISPLAY_MODE_STORAGE_KEY),
    );
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(EXPENSES_DISPLAY_MODE_STORAGE_KEY, displayMode);
  }, [displayMode]);

  // Capture one clock anchor per render so the inflation exponent can't drift across a minute boundary.
  const renderNow = new Date();
  const todayMonthIndex = renderNow.getMonth();

  const scenarios = scenarioQuery.aggregates as ReadonlyArray<ScenarioAggregate>;
  useEffect(() => {
    let active = true;
    void (async () => {
      const selected = await readSelectedScenario();
      if (!active) return;
      setSelectedScenarioId(selected?.scenarioId ?? null);
    })();
    return () => {
      active = false;
    };
  }, [scenarios, selectedScenarioRevision]);

  const loaded = useMemo<LoadedData | null>(() => {
    if (!dataReady) return null;
    const cats = categoryQuery.aggregates as ReadonlyArray<
      Aggregate<ExpenseCategoryPayload>
    >;
    const expenses = expenseQuery.aggregates as ReadonlyArray<
      Aggregate<ExpensePayload>
    >;
    const members = memberQuery.aggregates as ReadonlyArray<
      Aggregate<HouseholdMemberPayload>
    > as Aggregate<HouseholdMemberPayload>[];
    const catName = new Map<string, string>();
    for (const c of cats) catName.set(c.id, c.payload.name);
    const rows: ExpenseRow[] = expenses.map((e) => ({
      id: e.id,
      version: e.version,
      payload: e.payload,
      categoryName: catName.get(e.payload.categoryId) ?? '(unknown category)',
    }));
    return {
      rows,
      cats: cats as Aggregate<ExpenseCategoryPayload>[],
      members,
      scenarios: scenarios as ScenarioAggregate[],
      selectedScenarioId,
    };
  }, [
    dataReady,
    expenseQuery.aggregates,
    categoryQuery.aggregates,
    memberQuery.aggregates,
    scenarios,
    selectedScenarioId,
  ]);

  const groups = useMemo<CategoryGroup[]>(() => {
    if (!loaded) return [];
    const catName = new Map<string, string>();
    for (const c of loaded.cats) catName.set(c.id, c.payload.name);
    return groupExpenses(loaded.rows, catName);
  }, [loaded]);
  const householdMembers = loaded?.members ?? [];
  const projection = useMemo<ProjectionData>(() => {
    if (!loaded) return emptyProjectionData();
    return buildProjection(
      loaded.rows,
      loaded.cats,
      loaded.members,
      loaded.scenarios,
      loaded.selectedScenarioId,
      resolvedTheme,
      displayMode,
      todayMonthIndex,
    );
  }, [loaded, resolvedTheme, displayMode, todayMonthIndex]);

  const loading = !dataReady;

  const premiumExpenses = useMemo(
    () =>
      premiumCheckExpenses(
        expenseQuery.aggregates as ReadonlyArray<Aggregate<ExpensePayload>>,
        scenarios,
        selectedScenarioId,
      ),
    [expenseQuery.aggregates, scenarios, selectedScenarioId],
  );

  // After load, restore focus to the row named by focusExpenseId (validated), then strip the param; an invalid id is a no-op.
  useEffect(() => {
    if (loading) return;
    if (focusRestoredRef.current) return;
    focusRestoredRef.current = true;

    const rawId = searchParams.get('focusExpenseId');
    // Always strip the param from the URL.
    if (rawId !== null) {
      const url = new URL(window.location.href);
      url.searchParams.delete('focusExpenseId');
      window.history.replaceState(null, '', url.pathname + (url.search === '?' ? '' : url.search));
    }
    if (!rawId) return;
    // Validate: aggregate ids are random UUIDs; reject selector metacharacters.
    if (!/^[\w-]{1,128}$/.test(rawId)) return;
    const row = document.querySelector<HTMLElement>(`li[data-expense-id="${rawId}"]`);
    if (!row) return;
    // Scroll the row into view without animation (reduced-motion safe).
    row.scrollIntoView({ behavior: 'instant', block: 'nearest' });
    const editBtn = row.querySelector<HTMLButtonElement>('button[aria-label="Edit"]');
    editBtn?.focus({ preventScroll: true });
  }, [loading, searchParams]);

  useEffect(() => {
    if (loading || premiumsEntryReadRef.current) return;
    premiumsEntryReadRef.current = true;
    if (searchParams.get(MEDICARE_PREMIUMS_PARAM) === null) return;
    const url = new URL(window.location.href);
    url.searchParams.delete(MEDICARE_PREMIUMS_PARAM);
    window.history.replaceState(null, '', url.pathname + url.search);
    setPremiumsOpen(true);
  }, [loading, searchParams]);

  const onDelete = async (row: ExpenseRow): Promise<void> => {
    if (!householdId) return;
    const ok = await confirm(
      `Delete "${row.payload.name}"?`,
      'This cannot be undone. Scenario references to this expense will be cleared in a follow-up release.',
    );
    if (!ok) return;
    setDeleteError(null);
    try {
      await queueLocalMutation<ExpensePayload>({
        type: 'expense',
        aggregateId: row.id,
        householdId,
        operation: 'delete',
        expectedVersion: row.version,
        payload: row.payload,
      });
      notifyPending();
    } catch {
      setDeleteError('Failed to delete expense.');
    }
  };

  const error = deleteError ?? loadError;

  if (loading) return <LoadingState label="Loading your expenses…" variant="table" />;

  return (
    <section aria-labelledby="expenses-heading">
      <PageHeader
        title={<span id="expenses-heading">Expenses</span>}
        subtitle="Expected retirement expenses, entered in today's dollars. The projection chart's display-unit toggle switches between today's dollars (flat, inflation pulled out) and future dollars (the scenario's inflation rate applied)."
        action={{
          label: 'Add expense',
          onClick: () => navigate('/expenses/new'),
          ariaLabel: 'Add expense',
        }}
        actionIcon={<PlusIcon />}
        secondaryActions={[
          {
            key: 'add-medicare-premiums',
            label: 'Add Medicare premiums',
            onClick: () => setPremiumsOpen(true),
          },
        ]}
      />

      {error && <Alert tone="error">{error}</Alert>}

      {projection.rows.length > 0 && (() => {
        const tabs = (
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedRadioGroup<DisplayMode>
              ariaLabel="Display unit"
              size="sm"
              value={displayMode}
              onChange={setDisplayMode}
              options={[
                {
                  value: 'today',
                  label: "Today's dollars",
                  title:
                    "What today's prices would buy, with inflation already pulled out.",
                },
                {
                  value: 'future',
                  label: 'Future dollars',
                  title:
                    'The actual amounts a future statement will show, with inflation included.',
                },
              ]}
            />
            <div className="flex flex-wrap gap-1">
              <button
                type="button"
                aria-pressed={chartTab === 'total'}
                className={
                  chartTab === 'total'
                    ? btnPrimarySmClass
                    : btnSecondarySmClass
                }
                onClick={() => setChartTab('total')}
              >
                Total expenses
              </button>
              <button
                type="button"
                aria-pressed={chartTab === 'category'}
                className={
                  chartTab === 'category'
                    ? btnPrimarySmClass
                    : btnSecondarySmClass
                }
                onClick={() => setChartTab('category')}
                disabled={projection.categoryMeta.length === 0}
              >
                Expenses by Category
              </button>
            </div>
          </div>
        );
        return chartTab === 'total' ? (
          <ExpensesProjectionSection
            rows={projection.rows}
            markers={projection.markers}
            members={projection.members}
            tabs={tabs}
          />
        ) : (
          <ExpensesCategorySection
            categoryRows={projection.categoryRows}
            categoryMeta={projection.categoryMeta}
            markers={projection.markers}
            members={projection.members}
            tabs={tabs}
          />
        );
      })()}

      {groups.length === 0 ? (
        <section className="mb-4 flex flex-col items-start gap-4 rounded-2xl border border-line bg-surface-raised p-6 shadow-sm">
          <Muted as="p" className="m-0 max-w-prose">
            No expenses yet. Expenses are what you expect to spend each year in
            retirement, entered in today&apos;s dollars by category. Add your
            first one from the button above, and the projection chart fills in
            your yearly run-rate.
          </Muted>
        </section>
      ) : (
        groups.map((g) => (
          <ExpenseGroupCard
            key={g.categoryId}
            group={g}
            members={householdMembers}
            onEdit={(id) =>
              navigate(
                `/expenses/${id}/edit?returnTo=${encodeURIComponent(`/expenses?focusExpenseId=${id}`)}`,
              )
            }
            onDelete={onDelete}
          />
        ))
      )}

      {dialog}
      {premiumsOpen && householdId && (
        <MedicarePremiumsDialog
          householdId={householdId}
          members={householdMembers}
          expenses={premiumExpenses}
          categories={categoryQuery.aggregates as ReadonlyArray<Aggregate<ExpenseCategoryPayload>>}
          onClose={() => setPremiumsOpen(false)}
        />
      )}
    </section>
  );
};
