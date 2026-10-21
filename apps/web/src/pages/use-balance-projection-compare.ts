/**
 * Balance Projection page — Compare tab data hook.
 *
 * Owns everything the Compare panel needs that is not presentation: which
 * scenario to compare with (URL, then the remembered choice, then the viewed
 * scenario's parent, then none), the selector's option list, the remembered-
 * choice read/write, and the second deterministic projection for the chosen
 * scenario. That projection is the page's own `loadPageData` call over the same
 * eight slices, run only while the tab is selected (the panel is force-mounted,
 * so mounting is not selecting) and deferred to an idle slice so a large
 * household cannot hitch a frame. A finished result is kept across tab switches
 * and recomputed only when the inputs the page's own effect depends on, or the
 * comparison id, change. The viewed scenario's figures never wait on it.
 *
 * Status: `none` (nothing chosen), `pending` (queued or running), `ready`
 * (`comparison` holds the projected scenario), `unprojectable` (no retirement
 * age resolves, so there is no projection and nothing is wrong to report),
 * `unavailable` (the projection ran but one side has no usable Planned
 * result, e.g. an unconfigured pension election, so there is nothing to
 * compare) or `error` (a recognised configuration clash; `errorMessage` says
 * which).
 */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { hasPlannedProjection } from './balance-projection-compare-data';
import { COMPARE_WITH_PARAM } from './balance-projection-page-constants';
import { loadPageData, type PipelineData } from './balance-projection-page-data';
import type { UseBalanceProjectionDataResult } from './use-balance-projection-data';
import { TaxIntegrationInvalidInputError } from '../lib/balance-projection-runner-tax';
import { friendlyProjectionErrorMessage } from '../lib/tax-integration';
import {
  buildScenarioTreeOptions,
  scenarioOptionLabel,
} from '../lib/scenario-tree-options';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import {
  COMPARE_CHOICE_STORAGE_KEY,
  parseCompareChoices,
} from '../lib/view-deflator';
import { yieldToIdle } from '../lib/yield-to-idle';

type CompareStatus = 'none' | 'pending' | 'ready' | 'unprojectable' | 'unavailable' | 'error';

interface CompareOption {
  readonly value: string;
  readonly label: string;
  readonly depth: number;
}

export interface UseBalanceProjectionCompareInput {
  readonly dataLoad: UseBalanceProjectionDataResult;
  /** The viewed scenario's projection — the page's own `data`. */
  readonly data: PipelineData;
  /** True while the Compare tab is the selected view. */
  readonly isActive: boolean;
  readonly nowYear: number;
  readonly nowMonthIndex: number;
}

export interface UseBalanceProjectionCompareResult {
  /** Every scenario but the viewed one, in the sidebar picker's tree order. */
  readonly options: ReadonlyArray<CompareOption>;
  readonly comparisonId: string | null;
  readonly comparisonName: string | null;
  readonly status: CompareStatus;
  /** The comparison scenario's projection; non-null only when `status` is `ready`. */
  readonly comparison: PipelineData | null;
  readonly errorMessage: string | null;
  /** A selector change: writes `?with=` (REPLACE) and the remembered choice. */
  readonly choose: (id: string) => void;
}

const FALLBACK_ERROR_MESSAGE =
  'This scenario can\'t be projected with its current settings.';

type Outcome =
  | { readonly status: 'ready'; readonly comparison: PipelineData }
  | { readonly status: 'unprojectable' }
  | { readonly status: 'unavailable' }
  | { readonly status: 'error'; readonly message: string };

function readRemembered(): ReadonlyMap<string, string> {
  if (typeof window === 'undefined') return new Map();
  try {
    return parseCompareChoices(window.localStorage.getItem(COMPARE_CHOICE_STORAGE_KEY));
  } catch {
    return new Map();
  }
}

function writeRemembered(choices: ReadonlyMap<string, string>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      COMPARE_CHOICE_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(choices)),
    );
  } catch {
    // Storage blocked or full: the choice still holds for this visit via the URL.
  }
}

/** Which scenario to compare the viewed one with, or null for none. */
export function resolveComparisonId(args: {
  readonly viewedId: string;
  readonly scenarios: ReadonlyArray<ScenarioAggregate>;
  readonly withParam: string | null;
  readonly remembered: ReadonlyMap<string, string>;
}): string | null {
  const { viewedId, scenarios, withParam, remembered } = args;
  const isLiveOther = (id: string | null | undefined): id is string =>
    !!id && id !== viewedId && scenarios.some((s) => s.id === id);
  if (isLiveOther(withParam)) return withParam;
  const rememberedId = remembered.get(viewedId);
  if (isLiveOther(rememberedId)) return rememberedId;
  const parentId = scenarios.find((s) => s.id === viewedId)?.payload.parentScenarioId;
  return isLiveOther(parentId) ? parentId : null;
}

function sameInputs(a: ReadonlyArray<unknown>, b: ReadonlyArray<unknown>): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function useBalanceProjectionCompare(
  input: UseBalanceProjectionCompareInput,
): UseBalanceProjectionCompareResult {
  const { dataLoad, data, isActive, nowYear, nowMonthIndex } = input;
  const {
    scenarios,
    ready,
    members,
    accounts,
    balances,
    expenses,
    expenseCategories,
    incomeStreams,
    ssBenefits,
  } = dataLoad;
  const viewedId = data.selectedScenarioId;
  const [searchParams, setSearchParams] = useSearchParams();
  const rawWithParam = searchParams.get(COMPARE_WITH_PARAM);
  // `?with=` names a partner for the scenario that was viewed when it arrived
  // (a "Compare with parent" link, or a selector choice). Once a different
  // scenario is viewed (a sidebar switch) it no longer applies, so it stops
  // overriding that scenario's remembered choice and default.
  const [withAnchor, setWithAnchor] = useState<{
    readonly withParam: string;
    readonly viewedId: string;
  } | null>(null);
  if (rawWithParam === null) {
    if (withAnchor !== null) setWithAnchor(null);
  } else if (withAnchor?.withParam !== rawWithParam) {
    setWithAnchor({ withParam: rawWithParam, viewedId });
  }
  const withParamStale =
    rawWithParam !== null &&
    withAnchor?.withParam === rawWithParam &&
    withAnchor.viewedId !== viewedId;
  const withParam = withParamStale ? null : rawWithParam;
  const [remembered, setRemembered] = useState(readRemembered);

  const options = useMemo(
    () =>
      buildScenarioTreeOptions([...scenarios])
        .filter(({ scenario }) => scenario.id !== viewedId)
        .map(({ scenario, depth }) => ({
          value: scenario.id,
          label: scenarioOptionLabel(scenario),
          depth,
        })),
    [scenarios, viewedId],
  );

  const comparisonId = useMemo(
    () =>
      ready && scenarios.length > 0
        ? resolveComparisonId({ viewedId, scenarios, withParam, remembered })
        : null,
    [ready, scenarios, viewedId, withParam, remembered],
  );
  // Drop the spent parameter so the URL matches what the tab resolves.
  useEffect(() => {
    if (!withParamStale) return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(COMPARE_WITH_PARAM);
        return next;
      },
      { replace: true },
    );
  }, [withParamStale, setSearchParams]);
  const comparisonName =
    scenarios.find((s) => s.id === comparisonId)?.payload.name ?? null;

  // The inputs the page's own projection effect depends on, plus the id. A
  // stored result is current only while all of them are unchanged.
  const inputs = useMemo(
    () => [
      comparisonId,
      scenarios,
      members,
      accounts,
      balances,
      expenses,
      expenseCategories,
      incomeStreams,
      ssBenefits,
      nowYear,
      nowMonthIndex,
    ],
    [
      comparisonId,
      scenarios,
      members,
      accounts,
      balances,
      expenses,
      expenseCategories,
      incomeStreams,
      ssBenefits,
      nowYear,
      nowMonthIndex,
    ],
  );
  const [result, setResult] = useState<{
    readonly inputs: ReadonlyArray<unknown>;
    readonly outcome: Outcome;
  } | null>(null);
  // An error other than a recognised configuration clash is a bug, not a
  // state to show: it is rethrown from render so the error boundary sees it,
  // as it would from the page's own effect (an idle callback cannot throw to it).
  const [fatal, setFatal] = useState<{ readonly error: unknown } | null>(null);
  if (fatal) throw fatal.error;

  const outcome =
    result !== null && sameInputs(result.inputs, inputs) ? result.outcome : null;
  const current = outcome !== null;

  useEffect(() => {
    if (!isActive || comparisonId === null || current) return;
    return yieldToIdle(() => {
      try {
        const comparison = loadPageData({
          scenarios,
          selectedScenarioId: comparisonId,
          members,
          accounts,
          balances,
          expenses,
          incomeStreams,
          ssBenefits,
          categories: expenseCategories,
          todayYear: nowYear,
          todayMonthIndex: nowMonthIndex,
        });
        setResult({
          inputs,
          outcome: !comparison.pageResult
            ? { status: 'unprojectable' }
            : hasPlannedProjection(comparison)
              ? { status: 'ready', comparison }
              : { status: 'unavailable' },
        });
      } catch (e) {
        if (e instanceof TaxIntegrationInvalidInputError) {
          setResult({
            inputs,
            outcome: {
              status: 'error',
              message: friendlyProjectionErrorMessage(e) ?? FALLBACK_ERROR_MESSAGE,
            },
          });
        } else {
          setFatal({ error: e });
        }
      }
    });
  }, [
    isActive,
    comparisonId,
    current,
    inputs,
    scenarios,
    members,
    accounts,
    balances,
    expenses,
    expenseCategories,
    incomeStreams,
    ssBenefits,
    nowYear,
    nowMonthIndex,
  ]);

  const choose = (id: string): void => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set(COMPARE_WITH_PARAM, id);
        return next;
      },
      { replace: true },
    );
    const next = new Map(readRemembered());
    next.set(viewedId, id);
    writeRemembered(next);
    setRemembered(next);
  };

  // A ready comparison still needs a usable Planned result on the viewed side;
  // without one, the headline would read its missing figures as "Never".
  const readyComparison =
    outcome?.status === 'ready' && hasPlannedProjection(data) ? outcome.comparison : null;
  const status: CompareStatus =
    comparisonId === null
      ? 'none'
      : outcome === null
        ? 'pending'
        : outcome.status === 'ready' && readyComparison === null
          ? 'unavailable'
          : outcome.status;

  return {
    options,
    comparisonId,
    comparisonName,
    status,
    comparison: readyComparison,
    errorMessage: outcome?.status === 'error' ? outcome.message : null,
    choose,
  };
}
