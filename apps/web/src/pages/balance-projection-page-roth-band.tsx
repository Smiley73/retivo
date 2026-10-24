/** "Roth conversions" card: the heading with its (i) popover, the "Total Roth converted" tile and the per-year bar chart, covering both working-years and Fill-mode conversions. Returns null when nothing was converted; the host gates the wrapping section the same way. */
import React from 'react';
import {
  RothConversionsChart,
  type RothConversionsChartRow,
} from '../components/RothConversionsChart';
import type { TooltipMember } from '../components/tooltip-member';
import { ChartInfoPopover } from '../components/ChartInfoPopover';
import { Muted } from '../components/Muted';
import { StatGrid, Stat } from '../components/StatGrid';
import { formatCurrencyShort } from '../lib/format-currency';
import { bandSectionH2Class } from './accounts-page-chrome';

const ROTH_PER_BAR_CAPTION =
  'Each bar is the amount converted from pre-tax savings to Roth that year.';

const ROTH_CONVERTED_DISCLOSURE =
  'Total Roth converted is the lifetime amount moved from your pre-tax accounts ' +
  'into a Roth account — conversions you planned during your working years and ' +
  "any made automatically under the income cap's Fill mode. Federal income tax " +
  'applies on the converted amount in the year of each conversion; state taxes ' +
  'may also apply and are not modeled here. After conversion the money grows ' +
  'tax-free in the Roth.';

const RothConversionsMethodologyContent: React.FC = () => (
  <div className="flex flex-col gap-2">
    <p className="m-0">{ROTH_PER_BAR_CAPTION}</p>
    <p className="m-0">{ROTH_CONVERTED_DISCLOSURE}</p>
  </div>
);

export interface RothConversionsBandProps {
  /** Nominal dollars, death-year filtered by the host, which gates the section on > 0. */
  readonly totalRothConverted: number;
  /** Built from the same source and death-year filter as totalRothConverted, so the bars sum to the tile. */
  readonly rows: ReadonlyArray<RothConversionsChartRow>;
  readonly members?: ReadonlyArray<TooltipMember>;
  readonly methodLabel: string;
  readonly subLabel?: string;
}

export const RothConversionsBand: React.FC<RothConversionsBandProps> = ({
  totalRothConverted,
  rows,
  members,
  methodLabel,
  subLabel,
}) => {
  if (totalRothConverted <= 0) return null;
  return (
    <>
      <div className="mt-4 flex flex-col gap-1">
        <div className="flex items-center gap-1.5">
          <h2 id="roth-conversions-heading" className={bandSectionH2Class}>
            Roth conversions ({methodLabel})
          </h2>
          <ChartInfoPopover label="About the Roth conversions chart">
            <RothConversionsMethodologyContent />
          </ChartInfoPopover>
        </div>
        {subLabel && (
          <Muted as="p" className="m-0 text-xs">
            {subLabel}
          </Muted>
        )}
      </div>
      <StatGrid cols="three">
        <Stat
          label="Total Roth converted"
          value={formatCurrencyShort(totalRothConverted)}
        />
      </StatGrid>
      {rows.length > 0 && (
        <RothConversionsChart rows={rows} members={members} />
      )}
    </>
  );
};
