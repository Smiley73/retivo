/**
 * Pure row-builders for the Balance Projection burden charts (Tax & Health-
 * Cost Burden, RMD, Roth conversions, QCD). Extracted verbatim from the
 * useMemo transforms in `balance-projection-page-charts.tsx` so BOTH the
 * on-page chart section AND the off-screen Export PDF render host derive
 * identical rows from the view-model's resolved drawdown (no drift between the
 * screen and the PDF).
 *
 * Pure — no React, no DOM. Each builder reproduces the page's exact death-year
 * flooring, MC drawdown-phase filter (tax), basis-aware deflation, and positive
 * skip conditions. See the source TSDoc in `balance-projection-page-charts.tsx`
 * for the full rationale.
 */
import type { TaxBurdenChartRow } from '../components/TaxBurdenChart';
import type { RmdChartRow } from '../components/RmdChart';
import type { DrawdownByMethodResult } from './balance-projection-page-data';
import type { DisplayMode } from '../lib/view-deflator';

/** Floor the fractional death marker to its integer death year (death = Dec 31
 *  of that year), or `null` when there is no finite death marker. */
function deathYearOf(lastDeathFractional: number | null): number | null {
  return lastDeathFractional !== null && Number.isFinite(lastDeathFractional)
    ? Math.floor(lastDeathFractional)
    : null;
}

export interface BuildTaxBurdenRowsArgs {
  /** Resolved per-year drawdown (representative MC run under an MC basis, else
   *  the deterministic method). `null` ⇒ no rows. */
  readonly resolvedDrawdown: DrawdownByMethodResult | null;
  /** Basis-aware deflator: path CPI under MC + Today's, flat otherwise. */
  readonly basisDeflator: (year: number) => number;
  /** Rightmost death marker's fractional X (floored to the death year). */
  readonly lastDeathFractional: number | null;
  /** True when an MC basis is the resolved basis — drives the drawdown-phase
   *  filter so pre-retirement accumulation years (no `accountBalances`) drop. */
  readonly isMcBasisActive: boolean;
}

/** Per-year tax / health-cost burden rows. Mirrors the page's
 *  `taxBurdenRows` useMemo exactly: MC drawdown-phase filter, death-year clip,
 *  basis-aware deflation, ACA-PTC stored negative. */
export function buildTaxBurdenRows(
  args: BuildTaxBurdenRowsArgs,
): TaxBurdenChartRow[] {
  const { resolvedDrawdown, basisDeflator, lastDeathFractional, isMcBasisActive } =
    args;
  const drawdown = resolvedDrawdown;
  if (!drawdown) return [];
  const deathYear = deathYearOf(lastDeathFractional);
  const phaseFiltered = isMcBasisActive
    ? drawdown.years.filter((yr) => yr.accountBalances !== undefined)
    : drawdown.years;
  const years =
    deathYear !== null
      ? phaseFiltered.filter((yr) => yr.year <= deathYear)
      : phaseFiltered;
  return years.map((yr) => {
    const d = basisDeflator(yr.year);
    return {
      year: yr.year,
      federalTax: ((yr.federalTaxCents ?? 0) / 100) * d,
      irmaaSurcharge: ((yr.irmaaSurchargeCents ?? 0) / 100) * d,
      // Stored negative: ACA-PTC is a benefit (renders below zero).
      acaPtcSubsidy: -(((yr.acaPtcSubsidyCents ?? 0) / 100) * d),
      acaCreditApplied: ((yr.acaCreditAppliedToPremiumsCents ?? 0) / 100) * d,
    };
  });
}

export interface BuildRmdRowsArgs {
  /** Resolved drawdown, OR the deterministic method's drawdown when no MC run
   *  is resolved (the page uses `resolvedDrawdown ?? drawdownByMethod[method]`,
   *  passed pre-resolved here). `null` ⇒ no rows. */
  readonly drawdown: DrawdownByMethodResult | null;
  readonly basisDeflator: (year: number) => number;
  readonly lastDeathFractional: number | null;
}

/** Per-year RMD rows split into met + shortfall, plus the retained (surplus)
 *  portion of the met figure. Mirrors the page's `rmdRows` useMemo: death-year
 *  clip, positive-floor skip, basis-aware deflation. `rmdRetained` uses the
 *  SAME source/death-clip/deflator the "Total RMD surplus" tile consumes —
 *  reinvested + held-as-cash cents — so `Σ rmdRetained` ties out to the tile.
 * In a surplus year the portfolio funds the floor (shortfall === 0), so
 *  retained ⊆ met by construction. */
export function buildRmdRows(args: BuildRmdRowsArgs): RmdChartRow[] {
  const { drawdown, basisDeflator, lastDeathFractional } = args;
  if (!drawdown) return [];
  const deathYear = deathYearOf(lastDeathFractional);
  const years =
    deathYear !== null
      ? drawdown.years.filter((yr) => yr.year <= deathYear)
      : drawdown.years;
  const rows: RmdChartRow[] = [];
  for (const yr of years) {
    const floorCents = yr.rmdFloorCents ?? 0;
    if (floorCents <= 0) continue;
    const shortfallCents = yr.rmdShortfallCents ?? 0;
    const d = basisDeflator(yr.year);
    const metCents = floorCents - shortfallCents;
    const retainedCents =
      (yr.rmdReinvestedCents ?? 0) + (yr.rmdOverflowToCashCents ?? 0);
    rows.push({
      year: yr.year,
      rmdMet: (metCents / 100) * d,
      rmdShortfall: (shortfallCents / 100) * d,
      rmdRetained: (retainedCents / 100) * d,
    });
  }
  return rows;
}

export interface BuildRothConversionsSeriesArgs {
  /** Resolved drawdown, OR the deterministic method's drawdown (pre-resolved by
   *  the caller as `resolvedDrawdown ?? drawdownByMethod[method]`). */
  readonly drawdown: DrawdownByMethodResult | null;
  readonly lastDeathFractional: number | null;
}

/** Per-conversion-year converted dollars, in NOMINAL dollars (never deflated).
 *  Covers both working-years (pre-retirement) Roth conversions from
 *  `drawdown.preRetirementConversionCentsByYear` and Fill-mode post-retirement
 *  auto-conversions from `DrawdownYear.rothConvertedCents`. The chart shows the
 *  ACTUAL dollars converted each year for every bar — no basis deflation.
 *  Death-year clip and positive-cents skip applied to both ranges.
 *  0 conversions ⇒ empty series. */
export function buildRothConversionsSeries(
  args: BuildRothConversionsSeriesArgs,
): { year: number; dollars: number }[] {
  const { drawdown, lastDeathFractional } = args;
  if (!drawdown) return [];
  const deathYear = deathYearOf(lastDeathFractional);
  // Accumulate cents per year so pre-retirement and post-retirement entries
  // for the same calendar year merge cleanly (shouldn't overlap in practice).
  const centsByYear = new Map<number, number>();
  for (const [year, cents] of drawdown.preRetirementConversionCentsByYear ?? []) {
    if (deathYear !== null && year > deathYear) continue;
    if (cents > 0) centsByYear.set(year, (centsByYear.get(year) ?? 0) + cents);
  }
  for (const yr of drawdown.years) {
    if (deathYear !== null && yr.year > deathYear) continue;
    const cents = yr.rothConvertedCents ?? 0;
    if (cents > 0) centsByYear.set(yr.year, (centsByYear.get(yr.year) ?? 0) + cents);
  }
  return Array.from(centsByYear.entries())
    .sort(([a], [b]) => a - b)
    .map(([year, cents]) => ({ year, dollars: cents / 100 }));
}

export interface BuildQcdRowsArgs {
  /** Resolved drawdown, OR the deterministic method's drawdown (pre-resolved by
   *  the caller). `null` ⇒ no rows. */
  readonly drawdown: DrawdownByMethodResult | null;
  readonly basisDeflator: (year: number) => number;
  readonly lastDeathFractional: number | null;
  /** Whether to deflate to today's dollars (reverses per-year qcdInflationFactor)
   *  or keep nominal. Matches the on-screen qcdTotals memo in
   *  balance-projection-page-charts.tsx. */
  readonly displayMode: DisplayMode;
}

/** Per-year QCD row: the amount given directly from a traditional IRA to
 *  charity (already deflated to the page's display-dollars basis), the
 *  remaining net taxable IRA RMD after the gift, and the RMD-offset slice —
 *  the part of the gross IRA-pool RMD the gift covered (`min(gift, gross)` per
 *  owner, summed). Shared by `buildQcdRows`, `buildQcdTableSpec`
 *  (pdf-tables.ts), and the render host's `qcdRows` prop.
 *
 *  Invariant (per year): `rmdOffsetDollars + netTaxableRmd = gross IRA-pool RMD`
 *  (both deflated on the RMD's year-end `basisDeflator`). The QCD-RMD split bar
 *  reads these two fields; the standalone QCD chart + PDF table read `qcdDollars`
 *  (the full gift, reversed on its stamped year-end engine factor) and
 *  `netTaxableRmd`. */
export interface QcdPdfRow {
  readonly year: number;
  readonly qcdDollars: number;
  readonly netTaxableRmd: number;
  /** The part of the gross IRA-pool RMD the gift covered (tax-free) —
   *  Σ_owner `qcdRmdOffsetCentsByOwner` / 100 × `basisDeflator(year)` (each
   *  owner entry already per-owner-capped at `min(gift, that owner's gross IRA
   *  RMD)`, so no household cross-netting). Deflated on the RMD's year-end
   *  `basisDeflator` (the RMD basis), NOT the gift's stamped factor, so
   *  `rmdOffsetDollars + netTaxableRmd` is a single-basis gross IRA RMD.
   *  0 in a pre-RMD gift year (no gross RMD to offset) or when the map is
   *  missing. */
  readonly rmdOffsetDollars: number;
}

/** Per-year QCD rows: the amount given directly from a traditional IRA to
 *  charity (already deflated to the page's display-dollars basis) and the
 *  remaining net taxable IRA RMD after the gift. Only years with `qcdCents > 0`
 *  are returned. Mirrors the on-screen `qcdTotals` useMemo bit-for-bit (same
 *  deflation, same guards, same death-year clip) so the PDF chart + table match
 *  the on-screen chart exactly. */
export function buildQcdRows(args: BuildQcdRowsArgs): QcdPdfRow[] {
  const { drawdown, basisDeflator, lastDeathFractional, displayMode } = args;
  if (!drawdown) return [];
  const deathYear = deathYearOf(lastDeathFractional);
  const rows: QcdPdfRow[] = [];
  for (const yr of drawdown.years) {
    if (deathYear !== null && yr.year > deathYear) continue;
    const qcdCents = yr.qcdCents ?? 0;
    if (qcdCents <= 0) continue;
    // Today's-dollars: reverse the engine's exact stamped inflation factor
    // (year-end anchor in both engines) so the REAL gift round-trips.
    // Future-dollars (or a missing/zero factor): the nominal cents as-is.
    // Guard against a missing/≤0 factor (no NaN/Infinity).
    const factor = yr.qcdInflationFactor ?? 1;
    const d = displayMode === 'today' && factor > 0 ? 1 / factor : 1;
    const qcdDollars = (qcdCents / 100) * d;
    // The net-taxable-RMD is an RMD-floor figure, not the gift — deflate it by
    // the year-END basisDeflator (the RMD chart + tax-detail column's basis),
    // NOT the QCD's stamped factor. basisDeflator already encodes the
    // today's-vs-future mode (identity under Future-dollars), so no displayMode
    // branch here. Guard a non-finite deflator (no NaN/Infinity chart data).
    const rmdBasis = basisDeflator(yr.year);
    const rmdDeflator = Number.isFinite(rmdBasis) ? rmdBasis : 0;
    const netTaxableRmd = ((yr.netTaxableRmdCents ?? 0) / 100) * rmdDeflator;
    // The RMD-offset slice — the part of the gross IRA-pool RMD the gift covered
    // (`min(gift, gross)` per owner, summed). Deflated on the SAME RMD year-end
    // basis so `rmdOffsetDollars + netTaxableRmd` is a single-basis gross IRA RMD.
    // 0 on a missing per-owner map (pre-RMD gift year / no offset).
    const offsetCents = Object.values(yr.qcdRmdOffsetCentsByOwner ?? {}).reduce(
      (sum, c) => sum + (Number.isFinite(c) ? c : 0),
      0,
    );
    const rmdOffsetDollars = (offsetCents / 100) * rmdDeflator;
    rows.push({ year: yr.year, qcdDollars, netTaxableRmd, rmdOffsetDollars });
  }
  return rows;
}
