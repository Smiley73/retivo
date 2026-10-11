/**
 * Unified PDF export orchestrator.
 *
 * Two cleanly separated halves:
 *
 *   1. `buildPdfSectionModel` — a PURE assembly step. Given the already-
 *      display-transformed rows/series + labels (NEVER raw engine data, NEVER
 *      re-deflated), it returns an ordered `PdfSectionModel` with one
 *      section per `PDF_SECTION_MANIFEST` entry, in manifest order. This is the
 *      tested surface: deterministic, no jsPDF, no DOM.
 *
 *   2. `buildAndDownloadPdf` — a thin RENDER step. It lazy-loads the jsPDF
 *      trio (injectable loader), walks the section model, captures
 *      each chart SVG (svg2pdf), renders each table (jspdf-autotable), and
 *      triggers the browser download. It only forwards already-prepared data to
 *      library calls, so it is in `vitest.config.ts` `coverage.exclude`.
 *
 * Framework-free: no React / JSX. The render step touches DOM (SVG nodes,
 * download anchor) but holds no component state.
 */
import {
  PDF_SECTION_MANIFEST,
  type PdfSectionEntry,
} from './section-manifest';
import {
  buildCoverLabels,
  buildSectionLabel,
  type CoverLabels,
} from './pdf-labels';
import {
  buildAccountBreakdownTableSpec,
  buildPortfolioFlowsTableSpec,
  buildReportAccountsTableSpec,
  buildReportExpensesTableSpec,
  buildReportIncomeTableSpec,
  buildRothTaxFreeTableSpec,
  buildYearByYearTableSpec,
  formatDollars,
  type PdfTableSpec,
} from './pdf-tables';
import { captureChartSvg } from './capture-chart-svg';
import {
  defaultPdfLibLoader,
  type PdfLibLoader,
} from './lazy-load';
import type { DisplayMode } from '../view-deflator';
import type { McBasis } from '../../pages/balance-projection-page-pipeline';
import type { ProjectionMethod } from '../../components/ProjectionChart';
import type { YearlyTableRow } from '../../pages/balance-projection-page-yearly';
import type { PortfolioFlowYear } from '../../pages/balance-projection-page-yearly-builders';
import type { ReportData, ReportHouseholdOverview } from '../report-data';
import type { ReportScenarioSettingGroup } from '../report-scenario-settings';
import { ONE_LINE_DISCLAIMER } from '../disclaimer-fragments';
import { APP_NAME, OPEN_SOURCE_TEXT, REPO_HOST_PATH, REPO_URL } from '../brand';
import { formatAgeYearsMonths } from '../format-age';

/** Per-kind section payload. A `cover` carries the cover labels; a `chart`
 *  carries the section header (the SVG itself is supplied separately at render
 *  time, keyed by section id); a `table` carries its autotable spec (or `null`
 *  when that table has no rows for the current scenario). */
type PdfSectionData =
  | { readonly kind: 'cover'; readonly labels: CoverLabels }
  | { readonly kind: 'chart'; readonly header: string; readonly tableSpec: PdfTableSpec | null }
  | { readonly kind: 'table'; readonly header: string; readonly spec: PdfTableSpec | null };

interface PdfSection {
  readonly manifest: PdfSectionEntry;
  readonly data: PdfSectionData;
}

export interface PdfSectionModel {
  readonly sections: ReadonlyArray<PdfSection>;
  readonly coverLabels: CoverLabels;
}

export interface BuildPdfSectionModelParams {
  readonly scenarioName: string;
  readonly activeMcBasis: McBasis | null;
  readonly activeMethod: ProjectionMethod;
  readonly displayMode: DisplayMode;
  /** Already display-transformed year-by-year rows. */
  readonly unifiedYearTableRows: ReadonlyArray<YearlyTableRow>;
  /** Already display-transformed annual portfolio flows, or `null`. */
  readonly portfolioFlowsByYear: ReadonlyArray<PortfolioFlowYear> | null;
  /** The CFP Report inventory + scenario data. */
  readonly reportData: ReportData;
  /** Render-clock "now" (month 1-12, day 1-31). */
  readonly date: { year: number; month: number; day: number };
  /** Per-chart-section data tables, keyed by manifest section id. A chart
   *  section gets a `tableSpec` only when an entry is present (tie this to the
   *  same data-presence gate the render host uses, so a chart never has a table
   *  without its chart, or vice-versa). Built (display-basis) by the page
   *  from `vm` / `expenseProjection` via the `pdf-tables` builders. */
  readonly chartTablesBySection?: ReadonlyMap<string, PdfTableSpec>;
  /** The withdrawal-guidance table spec (the PDF's final section), or `null`
   *  when it has no rows. A page-built `table`-kind spec with no existing
   *  channel, so it gets its own field (NOT folded into the chart-scoped
   *  `chartTablesBySection` map). Built (display-basis) by the page via the
   *  pure `buildWithdrawalGuidanceSectionSpec` selection helper — the MC note,
   *  the empty note, or the full table. */
  readonly withdrawalGuidanceTableSpec?: PdfTableSpec | null;
  /** Manifest section ids to leave out of the export entirely — the sections
   *  of beta features the user has not switched on (`lib/feature-flags.ts`
   *  `hiddenBetaPdfSectionIds`). Manifest order is preserved for the rest. */
  readonly excludedSectionIds?: ReadonlySet<string>;
}

/** Map a manifest table id to its autotable spec from the already-transformed
 *  inputs. Returns `null` when that table type has no data source yet (the
 *  remaining chart-derived tables + tax detail have none);
 *  a `null` spec causes the section to be skipped entirely (no page emitted). */
function tableSpecForSection(
  id: string,
  params: BuildPdfSectionModelParams,
): PdfTableSpec | null {
  switch (id) {
    case 'table-year-by-year':
      return buildYearByYearTableSpec(
        params.unifiedYearTableRows,
        params.activeMethod,
      );
    case 'chart-portfolio-flows':
      // The portfolio-flow table spec is built only when the caller supplies the numbers.
      return params.portfolioFlowsByYear
        ? buildPortfolioFlowsTableSpec(params.portfolioFlowsByYear)
        : null;
    case 'table-account-breakdown':
      return buildAccountBreakdownTableSpec(params.reportData.accounts);
    case 'report-accounts':
      return buildReportAccountsTableSpec(params.reportData.accounts);
    case 'report-expenses':
      return buildReportExpensesTableSpec(params.reportData.expenses);
    case 'report-income':
      return buildReportIncomeTableSpec(params.reportData.incomeStreams);
    case 'table-roth-tax-free':
      // A household with no Roth accounts has no rows — `null` skips the
      // page entirely, the same empty-table gate every other section
      // uses.
      return params.reportData.rothTaxFreeAmounts.length > 0
        ? buildRothTaxFreeTableSpec(params.reportData.rothTaxFreeAmounts)
        : null;
    case 'table-withdrawal-guidance':
      // Page-built (the MC note / empty note / full table chosen by the pure
      // selection helper); `null` when the page supplied none.
      return params.withdrawalGuidanceTableSpec ?? null;
    default:
      return null;
  }
}

/**
 * Pure assembly of the ordered section model. One section per manifest entry
 * (minus any `excludedSectionIds`), in manifest order, so the rendered PDF
 * order can never drift.
 */
export function buildPdfSectionModel(
  params: BuildPdfSectionModelParams,
): PdfSectionModel {
  const coverLabels = buildCoverLabels({
    scenarioName: params.scenarioName,
    activeMcBasis: params.activeMcBasis,
    activeMethod: params.activeMethod,
    displayMode: params.displayMode,
    date: params.date,
  });

  const excluded = params.excludedSectionIds;
  const includedEntries = excluded
    ? PDF_SECTION_MANIFEST.filter((entry) => !excluded.has(entry.id))
    : PDF_SECTION_MANIFEST;
  const sections: PdfSection[] = includedEntries.map((entry) => {
    if (entry.kind === 'cover') {
      return { manifest: entry, data: { kind: 'cover' as const, labels: coverLabels } };
    }
    const header = buildSectionLabel(
      entry.title,
      params.activeMcBasis,
      params.activeMethod,
      params.displayMode,
    );
    if (entry.kind === 'chart') {
      return {
        manifest: entry,
        data: {
          kind: 'chart' as const,
          header,
          tableSpec: params.chartTablesBySection?.get(entry.id) ?? null,
        },
      };
    }
    return {
      manifest: entry,
      data: {
        kind: 'table' as const,
        header,
        spec: tableSpecForSection(entry.id, params),
      },
    };
  });

  return { sections, coverLabels };
}

// ---------------------------------------------------------------------------
// Thin render step (coverage-excluded): forwards the prepared model to the
// lazy-loaded jsPDF / autotable / svg2pdf libraries. No display logic here.
// ---------------------------------------------------------------------------

/** Fixed chart draw width (PDF points) — every chart embeds at this width so
 *  the charts stay visually consistent page to page. */
const CHART_DRAW_WIDTH = 500;
/** Top of the chart area on a page (below the section title). */
const CHART_TOP = 70;
/** Single-chart max draw height — a touch shorter than the full page so the
 *  chart's data table has room to start on the same page before paginating. */
const CHART_MAX_HEIGHT = 360;
/** Gap between a chart's bottom edge and the start of its data table. */
const CHART_TABLE_GAP = 24;
/** Body/head font size for every autotable — small so dense year-by-year and
 *  per-account tables stay readable without spilling across many pages. */
const TABLE_FONT_SIZE = 7;
/** Shared autotable style options (render-only). */
const TABLE_STYLES = { fontSize: TABLE_FONT_SIZE, cellPadding: 2 } as const;
/** Totals rows stay visually distinct and appear once, on the table's last page. */
const TABLE_FOOT_STYLES = {
  fontStyle: 'bold' as const,
  fillColor: [238, 240, 242] as [number, number, number],
  textColor: [0, 0, 0] as [number, number, number],
  lineWidth: 0.5,
  lineColor: [120, 120, 120] as [number, number, number],
};
const SCENARIO_CONTENT_LEFT = 40;
const SCENARIO_CONTENT_WIDTH = 515;
const SCENARIO_CONTENT_BOTTOM = 795;
const SCENARIO_CONTINUATION_HEADING_Y = 50;
const SCENARIO_CONTENT_RESTART_Y = 74;
const SCENARIO_TABLE_FIRST_ROW_RESERVE = 22;
const SCENARIO_TABLE_BOTTOM_MARGIN = 47;
/** Retivo's PDF cover lockup redraws the solid favicon at half scale,
 *  matched to the wordmark's visible cap height. */
const BRAND_ACCENT_RGB = [14, 101, 73] as const;
const BRAND_DOT = { x: 47, y: 63, radius: 7 } as const;
const BRAND_WORDMARK = { x: 68, y: 69 } as const;

/** Read an SVG's height-to-width aspect ratio from its `viewBox` (the chart
 *  engine emits `0 0 <w> <h>`, where `h` already includes the PDF legend band).
 *  Falls back to numeric width/height attributes, then a sane landscape
 *  default. Used to derive a NON-distorting draw height for each chart so the
 *  fixed-width embed never stretches the vector (the engine SVGs carry
 *  `preserveAspectRatio="none"`, so the draw rect must match the true aspect). */
/* c8 ignore start -- exercised only in a real export (svg2pdf path) */
function svgAspectRatio(svg: SVGElement): number {
  const vb = svg.getAttribute('viewBox');
  if (vb) {
    const parts = vb.split(/[\s,]+/).map(Number);
    if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
      return parts[3] / parts[2];
    }
  }
  const w = Number(svg.getAttribute('width'));
  const h = Number(svg.getAttribute('height'));
  if (w > 0 && h > 0) return h / w;
  return 0.45;
}
/* c8 ignore stop */

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

type ReportOverviewMember = ReportHouseholdOverview['members'][number];

function formatScenarioRetirementAge(
  age: ReportOverviewMember['retirementAge'],
): string {
  return age.months === 6 ? `${age.years}.5` : formatAgeYearsMonths(age);
}

function buildScenarioMemberLine(member: ReportOverviewMember): string {
  const segments = [`- ${member.name}`];
  if (member.currentAge != null) segments.push(`age ${member.currentAge}`);
  const month =
    member.retirementMonth != null &&
    member.retirementMonth >= 1 &&
    member.retirementMonth <= MONTH_NAMES.length
      ? MONTH_NAMES[member.retirementMonth - 1]
      : null;
  const retirementDate =
    member.retirementYear == null
      ? ''
      : ` ${month ? `${month} ` : ''}${member.retirementYear}`;
  segments.push(
    `retires${retirementDate} at age ${formatScenarioRetirementAge(member.retirementAge)}`,
  );
  return segments.join(' · ');
}

/** Display label for the legal-disclaimer page heading + its Table-of-Contents
 *  entry — single-sourced so the two can never drift. */
const IMPORTANT_INFO_TITLE = 'Important Information';

function tableFootOptions(spec: PdfTableSpec): {
  foot?: string[][];
  showFoot?: 'lastPage';
  footStyles?: typeof TABLE_FOOT_STYLES;
} {
  if (!spec.foot) return {};
  return {
    foot: spec.foot,
    showFoot: 'lastPage',
    footStyles: TABLE_FOOT_STYLES,
  };
}

/** Parse a `#RRGGBB` hex string to jsPDF's numeric RGB channels, or `null`
 *  when the input is absent / malformed (caller keeps the default text color). */
/* c8 ignore start -- render-only color helper (jsPDF setTextColor path) */
function hexToRgb(hex: string | undefined): { r: number; g: number; b: number } | null {
  if (!hex) return null;
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return null;
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}
/* c8 ignore stop */

export interface BuildAndDownloadPdfParams {
  readonly sectionModel: PdfSectionModel;
  /** Live SVG nodes for the `chart` sections, keyed by manifest section id.
   *  A missing entry means that chart isn't mounted and is skipped. */
  readonly svgElementsBySection: ReadonlyMap<string, SVGElement>;
  readonly filename: string;
  /** Injectable loader — tests pass a mock so no real jsPDF loads. */
  readonly loader?: PdfLibLoader;
  readonly signal?: AbortSignal;
  /** Optional disclaimer text appended as a final page after all sections. */
  readonly disclaimer?: string;
  /** Household overview, folded into the Scenario page (portfolio, annual
   *  contributions, members, projection milestones). */
  readonly overview?: ReportHouseholdOverview;
  /** MC plan success rate (0–1), or `null` when no MC result / not applicable. */
  readonly successProbability?: number | null;
  /** Hex color (`#RRGGBB`) for the success-probability figure — the standardized
   *  red/amber/green tier (`successTierForPct`), resolved by the page so this
   *  render step stays framework-free. Omit → neutral text color. */
  readonly successProbabilityColor?: string;
  /** Estimated portfolio balance at the primary retirement year, in the active
   *  display unit (today's or future dollars). Omit when unavailable. */
  readonly atRetirementBalance?: number | null;
  /** Estimated portfolio balance at the end-of-horizon year, in the active
   *  display unit. Omit when unavailable. */
  readonly atHorizonBalance?: number | null;
  /** Active scenario's single-line description (omit / empty to render none). */
  readonly scenarioDescription?: string;
  /** Active scenario's multi-line notes (omit / empty to render none). */
  readonly scenarioNotes?: string;
  /** Grouped scenario settings for the Scenario page (one small table per
   *  group). Empty / omitted → the Scenario section emits no page. */
  readonly scenarioSettingGroups?: ReadonlyArray<ReportScenarioSettingGroup>;
}

export async function buildAndDownloadPdf(
  params: BuildAndDownloadPdfParams,
): Promise<void> {
  const loader = params.loader ?? defaultPdfLibLoader;
  const { jsPDF, autoTable, svg2pdf } = await loader();
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });

  // Generated-on date string, shared by the title page and the running footer.
  const generatedDate = params.sectionModel.coverLabels.generatedOn.replace(
    'Generated on ',
    '',
  );

  // Table-of-contents bookkeeping: page 3 is reserved up front, then filled once
  // every section's true start page is known (autotable pagination shifts page
  // numbers, so they only resolve after the full render completes).
  let tocPageNumber: number | null = null;
  const tocEntries: Array<{ title: string; page: number }> = [];

  for (const section of params.sectionModel.sections) {
    if (section.data.kind === 'cover') {
      const { labels } = section.data;

      // ----- Page 1: title page -----
      // App brand: the transparent favicon's solid pine dot redrawn as a
      // fill-only vector, so no external asset has to load in the PDF pipeline.
      doc.setFillColor(...BRAND_ACCENT_RGB);
      doc.circle(BRAND_DOT.x, BRAND_DOT.y, BRAND_DOT.radius, 'F');
      doc.setTextColor(...BRAND_ACCENT_RGB);
      doc.setFontSize(18);
      doc.text(APP_NAME, BRAND_WORDMARK.x, BRAND_WORDMARK.y);
      doc.setTextColor(0, 0, 0);

      // Open-source line, page-one provenance only, with a real external link
      // to the repo (not repeated per page).
      doc.setFontSize(9);
      doc.setTextColor(90, 90, 90);
      doc.textWithLink(OPEN_SOURCE_TEXT, 40, 104, { url: REPO_URL });
      doc.setTextColor(0, 0, 0);

      doc.setFontSize(26);
      doc.text('Retirement Planning Report', 40, 150);

      const household =
        params.overview && params.overview.members.length > 0
          ? params.overview.members.map((m) => m.name).join('  ·  ')
          : params.overview?.householdName || '—';

      const fields: ReadonlyArray<{ label: string; value: string }> = [
        { label: 'SCENARIO', value: labels.scenarioName },
        { label: 'DATE', value: generatedDate },
        { label: 'BASIS', value: `${labels.basisLabel}  ·  ${labels.displayModeLabel}` },
        { label: 'HOUSEHOLD', value: household },
      ];
      let y = 205;
      for (const f of fields) {
        doc.setFontSize(10);
        doc.setTextColor(120, 120, 120);
        doc.text(f.label, 40, y);
        doc.setTextColor(0, 0, 0);
        doc.setFontSize(15);
        doc.text(f.value, 40, y + 19);
        y += 50;
      }
      // The scenario description + notes now lead the Scenario page (not the
      // cover) so they sit with the rest of the scenario detail.

      // ----- Page 2: "Important Information" legal disclaimer -----
      if (params.disclaimer) {
        doc.addPage();
        const importantInfoPage = doc.getNumberOfPages();
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(16);
        doc.text(IMPORTANT_INFO_TITLE, 40, 60);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(12);
        /* c8 ignore next -- splitTextToSize uses real jsPDF font metrics */
        const lines = doc.splitTextToSize(params.disclaimer, 515) as string[];
        doc.text(lines, 40, 88);
        // ToC entry for the disclaimer page. Pushed here (during cover
        // processing, before any content section) so it leads the ToC (A-11).
        tocEntries.push({ title: IMPORTANT_INFO_TITLE, page: importantInfoPage });
      }

      // ----- Page 3: table of contents (reserved here, filled at the end) -----
      doc.addPage();
      tocPageNumber = doc.getNumberOfPages();

      doc.setFontSize(12);
      continue;
    }

    // Decide whether this section emits a page.
    if (section.data.kind === 'chart') {
      // Skip chart sections whose SVG element isn't mounted — no page emitted.
      if (!params.svgElementsBySection.has(section.manifest.id)) continue;
    }
    if (section.data.kind === 'table') {
      // The Scenario page renders from the render-step params (overview +
      // grouped settings), not an autotable spec; every other table needs a
      // non-null spec.
      if (section.manifest.id === 'report-scenarios') {
        if (!params.overview && !params.scenarioSettingGroups?.length) continue;
      } else if (!section.data.spec) {
        continue;
      }
    }

    doc.addPage();
    tocEntries.push({ title: section.manifest.title, page: doc.getNumberOfPages() });

    /* c8 ignore start -- render-only Scenario page header (jsPDF text) */
    if (section.manifest.id === 'report-scenarios') {
      // Kicker label (the generic section title) above the scenario name.
      doc.setFontSize(10);
      doc.setTextColor(120, 120, 120);
      doc.text('SCENARIO', SCENARIO_CONTENT_LEFT, SCENARIO_CONTINUATION_HEADING_Y);
      doc.setTextColor(0, 0, 0);

      let sy = SCENARIO_CONTENT_RESTART_Y;
      const drawScenarioContinuationHeading = (): void => {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(12);
        doc.setTextColor(0, 0, 0);
        doc.text(
          'Scenario (continued)',
          SCENARIO_CONTENT_LEFT,
          SCENARIO_CONTINUATION_HEADING_Y,
        );
        doc.setFont('helvetica', 'normal');
      };
      const addScenarioContinuation = (): void => {
        doc.addPage();
        drawScenarioContinuationHeading();
        sy = SCENARIO_CONTENT_RESTART_Y;
      };
      const beginScenarioBlock = (
        gap: number,
        lastReservedBaselineOffset = 0,
      ): void => {
        if (sy + gap + lastReservedBaselineOffset > SCENARIO_CONTENT_BOTTOM) {
          addScenarioContinuation();
          return;
        }
        sy += gap;
      };
      const writeScenarioLines = (
        lines: ReadonlyArray<string>,
        lineHeight: number,
        applyStyle: () => void,
      ): void => {
        for (const line of lines) {
          if (sy > SCENARIO_CONTENT_BOTTOM) addScenarioContinuation();
          applyStyle();
          doc.text(line, SCENARIO_CONTENT_LEFT, sy);
          sy += lineHeight;
        }
      };

      // --- Scenario name + description + notes (top of the page) ---
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(18);
      doc.text(
        params.sectionModel.coverLabels.scenarioName,
        SCENARIO_CONTENT_LEFT,
        sy,
      );
      doc.setFont('helvetica', 'normal');
      sy += 4;

      if (params.scenarioDescription && params.scenarioDescription.trim()) {
        const lines = doc.splitTextToSize(
          params.scenarioDescription.trim(),
          SCENARIO_CONTENT_WIDTH,
        ) as string[];
        beginScenarioBlock(16);
        writeScenarioLines(lines, 13, () => {
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(10.5);
          doc.setTextColor(60, 60, 60);
        });
        doc.setTextColor(0, 0, 0);
      }
      if (params.scenarioNotes && params.scenarioNotes.trim()) {
        const lines = doc.splitTextToSize(
          params.scenarioNotes.trim(),
          SCENARIO_CONTENT_WIDTH,
        ) as string[];
        beginScenarioBlock(12);
        writeScenarioLines(lines, 12, () => {
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(9.5);
          doc.setTextColor(110, 110, 110);
        });
        doc.setTextColor(0, 0, 0);
      }

      // --- Success probability: prominent + red/amber/green tier color ---
      if (params.successProbability != null) {
        beginScenarioBlock(26, 30);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        doc.setTextColor(120, 120, 120);
        doc.text('PLAN SUCCESS PROBABILITY', SCENARIO_CONTENT_LEFT, sy);
        doc.setTextColor(0, 0, 0);
        sy += 30;
        const rgb = hexToRgb(params.successProbabilityColor);
        if (rgb) doc.setTextColor(rgb.r, rgb.g, rgb.b);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(32);
        doc.text(
          `${Math.round(params.successProbability * 100)}%`,
          SCENARIO_CONTENT_LEFT,
          sy,
        );
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(0, 0, 0);
        sy += 6;
      }

      // --- Household overview (folded in from the former overview page) ---
      const ov = params.overview;
      if (ov) {
        beginScenarioBlock(22, 15);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        doc.setTextColor(0, 0, 0);
        doc.text(
          `Total portfolio: ${formatDollars(ov.totalCurrentPortfolio)}`,
          SCENARIO_CONTENT_LEFT,
          sy,
        );
        sy += 15;
        doc.text(
          `Annual contributions: ${formatDollars(ov.annualContributionRunRate)}/yr`,
          SCENARIO_CONTENT_LEFT,
          sy,
        );
        sy += 22;

        if (ov.members.length > 0) {
          const memberLines = ov.members.map(
            (member) =>
              doc.splitTextToSize(
                buildScenarioMemberLine(member),
                SCENARIO_CONTENT_WIDTH,
              ) as string[],
          );
          beginScenarioBlock(0, 16);
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(11);
          doc.setTextColor(0, 0, 0);
          doc.text('Members', SCENARIO_CONTENT_LEFT, sy);
          doc.setFont('helvetica', 'normal');
          sy += 16;
          for (const lines of memberLines) {
            writeScenarioLines(lines, 15, () => {
              doc.setFont('helvetica', 'normal');
              doc.setFontSize(10);
              doc.setTextColor(0, 0, 0);
            });
          }
          sy += 8;
        }

        const milestoneLines = [
          ...(params.atRetirementBalance != null
            ? [
                `At retirement (estimated): ${formatDollars(
                  params.atRetirementBalance,
                )}`,
              ]
            : []),
          ...(params.atHorizonBalance != null
            ? [`At horizon (estimated): ${formatDollars(params.atHorizonBalance)}`]
            : []),
        ];
        if (milestoneLines.length > 0) {
          beginScenarioBlock(0, 16);
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(11);
          doc.setTextColor(0, 0, 0);
          doc.text('Projection milestones', SCENARIO_CONTENT_LEFT, sy);
          doc.setFont('helvetica', 'normal');
          sy += 16;
          writeScenarioLines(milestoneLines, 15, () => {
            doc.setFont('helvetica', 'normal');
            doc.setFontSize(10);
            doc.setTextColor(0, 0, 0);
          });
          sy += 8;
        }
      }

      // --- Resolved scenario settings (one small table per titled group) ---
      let isFirstSettingGroup = true;
      for (const group of params.scenarioSettingGroups ?? []) {
        beginScenarioBlock(
          isFirstSettingGroup ? 14 : 0,
          SCENARIO_TABLE_FIRST_ROW_RESERVE,
        );
        isFirstSettingGroup = false;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.setTextColor(0, 0, 0);
        doc.text(group.title, SCENARIO_CONTENT_LEFT, sy);
        doc.setFont('helvetica', 'normal');
        autoTable(doc, {
          body: group.rows.map((r) => [r.label, r.value]),
          startY: sy + 8,
          styles: TABLE_STYLES,
          // Fixed label column + auto value column so long values wrap instead
          // of overflowing the page (jspdf-autotable linebreak overflow).
          columnStyles: { 0: { cellWidth: 175 }, 1: { cellWidth: 'auto' } },
          margin: {
            top: SCENARIO_CONTENT_RESTART_Y,
            bottom: SCENARIO_TABLE_BOTTOM_MARGIN,
          },
          didDrawPage: (data) => {
            if (data.pageNumber > 1) drawScenarioContinuationHeading();
          },
        });
        const finalY = (doc as unknown as { lastAutoTable?: { finalY?: number } })
          .lastAutoTable?.finalY;
        sy = (finalY ?? sy + 8 + group.rows.length * 14) + 22;
      }
      continue;
    }
    /* c8 ignore stop */

    doc.setFontSize(12);
    doc.text(section.manifest.title, 40, 50);

    if (section.data.kind === 'chart') {
      const svg = params.svgElementsBySection.get(section.manifest.id);
      /* c8 ignore next -- svg2pdf walks real SVG layout, untestable in jsdom */
      if (svg) {
        // One chart per page: draw at its true aspect (no stretch), capped a
        // little short of full height so the data table has room beneath it.
        let w = CHART_DRAW_WIDTH;
        let h = w * svgAspectRatio(svg);
        if (h > CHART_MAX_HEIGHT) {
          w *= CHART_MAX_HEIGHT / h;
          h = CHART_MAX_HEIGHT;
        }
        await captureChartSvg(svg, doc, svg2pdf, 40, CHART_TOP, w, h);
        // The chart's data table flows under it (autotable paginates the rest).
        /* c8 ignore next -- tableSpec rendering exercised via the table path */
        if (section.data.tableSpec) {
          autoTable(doc, {
            head: section.data.tableSpec.head,
            body: section.data.tableSpec.body,
            ...tableFootOptions(section.data.tableSpec),
            startY: CHART_TOP + h + CHART_TABLE_GAP,
            styles: TABLE_STYLES,
          });
        }
      }
      continue;
    }

    if (section.data.kind === 'table' && section.data.spec) {
      autoTable(doc, {
        head: section.data.spec.head,
        body: section.data.spec.body,
        ...tableFootOptions(section.data.spec),
        startY: 70,
        styles: TABLE_STYLES,
      });
    }
  }

  // Fill the reserved table-of-contents page now that every section's start
  // page is known. Each row links to its page (jsPDF internal GoTo action).
  if (tocPageNumber !== null && tocEntries.length > 0) {
    doc.setPage(tocPageNumber);
    doc.setFontSize(16);
    doc.text('Table of Contents', 40, 60);
    doc.setFontSize(11);
    let tocY = 92;
    for (const entry of tocEntries) {
      doc.textWithLink(entry.title, 40, tocY, { pageNumber: entry.page });
      doc.text(String(entry.page), 555, tocY, { align: 'right' });
      tocY += 20;
    }
  }

  // Running header + footer on every page (header skipped on the title page).
  const totalPages = doc.getNumberOfPages();
  doc.setFontSize(8);
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    if (i > 1) {
      doc.text(APP_NAME, 40, 24);
      doc.text(generatedDate, 555, 24, { align: 'right' });
    }
    doc.text(`Page ${i} of ${totalPages}`, 555, 825, { align: 'right' });
    doc.text(REPO_HOST_PATH, 40, 825);
    // Per-page legal line (C-2): a detached PDF page still carries the
    // illustrative-estimates disclaimer. Centered between the repo address + page number.
    doc.text(ONE_LINE_DISCLAIMER, 297, 825, { align: 'center' });
  }

  if (params.signal?.aborted) return;
  /* c8 ignore next -- triggers a browser download, untestable in jsdom */
  doc.save(params.filename);
}
