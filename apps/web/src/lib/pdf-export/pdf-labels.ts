/**
 * Pure string builders for the jsPDF export's cover, header and section labels.
 * Basis wording reuses `resolvedBasisLabel` so the PDF names a basis as the page does.
 */
import type { DisplayMode } from '../view-deflator';
import type { McBasis } from '../monte-carlo';
import type { ProjectionMethod } from '../../components/ProjectionChart';
import { resolvedBasisLabel } from '../../pages/balance-projection-page-constants';
import { pad2 } from './format';

function displayModeLabel(displayMode: DisplayMode): string {
  return displayMode === 'today' ? "Today's dollars" : 'Future dollars';
}

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
  readonly date: { year: number; month: number; day: number };
}

export interface CoverLabels {
  readonly title: string;
  readonly scenarioName: string;
  readonly basisLabel: string;
  readonly displayModeLabel: string;
  readonly generatedOn: string;
}

function formatIsoDate(date: {
  year: number;
  month: number;
  day: number;
}): string {
  return `${date.year}-${pad2(date.month)}-${pad2(date.day)}`;
}

export function buildCoverLabels(params: CoverLabelParams): CoverLabels {
  return {
    title: 'Retirement plan report',
    scenarioName: params.scenarioName,
    basisLabel: basisLabel(params.activeMcBasis, params.activeMethod),
    displayModeLabel: displayModeLabel(params.displayMode),
    generatedOn: `Generated on ${formatIsoDate(params.date)}`,
  };
}

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
 * Methodology caption for an MC-sourced surface, so one illustrative path is not read as an average
 * or band.
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

export function buildReportSectionNote(): string {
  return "Current values; annual amounts in today's dollars.";
}

export function buildInventoryNote(): string {
  return 'Current household entries for the selected scenario.';
}
