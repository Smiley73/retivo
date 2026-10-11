/**
 * Dashboard "Portfolio allocation - by tax treatment" card (Graphite
 * Spectrum mock).
 *
 * A horizontal stacked allocation bar (one segment per tax-treatment slice
 * — tax-deferred / taxable / tax-free (Roth) / tax-free (HSA) — coloured by
 * the registered bucket fills) above a key/value legend list: swatch + label
 * on the left, right-aligned mono percentage on the right.
 *
 * The four-slice split is the cheap current-balance aggregate computed in
 * `useDashboardProjection` (via `deriveTaxTreatmentAllocation`) — no
 * projection needed; tax-free is split into a Roth slice and an HSA slice.
 * The segment fills are
 * the same `bg-{bucket}` token pairs the account tables' bucket bar uses
 * (already AA-registered in contrast.ts); the bar + swatches are
 * `aria-hidden` decoration, the percentages carry the meaning for
 * assistive tech via the legend's text.
 *
 * The dashboard surface mirrors the Balance Projection portfolio split.
 */
import React from 'react';
import type {
  DashboardAllocationSlice,
  TaxTreatmentSliceKey,
} from './use-dashboard-projection';

const BUCKET_BG: Record<TaxTreatmentSliceKey, string> = {
  pretax: 'bg-pretax',
  taxable: 'bg-taxable',
  // Tax-free splits into a Roth slice and an HSA slice; each reuses its
  // established bucket hue (violet `roth`, teal `hsa`) rather than minting
  // a new colour.
  taxfree_roth: 'bg-roth',
  taxfree_hsa: 'bg-hsa',
};

const BUCKET_LABEL: Record<TaxTreatmentSliceKey, string> = {
  pretax: 'Tax-deferred',
  taxable: 'Taxable',
  taxfree_roth: 'Tax-free (Roth)',
  taxfree_hsa: 'Tax-free (HSA)',
};

function formatPct(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

export interface DashboardAllocationCardProps {
  readonly allocation: ReadonlyArray<DashboardAllocationSlice>;
}

export const DashboardAllocationCard: React.FC<DashboardAllocationCardProps> = ({
  allocation,
}) => {
  return (
    <section
      className="m-0 flex flex-col gap-4 rounded-2xl border border-line bg-surface-raised p-6 shadow-sm"
      aria-labelledby="dashboard-allocation-heading"
    >
      <h2
        id="dashboard-allocation-heading"
        className="m-0 text-lg font-semibold text-ink"
      >
        Portfolio allocation{' '}
        <span className="font-normal text-muted">- by tax treatment</span>
      </h2>

      {allocation.length === 0 ? (
        <p className="m-0 text-sm text-muted">
          Add an account balance to see your allocation.
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
                key={slice.bucket}
                className={BUCKET_BG[slice.bucket]}
                // eslint-disable-next-line no-restricted-syntax -- Graphite Spectrum mock: stacked-bar segment width is the data-driven allocation share (runtime %), not a static token
                style={{ width: formatPct(slice.share) }}
              />
            ))}
          </div>

          <dl className="m-0 flex flex-col gap-2.5">
            {allocation.map((slice) => (
              <div
                key={slice.bucket}
                className="flex items-center justify-between gap-3"
              >
                <dt className="flex items-center gap-2 text-sm text-ink">
                  <span
                    aria-hidden="true"
                    className={`inline-block size-2.5 rounded-sm ${BUCKET_BG[slice.bucket]}`}
                  />
                  {BUCKET_LABEL[slice.bucket]}
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
