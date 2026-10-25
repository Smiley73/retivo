/** "Stress-test outcomes" card: the Monte Carlo plan-success chart, its data-table disclosure and the market-stress comparison. yScale is page state read by this card and the per-year chart, passed in so the two cannot drift out of sync. */
import React from 'react';
import { PlanStressTestEmpty, type PlanStressTestVm } from '../components/PlanStressTestSection';
import { PlanStressTestChart } from '../components/PlanStressTestChart';
import { PlanStressTestMarketStress } from '../components/PlanStressTestCards';
import { ChartInfoPopover } from '../components/ChartInfoPopover';
import {
  CARD_SECTION_CLASS,
  SECTION_H2_CLASS,
} from './balance-projection-page-constants';

export interface BalanceProjectionStressCardProps {
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
    </div>
    {stressVm.error && !stressVm.result && (
      /* Print-only: the on-screen error toast is hidden from print, so this re-surfaces the failure reason on the printout (screen-hidden, revealed by the .bp-print-error print rule). */
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
