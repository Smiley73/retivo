/**
 * Dashboard "Portfolio allocation - by account type" card (Graphite Spectrum).
 *
 * Same visual shell as `DashboardAllocationCard` (a horizontal stacked bar
 * above a key/value legend), but buckets WHOLE accounts by
 * `accountCategory` rather than by tax treatment — so a MIXED 401(k) shows
 * in full under Retirement here, where the allocation card splits it across
 * pre-tax / taxable. The two cards intentionally don't match.
 *
 * HSA gets its own standalone account-category colour (`bg-hsa`) — NOT one
 * of the four locked account-bucket hues; the other categories reuse the
 * bucket fills (pretax / roth / taxable / cash) and Other reuses the
 * neutral `bg-muted`. The bar + swatches are `aria-hidden` decoration; the
 * legend text carries the meaning for assistive tech.
 */
import React from 'react';
import type { AccountCategory } from '../lib/account-category';
import type { DashboardByTypeSlice } from './use-dashboard-projection';

const CATEGORY_BG: Record<AccountCategory, string> = {
  retirement: 'bg-pretax',
  roth: 'bg-roth',
  brokerage: 'bg-taxable',
  hsa: 'bg-hsa',
  cash: 'bg-cash',
  other: 'bg-muted',
};

const CATEGORY_LABEL: Record<AccountCategory, string> = {
  retirement: 'Retirement',
  roth: 'Roth',
  brokerage: 'Brokerage',
  hsa: 'HSA',
  cash: 'Cash & savings',
  other: 'Other',
};

function formatPct(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

export interface DashboardByAccountTypeCardProps {
  readonly allocation: ReadonlyArray<DashboardByTypeSlice>;
}

export const DashboardByAccountTypeCard: React.FC<
  DashboardByAccountTypeCardProps
> = ({ allocation }) => {
  return (
    <section
      className="m-0 flex flex-col gap-4 rounded-2xl border border-line bg-surface-raised p-6 shadow-sm"
      aria-labelledby="dashboard-by-account-type-heading"
    >
      <h2
        id="dashboard-by-account-type-heading"
        className="m-0 text-lg font-semibold text-ink"
      >
        Portfolio allocation{' '}
        <span className="font-normal text-muted">- by account type</span>
      </h2>

      {allocation.length === 0 ? (
        <p className="m-0 text-sm text-muted">
          Add an account balance to see your accounts by type.
        </p>
      ) : (
        <>
          {/* Decorative stacked bar — the legend below carries the
              numbers for assistive tech, so the bar is aria-hidden. */}
          <div
            aria-hidden="true"
            className="flex h-3 w-full overflow-hidden rounded-full"
          >
            {allocation.map((slice) => (
              <span
                key={slice.category}
                className={CATEGORY_BG[slice.category]}
                // eslint-disable-next-line no-restricted-syntax -- Graphite Spectrum mock: stacked-bar segment width is the data-driven allocation share (runtime %), not a static token
                style={{ width: formatPct(slice.share) }}
              />
            ))}
          </div>

          <dl className="m-0 flex flex-col gap-2.5">
            {allocation.map((slice) => (
              <div
                key={slice.category}
                className="flex items-center justify-between gap-3"
              >
                <dt className="flex items-center gap-2 text-sm text-ink">
                  <span
                    aria-hidden="true"
                    className={`inline-block size-2.5 rounded-sm ${CATEGORY_BG[slice.category]}`}
                  />
                  {CATEGORY_LABEL[slice.category]}
                </dt>
                <dd className="m-0 font-mono text-sm tabular-nums text-ink">
                  {formatPct(slice.share)}
                </dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </section>
  );
};
