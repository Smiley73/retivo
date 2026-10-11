/**
 * Pure string builders for the unified PDF export's cover / header / section
 * labels. Every function here is a pure string transform — no
 * React, no DOM, no jsPDF — so they are unit-testable in jsdom and reused by
 * both the build pipeline (`build-pdf.ts`) and the render host.
 *
 * Basis + display-mode wording reuses the existing Balance Projection label
 * helper (`resolvedBasisLabel`) so the PDF names a basis exactly as the
 * on-screen page does.
 *
 * Framework-free: pure functions over strings.
 */
import type { DisplayMode } from '../view-deflator';
import type { McBasis } from '../../pages/balance-projection-page-pipeline';
import type { ProjectionMethod } from '../../components/ProjectionChart';
import { resolvedBasisLabel } from '../../pages/balance-projection-page-constants';
import { pad2 } from './format';

/** Human label for the active display basis (today's vs future dollars). */
export function displayModeLabel(displayMode: DisplayMode): string {
  return displayMode === 'today' ? "Today's dollars" : 'Future dollars';
}

/** Label for the active projection basis — the MC tier name when a Monte
 *  Carlo basis is selected, else the deterministic method label. */
function basisLabel(
  activeMcBasis: McBasis | null,
  activeMethod: ProjectionMethod,
): string {
  return resolvedBasisLabel(activeMcBasis, activeMethod);
}

export interface CoverLabelParams {
  readonly scenarioName: string;
  readonly activeMcBasis: McBasis | null;
  readonly activeMethod: ProjectionMethod;
  readonly displayMode: DisplayMode;
  /** Render-clock "now" — the generated-on stamp. Passed as parts so the
   *  builder stays pure (no `new Date()` read). */
  readonly date: { year: number; month: number; day: number };
}

export interface CoverLabels {
  readonly title: string;
  readonly scenarioName: string;
  readonly basisLabel: string;
  readonly displayModeLabel: string;
  readonly generatedOn: string;
}

/** ISO `YYYY-MM-DD` from the date parts (month 1-12, day 1-31). */
export function formatIsoDate(date: {
  year: number;
  month: number;
  day: number;
}): string {
  return `${date.year}-${pad2(date.month)}-${pad2(date.day)}`;
}

/** Build the cover-page labels: title, scenario name, basis, display mode,
 *  and a "Generated on <date>" stamp. */
export function buildCoverLabels(params: CoverLabelParams): CoverLabels {
  return {
    title: 'Retirement plan report',
    scenarioName: params.scenarioName,
    basisLabel: basisLabel(params.activeMcBasis, params.activeMethod),
    displayModeLabel: displayModeLabel(params.displayMode),
    generatedOn: `Generated on ${formatIsoDate(params.date)}`,
  };
}

/** A scoped header label for a section, suffixing the basis + display mode so
 *  each captured surface names the basis that drove it. */
export function buildSectionLabel(
  sectionTitle: string,
  activeMcBasis: McBasis | null,
  activeMethod: ProjectionMethod,
  displayMode: DisplayMode,
): string {
  const basis = basisLabel(activeMcBasis, activeMethod);
  return `${sectionTitle} — ${basis} · ${displayModeLabel(displayMode)}`;
}

/**
 * Methodology caption for an MC-sourced surface. Disambiguates the
 * single representative path from an average / percentile / fan so a reader
 * does not over-read one illustrative line.
 */
export function buildMcMethodologyLabel(
  surface: 'representative' | 'percentile' | 'fan',
): string {
  switch (surface) {
    case 'representative':
      return 'Shows one representative simulated path — not an average or percentile.';
    case 'percentile':
      return 'Shows a percentile of simulated outcomes, not a single path.';
    case 'fan':
      return 'Shows the fan of simulated outcomes (percentile bands), not a single path.';
  }
}

/** Note for the CFP Report inventory sections — current values, annual
 *  amounts, in today's dollars. */
export function buildReportSectionNote(): string {
  return "Current values; annual amounts in today's dollars.";
}

/** Note rendered above an inventory table (accounts / expenses / income),
 *  clarifying these are the household's current entries. */
export function buildInventoryNote(): string {
  return 'Current household entries for the selected scenario.';
}
