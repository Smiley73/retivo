/**
 * Manifest of the jsPDF export's sections in content order; the render host and the build pipeline both read it.
 */

export interface PdfSectionEntry {
  readonly id: string;
  readonly title: string;
  readonly kind: 'cover' | 'chart' | 'table';
}

/** The ordered section list, in PDF content order. */
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

/** Look up a section's display title by manifest id; throws on an unknown id. */
export function pdfSectionTitle(id: string): string {
  const entry = PDF_SECTION_MANIFEST.find((e) => e.id === id);
  if (!entry) {
    throw new Error(`Unknown PDF section id: ${id}`);
  }
  return entry.title;
}
