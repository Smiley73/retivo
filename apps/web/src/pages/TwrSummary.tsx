import React from 'react';
import { formatCurrency } from '../lib/format-currency';
import { formatPercent } from '../components/PercentInput';
import { StatGrid, Stat } from '../components/StatGrid';
import type { BalanceRow } from './AccountBalancesPage';
import { valueNegativeClass, valuePositiveClass } from './accounts-page-chrome';

function calcTwr(rows: BalanceRow[]): number {
  if (rows.length === 0) return 0;
  const product = rows.reduce((acc, b) => acc * (1 + b.returnPct / 100), 1);
  return (Math.pow(product, 1 / rows.length) - 1) * 100;
}

function calcTotalGainLoss(rows: BalanceRow[]): number {
  if (rows.length === 0) return 0;
  const sorted = [...rows].sort((a, b) => a.year - b.year);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const totalContrib = sorted.reduce((sum, b) => sum + b.totalContributions, 0);
  const totalRollovers = sorted.reduce((sum, b) => sum + b.rollover, 0);
  const totalDistributions = sorted.reduce((sum, b) => sum + b.distributions, 0);
  return (
    last.endingBalance -
    first.startingBalance -
    totalContrib -
    totalRollovers +
    totalDistributions
  );
}

interface TwrSummaryProps {
  rows: BalanceRow[];
  isMixed: boolean;
}

export const TwrSummary: React.FC<TwrSummaryProps> = ({ rows, isMixed }) => {
  const sorted = [...rows].sort((a, b) => a.year - b.year);
  const latest = sorted[sorted.length - 1];
  const totalGainLoss = calcTotalGainLoss(rows);
  const twr = calcTwr(rows);
  const totalContributionsAll = rows.reduce(
    (sum, b) => sum + b.totalContributions,
    0,
  );
  const latestPreTax = latest.endingBalancePreTax ?? 0;
  const latestPostTax = latest.endingBalancePostTax ?? 0;
  const totalEnding = latest.endingBalance;
  const preTaxPct = totalEnding > 0 ? (latestPreTax / totalEnding) * 100 : 0;
  const postTaxPct = totalEnding > 0 ? (latestPostTax / totalEnding) * 100 : 0;
  const negPos = (n: number) =>
    n < 0 ? valueNegativeClass : valuePositiveClass;
  return (
    <div className="mb-5" aria-label="Balance summary">
      <StatGrid cols="four">
        <Stat
          label="Contributions"
          value={formatCurrency(totalContributionsAll)}
        />
        <Stat
          label="Current Balance"
          value={formatCurrency(totalEnding)}
        />
        <Stat
          label="Gain/Loss"
          value={
            <span className={negPos(totalGainLoss)}>
              {formatCurrency(totalGainLoss)}
            </span>
          }
        />
        <Stat
          label="Ann. Return"
          value={<span className={negPos(twr)}>{formatPercent(twr)}</span>}
        />
        {isMixed && (
          <>
            <Stat
              label="Pre-Tax Balance"
              value={formatCurrency(latestPreTax)}
            />
            <Stat label="Pre-Tax %" value={formatPercent(preTaxPct)} />
            <Stat
              label="Post-Tax Balance"
              value={formatCurrency(latestPostTax)}
            />
            <Stat label="Post-Tax %" value={formatPercent(postTaxPct)} />
          </>
        )}
      </StatGrid>
    </div>
  );
};
