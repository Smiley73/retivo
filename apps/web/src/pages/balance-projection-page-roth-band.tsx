/**
 * Balance Projection page — "Roth conversions" card.
 * Renders the basis-suffixed heading with its `(i)` methodology popover,
 * the "Total Roth converted" tile, and the per-year conversions bar chart.
 * One surface for BOTH working-years (planned) conversions and Fill-mode
 * auto-conversions — the host builds a single nominal series covering both.
 *
 * Returns `null` when nothing was converted; the host gates the wrapping
 * <section> on the same condition, so the card is absent rather than empty.
 */
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

/** Per-bar caption for the conversions chart. */
const ROTH_PER_BAR_CAPTION =
  'Each bar is the amount converted from pre-tax savings to Roth that year.';

/** "Total Roth converted" disclosure — covers planned working-years
 *  conversions AND Fill-mode auto-conversions; federal tax in the conversion
 *  year, state taxes not modeled, tax-free growth after. */
const ROTH_CONVERTED_DISCLOSURE =
  'Total Roth converted is the lifetime amount moved from your pre-tax accounts ' +
  'into a Roth account — conversions you planned during your working years and ' +
  "any made automatically under the income cap's Fill mode. Federal income tax " +
  'applies on the converted amount in the year of each conversion; state taxes ' +
  'may also apply and are not modeled here. After conversion the money grows ' +
  'tax-free in the Roth.';

/** Methodology prose for the card's `(i)` info popover — the per-bar caption
 *  plus the federal-only disclosure. Nothing renders inline below the chart. */
const RothConversionsMethodologyContent: React.FC = () => (
  <div className="flex flex-col gap-2">
    <p className="m-0">{ROTH_PER_BAR_CAPTION}</p>
    <p className="m-0">{ROTH_CONVERTED_DISCLOSURE}</p>
  </div>
);

export interface RothConversionsBandProps {
  /** Lifetime Roth converted — planned working-years conversions plus
   *  Fill-mode auto-conversions — in NOMINAL dollars, death-year filtered by
   *  the host. The host gates the section on `> 0`. */
  readonly totalRothConverted: number;
  /** Per-conversion-year nominal dollars (`{ year, dollars }`), built from the
   *  SAME source + death-year filter as `totalRothConverted`, so the bars sum
   *  bit-for-bit to the tile. */
  readonly rows: ReadonlyArray<RothConversionsChartRow>;
  /** Household members shown in the tooltip header — "<First> (age N)". */
  readonly members?: ReadonlyArray<TooltipMember>;
  /** Basis label suffixed onto the card title — the MC tier under an MC basis,
   *  else the deterministic method (Planned / Historical). */
  readonly methodLabel: string;
  /** Optional small note under the title (MC basis only: "Based on one example
   *  simulated path."). */
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
