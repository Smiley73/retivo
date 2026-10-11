/**
 * Working-years analysis panel. Shows the bracket headroom, the
 * BETR for all four tax-payment-source variants, a convert/hold verdict per
 * source, the bracket-fill Convert tranche total, and the whole-dollar
 * `preRetirementTaxableIncomeDollars` entry field.
 *
 * BETR-only (no all-in rate) — SS income and full MAGI are not available for
 * pre-retirement years. When taxable income is absent the panel renders a
 * needs-input state, not 0 headroom.
 */
import React from 'react';
import { Card } from '../../components/Card';
import { MoneyInput } from '../../components/MoneyInput';
import { Alert } from '../../components/Alert';
import { StatGrid, Stat } from '../../components/StatGrid';
import { formatCurrency } from '../../lib/format-currency';
import { formatPercent } from '../../components/PercentInput';
import {
  computeBETR,
  DEFAULT_DRAG_BY_SOURCE,
  DEFAULT_IRA_GROWTH_RATE,
  type BETRSource,
  type WorkingYearsBETRSummary,
} from '../../lib/betr-calculator';
import { comparisonLabel, BETR_SOURCE_LABELS } from './betr-presentation-shared';

interface WorkingYearsPanelProps {
  summary: WorkingYearsBETRSummary;
  /** Current entered taxable income (whole dollars), or undefined when unset. */
  taxableIncomeDollars: number | undefined;
  onTaxableIncomeChange: (next: number) => void;
  /** Years to retirement (the n in the from-outside BETR opportunity-cost term). */
  yearsToRetirement: number;
  /** Commit the draft taxable income (blur-commit — one save per edit). */
  onTaxableIncomeCommit: () => void;
  /** The page-selected tax-payment source — the slider drag applies to it only. */
  source: BETRSource;
  dragPct: number;
  /** When set, at least one penalty-carrying convertible-source owner is still
   *  under 59½ (their 59½ year `>= currentCalendarYear`), so the "Pay tax from
   *  the IRA" row shows a before→after-59½ break-even split naming `firstName`.
   *  Undefined → the row renders as a single unpenalized value (today's behavior). */
  iraOwnerBoundary?: { year: number; firstName: string };
}

/** Drag fraction for one source row: the user's slider for the SELECTED taxable
 *  variant, the Vanguard per-source default otherwise so taxEfficient (10%) and
 *  taxInefficient (25%) stay distinct at the default slider. */
function dragForSource(rowSource: BETRSource, selected: BETRSource, dragPct: number): number {
  if (rowSource === selected && (rowSource === 'taxEfficient' || rowSource === 'taxInefficient')) {
    return dragPct / 100;
  }
  return DEFAULT_DRAG_BY_SOURCE[rowSource];
}

/** The from-IRA "before 59½ → after 59½" two-verdict break-even cell. The
 *  "before" half carries the 10% early-withdrawal penalty; the "after" half is
 *  the plain unpenalized rate. Mirrors the transition-cell a11y idiom
 *  (`aria-hidden` arrow + `sr-only " to "`, ss-optimizer-age-cell.tsx) so screen
 *  readers announce "X to Y". Built inline (no shared-primitive extraction) —
 *  both halves need a verdict, which the baseline-only MetricTransition lacks. */
const IraPenaltySplitCell: React.FC<{
  tNow: number;
  yearsToRetirement: number;
  afterBetr: number;
  afterVerdict: 'Convert' | 'Hold';
  tFuture: number;
}> = ({ tNow, yearsToRetirement, afterBetr, afterVerdict, tFuture }) => {
  const beforeBetr = computeBETR('ira', tNow, yearsToRetirement, DEFAULT_IRA_GROWTH_RATE, {
    under59Penalty: true,
  });
  const beforeVerdict = tFuture > beforeBetr ? 'Convert' : 'Hold';
  return (
    <span className="whitespace-nowrap font-mono tabular-nums text-muted">
      <span className="text-muted/80">
        {formatPercent(beforeBetr * 100)} · {comparisonLabel(beforeVerdict)} (before 59½)
      </span>
      <span aria-hidden="true" className="mx-1">
        →
      </span>
      <span className="sr-only"> to </span>
      {formatPercent(afterBetr * 100)} · {comparisonLabel(afterVerdict)} (after 59½)
    </span>
  );
};

export const WorkingYearsPanel: React.FC<WorkingYearsPanelProps> = ({
  summary,
  taxableIncomeDollars,
  onTaxableIncomeChange,
  yearsToRetirement,
  onTaxableIncomeCommit,
  source,
  dragPct,
  iraOwnerBoundary,
}) => {
  const needsInput = taxableIncomeDollars === undefined;
  // Representative marginal rate for the four-source BETR display = the first
  // bracket-fill tranche's T_now (the rate at the user's current income). Falls
  // back to 0 in the needs-input state.
  const tNow = summary.tranches[0]?.T_now ?? 0;

  return (
    <Card>
      <h2 className="mb-3 text-lg font-semibold text-ink">Working years</h2>
      <div className="max-w-xs">
        <MoneyInput
          variant="form"
          id="betr-taxable-income"
          label="Your current taxable income (after deductions)"
          value={taxableIncomeDollars ?? 0}
          onChange={onTaxableIncomeChange}
          onBlur={onTaxableIncomeCommit}
          decimals={0}
          allowNegative={false}
        />
      </div>
      <p className="mb-4 text-xs text-muted">
        Your current taxable income is user-entered; the modeled rate is derived
        from the tax brackets — update it if your income changes.
      </p>

      {needsInput ? (
        <Alert tone="info">
          Enter your current taxable income above to see your bracket headroom and
          a bracket-fill conversion amount.
        </Alert>
      ) : (
        <>
          <StatGrid>
            <Stat
              label="Bracket headroom"
              value={formatCurrency(summary.bracketHeadroomCents / 100)}
            />
            <Stat
              label="Bracket-fill conversion (below break-even)"
              value={formatCurrency(summary.convertTotalCents / 100)}
            />
            <Stat
              label="Future RMD-era rate"
              value={formatPercent(summary.T_future * 100)}
            />
          </StatGrid>

          <h3 className="mb-2 mt-4 text-sm font-semibold text-ink">
            Break-even rate by where you pay the tax
          </h3>
          <ul className="flex flex-col gap-1.5">
            {BETR_SOURCE_LABELS.map(({ source: rowSource, label }) => {
              const betr = computeBETR(rowSource, tNow, yearsToRetirement, DEFAULT_IRA_GROWTH_RATE, {
                dragPct: dragForSource(rowSource, source, dragPct),
              });
              const verdict = summary.T_future > betr ? 'Convert' : 'Hold';
              const showIraSplit = rowSource === 'ira' && iraOwnerBoundary !== undefined;
              return (
                <li
                  key={rowSource}
                  className="flex items-center justify-between gap-3 text-sm"
                >
                  <span className="text-ink">{label}</span>
                  {showIraSplit ? (
                    <IraPenaltySplitCell
                      tNow={tNow}
                      yearsToRetirement={yearsToRetirement}
                      afterBetr={betr}
                      afterVerdict={verdict}
                      tFuture={summary.T_future}
                    />
                  ) : (
                    <span className="font-mono tabular-nums text-muted">
                      {formatPercent(betr * 100)} · {comparisonLabel(verdict)}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {iraOwnerBoundary !== undefined && (
            <p className="mt-2 text-xs text-muted">
              Before 59½, withholding the conversion tax from the IRA (including{' '}
              {iraOwnerBoundary.firstName}) is itself an early withdrawal and adds a
              10% penalty to that tax — so the &ldquo;before 59½&rdquo; break-even is
              higher. Paying the tax from cash or a taxable account avoids it. The
              modeled amount assumes the tax is paid from outside funds, so the written
              conversion is unpenalized regardless of the from-IRA rate shown here.
              If you qualify for a §72(t) exception (SEPP or disability — the
              age-55 separation-from-service exception does not apply to IRAs),
              mark that account exempt in the Tax-assumptions settings to hide
              this split.
            </p>
          )}
        </>
      )}
    </Card>
  );
};
