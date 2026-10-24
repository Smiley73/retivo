/** Yearly section chart bands: "Expected cashflow", "Income breakdown" and "Annual Portfolio Flow". */
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
  /** Income-breakdown sources are planned inputs that don't vary with market luck, so its title always names the deterministic method, even under an MC basis. */
  readonly methodLabel: string;
  readonly resolvedLabel: string;
  readonly cashflowGranularity: CashflowGranularity;
  readonly onGranularityChange: (g: CashflowGranularity) => void;
  readonly incomeBreakdownGranularity: CashflowGranularity;
  readonly onIncomeBreakdownGranularityChange: (g: CashflowGranularity) => void;
  readonly cashflowChartRows: ReadonlyArray<CashflowMonthlyPoint>;
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
