/** Dashboard "Plan basics" card: net worth, projected-at-retirement and retirement year, plus the methodology-modal trigger and the today's-dollars note.
* It takes no view model so the dashboard can still render it on a config error; it carries no simulation-derived figure, so no dim, aria-busy or live region. */
import React from 'react';
import { formatCurrencyShort } from '../lib/format-currency';
import { MonteCarloMethodologyModal } from '../components/MonteCarloMethodologyModal';

export interface DashboardPlanBasicsCardProps {
  readonly netWorth: number;
  readonly projectedAtRetirement: number | null;
  readonly retirementYear: number | null;
}

const KV_ROW = 'flex items-baseline justify-between gap-3';
const KV_KEY = 'text-sm text-muted';
const KV_VALUE = 'font-mono text-sm tabular-nums text-ink';

export const DashboardPlanBasicsCard: React.FC<DashboardPlanBasicsCardProps> = ({
  netWorth,
  projectedAtRetirement,
  retirementYear,
}) => {
  return (
    <section
      className="m-0 flex flex-col gap-4 rounded-2xl border border-line bg-surface-raised p-6 shadow-sm"
      aria-labelledby="dashboard-plan-basics-heading"
    >
      <div className="flex items-center gap-2">
        <h2
          id="dashboard-plan-basics-heading"
          className="m-0 text-lg font-semibold text-ink"
        >
          Plan basics
        </h2>
        <MonteCarloMethodologyModal />
      </div>

      <dl className="m-0 flex flex-col gap-2.5">
        <div className={KV_ROW}>
          <dt className={KV_KEY}>Current net worth</dt>
          <dd className={`m-0 ${KV_VALUE}`}>{formatCurrencyShort(netWorth)}</dd>
        </div>
        <div className={KV_ROW}>
          <dt className={KV_KEY}>Projected at retirement</dt>
          <dd className={`m-0 ${KV_VALUE} text-positive`}>
            {projectedAtRetirement == null
              ? '—'
              : formatCurrencyShort(projectedAtRetirement)}
          </dd>
        </div>
        <div className={KV_ROW}>
          <dt className={KV_KEY}>Retirement year</dt>
          <dd className={`m-0 ${KV_VALUE}`}>{retirementYear ?? '—'}</dd>
        </div>
      </dl>

      <p className="m-0 text-xs text-muted">Figures shown in today's dollars.</p>
    </section>
  );
};
