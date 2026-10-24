/** Bottom chart sections of the Balance Projection page: tax and health-cost burden, RMD, QCD and Roth conversion cards, plus the standing estimate note. */
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
  /** The representative MC run when an MC basis is active, else the deterministic method; the tax-burden and RMD charts read this. */
  readonly resolvedDrawdown: DrawdownByMethodResult | null;
  readonly resolvedLabel: string;
  readonly isMcBasisActive: boolean;
  /** Flat deflator, kept only for the deterministic-only Taxes & health-costs table (gated off under MC). */
  readonly viewDeflator: (year: number, monthIndex?: number) => number;
  /** Path CPI under MC + Today's, the flat `viewDeflator` otherwise; drives every MC-sourced surface here. */
  readonly basisDeflator: (year: number) => number;
  readonly markers: ReadonlyArray<CashflowChartMarker>;
  readonly tooltipMembers: ReadonlyArray<TooltipMember>;
  readonly displayMode: DisplayMode;
  readonly lastDeathFractional: number | null;
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
  const [taxDetailOpen, setTaxDetailOpen] = useState(false);

  const drawdownYears = useMemo(
    () => resolvedDrawdown?.years ?? drawdownByMethod?.[activeMethod]?.years ?? [],
    [resolvedDrawdown, drawdownByMethod, activeMethod],
  );

  const magiEstimatedFromProjection = useMemo(
    () => drawdownYears.some((yr) => yr.magiEstimatedFromProjection === true),
    [drawdownYears],
  );

  // Read off the deterministic drawdown: only its post-pass stamps the flag, so keying off `drawdownYears` dropped the disclosure under an MC basis.
  const medicareBasePremiumMissing = useMemo(
    () =>
      (drawdownByMethod?.[activeMethod]?.years ?? []).some(
        (yr) => yr.medicareBasePremiumMissing === true,
      ) || drawdownYears.some((yr) => yr.medicareBasePremiumMissing === true),
    [drawdownByMethod, activeMethod, drawdownYears],
  );

  // Read off the deterministic drawdown too: the MC representative run never stamps `fplPercentage`.
  const medicaidMayApply = useMemo(
    () => hasMedicaidRangeYear(drawdownByMethod?.[activeMethod]?.years ?? []),
    [drawdownByMethod, activeMethod],
  );

  // Rows past the integer death year are dropped; the death-year row carries full annual values (death is Dec 31).
  // Under MC the run spans pre-retirement years with no per-account balances or tax; the shared builder filters to the drawdown phase, never by taxable signal, so zero-tax drawdown years are kept.
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

  const rmdRows = useMemo(
    (): RmdChartRow[] =>
      buildRmdRows({
        drawdown: resolvedDrawdown ?? drawdownByMethod?.[activeMethod] ?? null,
        basisDeflator,
        lastDeathFractional,
      }),
    [resolvedDrawdown, drawdownByMethod, activeMethod, basisDeflator, lastDeathFractional],
  );

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

  // Built by the shared buildQcdRows so the on-page chart and the PDF render host derive identical rows.
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
    // Filter to offset + net > 0: buildQcdRows also emits pre-RMD gift years with a $0 gross RMD. One deflation path keeps the column sums equal to the tiles.
    const splitRows = rows
      .filter((r) => r.rmdOffsetDollars + r.netTaxableRmd > 0)
      .map((r) => ({
        year: r.year,
        rmdOffsetDollars: r.rmdOffsetDollars,
        netTaxableDollars: r.netTaxableRmd,
      }));
    return { totalQcd, totalNetTaxableRmd, totalRmdOffset, qcdByYear, splitRows };
  }, [resolvedDrawdown, drawdownByMethod, activeMethod, displayMode, basisDeflator, lastDeathFractional]);

  // Nominal dollars converted each year (no basis deflation), so the bars sum to the tile.
  const rothConversionsSeries = useMemo(
    (): { year: number; dollars: number }[] =>
      buildRothConversionsSeries({
        drawdown: resolvedDrawdown ?? drawdownByMethod?.[activeMethod] ?? null,
        lastDeathFractional,
      }),
    [resolvedDrawdown, drawdownByMethod, activeMethod, lastDeathFractional],
  );

  const rothConvertedTotal = useMemo(
    (): number =>
      rothConversionsSeries.reduce((sum, r) => sum + r.dollars, 0),
    [rothConversionsSeries],
  );

  // Fill is on but nothing converted. Reads the deterministic drawdown, never the resolved one: a per-path zero under MC is not a per-plan zero.
  // Planned working-years conversions are not Fill conversions, so the copy says Fill "did not convert anything".
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

  const mcSubLabel = isMcBasisActive ? MC_REPRESENTATIVE_RUN_SUBLABEL : undefined;

  return (
    <>
      {/* The no-signal branch renders the same heading id itself so the section always has an accessible name. */}
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
              {/* Gated off under MC: the table reads cashflow-funding fields the representative run never produces. */}
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
                  {/* Always mounted but hidden when collapsed; print reveals only .bp-print-expand[hidden]. */}
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

      <BalanceProjectionEstimateNote
        magiEstimatedFromProjection={isMcBasisActive ? false : magiEstimatedFromProjection}
        isMcBasisActive={isMcBasisActive}
        medicareBasePremiumMissing={medicareBasePremiumMissing}
        medicaidMayApply={medicaidMayApply}
      />
    </>
  );
};
