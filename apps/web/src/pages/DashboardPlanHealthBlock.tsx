/** Dashboard "Retirement readiness" block: the hero plan-success tile beside a Typical / Pessimistic comparison grid, dimmed with aria-busy and aria-live while the simulation runs. The KV rows and methodology modal live in DashboardPlanBasicsCard. */
import React from 'react';
import type { PlanStressTestVm } from '../components/PlanStressTestSection';
import { STATUS_TEXT_CLASS } from '../components/plan-stress-test-chrome';
import type { StatusTier } from '../components/plan-stress-test-chrome';
import { formatCurrencyShort } from '../lib/format-currency';
import { Tooltip } from '../components/Tooltip';

export interface DashboardPlanHealthBlockProps {
  readonly vm: PlanStressTestVm;
}

const SUCCESS_TOOLTIP =
  'The share of 10,000 randomized market simulations in which your savings last the whole plan.';

// The text label carries the tier the hue encodes (WCAG 1.4.1), keyed by the same threshold tier as the % color (successTierForPct); it is a factual band label, not a safe/unsafe verdict, and muted (still computing) has none.
const SUCCESS_QUALIFIER: Record<StatusTier, string> = {
  muted: '',
  success: 'At or above 85%',
  warning: '70% to 84%',
  danger: 'Below 70%',
};

const TH_COL_CLASS = 'px-3 pb-1 pt-0 text-right text-sm font-medium text-muted';
const TH_ROW_CLASS = 'px-3 py-1.5 text-left text-sm font-medium text-ink';
const TD_CLASS = 'px-3 py-1.5 text-right font-mono text-sm tabular-nums';

interface Cell {
  readonly text: string;
  readonly className: string;
}

function endingBalanceCell(value: number | null, pending: boolean): Cell {
  if (pending || value == null) {
    return { text: '—', className: '' };
  }
  return {
    text: formatCurrencyShort(value),
    className: value > 0 ? 'text-positive' : 'text-negative',
  };
}

// Both the word and the tint come off the raw null depletion-year test, so they cannot disagree; horizonStatus was rejected because its zero-balance fallback reports danger for a null year and would paint "Never" red.
function depletionCell(year: number | null, pending: boolean): Cell {
  if (pending) {
    return { text: '—', className: '' };
  }
  if (year === null) {
    return { text: 'Never', className: 'text-positive' };
  }
  return { text: String(year), className: 'text-negative' };
}

export const DashboardPlanHealthBlock: React.FC<DashboardPlanHealthBlockProps> = ({
  vm,
}) => {
  // Not `vm.isStale || vm.isRunning`: the Monte Carlo result lives in one app-wide provider, so on a first mount after another surface ran a simulation that predicate would paint another scenario's numbers undimmed.
  const pending = vm.stressPairSignature === null;
  const successText =
    pending || vm.successPct == null ? '—' : `${vm.successPct}%`;

  const endTypical = endingBalanceCell(vm.endTypical, pending);
  const endPessimistic = endingBalanceCell(vm.endPessimistic, pending);
  const typicalDepletion = depletionCell(vm.typicalDepletionYear, pending);
  const pessimisticDepletion = depletionCell(
    vm.pessimisticDepletionYear,
    pending,
  );

  return (
    <section
      className={`m-0 flex flex-col gap-4 rounded-2xl border border-line bg-surface-raised p-6 shadow-sm transition-opacity duration-150 ${
        pending ? 'opacity-50' : 'opacity-100'
      }`}
      aria-labelledby="dashboard-plan-health-heading"
      aria-busy={pending}
    >
      <h2
        id="dashboard-plan-health-heading"
        className="m-0 text-lg font-semibold text-ink"
      >
        Retirement readiness
      </h2>

      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        {/* Live region so the swap is announced when the Monte-Carlo run settles. */}
        <div className="flex flex-1 flex-col gap-1" aria-live="polite">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span
              className={`font-bold leading-none text-5xl ${STATUS_TEXT_CLASS[vm.successTier]}`}
            >
              {pending ? (
                successText
              ) : (
                <Tooltip multiline content={SUCCESS_TOOLTIP}>
                  {successText}
                </Tooltip>
              )}
            </span>
            {!pending && SUCCESS_QUALIFIER[vm.successTier] && (
              <span
                className={`text-sm font-semibold ${STATUS_TEXT_CLASS[vm.successTier]}`}
              >
                {SUCCESS_QUALIFIER[vm.successTier]}
              </span>
            )}
          </div>
          <span className="text-sm text-muted">
            {pending ? (
              'calculating plan success…'
            ) : (
              <>
                <Tooltip multiline content={SUCCESS_TOOLTIP}>
                  plan success
                </Tooltip>{' '}
                across {(10000).toLocaleString()} simulations
              </>
            )}
          </span>
        </div>

        <div className="flex-1" aria-live="polite">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <td />
                <th scope="col" className={TH_COL_CLASS}>
                  Typical
                </th>
                <th scope="col" className={TH_COL_CLASS}>
                  Pessimistic
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row" className={TH_ROW_CLASS}>
                  Ending balance
                </th>
                <td className={`${TD_CLASS} ${endTypical.className}`}>
                  {endTypical.text}
                </td>
                <td className={`${TD_CLASS} ${endPessimistic.className}`}>
                  {endPessimistic.text}
                </td>
              </tr>
              <tr>
                <th scope="row" className={TH_ROW_CLASS}>
                  Money runs out
                </th>
                <td className={`${TD_CLASS} ${typicalDepletion.className}`}>
                  {typicalDepletion.text}
                </td>
                <td
                  className={`${TD_CLASS} ${pessimisticDepletion.className}`}
                >
                  {pessimisticDepletion.text}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
};
