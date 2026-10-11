/**
 * Balance Projection page — per-account breakdown section shell. Composes
 * the per-account breakdown sub-section (`-yearly-breakdown.tsx`) and the
 * year-by-year table sub-section (`-yearly-table.tsx`) inside the "Per-account
 * breakdown" card. Also the home of the shared yearly types +
 * `computeMethodTotal` + `buildYearlyChartRows` — kept here rather than
 * relocated, since they are read by ~ten modules including the view-model
 * hook, `balance-projection-page-data.ts`, and `lib/pdf-export/*`. The three
 * retirement bands (Expected cashflow / Income breakdown / Annual Portfolio
 * Flow) that used to render alongside this card live in the sibling
 * `balance-projection-page-yearly-bands.tsx` — split out because each
 * half belongs to a different future view. The breakdown table + year-by-year
 * `<TableScroll>` were split into siblings to keep this file
 * under the shape cap.
 */
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
  /**
   * MAGI cap breached this year — drew from pre-tax to cover spending
   * after taxable was depleted. Positive dollar amount; 0 = no breach.
   */
  readonly magiCapBreachDollars?: number;
  /**
   * MAGI cap routed dollars from pre-tax to taxable in a later tier
   * to honor the cap. Positive dollar amount; 0 = no override.
   */
  readonly magiCapTierOverrideDollars?: number;
  /**
   * Dollars converted from pre-tax to the target Roth this year under
   * the income cap's Fill mode. Already deflated to the display basis.
   * Positive = a conversion ran; 0 / absent = none (Minimize, no cap, or an
   * RMD-breach year). An internal transfer, NOT income.
   */
  readonly rothConverted?: number;
}

export interface BreakdownAccountRow {
  readonly account: Aggregate<AccountPayload>;
  readonly ownerDisplay: string;
  readonly ownerRetirementDate: string | null;
  readonly latestBalance: number | null;
  readonly outputs: Record<ProjectionMethod, ProjectionOutput | null>;
  readonly hasInsufficientHistory: boolean;
  /** Per-account expected return rate (percent) per projection method.
   *  Each account compounds at its own rate through the drawdown
   *  horizon (per-account engine). */
  readonly ratePctByMethod: Record<ProjectionMethod, number | null>;
  /** Per-month (preTax, postTax) contribution amount for this account.
   *  Used to synthesize post-primary-retirement contribution deposits
   *  for individual accounts whose owner retires AFTER primary. */
  readonly perMonthContribution: { readonly preTax: number; readonly postTax: number };
}

export interface BalanceProjectionMethodTotal {
  readonly total: number;
  /** Count of accounts INCLUDED in this method's total at
   *  their PLANNED rate because they lack ≥2 yr of empirical history (the
   *  Historical view's per-account fallback). Drives the totals-card
   *  disclosure footnote. `0` for the Planned method (always empirical-
   *  agnostic) and when every account has empirical history. Was the prior
   *  "excluded from total" count before the exclusion was reversed. */
  readonly plannedRateCount: number;
}

export interface BalanceProjectionYearlyProps {
  readonly accountRows: ReadonlyArray<BreakdownAccountRow>;
  readonly activeMethod: ProjectionMethod;
  readonly displayedTotals: Record<ProjectionMethod, BalanceProjectionMethodTotal> | null;
  /** When an MC basis is the resolved basis, the per-account breakdown
   *  table is replaced by an explanatory note (the MC engine runs a single
   *  pooled portfolio, so there is no per-account MC counterpart to the
   *  deterministic projected-at-retirement balances). */
  readonly isMcBasisActive: boolean;
  readonly hiddenInactiveCount: number;
  readonly hiddenZeroHistoryCount: number;
  readonly primaryRetirementYear: number | null;
  readonly viewDeflator: (year: number, monthIndex?: number) => number;
  /** Per-account breakdown table disclosure — collapsed by default like
   *  the year-by-year table. */
  readonly breakdownTableOpen: boolean;
  readonly onToggleBreakdownTable: () => void;
  readonly yearTableOpen: boolean;
  readonly onToggleYearTable: () => void;
  readonly yearTableRows: ReadonlyArray<YearlyTableRow>;
  readonly displayMode: DisplayMode;
  /**
   * Years where the MAGI cap was breached. Used to render the
   * "Cap breached in N years" Alert banner above the table.
   */
  readonly magiCapBreachYears?: ReadonlyArray<number>;
  /**
   * When false (no MAGI cap configured), hide the Cap column
   * from the year table to avoid showing an always-empty column.
   */
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
  // The per-account breakdown + year-by-year tables remain together in the
  // "Per-account breakdown" card (they are tables, not graphs); the three
  // chart bands that used to render as siblings here now live in
  // `balance-projection-page-yearly-bands.tsx` (01).
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

/**
 * Aggregate a method's per-account `out.total` into a household-wide
 * `MethodTotal`. Per-account compounding replaces the legacy
 * balance-weighted blended-rate footnote.
 *
 * Under the Historical (TWR) method a non-CBP account that
 * lacks ≥2 yr of empirical history is INCLUDED in the total at its planned
 * rate (the runner fills `outputs.twr` with the planned projection), not
 * excluded. `plannedRateCount` counts those mixed-basis accounts so the
 * totals card can disclose them. A row with no `outputs[method]` at all
 * (e.g. a zero-portfolio account) contributes nothing and is not counted.
 */
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

/**
 * Build the chart's deterministic-projection row set (pre-retirement
 * accumulation; the runner / drawdown engine extends with the dashed
 * post-retirement segment). Mirrors BPP's prior in-page builder.
 */
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
            // Account's first projected year is later than this chart
            // year — fall back to the historical ending balance, NOT
            // the terminal retirement value (avoids the "2026 spike").
            acc += row.latestBalance ?? 0;
          } else {
            // Past the projection — freeze at terminal value.
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
      // Plot year-end-Y at chart X = Y + 1 so integer ticks read as
      // calendar boundaries.
      x: year + 1,
      plannedSolid: planned.solid,
      plannedDashed: planned.dashed,
      twrSolid: twr.solid,
      twrDashed: twr.dashed,
      plannedGrowth: growthSum('planned'),
      twrGrowth: growthSum('twr'),
    };
  });

  // Append the synthesized retirement-date snapshot row at the
  // fractional X position of primary's retirement date.
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
