/** "Qualified Charitable Distributions" card: heading with its (i) popover, the "QCD distributed" tile and the per-year gift bar chart over the full gift window (a QCD can start at 70½, before the RMD age). Returns null when nothing was given.
* The RMD-side figures live on the RMD card because they describe the required withdrawal, not the gift. */
import React from 'react';
import { QcdChart, type QcdChartRow } from '../components/QcdChart';
import type { TooltipMember } from '../components/tooltip-member';
import { ChartInfoPopover } from '../components/ChartInfoPopover';
import { Muted } from '../components/Muted';
import { StatGrid, Stat } from '../components/StatGrid';
import { formatCurrencyShort } from '../lib/format-currency';
import { bandSectionH2Class } from './accounts-page-chrome';

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
  /** On the gift basis (today's dollars reverse the engine's year-average factor), death-year filtered by the host, which gates the section on > 0. */
  readonly totalQcd: number;
  /** Built from the same rows and deflator as totalQcd, so the bars sum to the tile. */
  readonly rows: ReadonlyArray<QcdChartRow>;
  readonly members?: ReadonlyArray<TooltipMember>;
  readonly methodLabel: string;
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
