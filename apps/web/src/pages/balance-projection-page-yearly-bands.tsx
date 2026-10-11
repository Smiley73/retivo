/**
 * Balance Projection page — yearly section chart bands: "Expected
 * cashflow", "Income breakdown", and "Annual Portfolio Flow", each of
 * which already cards itself. Split out of
 * `balance-projection-page-yearly.tsx` so that file can stay the
 * home of the shared yearly types (`YearlyTableRow`, `BreakdownAccountRow`,
 * `BalanceProjectionMethodTotal`) plus the "Per-account breakdown" card,
 * while this half composes into its own future view independently.
 */
import React from 'react';
import type {
  CashflowChartMarker,
  CashflowMonthlyPoint,
} from '../components/CashflowProjectionChart';
import type { IncomeBreakdownPoint } from '../components/IncomeBreakdownChart';
import type { CategoryMeta } from '../lib/category-palette';
import { type CashflowGranularity } from '../lib/view-deflator';
import type { TooltipMember } from '../components/tooltip-member';
import { YearlyCashflowBand } from './balance-projection-page-yearly-cashflow';
import { YearlyIncomeBreakdownBand } from './balance-projection-page-yearly-income-breakdown';
import { YearlyPortfolioFlowsBand } from './balance-projection-page-yearly-portfolio-flows';

export interface BalanceProjectionYearlyBandsProps {
  /** Human label for the active deterministic method (Planned / TWR), suffixed
   *  onto the Income-breakdown title — that chart's income sources are planned
   *  inputs that do not vary with market luck, so it always names the
   *  deterministic method even under an MC basis. */
  readonly methodLabel: string;
  /** Label of the basis the resolved drawdown reflects (the MC tier when a
   *  Monte Carlo basis is active, else `methodLabel`). Suffixed onto the
   *  Expected-cashflow + Annual-Portfolio-Flow titles so each names the basis
   *  driving it. */
  readonly resolvedLabel: string;
  readonly cashflowGranularity: CashflowGranularity;
  readonly onGranularityChange: (g: CashflowGranularity) => void;
  readonly incomeBreakdownGranularity: CashflowGranularity;
  readonly onIncomeBreakdownGranularityChange: (g: CashflowGranularity) => void;
  readonly cashflowChartRows: ReadonlyArray<CashflowMonthlyPoint>;
  /** Active expense categories for the cashflow "by category" toggle.
   *  Empty ⇒ the toggle is disabled (Total-only). */
  readonly categoryMeta: ReadonlyArray<CategoryMeta>;
  readonly breakdownChartRows: ReadonlyArray<IncomeBreakdownPoint>;
  readonly portfolioFlowsRows: ReadonlyArray<{
    readonly year: number;
    readonly contributions: number;
    readonly gains: number;
    readonly deposits: number;
    readonly withdrawals: number;
    readonly qcd: number;
    readonly netChange: number;
  }>;
  /** Retirement + life-expectancy markers (the canonical teal
   *  `Retires <Mon YYYY>` retirement line plus the death lines) shared
   *  by all three chart bands. */
  readonly chartMarkers: ReadonlyArray<CashflowChartMarker>;
  readonly tooltipMembers: ReadonlyArray<TooltipMember>;
  readonly depletionYear: number | null;
}

export const BalanceProjectionYearlyBands: React.FC<BalanceProjectionYearlyBandsProps> = ({
  methodLabel,
  resolvedLabel,
  cashflowGranularity,
  onGranularityChange,
  incomeBreakdownGranularity,
  onIncomeBreakdownGranularityChange,
  cashflowChartRows,
  categoryMeta,
  breakdownChartRows,
  portfolioFlowsRows,
  chartMarkers,
  tooltipMembers,
  depletionYear,
}) => (
  <>
    <YearlyCashflowBand
      cashflowGranularity={cashflowGranularity}
      onGranularityChange={onGranularityChange}
      cashflowChartRows={cashflowChartRows}
      chartMarkers={chartMarkers}
      tooltipMembers={tooltipMembers}
      depletionYear={depletionYear}
      methodLabel={resolvedLabel}
      categoryMeta={categoryMeta}
    />
    <YearlyIncomeBreakdownBand
      breakdownChartRows={breakdownChartRows}
      chartMarkers={chartMarkers}
      tooltipMembers={tooltipMembers}
      depletionYear={depletionYear}
      incomeBreakdownGranularity={incomeBreakdownGranularity}
      onGranularityChange={onIncomeBreakdownGranularityChange}
      methodLabel={methodLabel}
    />
    <YearlyPortfolioFlowsBand
      portfolioFlowsRows={portfolioFlowsRows}
      chartMarkers={chartMarkers}
      tooltipMembers={tooltipMembers}
      depletionYear={depletionYear}
      methodLabel={resolvedLabel}
    />
  </>
);
