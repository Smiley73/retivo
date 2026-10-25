/** Adapts the page's already-built view model onto balance-projection-swr-derivation; it mounts no view model and starts no Monte Carlo run.
* The per-source income split (sourceSplitByYear) is not on the vm, so it comes from a second buildPageCashflowSeries call with the same inputs as the page's cashflowSeries memo. */
import { useMemo } from 'react';
import type { Aggregate, ExpensePayload, IncomeStreamPayload, SocialSecurityBenefitPayload } from '../db/types';
import type { ProjectionMethod } from '../components/ProjectionChart';
import type { DisplayMode } from '../lib/view-deflator';
import type { SwrComparisonResult } from '../lib/safe-withdrawal-rate-chart-types';
import { buildViewDeflatorForExport } from './balance-projection-view-derivation';
import type { McBasis } from '../lib/monte-carlo';
import { buildPageCashflowSeries } from './balance-projection-page-cashflow';
import type { PipelineData } from './balance-projection-page-data';
import { buildSwrComparisonData } from './balance-projection-swr-derivation';
import type { BalanceProjectionViewModel } from './use-balance-projection-view-model';

export interface UseBalanceProjectionSwrDataInput {
  readonly data: PipelineData | null;
  /** The page's own view model; a second useBalanceProjectionViewModel() call would duplicate the Monte Carlo run. */
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

  // Always Today's dollars: vm.viewDeflator collapses to the identity under Future dollars, leaving the rule figures no real basis to inflate from.
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
