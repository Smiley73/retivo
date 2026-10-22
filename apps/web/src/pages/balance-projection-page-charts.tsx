/**
 * Balance Projection page — bottom chart sections: the Tax & Health-Cost
 * Burden chart, the three sibling distribution cards (Required
 * Minimum Distributions → Qualified Charitable Distributions → Roth
 * conversions, each gated on its own data), and the standing tax-estimate
 * disclosure note. Extracted from `BalanceProjectionPage.tsx` so the page
 * stays a thin orchestration layer under the file shape cap.
 * The Account Balance Stack section that used to render ahead of this half
 * lives in the sibling `balance-projection-page-account-stack-section.tsx`;
 * split out because each half belongs to a different future view.
 * All inputs arrive as props; the only local derivation is the per-year
 * chart rows (deflated from the runner drawdown years).
 */
import React, { useMemo, useState } from 'react';
import { Alert } from '../components/Alert';
import { Muted } from '../components/Muted';
import { BalanceProjectionEstimateNote } from '../components/BalanceProjectionEstimateNote';
import type { CashflowChartMarker } from '../components/CashflowProjectionChart';
import type { TooltipMember } from '../components/tooltip-member';
import type { TaxBurdenChartRow } from '../components/TaxBurdenChart';
import type { RmdChartRow } from '../components/RmdChart';
import type { ProjectionMethod } from '../components/ProjectionChart';
import {
  buildTaxBurdenRows,
  buildRmdRows,
  buildRothConversionsSeries,
  buildQcdRows,
  hasMedicaidRangeYear,
} from './balance-projection-burden-rows';
import { TaxBurdenBand } from './balance-projection-page-tax-burden';
import { RmdBand } from './balance-projection-page-rmd-band';
import { QcdBand } from './balance-projection-page-qcd-band';
import { RothConversionsBand } from './balance-projection-page-roth-band';
import { bandSectionH2Class, btnSecondarySmClass } from './accounts-page-chrome';
import { BalanceProjectionTaxDetail } from './balance-projection-page-tax-detail';
import type { DrawdownByMethodResult } from './balance-projection-page-data';
import type { DisplayMode } from '../lib/view-deflator';
import {
  CARD_SECTION_CLASS,
  MC_REPRESENTATIVE_RUN_SUBLABEL,
  MC_TAX_ESTIMATE_SUBLABEL,
} from './balance-projection-page-constants';

export interface BalanceProjectionChartsProps {
  readonly drawdownByMethod:
    | Record<ProjectionMethod, DrawdownByMethodResult | null>
    | null;
  readonly activeMethod: ProjectionMethod;
  /** Resolved per-year drawdown (representative MC run when active, else the
   *  deterministic method). The MC-driven Tax & Health-Cost Burden chart AND —
   *  v23 — the RMD chart read THIS, so their per-account bands + RMD bars
   *  follow the selected MC representative run's captured per-account
   *  balances. */
  readonly resolvedDrawdown: DrawdownByMethodResult | null;
  /** Label of the basis the resolved drawdown reflects (the MC tier when a
   *  Monte Carlo basis is active, else `methodLabel`). Suffixed onto the
   *  resolved-source titles (RMD, Tax & Health-Cost Burden) so each names the
   *  basis driving it. */
  readonly resolvedLabel: string;
  /** True when an MC basis is the RESOLVED basis — drives the
   *  "Based on one example simulated path." sub-label below the RMD title.
   *  False under a deterministic method. */
  readonly isMcBasisActive: boolean;
  /** Flat scenario deflator — retained ONLY for the deterministic-only
   *  Taxes & health-costs detail table (gated OFF under MC). Every
   *  MC-sourced surface here (RMD / Tax Burden / RMD-surplus / Roth) uses
   *  `basisDeflator` instead. */
  readonly viewDeflator: (year: number, monthIndex?: number) => number;
  /** Basis-aware deflator for the MC-sourced display surfaces: path
   *  CPI under MC + Today's, the flat `viewDeflator` otherwise. Drives the RMD
   *  chart, the Tax & Health-Cost Burden chart, and the RMD-surplus tile. */
  readonly basisDeflator: (year: number) => number;
  readonly markers: ReadonlyArray<CashflowChartMarker>;
  readonly tooltipMembers: ReadonlyArray<TooltipMember>;
  readonly displayMode: DisplayMode;
  /** Rightmost death marker's fractional X. When the death falls
   *  mid-year the tax-burden series' death-year row is prorated to the
   *  partial year lived and repositioned onto the marker so the final
   *  bar reaches it (matching the cashflow + portfolio-flow charts). */
  readonly lastDeathFractional: number | null;
  /** True when the active cap is in Fill mode. When no conversions occur
   *  across the horizon a notice explains the likely reason. */
  readonly capFillActive: boolean;
}

export const BalanceProjectionCharts: React.FC<BalanceProjectionChartsProps> = ({
  drawdownByMethod,
  activeMethod,
  resolvedDrawdown,
  resolvedLabel,
  isMcBasisActive,
  viewDeflator,
  basisDeflator,
  markers,
  tooltipMembers,
  displayMode,
  lastDeathFractional,
  capFillActive,
}) => {
  /** Collapsed-by-default disclosure for the Taxes & health costs table,
   *  folded into the Tax Burden chart section (mirrors the Stress-test
   *  outcomes "Show … data table" pattern). */
  const [taxDetailOpen, setTaxDetailOpen] = useState(false);

  /** Resolved drawdown years (representative run under an MC basis, else the
   *  deterministic method) — read here only for the MAGI-estimated disclosure
   *  flag below. (The Account balances over time band lives in the sibling
   *  `balance-projection-page-account-stack-section.tsx` and consumes the
   *  unified `accountStackTimeline` assembled in the view-model instead.) */
  const drawdownYears = useMemo(
    () => resolvedDrawdown?.years ?? drawdownByMethod?.[activeMethod]?.years ?? [],
    [resolvedDrawdown, drawdownByMethod, activeMethod],
  );

  /** True when any projection year's IRMAA look-back was estimated from
   *  the projected first-year MAGI (member on Medicare in years 0–1 with no
   *  stored two-years-prior bootstrap). Drives the disclosure line in the
   *  standing estimate note. */
  const magiEstimatedFromProjection = useMemo(
    () => drawdownYears.some((yr) => yr.magiEstimatedFromProjection === true),
    [drawdownYears],
  );

  /** True when any projection year is charged a Medicare
   *  income-related surcharge while the plan models no medical spending at all,
   *  so the base Medicare premium (a user-entered medical expense) is missing.
   *  Drives the readiness warning in the standing estimate note.
   *
   *  Read off the DETERMINISTIC drawdown rather than the active chart
   *  basis. The fact ("this plan records no medical spending, yet a surcharge is
   *  charged") is basis-INDEPENDENT: only the deterministic post-pass stamps the
   *  flag, so keying it off `drawdownYears` silently dropped the disclosure the
   *  moment the user switched to a Monte Carlo basis. */
  const medicareBasePremiumMissing = useMemo(
    () =>
      (drawdownByMethod?.[activeMethod]?.years ?? []).some(
        (yr) => yr.medicareBasePremiumMissing === true,
      ) || drawdownYears.some((yr) => yr.medicareBasePremiumMissing === true),
    [drawdownByMethod, activeMethod, drawdownYears],
  );

  /** Medicaid paragraph flag, read off the DETERMINISTIC drawdown like
   *  `medicareBasePremiumMissing`: the MC representative run never stamps
   *  `fplPercentage`. */
  const medicaidMayApply = useMemo(
    () => hasMedicaidRangeYear(drawdownByMethod?.[activeMethod]?.years ?? []),
    [drawdownByMethod, activeMethod],
  );

  /** Per-year tax / health-cost burden rows for TaxBurdenBand,
   *  deflated from the active method's runner drawdown years. Death =
   *  Dec 31 of `deathYear`, the terminal year, so we drop the rows past
   *  the death year (`lastDeathFractional` is the fractional death-year
   *  marker that is floored to the integer death year here)
   *  and the death-year row carries FULL annual tax values — no
   *  partial-year proration. The marker lands on the last bar
   *  (`deathYear`) via the bar chart's own x-convention. */
  // Under an MC basis the representative run's `years` span the full
  // horizon incl. pre-retirement accumulation (which carry no per-account
  // `accountBalances` and no tax). The shared pure builder filters to the
  // DRAWDOWN-PHASE marker only — NEVER by taxable signal — so the x-domain
  // starts at retirement (matching the deterministic basis) while legitimate
  // zero-tax drawdown years are kept. `hasSignal` (below) stays the
  // chart-vs-genuine-zero-copy selector. Basis-aware deflation: under an
  // MC basis + Today's-dollars these MC-sourced tax cents deflate by the path's
  // own CPI so the band ties to the MC balance line.
  const taxBurdenRows = useMemo(
    (): TaxBurdenChartRow[] =>
      buildTaxBurdenRows({
        resolvedDrawdown,
        basisDeflator,
        lastDeathFractional,
        isMcBasisActive,
      }),
    [resolvedDrawdown, basisDeflator, lastDeathFractional, isMcBasisActive],
  );

  /** Per-year RMD rows for RmdBand — the required minimum split into the
   *  amount met (`rmdFloor − rmdShortfall`) and the shortfall, deflated
   *  from the active method's runner drawdown years. Only years with a
   *  positive `rmdFloorCents` are kept; the section is hidden entirely
   *  when none exist. Death-year handling mirrors `taxBurdenRows`:
   *  rows past the integer death year are dropped, the death-year row
   *  carries its FULL annual RMD. */
  const rmdRows = useMemo(
    (): RmdChartRow[] =>
      buildRmdRows({
        drawdown: resolvedDrawdown ?? drawdownByMethod?.[activeMethod] ?? null,
        basisDeflator,
        lastDeathFractional,
      }),
    [resolvedDrawdown, drawdownByMethod, activeMethod, basisDeflator, lastDeathFractional],
  );

  /** Lifetime retained RMD surplus (reinvested + held-as-cash) for
   *  the "Total RMD surplus" tile — a single combined figure, deflated by the
   *  same basis-aware `basisDeflator` the RMD/flow surfaces use so it ties out
   *  to the flow series under every basis. Death-year filtered to match the
   *  RMD rows. */
  const rmdSurplusTotal = useMemo((): number => {
    const drawdown = resolvedDrawdown ?? drawdownByMethod?.[activeMethod];
    if (!drawdown) return 0;
    const deathYear =
      lastDeathFractional !== null && Number.isFinite(lastDeathFractional)
        ? Math.floor(lastDeathFractional)
        : null;
    let total = 0;
    for (const yr of drawdown.years) {
      if (deathYear !== null && yr.year > deathYear) continue;
      const surplusCents =
        (yr.rmdReinvestedCents ?? 0) + (yr.rmdOverflowToCashCents ?? 0);
      if (surplusCents <= 0) continue;
      total += (surplusCents / 100) * basisDeflator(yr.year);
    }
    return total;
  }, [resolvedDrawdown, drawdownByMethod, activeMethod, basisDeflator, lastDeathFractional]);

  /** Lifetime QCD distributed (the QCD card's tile) + lifetime
   *  net-taxable-RMD-after-QCD and RMD-offset (the RMD card's conditional
   *  tiles), AND the per-year QCD series for the QCD card's bar
   *  chart. Built by the shared pure builder
   *  `buildQcdRows` (in balance-projection-burden-rows.ts) so BOTH the on-page
   *  chart section AND the Export PDF render host derive identical rows (no
   *  drift). `qcdByYear` keeps only `dollars > 0` years. 0 → the QCD tiles +
   *  chart all hide.
   *
   *  Each year's QCD is deflated to the page's display-dollars basis (see `buildQcdRows`). */
  const qcdTotals = useMemo((): {
    totalQcd: number;
    totalNetTaxableRmd: number;
    totalRmdOffset: number;
    qcdByYear: { year: number; dollars: number }[];
    splitRows: {
      year: number;
      rmdOffsetDollars: number;
      netTaxableDollars: number;
    }[];
  } => {
    const rows = buildQcdRows({
      drawdown: resolvedDrawdown ?? drawdownByMethod?.[activeMethod] ?? null,
      basisDeflator,
      lastDeathFractional,
      displayMode,
    });
    const totalQcd = rows.reduce((s, r) => s + r.qcdDollars, 0);
    const totalNetTaxableRmd = rows.reduce((s, r) => s + r.netTaxableRmd, 0);
    const totalRmdOffset = rows.reduce((s, r) => s + r.rmdOffsetDollars, 0);
    const qcdByYear = rows.map((r) => ({ year: r.year, dollars: r.qcdDollars }));
    // The QCD-RMD split bar rows: one bar per GIFT year that carries a gross
    // IRA RMD. `buildQcdRows` emits every QCD year (incl. pre-RMD gift
    // years with a $0 gross RMD → offset = net = 0), so filter to
    // `offset + net > 0`; RMD years without a gift are never emitted at all,
    // so the chart spans the gift window, not the RMD horizon. One
    // deflation path only (the widened `buildQcdRows`), so the teal column-sum
    // equals the "Net taxable IRA RMD" tile and the amber column-sum equals the
    // "RMD covered by QCD" tile by construction. Map `netTaxableRmd` →
    // `netTaxableDollars` at this boundary (the single canonical downstream shape).
    const splitRows = rows
      .filter((r) => r.rmdOffsetDollars + r.netTaxableRmd > 0)
      .map((r) => ({
        year: r.year,
        rmdOffsetDollars: r.rmdOffsetDollars,
        netTaxableDollars: r.netTaxableRmd,
      }));
    return { totalQcd, totalNetTaxableRmd, totalRmdOffset, qcdByYear, splitRows };
  }, [resolvedDrawdown, drawdownByMethod, activeMethod, displayMode, basisDeflator, lastDeathFractional]);

  /** Per-conversion-year converted dollars for the Roth conversions bar chart
   *  AND the "Total Roth converted" tile. Built from the SAME source
   *  (`resolvedDrawdown ?? drawdownByMethod[activeMethod]`) and the SAME
   *  death-year filter (`yr.year <= deathYear`). The bars show the ACTUAL
   *  nominal dollars converted each year — no basis deflation — so the chart
   *  reflects what is really moved; the tile derives from this same series so
   *  the bars sum bit-for-bit to the tile. 0 conversions → empty series →
   *  chart + tile + explainer all hide together. */
  const rothConversionsSeries = useMemo(
    (): { year: number; dollars: number }[] =>
      buildRothConversionsSeries({
        drawdown: resolvedDrawdown ?? drawdownByMethod?.[activeMethod] ?? null,
        lastDeathFractional,
      }),
    [resolvedDrawdown, drawdownByMethod, activeMethod, lastDeathFractional],
  );

  /** Lifetime Roth converted (planned working-years conversions + Fill-mode
   *  auto-conversions) for the Roth card's "Total Roth converted" tile —
   *  the sum of the same per-year series the chart draws, so the tile and the
   *  bars tie out by construction. 0 → the whole Roth card hides. */
  const rothConvertedTotal = useMemo(
    (): number =>
      rothConversionsSeries.reduce((sum, r) => sum + r.dollars, 0),
    [rothConversionsSeries],
  );

  /** Fill mode is on but not a single dollar converted across the horizon.
   *  Surface why so the user isn't left guessing — the engine flags an
   *  unresolved target Roth per year; otherwise the cap simply had
   *  no room to fill (withdrawals + RMDs met it, the cap turned off before the
   *  drawdown years, or there were no pre-tax dollars to convert).
   *
   *  Reads the DETERMINISTIC method drawdown (`drawdownByMethod[activeMethod]`),
   *  never the resolved drawdown. The MC representative run DOES carry per-year
   *  Roth conversions since ENGINE_VERSION 30 (and the `rothConversionsSeries`
   *  above now deflates those converted cents by the path's own CPI via
   *  `basisDeflator`) — but this no-conversion notice intentionally stays
   *  on the deterministic drawdown: re-pointing it at the MC run changes the
   *  user-facing copy semantics (a per-path zero is not a per-plan zero), a
   *  separate display-logic decision.
   *
   *  Planned working-years conversions are NOT Fill conversions, so the Roth
   *  card can still render beside this notice — the copy therefore says Fill
   *  "did not convert anything", never "no Roth conversions happened". */
  const fillNoConversionNotice = useMemo((): string | null => {
    if (!capFillActive) return null;
    const drawdown = drawdownByMethod?.[activeMethod];
    if (!drawdown) return null;
    const converted = drawdown.years.some((y) => (y.rothConvertedCents ?? 0) > 0);
    if (converted) return null;
    const degradedNoTarget = drawdown.years.some(
      (y) => y.rothConversionDegradedNoTarget,
    );
    if (degradedNoTarget) {
      return (
        'Fill mode is on, but no Roth account could be used as the conversion ' +
        'target — pick a Roth account in the withdrawal-strategy settings so ' +
        'conversions can run.'
      );
    }
    return (
      'Fill mode is on, but it did not convert anything in this projection. ' +
      'Common reasons: the cap turns off (at its end age) before your ' +
      'retirement years, your withdrawals and RMDs already use up the room ' +
      'under the cap, or there are no pre-tax balances left to convert. Try a ' +
      'higher cap end age or a higher cap amount.'
    );
  }, [capFillActive, drawdownByMethod, activeMethod]);

  /** MC-only note under each resolved-source card title ("Based on one
   *  example simulated path."); absent under a deterministic method. */
  const mcSubLabel = isMcBasisActive ? MC_REPRESENTATIVE_RUN_SUBLABEL : undefined;

  return (
    <>
      {/* Tax & Health-Cost Burden chart — rendered for EVERY
          withdrawal strategy (tax cashflow funds all of them). If the run
          produced no taxable signal, show an explanation in place of the
          chart. The section's accessible name (`tax-burden-heading`) is owned
          by the inner TaxBurdenBand's <h2> in the signal branch; the no-signal
          branch renders the same heading id itself so the section is never
          left without an accessible name.

          The year-by-year "Taxes & health costs" sub-table is folded into
          this same section as a collapsed-by-default disclosure below the
          chart (mirrors the Stress-test outcomes "Show … data table"
          pattern); the toggle button carries the same small size as the
          page's "Show year-by-year table" control (`btnSecondarySmClass`). */}
      <section className={CARD_SECTION_CLASS} aria-labelledby="tax-burden-heading">
        {(() => {
          const hasSignal = taxBurdenRows.some(
            (r) =>
              r.federalTax !== 0 ||
              r.irmaaSurcharge !== 0 ||
              r.acaPtcSubsidy !== 0,
          );
          if (!hasSignal) {
            return (
              <>
                <h2 id="tax-burden-heading" className={bandSectionH2Class}>
                  Tax &amp; Health-Cost Burden ({resolvedLabel})
                </h2>
                {/* Every strategy legitimately owing $0 shows the genuine
                    no-taxable-events copy. */}
                <Muted>
                  No taxable retirement events in this projection. Every year
                  has $0 federal tax, $0 IRMAA surcharge, and $0 ACA premium tax
                  credit. The chart fills in once drawdowns or RMDs generate
                  taxable income.
                </Muted>
              </>
            );
          }
          return (
            <>
              <TaxBurdenBand
                rows={taxBurdenRows}
                markers={markers}
                members={tooltipMembers}
                displayMode={displayMode}
                methodLabel={resolvedLabel}
                subLabel={isMcBasisActive ? MC_TAX_ESTIMATE_SUBLABEL : undefined}
                isMcBasisActive={isMcBasisActive}
              />
              {/* The year-by-year "Taxes & health costs" sub-table reads
                  cashflow-funding fields (IRMAA withheld vs cash-paid,
                  tax-funded withdrawals) the MC representative run never
                  produces, so it is gated OFF under an MC basis (all-$0 rows
                  with "funded from portfolio" tooltips otherwise). It stays
                  fully functional under the deterministic methods. */}
              {!isMcBasisActive && (
                <>
                  <button
                    type="button"
                    className={`report-print-hide ${btnSecondarySmClass} self-start`}
                    aria-expanded={taxDetailOpen}
                    onClick={() => setTaxDetailOpen((open) => !open)}
                  >
                    {taxDetailOpen
                      ? 'Hide taxes & health costs table'
                      : 'Show taxes & health costs table'}
                  </button>
                  {/* Always mounted but `display:none`/out of the a11y tree
                      when collapsed: print reveals only
                      `.bp-print-expand[hidden]`. */}
                  <div hidden={!taxDetailOpen} className="bp-print-expand">
                    <BalanceProjectionTaxDetail
                      drawdownYears={resolvedDrawdown?.years ?? []}
                      viewDeflator={viewDeflator}
                      embedded
                    />
                  </div>
                </>
              )}
            </>
          );
        })()}
      </section>

      {/* Three sibling distribution cards, each gated on its own data so no
          empty card ever renders: Required Minimum Distributions (RMD rows),
          Qualified Charitable Distributions (a QCD in any year), and Roth
          conversions (anything converted). Each band owns its <h2> id
          (`rmd-heading` / `qcd-heading` / `roth-conversions-heading`); the
          outer sections are bare chrome wrappers labelled by those ids. */}
      {rmdRows.length > 0 && (
        <section className={CARD_SECTION_CLASS} aria-labelledby="rmd-heading">
          <RmdBand
            rows={rmdRows}
            totalSurplus={rmdSurplusTotal}
            hasQcd={qcdTotals.totalQcd > 0}
            totalNetTaxableRmd={qcdTotals.totalNetTaxableRmd}
            totalRmdOffset={qcdTotals.totalRmdOffset}
            splitRows={qcdTotals.splitRows}
            markers={markers}
            members={tooltipMembers}
            methodLabel={resolvedLabel}
            subLabel={mcSubLabel}
          />
        </section>
      )}

      {qcdTotals.totalQcd > 0 && (
        <section className={CARD_SECTION_CLASS} aria-labelledby="qcd-heading">
          <QcdBand
            totalQcd={qcdTotals.totalQcd}
            rows={qcdTotals.qcdByYear}
            members={tooltipMembers}
            methodLabel={resolvedLabel}
            subLabel={mcSubLabel}
          />
        </section>
      )}

      {/* Fill-mode "nothing converted" explainer — sits in the Roth
          card's slot, shown when the deterministic projection ran Fill but
          converted $0 (the Roth card may still render beside it when planned
          working-years conversions exist). */}
      {fillNoConversionNotice && (
        <Alert tone="info">{fillNoConversionNotice}</Alert>
      )}

      {rothConvertedTotal > 0 && (
        <section
          className={CARD_SECTION_CLASS}
          aria-labelledby="roth-conversions-heading"
        >
          <RothConversionsBand
            totalRothConverted={rothConvertedTotal}
            rows={rothConversionsSeries}
            members={tooltipMembers}
            methodLabel={resolvedLabel}
            subLabel={mcSubLabel}
          />
        </section>
      )}

      {/* Standing disclosure framing the tax / IRMAA / ACA figures as
          balance-affecting estimates. Adds the projected-first-year-MAGI
          line when the first-year IRMAA look-back was estimated. Adds the
          missing-Medicare-premium readiness warning. */}
      <BalanceProjectionEstimateNote
        magiEstimatedFromProjection={isMcBasisActive ? false : magiEstimatedFromProjection}
        isMcBasisActive={isMcBasisActive}
        medicareBasePremiumMissing={medicareBasePremiumMissing}
        medicaidMayApply={medicaidMayApply}
      />
    </>
  );
};
