/**
 * Balance Projection page — "Qualified Charitable Distributions (QCD)" card.
 * Renders the basis-suffixed heading with its `(i)` methodology popover,
 * the "QCD distributed" tile, and the per-year gift bar chart, spanning the
 * FULL gift window (a QCD can start at 70½, before the RMD trigger age).
 *
 * Returns `null` when nothing was given; the host gates the wrapping
 * <section> on the same condition, so the card is absent rather than empty.
 * The RMD-side QCD figures — "Net taxable IRA RMD", "RMD covered by QCD", and
 * the covered-vs-taxable split chart — live on the sibling RMD card
 * (`balance-projection-page-rmd-band.tsx`), because they describe the
 * required withdrawal, not the gift.
 */
import React from 'react';
import { QcdChart, type QcdChartRow } from '../components/QcdChart';
import type { TooltipMember } from '../components/tooltip-member';
import { ChartInfoPopover } from '../components/ChartInfoPopover';
import { Muted } from '../components/Muted';
import { StatGrid, Stat } from '../components/StatGrid';
import { formatCurrencyShort } from '../lib/format-currency';
import { bandSectionH2Class } from './accounts-page-chrome';

/** Methodology prose for the card's `(i)` info popover. Phrased so it stays
 *  true when the RMD card is absent (a gift before the RMD trigger age). */
const QcdMethodologyContent: React.FC = () => (
  <div className="flex flex-col gap-2">
    <p className="m-0">
      QCD distributed is the lifetime amount given directly from a traditional
      IRA to charity at age 70½ or older — a Qualified Charitable Distribution.
      Each bar is the amount given that year. A QCD counts toward your
      traditional IRA&apos;s required minimum withdrawal and is left out of your
      taxable income. Once required minimum withdrawals begin, the Required
      Minimum Distributions card shows how much of each year&apos;s minimum your
      QCD covered and what stays taxable. A 401(k) or other employer-plan
      required withdrawal is not affected.
    </p>
  </div>
);

export interface QcdBandProps {
  /** Lifetime QCD distributed on the gift basis (today's dollars reverse the
   *  engine's year-average factor; future dollars are nominal), death-year
   *  filtered by the host. The host gates the section on `> 0`. */
  readonly totalQcd: number;
  /** Per-gift-year dollars (`{ year, dollars }`), built from the SAME rows +
   *  deflator as `totalQcd`, so the bars sum bit-for-bit to the tile. */
  readonly rows: ReadonlyArray<QcdChartRow>;
  /** Household members shown in the tooltip header — "<First> (age N)". */
  readonly members?: ReadonlyArray<TooltipMember>;
  /** Basis label suffixed onto the card title — the MC tier under an MC basis,
   *  else the deterministic method (Planned / Historical). */
  readonly methodLabel: string;
  /** Optional small note under the title (MC basis only: "Based on one example
   *  simulated path."). */
  readonly subLabel?: string;
}

export const QcdBand: React.FC<QcdBandProps> = ({
  totalQcd,
  rows,
  members,
  methodLabel,
  subLabel,
}) => {
  if (totalQcd <= 0) return null;
  return (
    <>
      <div className="mt-4 flex flex-col gap-1">
        <div className="flex items-center gap-1.5">
          <h2 id="qcd-heading" className={bandSectionH2Class}>
            Qualified Charitable Distributions (QCD) ({methodLabel})
          </h2>
          <ChartInfoPopover label="About the Qualified Charitable Distributions chart">
            <QcdMethodologyContent />
          </ChartInfoPopover>
        </div>
        {subLabel && (
          <Muted as="p" className="m-0 text-xs">
            {subLabel}
          </Muted>
        )}
      </div>
      <StatGrid cols="three">
        <Stat label="QCD distributed" value={formatCurrencyShort(totalQcd)} />
      </StatGrid>
      {rows.length > 0 && <QcdChart rows={rows} members={members} />}
    </>
  );
};
