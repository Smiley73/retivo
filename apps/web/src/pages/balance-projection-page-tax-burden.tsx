/**
 * Balance Projection page — "Tax & Health-Cost Burden" band.
 * Shows per-year federal income tax + IRMAA surcharge above zero and
 * ACA-PTC subsidy below zero. Rendered for EVERY named withdrawal strategy
 * (tax cashflow funds all strategies).
 */
import React, { useCallback, useMemo } from 'react';
import { TaxBurdenChart, type TaxBurdenChartRow } from '../components/TaxBurdenChart';
import type { TooltipMember } from '../components/tooltip-member';
import { ChartInfoPopover } from '../components/ChartInfoPopover';
import { Muted } from '../components/Muted';
import { StatGrid, Stat } from '../components/StatGrid';
import { useChartZoom } from '../lib/use-chart-zoom';
import { ChartZoomReset } from '../components/ChartZoomReset';
import type { CashflowChartMarker } from '../components/CashflowProjectionChart';
import { formatCurrencyShort } from '../lib/format-currency';
import type { DisplayMode } from '../lib/view-deflator';
import { bandSectionH2Class } from './accounts-page-chrome';

/**
 * Lifetime totals for the tax-burden summary tiles — sums the already-deflated
 * chart rows so the figures match the chart column-sums and honor the
 * Display-unit toggle by construction. The ACA-PTC series is stored negative
 * (renders below zero); this flips it to a positive credit-received figure.
 */
export function sumTaxBurden(rows: ReadonlyArray<TaxBurdenChartRow>): {
  federalTax: number;
  irmaaSurcharge: number;
  acaPtcCredit: number;
} {
  let federalTax = 0;
  let irmaaSurcharge = 0;
  let acaPtcSubsidy = 0;
  for (const r of rows) {
    federalTax += r.federalTax;
    irmaaSurcharge += r.irmaaSurcharge;
    acaPtcSubsidy += r.acaPtcSubsidy;
  }
  // `+ 0` normalizes a sign-flipped `-0` back to `0` (so an all-zero credit
  // never formats as "-$0").
  return { federalTax, irmaaSurcharge, acaPtcCredit: -acaPtcSubsidy + 0 };
}

/**
 * Summary-tile row for the tax-burden band — the three deflated lifetime totals
 * (federal tax, IRMAA, ACA-PTC credit). Extracted from `TaxBurdenBand` to keep
 * that component within the 60-line shape limit; rendered only inside its
 * hasSignal branch so the gate-by-placement is preserved. The lifetime-basis
 * caption that used to sit below the grid now lives in the section's `(i)` info
 * popover (`TaxBurdenMethodologyContent`).
 */
const TaxBurdenSummaryTiles: React.FC<{
  readonly totals: ReturnType<typeof sumTaxBurden>;
}> = ({ totals }) => (
  <StatGrid cols="three">
    <Stat
      label="Federal income tax"
      value={formatCurrencyShort(totals.federalTax)}
    />
    <Stat
      label="Medicare surcharges (IRMAA)"
      value={formatCurrencyShort(totals.irmaaSurcharge)}
    />
    <Stat
      label="ACA health credits"
      value={formatCurrencyShort(totals.acaPtcCredit)}
    />
  </StatGrid>
);

/**
 * Methodology prose for the tax-burden band's `(i)` info popover — folds BOTH
 * the lifetime-tiles caption (dollar-mode basis) and the standing chart caption
 * (above/below-zero stacking + the IRS §86 SS-tax treatment, with its MC vs
 * deterministic funded-base sentence variant) into one disclosure, closed by
 * the shared display-only qualification: the yield / interest /
 * cost-basis tax refinements are shown but not yet funded from the portfolio
 * in either engine. The numeric tiles + chart stay inline; only this prose
 * moved behind the `(i)`.
 */
const TaxBurdenMethodologyContent: React.FC<{
  readonly displayMode: DisplayMode;
  readonly isMcBasisActive: boolean;
}> = ({ displayMode, isMcBasisActive }) => (
  <div className="flex flex-col gap-2">
    <p className="m-0">
      Lifetime totals across every projected retirement year for the selected
      method, in {displayMode === 'today' ? "today's" : 'future'} dollars. ACA
      health credits are shown as a positive amount, they reduce your net cost.
    </p>
    <p className="m-0">
      Federal income tax and Medicare IRMAA surcharge for each retirement year
      stack above zero; the ACA-PTC premium tax credit subsidy renders below zero
      (it reduces your net cost). Federal tax already incorporates any
      ordinary-income impact of taxable Social Security benefits per IRS §86, no
      separate SS-tax segment is shown.{' '}
      {isMcBasisActive
        ? // The MC drawdown funds the core tax bill from the portfolio each
          // year (every strategy), so that portion IS reflected in the
          // simulated balances.
          'These are estimated taxes for this example path; they are funded from the portfolio each year, so they affect the projected balances.'
        : 'These costs are funded from the portfolio each year, so they affect your projected balances, shown for every withdrawal strategy.'}{' '}
      {/* The yield / interest / cost-basis refinements are
          display-exact in BOTH engines but deliberately NOT funded into either
          engine's balance progression — mirror the BalanceProjectionEstimateNote
          disclosure so this popover never overstates what the balances absorb. */}
      One exception: the displayed figures also include the yearly tax on
      estimated investment yield inside taxable brokerage accounts and on
      savings, money-market, and CD interest, using an estimated year-by-year
      cost basis. That added portion refines the tax shown but is not yet
      pulled from the portfolio, so the projected balances do not subtract it.
    </p>
  </div>
);

export interface TaxBurdenBandProps {
  readonly rows: ReadonlyArray<TaxBurdenChartRow>;
  /** Retirement + death markers rendered as dashed reference lines. */
  readonly markers?: ReadonlyArray<CashflowChartMarker>;
  /** Household members shown in tooltip header — "<First> (age N)". */
  readonly members?: ReadonlyArray<TooltipMember>;
  /** Drives the summary-tile caption's dollar-mode wording. */
  readonly displayMode: DisplayMode;
  /** Active deterministic method label (Planned / TWR) suffixed onto the
   *  band title so the user can tell which basis this chart reflects. */
  readonly methodLabel: string;
  /** Optional small note rendered below the band title (shown only under an MC
   *  basis: the display-only tax disclosure). Absent under a deterministic
   *  method. */
  readonly subLabel?: string;
  /** True when an MC basis is active — swaps the caption's final sentence to the
   *  display-only wording. Defaults to false (deterministic verbatim). */
  readonly isMcBasisActive?: boolean;
}

export const TaxBurdenBand: React.FC<TaxBurdenBandProps> = ({
  rows,
  markers,
  members,
  displayMode,
  methodLabel,
  subLabel,
  isMcBasisActive = false,
}) => {
  const totals = useMemo(() => sumTaxBurden(rows), [rows]);
  const xDomainFull = useMemo((): [number, number] => {
    if (rows.length === 0) return [0, 0];
    return [rows[0].year, rows[rows.length - 1].year];
  }, [rows]);

  const rowsForY = useMemo(
    () => rows.map((r) => ({ x: r.year })),
    [rows],
  );

  const computeY = useCallback(
    (visibleRows: readonly { x: number }[]): [number, number] | null => {
      const xs = new Set(visibleRows.map((r) => r.x));
      const visible = rows.filter((r) => xs.has(r.year));
      if (visible.length < 2) return null;
      // Use per-row stacked sums so the y-domain matches the tallest and
      // deepest stacked bars. Positive stack = federalTax + irmaaSurcharge;
      // negative stack = acaPtcSubsidy (stored negative by convention).
      const yMax = Math.max(0, ...visible.map((r) => r.federalTax + r.irmaaSurcharge));
      const yMin = Math.min(0, ...visible.map((r) => r.acaPtcSubsidy));
      if (yMin === 0 && yMax === 0) return null;
      return [yMin, yMax];
    },
    [rows],
  );

  const zoom = useChartZoom({ xDomainFull, rowsForY, computeY });

  return (
    <>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <h2 id="tax-burden-heading" className={bandSectionH2Class}>
              Tax &amp; Health-Cost Burden ({methodLabel})
            </h2>
            <ChartInfoPopover label="About the Tax & Health-Cost Burden chart">
              <TaxBurdenMethodologyContent
                displayMode={displayMode}
                isMcBasisActive={isMcBasisActive}
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
      <TaxBurdenSummaryTiles totals={totals} />
      <TaxBurdenChart
        rows={[...rows]}
        members={members}
        markers={markers}
        xDomain={zoom.xDomain}
        yDomain={zoom.yDomain}
        dragSelection={zoom.dragSelection}
        mouseHandlers={zoom.mouseHandlers}
        isDragging={zoom.isDragging}
      />
    </>
  );
};
