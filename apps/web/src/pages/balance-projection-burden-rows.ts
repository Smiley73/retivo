/** Pure row builders for the burden charts, shared by the on-page chart sections and the Export PDF render host so the two cannot drift. */
import type { TaxBurdenChartRow } from '../components/TaxBurdenChart';
import type { RmdChartRow } from '../components/RmdChart';
import type { DrawdownByMethodResult } from './balance-projection-page-data';
import type { DisplayMode } from '../lib/view-deflator';
import type { DrawdownYear } from '../lib/drawdown-engine-types';

function deathYearOf(lastDeathFractional: number | null): number | null {
  return lastDeathFractional !== null && Number.isFinite(lastDeathFractional)
    ? Math.floor(lastDeathFractional)
    : null;
}

// Statutory Medicaid-expansion line: 133% of the federal poverty line plus the 5-point income disregard.
const MEDICAID_EXPANSION_FPL_PERCENT = 138;

/** The engine leaves `fplPercentage` at 0 for a year it did not compute, so 0 means "not computed", never "no income". */
export function hasMedicaidRangeYear(
  years: ReadonlyArray<Pick<DrawdownYear, 'fplPercentage'>>,
): boolean {
  return years.some(
    (yr) =>
      yr.fplPercentage !== undefined &&
      yr.fplPercentage > 0 &&
      yr.fplPercentage <= MEDICAID_EXPANSION_FPL_PERCENT,
  );
}

export interface BuildTaxBurdenRowsArgs {
  readonly resolvedDrawdown: DrawdownByMethodResult | null;
  readonly basisDeflator: (year: number) => number;
  readonly lastDeathFractional: number | null;
  /** Drives the drawdown-phase filter so pre-retirement years (no accountBalances) drop. */
  readonly isMcBasisActive: boolean;
}

/** Per-year tax / health-cost burden rows: MC drawdown-phase filter, death-year clip, basis-aware deflation, ACA-PTC stored negative. */
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
      acaPtcSubsidy: -(((yr.acaPtcSubsidyCents ?? 0) / 100) * d),
      acaCreditApplied: ((yr.acaCreditAppliedToPremiumsCents ?? 0) / 100) * d,
    };
  });
}

export interface BuildRmdRowsArgs {
  readonly drawdown: DrawdownByMethodResult | null;
  readonly basisDeflator: (year: number) => number;
  readonly lastDeathFractional: number | null;
}

/** Per-year RMD rows split into met and shortfall plus the retained surplus, which uses the same source and deflator as the "Total RMD surplus" tile so the sums tie out. */
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
  readonly drawdown: DrawdownByMethodResult | null;
  readonly lastDeathFractional: number | null;
}

/** Converted dollars per year in nominal dollars (never deflated), covering working-years and Fill-mode conversions; the death-year clip applies. */
export function buildRothConversionsSeries(
  args: BuildRothConversionsSeriesArgs,
): { year: number; dollars: number }[] {
  const { drawdown, lastDeathFractional } = args;
  if (!drawdown) return [];
  const deathYear = deathYearOf(lastDeathFractional);
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
  readonly drawdown: DrawdownByMethodResult | null;
  readonly basisDeflator: (year: number) => number;
  readonly lastDeathFractional: number | null;
  /** Today's dollars reverse the per-year qcdInflationFactor; matches the on-screen qcdTotals memo. */
  readonly displayMode: DisplayMode;
}

/** Per-year QCD row; `rmdOffsetDollars + netTaxableRmd` equals the gross IRA-pool RMD, both on the RMD's year-end basisDeflator. */
export interface QcdPdfRow {
  readonly year: number;
  readonly qcdDollars: number;
  readonly netTaxableRmd: number;
  /** Σ_owner qcdRmdOffsetCentsByOwner, each already capped per owner at min(gift, gross IRA RMD); deflated on the RMD basis, not the gift's stamped factor. */
  readonly rmdOffsetDollars: number;
}

/** Per-year QCD rows (qcdCents > 0 only) mirroring the on-screen qcdTotals memo: same deflation, guards and death-year clip. */
export function buildQcdRows(args: BuildQcdRowsArgs): QcdPdfRow[] {
  const { drawdown, basisDeflator, lastDeathFractional, displayMode } = args;
  if (!drawdown) return [];
  const deathYear = deathYearOf(lastDeathFractional);
  const rows: QcdPdfRow[] = [];
  for (const yr of drawdown.years) {
    if (deathYear !== null && yr.year > deathYear) continue;
    const qcdCents = yr.qcdCents ?? 0;
    if (qcdCents <= 0) continue;
    // Today's dollars reverse the engine's stamped inflation factor so a real gift round-trips; a missing or non-positive factor leaves the nominal cents.
    const factor = yr.qcdInflationFactor ?? 1;
    const d = displayMode === 'today' && factor > 0 ? 1 / factor : 1;
    const qcdDollars = (qcdCents / 100) * d;
    // Deflate the net taxable RMD by the year-end basisDeflator, not the gift's stamped factor; guard a non-finite deflator.
    const rmdBasis = basisDeflator(yr.year);
    const rmdDeflator = Number.isFinite(rmdBasis) ? rmdBasis : 0;
    const netTaxableRmd = ((yr.netTaxableRmdCents ?? 0) / 100) * rmdDeflator;
    const offsetCents = Object.values(yr.qcdRmdOffsetCentsByOwner ?? {}).reduce(
      (sum, c) => sum + (Number.isFinite(c) ? c : 0),
      0,
    );
    const rmdOffsetDollars = (offsetCents / 100) * rmdDeflator;
    rows.push({ year: yr.year, qcdDollars, netTaxableRmd, rmdOffsetDollars });
  }
  return rows;
}
