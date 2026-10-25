/**
 * Plan stress-test fan chart, percentile data table and CBP remediation banner, plus the market-stress comparison
 * fan. Re-exported from `PlanStressTestSection.tsx`.
 */
import {
  Cell,
  Column,
  Row,
  Table,
  TableBody,
  TableHeader,
} from 'react-aria-components';
import { MonteCarloFanSection } from './monte-carlo-fan-section';
import { CbpRemediationBanner } from './CbpRemediationBanner';
import { TableScroll } from './TableScroll';
import { formatCurrency } from '../lib/format-currency';
import { TABLE_CLASS, TD_NUM_CLASS } from './plan-stress-test-chrome';
import { btnSecondarySmClass } from './dialog-chrome';
import {
  thStickyClass,
  thStickyNumClass,
} from '../pages/accounts-page-chrome';
import type { MonteCarloSummary } from '../lib/monte-carlo-types';
import type { PlanStressTestVm } from './PlanStressTestSection';

export interface PlanStressTestChartProps {
  vm: PlanStressTestVm;
  yScale?: 'linear' | 'log';
  dataTableOpen: boolean;
  onToggleDataTable: () => void;
}

/** Fan chart with a toggleable percentile data table; empty without accounts or a result. */
export function PlanStressTestChart({
  vm,
  yScale = 'linear',
  dataTableOpen,
  onToggleDataTable,
}: PlanStressTestChartProps) {
  if (vm.hasNoAccounts) return null;
  if (vm.cbpValidation && !vm.cbpValidation.ok) {
    return (
      <CbpRemediationBanner
        validation={vm.cbpValidation}
        accounts={vm.cbpAccounts}
        members={vm.cbpMembers}
      />
    );
  }
  const { result } = vm;
  const busy = vm.isStale || vm.isRunning;
  return (
    <div
      className={`flex flex-col gap-3 transition-opacity duration-150 ${
        busy ? 'opacity-50' : 'opacity-100'
      } ${vm.isRunning ? 'pointer-events-none' : ''}`}
      aria-busy={busy}
    >
      {result && (
        <MonteCarloFanSection
          result={result}
          real={vm.displayMode === 'today'}
          retirementYear={vm.retirementFractionalYear}
          retirementLabel={vm.retirementLabel}
          lifeMarkers={vm.lifeMarkers}
          yScale={yScale}
        />
      )}
      {result && (
        <>
          <button
            type="button"
            className={`report-print-hide self-start ${btnSecondarySmClass}`}
            aria-expanded={dataTableOpen}
            onClick={onToggleDataTable}
          >
            {dataTableOpen ? 'Hide stress-test data table' : 'Show stress-test data table'}
          </button>
          {/* Always mounted so print can reveal `.bp-print-expand[hidden]`, but out of the a11y
              tree when collapsed. */}
          <div hidden={!dataTableOpen} className="bp-print-expand">
            <TableScroll label="Plan stress-test yearly outcomes">
              <Table
                className={TABLE_CLASS}
                aria-label="Plan stress-test yearly outcomes"
              >
                <TableHeader>
                  <Column isRowHeader className={thStickyClass}>Year</Column>
                  <Column className={thStickyNumClass}>Bad-luck</Column>
                  <Column className={thStickyNumClass}>Pessimistic</Column>
                  <Column className={thStickyNumClass}>Typical</Column>
                </TableHeader>
                <TableBody>
                  {(() => {
                    const p =
                      vm.displayMode === 'today'
                        ? result.percentilesReal
                        : result.percentilesNominal;
                    return p.p50.map((_, i) => {
                      const y = result.firstYear + i;
                      return (
                        <Row key={y} id={String(y)}>
                          <Cell className={TD_NUM_CLASS}>{y}</Cell>
                          <Cell className={TD_NUM_CLASS}>{formatCurrency(p.p10[i])}</Cell>
                          <Cell className={TD_NUM_CLASS}>{formatCurrency(p.p25[i])}</Cell>
                          <Cell className={TD_NUM_CLASS}>{formatCurrency(p.p50[i])}</Cell>
                        </Row>
                      );
                    });
                  })()}
                </TableBody>
              </Table>
            </TableScroll>
          </div>
        </>
      )}
    </div>
  );
}

export interface PlanStressTestStressFanChartProps {
  readonly caseName: string;
  /** The stressed run's summary, drawn from the same simulated histories as the base run. */
  readonly stressResult: MonteCarloSummary;
  readonly vm: PlanStressTestVm;
  /**
   * True for longevity cases whose extra years draw fresh months, so the same-paths note holds only
   * through the original plan end.
   */
  readonly extendsHorizon?: boolean;
  /** Y-axis scale, so the stressed fan shares the base fan's axis. */
  readonly yScale?: 'linear' | 'log';
}

/**
 * Percentile fan for one stressed run, on the same chart, display mode and y-axis scale as the base
 * fan.
 */
export function PlanStressTestStressFanChart({
  caseName,
  stressResult,
  vm,
  extendsHorizon = false,
  yScale = 'linear',
}: PlanStressTestStressFanChartProps) {
  const headingId = 'stress-comparison-fan-heading';
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h4 id={headingId} className="m-0 text-sm font-semibold text-ink">
        Outcomes with {caseName.toLowerCase()}
      </h4>
      <MonteCarloFanSection
        result={stressResult}
        real={vm.displayMode === 'today'}
        retirementYear={vm.retirementFractionalYear}
        retirementLabel={vm.retirementLabel}
        // A horizon-extending case runs past the base run's death years, so those markers are left
        // off.
        lifeMarkers={extendsHorizon ? [] : vm.lifeMarkers}
        yScale={yScale}
      />
      <p className="m-0 text-sm text-muted">
        Same simulated market histories as the chart above, with {caseName.toLowerCase()}{' '}
        applied.
        {extendsHorizon
          ? ' The added years past the original end of your plan use fresh market draws. Life expectancy markers are left off, because this comparison runs past the ages they mark.'
          : ''}
      </p>
    </section>
  );
}
