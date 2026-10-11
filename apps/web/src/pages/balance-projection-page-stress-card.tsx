/**
 * Balance Projection page — "Stress-test outcomes" card: the Monte Carlo
 * plan-success chart, its data-table disclosure, and the market-stress
 * comparison beneath it. Extracted from `BalanceProjectionPage.tsx`
 * so the page stays a thin orchestration layer under the file shape cap.
 *
 * `yScale` is page state read by both the per-year projection chart and
 * this card's stress fan + market-stress comparison — it is threaded in
 * as a prop, not owned here, so the two surfaces cannot drift out of sync.
 * This card carries no running-status slot: the running progress bar (+
 * error toast) lives in the page header's controls toolbar next to the
 * title.
 */
import React from 'react';
import {
  PlanStressTestEmpty,
  PlanStressTestChart,
  PlanStressTestMarketStress,
  type PlanStressTestVm,
} from '../components/PlanStressTestSection';
import { ChartInfoPopover } from '../components/ChartInfoPopover';
import {
  CARD_SECTION_CLASS,
  SECTION_H2_CLASS,
} from './balance-projection-page-constants';

export interface BalanceProjectionStressCardProps {
  /** Rings the card while a Monte Carlo basis drives the screen, foregrounding
   *  the card that explains the scenario. */
  readonly mcActive: boolean;
  readonly stressVm: PlanStressTestVm;
  readonly yScale: 'linear' | 'log';
  readonly dataTableOpen: boolean;
  readonly onToggleDataTable: () => void;
}

export const BalanceProjectionStressCard: React.FC<BalanceProjectionStressCardProps> = ({
  mcActive,
  stressVm,
  yScale,
  dataTableOpen,
  onToggleDataTable,
}) => (
  <section
    className={
      mcActive
        ? `${CARD_SECTION_CLASS} ring-2 ring-accent ring-offset-2 ring-offset-surface`
        : CARD_SECTION_CLASS
    }
    aria-labelledby="stress-test-outcomes-heading"
  >
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-1.5">
        <h2 id="stress-test-outcomes-heading" className={SECTION_H2_CLASS}>
          Stress-test outcomes
        </h2>
        <ChartInfoPopover label="About the Stress-test outcomes chart">
          <p className="m-0">
            Today&apos;s-dollar outcome bands across thousands of randomly-sampled
            historical market paths. Surfaces sequence-of-returns risk the
            deterministic projection averages away.
          </p>
        </ChartInfoPopover>
      </div>
      {/* The running progress bar (+ error toast) now lives in the page
          header's controls toolbar next to the title — the running
          state swaps the Recalculate button for the progress bar there, so
          this card no longer carries a status slot. */}
    </div>
    {stressVm.error && !stressVm.result && (
      /* Print-only: the on-screen error toast lives in the page-header
         controls toolbar (report-print-hide), so it is omitted from print.
         This block re-surfaces the failure reason on the printout only —
         screen-hidden via `hidden`, revealed by the @media print rule for
         `.bp-print-error` (mirrors the bp-print-header reveal). */
      <div hidden className="bp-print-error" role="alert">
        Stress-test failed: {stressVm.error}
      </div>
    )}
    {stressVm.hasNoAccounts ? (
      <PlanStressTestEmpty />
    ) : (
      <>
        <PlanStressTestChart
          vm={stressVm}
          yScale={yScale}
          dataTableOpen={dataTableOpen}
          onToggleDataTable={onToggleDataTable}
        />
        {/* Same-path comparison against each approved market
            stress. Starts itself once the run above settles. */}
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          <h3 className="m-0 text-base font-semibold text-ink">
            Compare against market stresses
          </h3>
          <PlanStressTestMarketStress vm={stressVm} yScale={yScale} />
        </div>
      </>
    )}
  </section>
);
