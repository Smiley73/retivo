/** Per-account breakdown section shell: composes the breakdown and year-by-year table sub-sections, and hosts the shared yearly types, computeMethodTotal and buildYearlyChartRows that ~ten modules (including lib/pdf-export) read. */
import React from 'react';
import { type DisplayMode } from '../lib/view-deflator';
import { BalanceProjectionYearlyBreakdown } from './balance-projection-page-yearly-breakdown';
import { BalanceProjectionYearlyTable } from './balance-projection-page-yearly-table';
import type {
  ProjectionMethod,
  ProjectionChartRow,
} from '../components/ProjectionChart';
import type { ProjectionOutput } from '../lib/projection';
import type { AccountPayload, Aggregate } from '../db/types';
import {
  CARD_SECTION_CLASS,
  METHOD_ORDER,
} from './balance-projection-page-constants';

export interface YearlyTableRow {
  readonly year: number;
  readonly isCashflowYear: boolean;
  readonly balanceByMethod: Record<ProjectionMethod, number | null>;
  readonly earned: number | null;
  readonly withdrawal: number | null;
  readonly totalIncome: number | null;
  readonly expenses: number | null;
  readonly shortfall: number | null;
  readonly gains: number | null;
  readonly gainsBreakdown: { readonly growth: number; readonly income: number } | null;
  /** Positive dollars; 0 = no breach. Drew from pre-tax after taxable was depleted. */
  readonly magiCapBreachDollars?: number;
  /** Positive dollars routed from pre-tax to taxable in a later tier to honor the cap; 0 = no override. */
  readonly magiCapTierOverrideDollars?: number;
  /** Fill-mode conversion to the target Roth in display dollars; an internal transfer, not income. */
  readonly rothConverted?: number;
}

export interface BreakdownAccountRow {
  readonly account: Aggregate<AccountPayload>;
  readonly ownerDisplay: string;
  readonly ownerRetirementDate: string | null;
  readonly latestBalance: number | null;
  readonly outputs: Record<ProjectionMethod, ProjectionOutput | null>;
  readonly hasInsufficientHistory: boolean;
  readonly ratePctByMethod: Record<ProjectionMethod, number | null>;
  readonly perMonthContribution: { readonly preTax: number; readonly postTax: number };
}

export interface BalanceProjectionMethodTotal {
  readonly total: number;
  /** Accounts included at their planned rate because they lack ≥2 yr of empirical history; drives the totals-card footnote. */
  readonly plannedRateCount: number;
}

export interface BalanceProjectionYearlyProps {
  readonly accountRows: ReadonlyArray<BreakdownAccountRow>;
  readonly activeMethod: ProjectionMethod;
  readonly displayedTotals: Record<ProjectionMethod, BalanceProjectionMethodTotal> | null;
  /** The MC engine runs one pooled portfolio, so an MC basis replaces the per-account table with an explanatory note. */
  readonly isMcBasisActive: boolean;
  readonly hiddenInactiveCount: number;
  readonly hiddenZeroHistoryCount: number;
  readonly primaryRetirementYear: number | null;
  readonly viewDeflator: (year: number, monthIndex?: number) => number;
  readonly breakdownTableOpen: boolean;
  readonly onToggleBreakdownTable: () => void;
  readonly yearTableOpen: boolean;
  readonly onToggleYearTable: () => void;
  readonly yearTableRows: ReadonlyArray<YearlyTableRow>;
  readonly displayMode: DisplayMode;
  readonly magiCapBreachYears?: ReadonlyArray<number>;
  /** False hides the always-empty Cap column. */
  readonly isMagiCapActive?: boolean;
}

export const BalanceProjectionYearlySection: React.FC<BalanceProjectionYearlyProps> = ({
  accountRows,
  activeMethod,
  displayedTotals,
  isMcBasisActive,
  hiddenInactiveCount,
  hiddenZeroHistoryCount,
  primaryRetirementYear,
  viewDeflator,
  breakdownTableOpen,
  onToggleBreakdownTable,
  yearTableOpen,
  onToggleYearTable,
  yearTableRows,
  displayMode,
  magiCapBreachYears,
  isMagiCapActive = false,
}) => {
  return (
    <section className={CARD_SECTION_CLASS} aria-label="Per-account breakdown">
      <BalanceProjectionYearlyBreakdown
        accountRows={accountRows}
        activeMethod={activeMethod}
        displayedTotals={displayedTotals}
        isMcBasisActive={isMcBasisActive}
        hiddenInactiveCount={hiddenInactiveCount}
        hiddenZeroHistoryCount={hiddenZeroHistoryCount}
        primaryRetirementYear={primaryRetirementYear}
        viewDeflator={viewDeflator}
        breakdownTableOpen={breakdownTableOpen}
        onToggleBreakdownTable={onToggleBreakdownTable}
      />

      <BalanceProjectionYearlyTable
        activeMethod={activeMethod}
        yearTableOpen={yearTableOpen}
        onToggleYearTable={onToggleYearTable}
        yearTableRows={yearTableRows}
        displayMode={displayMode}
        magiCapBreachYears={magiCapBreachYears}
        isMagiCapActive={isMagiCapActive}
      />
    </section>
  );
};

/** Aggregates a method's per-account totals; a non-CBP account lacking ≥2 yr of history is included at its planned rate and counted in plannedRateCount for the disclosure. */
export function computeMethodTotal(
  rows: ReadonlyArray<BreakdownAccountRow>,
  method: ProjectionMethod,
): BalanceProjectionMethodTotal {
  let total = 0;
  let plannedRateCount = 0;
  for (const row of rows) {
    const out = row.outputs[method];
    if (!out) continue;
    total += out.total;
    if (method !== 'planned' && row.hasInsufficientHistory) {
      plannedRateCount += 1;
    }
  }
  return { total, plannedRateCount };
}

export function buildYearlyChartRows(
  rows: ReadonlyArray<BreakdownAccountRow>,
  primaryRetirementYear: number | null,
  primaryRetirementFractional: number | null,
): ProjectionChartRow[] {
  const yearSet = new Set<number>();
  for (const row of rows) {
    for (const m of METHOD_ORDER) {
      const out = row.outputs[m];
      if (!out) continue;
      for (const yt of out.yearlyTotals) yearSet.add(yt.year);
    }
  }
  const years = [...yearSet].sort((a, b) => a - b);
  const chartRows: ProjectionChartRow[] = years.map((year) => {
    const sum = (method: ProjectionMethod): number | null => {
      let acc = 0;
      let any = false;
      for (const row of rows) {
        const out = row.outputs[method];
        if (!out || out.yearlyTotals.length === 0) continue;
        const exact = out.yearlyTotals.find((y) => y.year === year);
        if (exact) {
          acc += exact.preTax + exact.postTax;
        } else {
          const first = out.yearlyTotals[0];
          if (year < first.year) {
            // Before the account's first projected year, use the historical ending balance, not the terminal value (avoids a spike).
            acc += row.latestBalance ?? 0;
          } else {
            const last = out.yearlyTotals[out.yearlyTotals.length - 1];
            acc += last.preTax + last.postTax;
          }
        }
        any = true;
      }
      return any ? acc : null;
    };
    const route = (
      method: ProjectionMethod,
    ): { solid: number | null; dashed: number | null } => {
      const value = sum(method);
      if (value === null) return { solid: null, dashed: null };
      if (primaryRetirementYear === null) return { solid: value, dashed: null };
      if (year === primaryRetirementYear) return { solid: null, dashed: value };
      return { solid: value, dashed: null };
    };
    const growthSum = (method: ProjectionMethod): number | null => {
      let acc = 0;
      let any = false;
      for (const row of rows) {
        const out = row.outputs[method];
        if (!out) continue;
        const exact = out.yearlyTotals.find((y) => y.year === year);
        if (!exact) continue;
        acc += exact.growth;
        any = true;
      }
      return any ? acc : null;
    };
    const planned = route('planned');
    const twr = route('twr');
    return {
      year,
      // Year-end Y plots at X = Y + 1 so integer ticks read as calendar boundaries.
      x: year + 1,
      plannedSolid: planned.solid,
      plannedDashed: planned.dashed,
      twrSolid: twr.solid,
      twrDashed: twr.dashed,
      plannedGrowth: growthSum('planned'),
      twrGrowth: growthSum('twr'),
    };
  });

  if (
    primaryRetirementYear !== null &&
    primaryRetirementFractional !== null &&
    chartRows.length > 0
  ) {
    const snapshotSum = (method: ProjectionMethod): number | null => {
      let acc = 0;
      let any = false;
      for (const row of rows) {
        const out = row.outputs[method];
        if (!out || out.yearlyTotals.length === 0) continue;
        const finalYt = out.yearlyTotals[out.yearlyTotals.length - 1];
        const snap = finalYt?.retirementSnapshot;
        if (snap) {
          acc += snap.preTax + snap.postTax;
          any = true;
        }
      }
      return any ? acc : null;
    };
    const planned = snapshotSum('planned');
    const twr = snapshotSum('twr');
    if (planned !== null || twr !== null) {
      const retirementMonthIndex = Math.max(
        0,
        Math.min(
          11,
          Math.floor((primaryRetirementFractional - primaryRetirementYear) * 12),
        ),
      );
      chartRows.push({
        year: primaryRetirementYear,
        x: primaryRetirementFractional,
        valueMonthIndex: retirementMonthIndex,
        plannedSolid: planned,
        plannedDashed: planned,
        twrSolid: twr,
        twrDashed: twr,
        plannedGrowth: null,
        twrGrowth: null,
      });
      chartRows.sort((a, b) => a.x - b.x);
    }
  }

  return chartRows;
}
