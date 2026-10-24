/** /scenarios/:id/inflation: a general-rate slider plus per-category effective rates. Save always co-persists the general ratePct (so resolveScenario readers keep it) and omits category rows equal to their default; orphan keys are preserved.
* A child that overrides only a category snapshots the resolved general rate, so a later parent change no longer flows to it. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { textLinkClass } from '../components/TextLink';
import { PercentInput, formatPercent } from '../components/PercentInput';
import { RangeSlider, snapToStep } from '../components/RangeSlider';
import { useUnsavedChangesGuard } from '../components/UnsavedChangesGuard';
import { PageHeader } from '../components/PageHeader';
import { LoadingState } from '../components/Skeleton';
import { Alert } from '../components/Alert';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';
import { Muted } from '../components/Muted';
import { RefreshIcon, CheckIcon, XIcon } from '../components/icons';
import {
  btnDangerSmClass,
  breadcrumbNavClass,
  footNoteClass,
  noteClass,
} from './scenarios-page-chrome';
import { listAggregates } from '../db/store';
import { saveScenario } from '../lib/scenario-mutations';
import { INFLATION_MAX, INFLATION_MIN } from '../lib/scenario-input-bounds';
import {
  resolveInflationForScenario,
  type ScenarioAggregate,
} from '../lib/scenario-resolution';
import {
  medicalCategoryIdsFrom,
  medicalCategoryIdSet,
} from '../lib/expense-category-resolvers';
import { useSync } from '../sync/SyncContext';
import {
  DEFAULT_INFLATION_PCT,
  DEFAULT_MEDICAL_INFLATION_SPREAD_PCT,
  type Aggregate,
  type ExpenseCategoryPayload,
  type InflationOverride,
  type ScenarioPayload,
} from '../db/types';

const INFLATION_STEP = 0.5;

function clampRate(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(INFLATION_MIN, Math.min(INFLATION_MAX, value));
}

// A category's inherited default: general + spread for isMedical, else general; displayed uncapped so a high general rate shows the true default.
function defaultRateFor(isMedical: boolean, generalRate: number): number {
  if (isMedical) {
    return generalRate + DEFAULT_MEDICAL_INFLATION_SPREAD_PCT;
  }
  return generalRate;
}

export const ScenarioInflationPage: React.FC = () => {
  const { id = '' } = useParams<{ id: string }>();
  const { householdId } = useAuth();
  const { notifyPending } = useSync();

  const [scenario, setScenario] = useState<ScenarioAggregate | null>(null);
  const [categories, setCategories] = useState<Aggregate<ExpenseCategoryPayload>[]>([]);
  // Membership drives the +2pp default and the IRMAA/ACA disclosure on every isMedical row, not just the legacy id.
  const medicalIds = useMemo(
    () => new Set(medicalCategoryIdsFrom(categories)),
    [categories],
  );
  const [generalRate, setGeneralRate] = useState<number>(DEFAULT_INFLATION_PCT);
  const [categoryDrafts, setCategoryDrafts] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const baselineGeneralRef = useRef<number>(DEFAULT_INFLATION_PCT);
  const baselineCategoryRef = useRef<Map<string, number>>(new Map());
  // The scenario's own stored overrides, kept so orphan keys survive a save verbatim.
  const ownStoredRatesRef = useRef<Record<string, number>>({});

  const reload = useCallback(async () => {
    try {
      const [allScenarios, allCategories] = await Promise.all([
        listAggregates('scenario') as Promise<ScenarioAggregate[]>,
        listAggregates('expenseCategory') as Promise<
          Aggregate<ExpenseCategoryPayload>[]
        >,
      ]);
      const sortedCategories = allCategories
        .slice()
        .sort((a, b) =>
          a.payload.name.localeCompare(b.payload.name, undefined, {
            sensitivity: 'base',
          }),
        );
      setCategories(sortedCategories);
      const found = allScenarios.find((s) => s.id === id) ?? null;
      setScenario(found);
      if (!found) {
        setError(`Scenario ${id} not found.`);
        return;
      }
      const medicalIdSetForLoad = medicalCategoryIdSet(
        medicalCategoryIdsFrom(sortedCategories),
      );
      const resolved = resolveInflationForScenario(
        id,
        allScenarios,
        medicalIdSetForLoad,
      );
      const general = snapToStep(
        clampRate(resolved.ratePct),
        INFLATION_MIN,
        INFLATION_MAX,
        INFLATION_STEP,
      );
      setGeneralRate(general);
      baselineGeneralRef.current = general;
      baselineCategoryRef.current = resolved.categoryRates;
      ownStoredRatesRef.current =
        found.payload.overrides.inflation?.categoryRates ?? {};
      const drafts = new Map<string, number>();
      for (const cat of sortedCategories) {
        const r =
          resolved.categoryRates.get(cat.id) ??
          defaultRateFor(medicalIdSetForLoad.has(cat.id), general);
        drafts.set(cat.id, r);
      }
      setCategoryDrafts(drafts);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const isDirty = useMemo(() => {
    if (generalRate !== baselineGeneralRef.current) return true;
    for (const cat of categories) {
      const d = categoryDrafts.get(cat.id);
      const baseline =
        baselineCategoryRef.current.get(cat.id) ??
        defaultRateFor(medicalIds.has(cat.id), baselineGeneralRef.current);
      if (d !== undefined && d !== baseline) return true;
    }
    return false;
  }, [generalRate, categories, categoryDrafts, medicalIds]);

  const { pendingNavModal } = useUnsavedChangesGuard(isDirty);

  const updateCategory = useCallback((categoryId: string, value: number) => {
    setCategoryDrafts((prev) => {
      const next = new Map(prev);
      next.set(categoryId, value);
      return next;
    });
  }, []);

  const resetCategory = useCallback(
    (categoryId: string) => {
      updateCategory(
        categoryId,
        defaultRateFor(medicalIds.has(categoryId), generalRate),
      );
    },
    [updateCategory, generalRate, medicalIds],
  );

  const handleGeneralRateChange = useCallback(
    (newRate: number) => {
      const oldGeneral = generalRate;
      setGeneralRate(newRate);
      // Recompute inherited category drafts to the new default, or saving after moving the slider would persist every category at its old default as a stale custom override.
      setCategoryDrafts((prev) => {
        const next = new Map(prev);
        for (const [catId, draft] of prev) {
          const isMedical = medicalIds.has(catId);
          if (draft === defaultRateFor(isMedical, oldGeneral)) {
            next.set(catId, defaultRateFor(isMedical, newRate));
          }
        }
        return next;
      });
    },
    [generalRate, medicalIds],
  );

  const handleSave = useCallback(async () => {
    if (!scenario || !householdId) return;
    setSaving(true);
    setError(null);
    try {
      const general = clampRate(generalRate);
      // Start from the stored overrides so orphan keys (deleted or imported-absent categories) are preserved verbatim, sanitised to the finite domain.
      const categoryRates: Record<string, number> = {};
      const liveIds = new Set(categories.map((c) => c.id));
      for (const [key, value] of Object.entries(ownStoredRatesRef.current)) {
        if (liveIds.has(key)) continue; // live categories handled below
        if (typeof value === 'number' && Number.isFinite(value)) {
          categoryRates[key] = clampRate(value);
        }
      }
      for (const cat of categories) {
        const d = categoryDrafts.get(cat.id);
        if (d === undefined) continue;
        const def = defaultRateFor(medicalIds.has(cat.id), general);
        // Compare against the uncapped default before clamping: Medical at general = 9% has draft 11, clamp gives 10, and 10 ≠ 11 would persist a spurious custom override.
        if (d === def) continue;
        categoryRates[cat.id] = clampRate(d);
      }
      const override: InflationOverride = { ratePct: general };
      if (Object.keys(categoryRates).length > 0) {
        override.categoryRates = categoryRates;
      }
      const payload: ScenarioPayload = {
        ...scenario.payload,
        overrides: { ...scenario.payload.overrides, inflation: override },
      };
      await saveScenario({ scenario, payload, householdId });
      notifyPending();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save.');
    } finally {
      setSaving(false);
    }
  }, [scenario, householdId, generalRate, categories, categoryDrafts, medicalIds, notifyPending, reload]);

  if (loading) {
    return (
      <section aria-labelledby="scenario-inflation-heading">
        <PageHeader title={<span id="scenario-inflation-heading">Inflation</span>} />
        <LoadingState label="Loading inflation rates…" variant="table" />
      </section>
    );
  }

  if (error || !scenario) {
    return (
      <section aria-labelledby="scenario-inflation-heading">
        <PageHeader title={<span id="scenario-inflation-heading">Inflation</span>} />
        <Alert tone="error">{error ?? 'Scenario not found.'}</Alert>
        <p>
          <Link to="/scenarios" className={textLinkClass}>
            ← All scenarios
          </Link>
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby="scenario-inflation-heading">
      <nav aria-label="Breadcrumb" className={breadcrumbNavClass}>
        <Link to={`/scenarios/${id}`}>← Back to scenario</Link>
      </nav>
      <PageHeader
        title={
          <span id="scenario-inflation-heading">
            Inflation: {scenario.payload.name}
          </span>
        }
        action={
          isDirty
            ? { label: saving ? 'Saving…' : 'Save', onClick: handleSave, disabled: saving }
            : undefined
        }
        actionIcon={<CheckIcon />}
        secondaryActions={
          isDirty
            ? [
                {
                  label: 'Cancel',
                  icon: <XIcon />,
                  onClick: () => {
                    setError(null);
                    void reload();
                  },
                  disabled: saving,
                  tone: 'neutral',
                },
              ]
            : undefined
        }
      />

      <div className={noteClass}>
        <p className="m-0">
          Set how fast your costs rise each year after you retire. The general
          rate applies to every category by default; Medical starts{' '}
          {DEFAULT_MEDICAL_INFLATION_SPREAD_PCT} percentage points higher
          because healthcare prices have historically risen faster than overall
          prices. Adjust any category, or leave it to inherit the general rate.
        </p>
      </div>

      <Card>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-muted">
            General inflation rate
          </span>
          <RangeSlider
            id="general-inflation-rate"
            ariaLabel="General annual inflation rate (percent)"
            min={INFLATION_MIN}
            max={INFLATION_MAX}
            step={INFLATION_STEP}
            value={generalRate}
            onChange={handleGeneralRateChange}
            formatValue={(v) => formatPercent(v)}
            formatAriaValue={(v) => `${v.toFixed(1)} percent`}
          />
          <Muted as="p" className="m-0">
            Long-run U.S. CPI averages ~3%. Adjust for your own assumptions.
          </Muted>
        </div>
      </Card>

      {categories.length === 0 ? (
        <Card>
          <Muted as="p" className="m-0">
            No expense categories yet. Add one from{' '}
            <Link to="/expense-categories" className={textLinkClass}>
              Expense categories
            </Link>{' '}
            first.
          </Muted>
        </Card>
      ) : (
        <ul className="mt-4 flex flex-col gap-2 p-0" aria-label="Per-category inflation rates">
          {categories.map((cat) => {
            const d = categoryDrafts.get(cat.id);
            if (d === undefined) return null;
            const isMedical = medicalIds.has(cat.id);
            const def = defaultRateFor(isMedical, generalRate);
            const isCustom = d !== def;
            const statusLabel = isCustom
              ? '(custom)'
              : isMedical
                ? `(+${DEFAULT_MEDICAL_INFLATION_SPREAD_PCT}pp default)`
                : `= general (${formatPercent(generalRate)})`;
            return (
              <li
                key={cat.id}
                className="flex flex-wrap items-center gap-3 rounded-md border border-line bg-surface p-3"
              >
                <span className="min-w-32 flex-1 text-sm font-medium text-ink">
                  {cat.payload.name}
                  {isCustom && (
                    <Badge tone="modified" className="ml-2">
                      Custom
                    </Badge>
                  )}
                </span>
                <span className="text-sm text-muted">{statusLabel}</span>
                <span className="inline-block w-20 text-left">
                  <PercentInput
                    variant="cell"
                    ariaLabel={`${cat.payload.name} inflation rate`}
                    value={d}
                    min={INFLATION_MIN}
                    max={INFLATION_MAX}
                    onChange={(v) => updateCategory(cat.id, v)}
                  />
                </span>
                {isCustom && (
                  <button
                    type="button"
                    className={`${btnDangerSmClass} gap-1.5`}
                    onClick={() => resetCategory(cat.id)}
                    disabled={saving}
                    aria-label={`Reset ${cat.payload.name} inflation rate`}
                  >
                    <RefreshIcon />
                    Reset
                  </button>
                )}
                {isMedical && (
                  <p className="m-0 w-full text-xs text-muted">
                    Enter your base Medicare / Medigap premiums here. IRMAA
                    surcharges are modeled separately — do not add them as an
                    expense. For pre-65 ACA Marketplace coverage, the subsidy is
                    sized from a benchmark plan and credited separately, so enter
                    the full (unsubsidized) premium as your Medical expense.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {categories.length > 0 && (
        <div className={footNoteClass}>
          Categories left at their default inherit the general rate. Saving a
          category override snapshots the current general rate for this
          scenario, so a later change to a parent scenario&apos;s general rate
          will not flow to it.
        </div>
      )}

      {pendingNavModal}
    </section>
  );
};
