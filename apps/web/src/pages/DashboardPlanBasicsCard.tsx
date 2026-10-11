/**
 * Dashboard "Plan basics" card: the small KV list that sits beside
 * `DashboardPlanHealthBlock` — current net worth, projected-at-retirement,
 * retirement year, plus the methodology-modal trigger and the
 * today's-dollars note.
 *
 * Deliberately takes no view-model: the dashboard renders this card even
 * when the plan-stress-test view-model is `null` on a config error, so a
 * `vm` prop would force it off the page in exactly the state it is meant
 * to survive. Net worth is always live; the other two figures render "—"
 * when `null`. No dim, no `aria-busy`, no live region — it carries no
 * simulation-derived figure.
 */
import React from 'react';
import { formatCurrencyShort } from '../lib/format-currency';
import { MonteCarloMethodologyModal } from '../components/MonteCarloMethodologyModal';

export interface DashboardPlanBasicsCardProps {
  /** Today's total net worth — a deterministic figure, always live. */
  readonly netWorth: number;
  /** Active-scenario deterministic portfolio total at the retirement year
   *  (today's dollars). `null` until the projection load resolves. */
  readonly projectedAtRetirement: number | null;
  /** Active-scenario primary retirement year. */
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
        {/* Methodology explainer moved here from the hero: the
            success figure it explains now lives on the health block, but
            the affordance still belongs beside the plan's headline
            numbers. */}
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
