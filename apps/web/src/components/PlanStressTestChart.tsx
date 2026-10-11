/**
 * Plan stress-test fan chart + percentile data table, extracted from
 * `PlanStressTestSection.tsx` to keep that file under the shape limit.
 *
 * Pure presentation over the shared `PlanStressTestVm`: renders the
 * Monte Carlo fan section, a toggleable yearly-percentile data table,
 * and the CBP remediation banner when the active scenario fails CBP
 * validation. No engine access — reads only off the
 * resolved `vm`.
 *
 * Also hosts the market-stress comparison fan
 * (`PlanStressTestStressFanChart`): the same fan component over a STRESSED
 * run's summary, so a stressed outcome band is read on the same terms as the
 * base band above it.
 *
 * Re-exported from `PlanStressTestSection.tsx` so existing importers and
 * the section's test suite keep their import paths unchanged.
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

/** Fan chart + toggleable percentile data table. Empty when there are
 *  no accounts or no result yet. */
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
          {/* Always mounted (inside the `result &&` guard so the table never
              mounts without a result) but `display:none`/out of the a11y tree
              when collapsed: print reveals only
              `.bp-print-expand[hidden]`. */}
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
  /** Plain-English name of the stress being plotted (e.g. "Higher fees"). */
  readonly caseName: string;
  /** The stressed run's summary. Same seed and path count as the base run, so
   *  the two fans are drawn from the SAME simulated market histories. */
  readonly stressResult: MonteCarloSummary;
  readonly vm: PlanStressTestVm;
  /** True for the longevity-bearing cases, whose extra years draw FRESH months
   *  — the same-paths claim then holds only through the original end of the
   *  plan and the note has to say so. */
  readonly extendsHorizon?: boolean;
  /** Y-axis scale, threaded from the page so the stressed fan is drawn on the
   *  same axis as the base fan above it. */
  readonly yScale?: 'linear' | 'log';
}

/**
 * Percentile fan for ONE stressed run, drawn with the same chart
 * component, display mode, and y-axis scale as the base fan above it, so the
 * two are read on like-for-like terms. The stress reuses the base run's seed
 * and path count, so any difference between the two fans is the changed
 * assumption, not a different draw.
 *
 * Markers carry over too, with ONE exception: a horizon-EXTENDING case plots no
 * life-expectancy markers, because they mark the BASE run's death years and the
 * fan deliberately runs past them (`extendsHorizon` below).
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
        // `vm.lifeMarkers` are the BASE run's projected death years. On a
        // horizon-EXTENDING case the fan deliberately runs past them, so
        // plotting them would draw a member's death marker with years of
        // portfolio band beyond it — the chart contradicting the very stress it
        // illustrates. The note below says the markers are left off.
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
