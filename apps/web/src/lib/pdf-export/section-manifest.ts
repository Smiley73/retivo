/**
 * Single source-of-truth manifest for the unified PDF export. Lists
 * the expected sections in the exact PDF content order: a cover page,
 * the Balance Projection charts, the Balance Projection tables, the CFP
 * Report inventory + scenario summary, and finally the projected withdrawals
 * table.
 *
 * Both the render host and the build-pipeline test import THIS constant
 * so the rendered section order can never silently drift from the documented
 * order — the test asserts the manifest's shape and the build pipeline emits
 * one section per manifest entry, in order.
 *
 * Framework-free: pure data + types, no React / DOM / jsPDF import.
 */

/** One section's manifest entry. `kind` discriminates the render path the
 *  host takes (a vector chart capture, an autotable, or the cover page). */
export interface PdfSectionEntry {
  readonly id: string;
  readonly title: string;
  readonly kind: 'cover' | 'chart' | 'table';
}

/**
 * The ordered section list (PDF content order). The cover is rendered as the
 * title page; the scenario summary leads (with the household overview folded
 * into it), then accounts, then the projection charts/tables, then income,
 * expenses, and the tax-related charts:
 *   1. Cover page (rendered as the title page).
 *   2. Scenario (household overview + resolved settings + provenance).
 *   3. Accounts inventory, then the per-account projection breakdown.
 *   4. Projection charts — balance, stress-test, expected cashflow, account
 *      balances (by type / by account), annual portfolio flows — + year-by-year.
 *   5. Income (inventory + breakdown chart).
 *   6. Expenses (inventory + overview / by-category charts).
 *   7. Tax-related — RMD, Charitable distributions (QCD), Roth conversions,
 *      Roth tax-free amounts, tax & health-cost burden, tax detail.
 *   8. Projected withdrawals (final section).
 */
export const PDF_SECTION_MANIFEST: ReadonlyArray<PdfSectionEntry> = [
  { id: 'cover', title: 'Cover', kind: 'cover' },

  // --- Scenario summary (the household overview is folded into this page) ---
  { id: 'report-scenarios', title: 'Scenario', kind: 'table' },

  // --- Accounts (current inventory, then the per-account projection) ---
  { id: 'report-accounts', title: 'Accounts', kind: 'table' },
  { id: 'table-account-breakdown', title: 'Per-account breakdown', kind: 'table' },

  // --- Projection charts + year-by-year ---
  { id: 'chart-balance', title: 'Balance projection', kind: 'chart' },
  { id: 'chart-stress-test', title: 'Stress test', kind: 'chart' },
  { id: 'chart-cashflow', title: 'Expected cashflow', kind: 'chart' },
  {
    id: 'chart-account-balances-tier',
    title: 'Account balances over time (by type)',
    kind: 'chart',
  },
  {
    id: 'chart-account-balances-account',
    title: 'Account balances over time (by account)',
    kind: 'chart',
  },
  { id: 'chart-portfolio-flows', title: 'Annual portfolio flows', kind: 'chart' },
  { id: 'table-year-by-year', title: 'Year-by-year detail', kind: 'table' },

  // --- Income ---
  { id: 'report-income', title: 'Income', kind: 'table' },
  { id: 'chart-income-breakdown', title: 'Income breakdown', kind: 'chart' },

  // --- Expenses ---
  { id: 'report-expenses', title: 'Expenses', kind: 'table' },
  { id: 'chart-expenses-total', title: 'Expense overview', kind: 'chart' },
  { id: 'chart-expenses-category', title: 'Expenses by category', kind: 'chart' },

  // --- Tax / RMD / QCD / Roth (tax-related, last) ---
  { id: 'chart-rmd', title: 'Required minimum distributions', kind: 'chart' },
  { id: 'chart-qcd', title: 'Charitable distributions (QCD)', kind: 'chart' },
  { id: 'chart-roth-conversions', title: 'Roth conversions', kind: 'chart' },
  { id: 'table-roth-tax-free', title: 'Roth tax-free amounts', kind: 'table' },
  { id: 'chart-tax-health-cost', title: 'Tax & health-cost burden', kind: 'chart' },
  { id: 'table-tax-detail', title: 'Tax detail', kind: 'table' },

  // --- Projected withdrawals (final section) ---
  { id: 'table-withdrawal-guidance', title: 'Projected withdrawals', kind: 'table' },
];

/**
 * Look up a section's display title by its manifest id — the single source of
 * truth for section names, so a table builder that needs a section's own title
 * (e.g. the projected-withdrawals note spec) derives it here instead of keeping
 * a second hardcoded copy that could silently drift on a future rename. Throws
 * on an unknown id (a programming error — the id set is fixed by this manifest).
 */
export function pdfSectionTitle(id: string): string {
  const entry = PDF_SECTION_MANIFEST.find((e) => e.id === id);
  if (!entry) {
    throw new Error(`Unknown PDF section id: ${id}`);
  }
  return entry.title;
}
