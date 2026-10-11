/**
 * Balance Projection page — basis-aware SWR data hook.
 *
 * Adapts the page's ALREADY-BUILT view model (`vm`, from the page's own
 * single `useBalanceProjectionViewModel()` call) onto
 * `balance-projection-swr-derivation.ts`'s pure builder — this hook mounts
 * no view model of its own and triggers no Monte Carlo run: the page's
 * existing `stressVm` already runs (or doesn't) independently of this tab,
 * exactly as it does for every other tab today.
 *
 * One raw input the vm doesn't surface is threaded through independently:
 * the per-year Social Security / pension / part-time / one-off split
 * (`sourceSplitByYear`), via a second call to the already-exported, pure
 * `buildPageCashflowSeries` with the SAME inputs the page's own
 * `cashflowSeries` memo uses — the single source for that split
 * (`CashflowMonthlyPoint`, what
 * `vm.incomeView` DOES surface, carries only the pre-summed `earned`
 * figure, not the per-source breakdown this tab's guaranteed/other-income
 * layers need).
 */
import { useMemo } from 'react';
import type { Aggregate, ExpensePayload, IncomeStreamPayload, SocialSecurityBenefitPayload } from '../db/types';
import type { ProjectionMethod } from '../components/ProjectionChart';
import type { DisplayMode } from '../lib/view-deflator';
import type { SwrComparisonResult } from '../lib/safe-withdrawal-rate-chart-types';
import { buildViewDeflatorForExport } from './balance-projection-view-derivation';
import {
  buildPageCashflowSeries,
  type McBasis,
  type PipelineData,
} from './balance-projection-page-pipeline';
import { buildSwrComparisonData } from './balance-projection-swr-derivation';
import type { BalanceProjectionViewModel } from './use-balance-projection-view-model';

export interface UseBalanceProjectionSwrDataInput {
  readonly data: PipelineData | null;
  /** The page's own view model — the SAME object every other tab reads,
   *  never a second `useBalanceProjectionViewModel()` call (that would
   *  duplicate the page's Monte Carlo run). */
  readonly vm: BalanceProjectionViewModel;
  readonly selectedScenarioId: string | null;
  readonly canonicalIncome: ReadonlyArray<Aggregate<IncomeStreamPayload>>;
  readonly canonicalExpenses: ReadonlyArray<Aggregate<ExpensePayload>>;
  readonly ssBenefits: ReadonlyArray<Aggregate<SocialSecurityBenefitPayload>>;
  readonly displayMode: DisplayMode;
  readonly activeMethod: ProjectionMethod;
  readonly activeMcBasis: McBasis | null;
  readonly nowYear: number;
  readonly nowMonthIndex: number;
}

export function useBalanceProjectionSwrData(
  input: UseBalanceProjectionSwrDataInput,
): SwrComparisonResult {
  const {
    data,
    vm,
    selectedScenarioId,
    canonicalIncome,
    canonicalExpenses,
    ssBenefits,
    displayMode,
    activeMethod,
    activeMcBasis,
    nowYear,
    nowMonthIndex,
  } = input;

  // ALWAYS Today's-dollars, independent of the page's active toggle:
  // `vm.viewDeflator` collapses to the identity under Future-dollars, which
  // would leave the rule figures with no real basis to inflate forward from
  // (see `balance-projection-swr-derivation.ts`'s docblock).
  const realDeflator = useMemo(
    () =>
      buildViewDeflatorForExport(
        'today',
        data?.resolved.inflation?.ratePct,
        nowYear,
        nowMonthIndex,
      ),
    [data?.resolved.inflation?.ratePct, nowYear, nowMonthIndex],
  );

  const primaryRetirementIso = useMemo<string | null>(() => {
    if (vm.primaryRetirementYear === null) return null;
    if (!data?.primaryMember) return null;
    return data.memberRetirementById.get(data.primaryMember.id) ?? null;
  }, [vm.primaryRetirementYear, data]);

  // Mirrors the page's own `cashflowChartEndYear` memo.
  const cashflowChartEndYear = useMemo<number | null>(() => {
    if (vm.primaryRetirementYear === null) return null;
    return vm.lastDeathFractional !== null
      ? Math.floor(vm.lastDeathFractional)
      : vm.primaryRetirementYear;
  }, [vm.primaryRetirementYear, vm.lastDeathFractional]);

  const sourceSplitByYear = useMemo(() => {
    if (!data || !selectedScenarioId || cashflowChartEndYear === null) return null;
    const series = buildPageCashflowSeries({
      data,
      selectedScenarioId,
      canonicalIncome,
      canonicalExpenses,
      ssBenefits,
      cashflowChartEndYear,
      lastDeathYear: vm.lastDeathYear,
      primaryRetirementYear: vm.primaryRetirementYear,
      primaryRetirementFractional: vm.retirementMarkers[0]?.fractionalYear ?? null,
      nowYear,
      nowMonthIndex,
    });
    return series?.sourceSplitByYear ?? null;
  }, [
    data,
    selectedScenarioId,
    canonicalIncome,
    canonicalExpenses,
    ssBenefits,
    cashflowChartEndYear,
    vm.lastDeathYear,
    vm.primaryRetirementYear,
    vm.retirementMarkers,
    nowYear,
    nowMonthIndex,
  ]);

  return useMemo(
    () =>
      buildSwrComparisonData({
        displayMode,
        activeMethod,
        activeMcBasis,
        enabledCalculatedMethods: vm.enabledCalculatedMethods,
        primaryRetirementYear: vm.primaryRetirementYear,
        cashflowFromYear: vm.cashflowFromYear,
        drawdownByMethod: vm.drawdownByMethod,
        activeRepresentativeRun: vm.activeRepresentativeRun,
        isMcBasisActive: vm.isMcBasisActive,
        viewDeflator: vm.viewDeflator,
        realDeflator,
        yearlyCashflowByYear: vm.incomeView?.yearlyCashflowByYear ?? null,
        drawdownEndYear: vm.incomeView?.drawdownEndYear ?? null,
        depletionYear: vm.incomeView?.depletionYear ?? null,
        resolvedDrawdownYears: vm.resolvedDrawdown?.years ?? null,
        sourceSplitByYear,
        primaryRetirementIso,
      }),
    [
      displayMode,
      activeMethod,
      activeMcBasis,
      vm.enabledCalculatedMethods,
      vm.primaryRetirementYear,
      vm.cashflowFromYear,
      vm.drawdownByMethod,
      vm.activeRepresentativeRun,
      vm.isMcBasisActive,
      vm.viewDeflator,
      realDeflator,
      vm.incomeView,
      vm.resolvedDrawdown,
      sourceSplitByYear,
      primaryRetirementIso,
    ],
  );
}
