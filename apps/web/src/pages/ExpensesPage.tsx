/**
 * /expenses — canonical retirement expense list.
 *
 * Page renders an `<ExpensesProjectionChart>` followed by the category-
 * grouped list. The chart plots the monthly run-rate of essential and
 * discretionary expenses from the earliest start month (or the resolved
 * retirement month, whichever is earlier) through the last surviving
 * member's projected end-of-life. A "Today's dollars / Future dollars"
 * `SegmentedRadioGroup` in the shared tab strip drives the display unit:
 * in *Today's dollars* (default) inflation is pinned to 0% so values stay
 * in today's-dollar terms (flat, unadjusted); in *Future dollars* the
 * chart inflates by the scenario's resolved `inflation.ratePct` (default
 * 3%) so the curve compounds forward. Either way the horizon and death
 * markers come from the resolved scenario — so the chart's shape reflects
 * when individual expenses start/end, the discretionary adjustment window,
 * and lifetime-anchored taper.
 *
 * Per-row actions: Edit (navigates to form) + Delete (confirm dialog).
 */
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
import { MEDICARE_PREMIUMS_PARAM } from './medicare-premium-helper';

/**
 * Compute per-year canonical-expense rows + life-expectancy markers
 * for the chart. Inflation depends on `displayMode`: `'today'` pins the
 * rate to 0% (today's-dollar values, no scenario overrides on the
 * expenses themselves), `'future'` uses the resolved scenario's
 * `inflation.ratePct` (default 3%) so the curve compounds forward from
 * the `todayMonthIndex` anchor. Either way the horizon and markers come
 * from the selected scenario so the chart aligns with the household's
 * plan: retirement year from the resolved primary retirement age,
 * last-death year from each member's resolved life expectancy. Returns
 * empty rows when there is no usable primary birthdate or retirement
 * age — the chart wrapper renders an empty state then.
 */
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

// Shape-limit note: this function is well above the ≤60-line cap. Extraction
// into focused helpers (context build, row projection, category-stack meta,
// tooltip-members) is orthogonal work, deferred to the next change that makes
// a non-trivial computation change inside this function.
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
  // Marker / category palette colors are resolved against the passed
  // `theme` so they match the rendered chart. The page recomputes this
  // builder whenever `useTheme()`'s `resolvedTheme` flips, so a live
  // theme toggle re-themes the markers on the already-mounted chart
  // (no implicit `.dark`-class read here).
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
    // Integer `deathYear` + `kind: 'death'`; the always-monthly expenses
    // chart maps it to the December sample so the marker hugs the data.
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

  // Death markers are the integer death year now (death = Dec 31 of
  // `deathYear`); `lastDeathFractional` = the latest of them.
  const lastDeathFractional = Math.max(
    ...markers.map((m) => m.fractionalYear),
  );
  // Loop bound is the integer death year. `Math.floor` is the identity on
  // the integer marker — the expense data runs through December of
  // `deathYear` (the engine keeps lifetime expenses active through then),
  // so the last monthly sample is December and the death marker hugs it.
  const lastFullYear = Math.floor(lastDeathFractional);
  if (lastFullYear < retirementYear) return emptyProjectionData();

  // Canonical expenses. Shared builder so the single-expense form
  // preview projects under a byte-identical context. Scenario knobs
  // (retirement / life-expectancy / discretionary-spending) shape the
  // horizon + discretionary adjustment. The shared builder pins
  // inflation to 0% (today's-dollar default — correct for the form
  // preview); here the Expenses page overrides it per the display-unit
  // toggle: `'today'` keeps 0% (flat, unadjusted), `'future'` uses the
  // chain-resolved scenario rate (default 3%) so the curve compounds
  // forward. The month anchor (`todayMonthIndex`, captured once per
  // render) is threaded in too so the future-mode curve is anchored to
  // the current month, not January. See `buildExpenseProjectionContext`.
  // Future mode passes the resolved per-category rates (Medical = general +
  // 2pp by default) so the medical band + the per-category chart grow
  // faster; Today's-dollars mode pins inflation to 0% with no category
  // rates so every category reads flat.
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

  // Widen the chart's left edge to the earliest expense start month, so
  // an expense that begins before retirement (e.g. a mortgage payment
  // active today) is visible from its real start rather than clipped at
  // retirementYear.
  const resolvedExpenses = rows.map((r) => ({
    id: r.id,
    source: 'canonical' as const,
    payload: r.payload,
  }));
  const earliestStart = findEarliestExpenseStartMonth(resolvedExpenses, ctx);
  const fromYear = earliestStart
    ? Math.min(earliestStart.year, retirementYear)
    : retirementYear;
  // Surface the canonical teal retirement marker whenever the retirement
  // boundary falls within the chart's x-domain. The domain is
  // [fromYear, lastFullYear]; `fromYear <= retirementYear` (min with it
  // above) and `lastFullYear >= retirementYear` (guarded above), so the
  // boundary is always in range here — including the common
  // `fromYear === retirementYear` case where the chart starts at
  // retirement. The SVG engine clamps a left-edge marker into view so a
  // marker at the very start of the domain stays visible.
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

  // Trim the trailing zero-rate tail. The monthly loop emits all 12
  // months of the death year, but every month past the lifetime end's
  // exclusive boundary is zero — without trimming, the chart draws the
  // line dropping to 0 at the death month and continuing along the
  // X-axis. Trimming leaves the line ending at the last active month,
  // with the dashed death marker visible just to its right rather than
  // a misleading drop-to-zero shape.
  let lastNonZero = projected.length - 1;
  while (lastNonZero >= 0 && projected[lastNonZero].total === 0) {
    lastNonZero--;
  }
  const trimmedLen = lastNonZero >= 0 ? lastNonZero + 1 : 0;
  const trimmed = projected.slice(0, trimmedLen);

  // Category projection runs the same window so the stacked chart's
  // x-axis matches "Total expenses" tick-for-tick. We slice to the
  // total-view's trimmed length so a death-month tail doesn't appear
  // in only the category view.
  const categoryProjected = projectExpensesByCategoryMonth(
    resolvedExpenses,
    ctx,
    { from: fromYear, to: lastFullYear },
  );
  const categoryRows = categoryProjected.slice(0, trimmedLen);

  // Annual (headline) expense rows for the PDF report's expense tables, from
  // the SAME annual engine the year-by-year math is the source of truth for
  // (`projectExpensesByYear` / `projectExpensesByCategoryYear`) under this
  // exact resolved-expense set, context, and display basis. The PDF tables read
  // these directly rather than re-deriving annual totals from the monthly
  // run-rate samples — a monthly rollup mean-over-active-months diverges from
  // the engine's active-months × year-mean-factor in partial (mid-year /
  // trimmed-death) years when inflation is non-zero. The window spans the same
  // years the trimmed chart covers (`fromYear` through the last visible year).
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

  // Determine which categories actually carry non-zero data in the
  // chart window — empty categories don't need a stack layer. Order
  // is alphabetical by category name so palette assignment is stable
  // across reloads (and the legend reads predictably).
  const catTotals = new Map<string, number>();
  for (const r of categoryRows) {
    for (const [cid, v] of Object.entries(r.byCategoryId)) {
      if (v !== 0) catTotals.set(cid, (catTotals.get(cid) ?? 0) + v);
    }
  }
  const activeIds = new Set(
    categories.filter((c) => (catTotals.get(c.id) ?? 0) > 0).map((c) => c.id),
  );
  // Shared assembly (sort alphabetical-by-name + palette in that order) so
  // a category lands on the SAME hue here and on the cashflow band.
  const categoryMeta: CategoryMeta[] = assembleCategoryMeta(
    categories.map((c) => ({ id: c.id, name: c.payload.name })),
    activeIds,
    theme,
  );

  // Build the per-household-member tuple the chart's tooltip uses to
  // render "<First> (age N)" rows. Birthdate is required (year only —
  // the tooltip uses `pointYear - birthYear`, the "age in this calendar
  // year" convention). Primary first so the tooltip reads consistently
  // with the rest of the app.
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
  /** Annual (headline) essential/discretionary totals for the PDF report's
   *  expense-overview table — from `projectExpensesByYear` under the same
   *  resolved expenses / context / display basis as the monthly chart rows. */
  annualRows: ExpenseProjectionPoint[];
  /** Annual per-category totals for the PDF report's expenses-by-category
   *  table — from `projectExpensesByCategoryYear` under the same inputs. */
  annualCategoryRows: ExpenseCategoryYearPoint[];
  categoryMeta: CategoryMeta[];
  markers: CashflowChartMarker[];
  members: TooltipMember[];
}

/** Raw, theme-independent data loaded from IndexedDB. The page derives
 *  `groups` / `householdMembers` / `projection` from this + the resolved
 *  theme so a theme toggle re-themes the chart without a reload. */
interface LoadedData {
  rows: ExpenseRow[];
  cats: Aggregate<ExpenseCategoryPayload>[];
  members: Aggregate<HouseholdMemberPayload>[];
  scenarios: ScenarioAggregate[];
  selectedScenarioId: string | null;
}

/** Group expense rows by category, alphabetical category order and
 *  alphabetical within — pure, so it can run in a render `useMemo`. */
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

/** localStorage key for the Expenses-page display-unit toggle. Distinct
 *  from the Balance Projection page's key so the two pages keep
 *  independent display-mode preferences. */
export const EXPENSES_DISPLAY_MODE_STORAGE_KEY = 'retivo.expenses.displayMode';

export const ExpensesPage: React.FC = () => {
  const { householdId } = useAuth();
  const { notifyPending } = useSync();
  const { confirm, dialog } = useConfirm();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { resolvedTheme } = useTheme();
  // Reactive reads: expenses + their reference data re-read on any write to
  // the subscribed stores (single saves/deletes via the per-store fine signal,
  // the default-categories bootstrap / demo fill / sync via the coarse
  // workspace event, scenario edits via the `scenario` store). The selected-
  // scenario *pointer* is read separately on the narrow revision below.
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
  // Run-once guard: restore fires at most once per navigation.
  const focusRestoredRef = useRef(false);
  // The "Add Medicare premiums" preview, opened by the header action or by the
  // entry-point query parameter (read once, like the focus restore below).
  const [premiumsOpen, setPremiumsOpen] = useState(false);
  const premiumsEntryReadRef = useRef(false);
  // Selected-scenario pointer: not a store-subscription slice, so it is read
  // from the local pointer store and refreshed when the sidebar switches the
  // active scenario or the scenario list changes.
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

  // Single real-clock anchor captured ONCE per render so the inflation
  // exponent can't drift across a clock-minute boundary (BPP pattern).
  const renderNow = new Date();
  const todayMonthIndex = renderNow.getMonth();

  // Re-read the selected-scenario pointer whenever the sidebar switches the
  // active scenario or the scenario list changes. A stored pick that no longer
  // names a live scenario falls back to the base inside `buildProjection`.
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

  // Raw, theme-independent data assembled from the reactive hook outputs.
  // `null` until every slice settles so the page keeps its loading skeleton.
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

  // Theme-reactive derivations. `projection` re-runs when the resolved
  // theme flips (markers / category palette re-color on a live
  // toggle without a data reload); `groups` is theme-independent.
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

  // Post-load focus restoration: after the first successful data
  // load, read `focusExpenseId` from the URL, validate it against a safe
  // format, scroll the matching row into view, focus its Edit button,
  // and strip the param via replaceState. A missing/invalid/unmatched
  // id is a no-op: the param is still stripped so the URL stays clean.
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
    // Focus the Edit button inside the row.
    const editBtn = row.querySelector<HTMLButtonElement>('button[aria-label="Edit"]');
    editBtn?.focus({ preventScroll: true });
  }, [loading, searchParams]);

  // Entry points (the Projections note, the Health coverage dialog) land here
  // with `medicarePremiums=1`: open the preview once data is ready and strip
  // the parameter so a reload does not reopen it.
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
      // The delete tombstone is an `expense` write, so the reactive read
      // re-runs and drops the row — no manual reload.
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
        // Plain toggle buttons — no tablist/tabpanel pair, so tablist
        // ARIA is removed; buttons remain the toggle affordance. Tab strip
        // lives in the chart card's header (top-right).
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
          expenses={expenseQuery.aggregates as ReadonlyArray<Aggregate<ExpensePayload>>}
          categories={categoryQuery.aggregates as ReadonlyArray<Aggregate<ExpenseCategoryPayload>>}
          onClose={() => setPremiumsOpen(false)}
        />
      )}
    </section>
  );
};
