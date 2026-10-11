/**
 * Balance Projection page — "Required Minimum Distributions" card.
 * Renders a summary stat row (first RMD year, total RMD years, peak
 * annual requirement, and — each only when present — total shortfall,
 * total RMD surplus, the net taxable IRA RMD after a QCD, and the part of
 * the IRA RMD a QCD covered) above a stacked-bar chart of the RMD met vs.
 * shortfall per year, followed — in QCD years that carry a gross IRA RMD —
 * by the QCD → net-taxable IRA RMD split chart under its own sub-heading.
 *
 * Returns `null` when there are no RMD rows, so the card disappears
 * entirely for scenarios with no RMD-eligible accounts (or a projection
 * that ends before the trigger age). The host decides whether to render
 * the wrapping <section> on the same `rows.length > 0` condition. Roth
 * conversions and the QCD gift chart are sibling cards
 * (`balance-projection-page-roth-band.tsx`,
 * `balance-projection-page-qcd-band.tsx`), not part of this one.
 */
import React, { useCallback, useMemo } from 'react';
import { RmdChart, type RmdChartRow } from '../components/RmdChart';
import {
  QcdRmdSplitChart,
  type QcdRmdSplitRow,
} from '../components/QcdRmdSplitChart';
import type { TooltipMember } from '../components/tooltip-member';
import { ChartInfoPopover } from '../components/ChartInfoPopover';
import { Muted } from '../components/Muted';
import { StatGrid, Stat } from '../components/StatGrid';
import { useChartZoom } from '../lib/use-chart-zoom';
import { ChartZoomReset } from '../components/ChartZoomReset';
import type { CashflowChartMarker } from '../components/CashflowProjectionChart';
import { formatCurrencyShort } from '../lib/format-currency';
import { bandSectionH2Class } from './accounts-page-chrome';

/**
 * Summary figures derived from the RMD rows: the first RMD calendar
 * year, the count of RMD years, the peak single-year requirement
 * (`max(rmdMet + rmdShortfall)`), and the lifetime shortfall total. All
 * dollar inputs are already deflated by the caller so these match the
 * chart column-sums by construction.
 */
export function summarizeRmd(
  rows: ReadonlyArray<RmdChartRow>,
  /** Lifetime retained RMD surplus (reinvested + held-as-cash),
   *  already deflated by the caller to match the chart/tile basis. The
   *  single combined figure for the "Total RMD surplus" tile. */
  totalSurplus = 0,
  /** Lifetime net TAXABLE IRA RMD after the QCD offset (`gross − min(Q, gross)`),
   *  already deflated by the caller on the RMD basis. Shown only
   *  when the plan makes a QCD (the caller's `hasQcd` gate). */
  totalNetTaxableRmd = 0,
  /** Lifetime RMD-offset — the part of the gross IRA RMD the QCD covered
   *  (`Σ min(Q, gross)`), already deflated by the caller on the RMD basis.
   *  Drives the conditional "RMD covered by QCD" tile (shown only when > 0). */
  totalRmdOffset = 0,
): {
  firstYear: number | null;
  totalYears: number;
  peakAnnual: number;
  totalShortfall: number;
  totalSurplus: number;
  totalNetTaxableRmd: number;
  totalRmdOffset: number;
} {
  let peakAnnual = 0;
  let totalShortfall = 0;
  for (const r of rows) {
    peakAnnual = Math.max(peakAnnual, r.rmdMet + r.rmdShortfall);
    totalShortfall += r.rmdShortfall;
  }
  return {
    firstYear: rows.length > 0 ? rows[0].year : null,
    totalYears: rows.length,
    peakAnnual,
    totalShortfall,
    totalSurplus,
    totalNetTaxableRmd,
    totalRmdOffset,
  };
}

/**
 * Summary-tile row for the RMD card — first RMD year, total RMD years,
 * peak annual requirement, and the conditional tiles: shortfall (only when
 * the plan misses an RMD), "Total RMD surplus" (only when required
 * withdrawals exceed spending in some year), "Net taxable IRA RMD"
 * (only when the plan makes a QCD) and "RMD covered by QCD" (only when a
 * QCD offset a gross IRA RMD). Column count grows with the number of
 * conditional tiles present.
 */
const STAT_GRID_COLS = ['three', 'four', 'five', 'six'] as const;

const RmdSummaryTiles: React.FC<{
  readonly summary: ReturnType<typeof summarizeRmd>;
  readonly hasQcd: boolean;
}> = ({ summary, hasQcd }) => {
  const hasRmdOffset = summary.totalRmdOffset > 0;
  const extraTiles =
    (summary.totalShortfall > 0 ? 1 : 0) +
    (summary.totalSurplus > 0 ? 1 : 0) +
    (hasQcd ? 1 : 0) +
    (hasRmdOffset ? 1 : 0);
  const cols = STAT_GRID_COLS[Math.min(extraTiles, STAT_GRID_COLS.length - 1)];
  return (
    <StatGrid cols={cols}>
      <Stat
        label="First RMD year"
        value={summary.firstYear !== null ? String(summary.firstYear) : '—'}
      />
      <Stat label="Total RMD years" value={String(summary.totalYears)} />
      <Stat
        label="Peak annual RMD"
        value={formatCurrencyShort(summary.peakAnnual)}
      />
      {summary.totalShortfall > 0 && (
        <Stat
          label="Total shortfall"
          value={formatCurrencyShort(summary.totalShortfall)}
        />
      )}
      {summary.totalSurplus > 0 && (
        <Stat
          label="Total RMD surplus"
          value={formatCurrencyShort(summary.totalSurplus)}
        />
      )}
      {hasQcd && (
        <Stat
          label="Net taxable IRA RMD"
          value={formatCurrencyShort(summary.totalNetTaxableRmd)}
        />
      )}
      {hasRmdOffset && (
        <Stat
          label="RMD covered by QCD"
          value={formatCurrencyShort(summary.totalRmdOffset)}
        />
      )}
    </StatGrid>
  );
};

/**
 * Methodology prose for the RMD card's `(i)` info popover — the always-on main
 * RMD caption plus the conditional explainers: RMD surplus, the net taxable
 * IRA RMD after a QCD, and — when the split chart renders — the split-bar
 * captions. Each renders only when its gating value is present.
 */
const RmdMethodologyContent: React.FC<{
  readonly totalSurplus: number;
  /** True when the plan makes a QCD — adds the "Net taxable IRA RMD" explainer. */
  readonly hasQcd: boolean;
  /** True when the QCD → net-taxable IRA RMD split bar renders (a QCD year
   *  carries a gross IRA RMD). Adds the split-bar captions. */
  readonly hasSplitChart: boolean;
}> = ({ totalSurplus, hasQcd, hasSplitChart }) => (
  <div className="flex flex-col gap-2">
    <p className="m-0">
      The IRS requires a minimum withdrawal from tax-deferred retirement accounts
      each year once you reach the trigger age.{' '}
      {totalSurplus > 0 ? (
        <>
          The teal bar is the part of that withdrawal used for spending and taxes,
          and the green bar is the surplus kept in your portfolio; any red segment
          is a shortfall — a year the plan&apos;s withdrawals fall short of the
          required minimum.
        </>
      ) : (
        <>
          The teal bar is the amount the plan withdraws toward that minimum; any
          red segment is a shortfall — a year the plan&apos;s withdrawals fall
          short of the required minimum.
        </>
      )}
    </p>
    {totalSurplus > 0 && (
      <p className="m-0">
        Total RMD surplus is the lifetime total of required withdrawals that
        exceeded your spending. That extra money stays in your portfolio —
        reinvested into a taxable account when you have one, otherwise held as
        cash and spent first in later years. You still owe ordinary income tax on
        the full required withdrawal either way.
      </p>
    )}
    {hasQcd && (
      <p className="m-0">
        Net taxable IRA RMD is the part of your traditional IRA&apos;s required
        minimum you still owe income tax on after a Qualified Charitable
        Distribution (QCD). A QCD — money given directly from the IRA to charity
        at age 70½ or older — counts toward that minimum and is left out of your
        taxable income. A 401(k) or other employer-plan required withdrawal is
        not affected and stays fully taxable.
      </p>
    )}
    {hasSplitChart && (
      <>
        <p className="m-0">
          The split bar covers the years you make a QCD. It shows that
          year&apos;s traditional IRA required minimum in two parts: the amber
          part your QCD covered (tax-free) and the teal part that stays taxable.
          Each bar&apos;s full height is that year&apos;s IRA required minimum.
          Years without a QCD are not shown — your required withdrawals can
          continue after your QCD years end, and the Required Minimum
          Distributions chart above covers those. A 401(k) or other
          employer-plan required withdrawal is not included here.
        </p>
        <p className="m-0">
          The amber part is not always your whole QCD — that is why it gets its
          own color. The Qualified Charitable Distributions card below shows the
          full amount you gave; this bar shows only the part that counted toward
          that year&apos;s required minimum. When your QCD is larger than the
          required minimum, the amber part stops at the minimum — so &ldquo;RMD
          covered by QCD&rdquo; can be smaller than &ldquo;QCD
          distributed&rdquo;. They answer different questions: how much of the
          required minimum your QCD covered, versus how much you gave.
        </p>
      </>
    )}
  </div>
);

export interface RmdBandProps {
  readonly rows: ReadonlyArray<RmdChartRow>;
  /** Lifetime retained RMD surplus (reinvested + held-as-cash),
   *  already deflated to the resolved basis by the caller. Drives the
   *  conditional "Total RMD surplus" tile + explainer (shown only when > 0). */
  readonly totalSurplus?: number;
  /** True when the plan makes a QCD from a traditional IRA in any year (the
   *  host passes `totalQcd > 0`). Gates the "Net taxable IRA RMD" tile + its
   *  explainer only — the gift figure itself lives on the sibling QCD card. */
  readonly hasQcd?: boolean;
  /** Lifetime net TAXABLE RMD after the QCD offset (`gross − min(Q, gross)`),
   *  already deflated by the caller on the RMD basis. */
  readonly totalNetTaxableRmd?: number;
  /** Lifetime RMD-offset — the part of the gross IRA RMD the QCD covered
   *  (`Σ min(Q, gross)`), already deflated by the caller on the RMD basis.
   *  Drives the conditional "RMD covered by QCD" tile (shown only when > 0).
   *  Distinct from the QCD card's "QCD distributed" (the full gift, on the
   *  gift basis). */
  readonly totalRmdOffset?: number;
  /** Per-year QCD → net-taxable IRA RMD split-bar rows
   *  (`{ year, rmdOffsetDollars, netTaxableDollars }`), already deflated to the
   *  resolved basis by the caller (both slices on the RMD's year-end
   *  `basisDeflator`) and FILTERED to QCD years that carry a gross IRA RMD
   *  (`offset + net > 0` — RMD years without a QCD are not plotted).
   *  Drives the split chart under its own sub-heading after the RMD chart. */
  readonly splitRows?: ReadonlyArray<QcdRmdSplitRow>;
  /** Retirement + death markers rendered as dashed reference lines. */
  readonly markers?: ReadonlyArray<CashflowChartMarker>;
  /** Household members shown in tooltip header — "<First> (age N)". */
  readonly members?: ReadonlyArray<TooltipMember>;
  /** Basis label suffixed onto the card title so the user can tell which basis
   *  this reflects — the MC tier under an MC basis, else the deterministic
   *  method (Planned / Historical). */
  readonly methodLabel: string;
  /** Optional small note rendered below the card title (shown only under an MC
   *  basis: "Based on one example simulated path."). Absent under a
   *  deterministic method. */
  readonly subLabel?: string;
}

export const RmdBand: React.FC<RmdBandProps> = ({
  rows,
  totalSurplus = 0,
  hasQcd = false,
  totalNetTaxableRmd = 0,
  totalRmdOffset = 0,
  splitRows = [],
  markers,
  members,
  methodLabel,
  subLabel,
}) => {
  const summary = useMemo(
    () => summarizeRmd(rows, totalSurplus, totalNetTaxableRmd, totalRmdOffset),
    [rows, totalSurplus, totalNetTaxableRmd, totalRmdOffset],
  );
  const xDomainFull = useMemo((): [number, number] => {
    if (rows.length === 0) return [0, 0];
    return [rows[0].year, rows[rows.length - 1].year];
  }, [rows]);

  const rowsForY = useMemo(() => rows.map((r) => ({ x: r.year })), [rows]);

  const computeY = useCallback(
    (visibleRows: readonly { x: number }[]): [number, number] | null => {
      const xs = new Set(visibleRows.map((r) => r.x));
      const visible = rows.filter((r) => xs.has(r.year));
      if (visible.length < 2) return null;
      const yMax = Math.max(0, ...visible.map((r) => r.rmdMet + r.rmdShortfall));
      if (yMax === 0) return null;
      return [0, yMax];
    },
    [rows],
  );

  const zoom = useChartZoom({ xDomainFull, rowsForY, computeY });

  if (rows.length === 0) return null;

  return (
    <>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <h2 id="rmd-heading" className={bandSectionH2Class}>
              Required Minimum Distributions ({methodLabel})
            </h2>
            <ChartInfoPopover label="About the Required Minimum Distributions chart">
              <RmdMethodologyContent
                totalSurplus={summary.totalSurplus}
                hasQcd={hasQcd}
                hasSplitChart={splitRows.length > 0}
              />
            </ChartInfoPopover>
          </div>
          {subLabel && (
            <Muted as="p" className="m-0 text-xs">
              {subLabel}
            </Muted>
          )}
        </div>
        <span className="report-print-hide">
          <ChartZoomReset isZoomed={zoom.isZoomed} onReset={zoom.reset} />
        </span>
      </div>
      <RmdSummaryTiles summary={summary} hasQcd={hasQcd} />
      <RmdChart
        rows={[...rows]}
        members={members}
        markers={markers}
        xDomain={zoom.xDomain}
        yDomain={zoom.yDomain}
        dragSelection={zoom.dragSelection}
        mouseHandlers={zoom.mouseHandlers}
        isDragging={zoom.isDragging}
      />
      {splitRows.length > 0 && (
        // The QCD → net-taxable IRA RMD split bar gets its OWN distinct
        // sub-heading id (`qcd-rmd-split-heading`) so the card never carries a
        // second `rmd-heading`. Shown only in QCD years that carry a gross IRA
        // RMD (the caller filters `offset + net > 0`) — the heading + `(i)`
        // prose say so in plain English, because RMD years without a QCD are
        // NOT plotted here (the aggregate RMD chart covers the full horizon).
        // The "RMD covered by QCD" tile lives in RmdSummaryTiles above and the
        // split explainer prose in the card `(i)` above.
        <>
          <h2
            id="qcd-rmd-split-heading"
            className={`mt-4 ${bandSectionH2Class}`}
          >
            IRA required withdrawal in QCD years — covered by QCD vs taxable
          </h2>
          <QcdRmdSplitChart rows={splitRows} members={members} />
        </>
      )}
    </>
  );
};
