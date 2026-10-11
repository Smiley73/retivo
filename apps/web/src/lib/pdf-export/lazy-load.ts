/**
 * Injectable dynamic-import loader for the PDF library trio.
 *
 * The `jspdf` / `jspdf-autotable` / `svg2pdf.js` libraries are heavy and only
 * needed on the export path, so they are lazy-loaded via dynamic `import()`
 * (kept out of the main bundle). The loader is injectable so tests substitute
 * a mock — no real jsPDF (which touches canvas / fonts) ever loads under the
 * jsdom test runner.
 *
 * Framework-free: a function type + the default real loader.
 */

/** The resolved library trio the build pipeline calls into. */
export interface PdfLibs {
  readonly jsPDF: typeof import('jspdf').jsPDF;
  readonly autoTable: typeof import('jspdf-autotable').default;
  readonly svg2pdf: typeof import('svg2pdf.js').svg2pdf;
}

/** Loads the PDF library trio. Tests substitute this with a mock. */
export type PdfLibLoader = () => Promise<PdfLibs>;

/** The production loader: dynamic-imports the trio in parallel. */
export const defaultPdfLibLoader: PdfLibLoader = () =>
  Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
    import('svg2pdf.js'),
  ]).then(([{ jsPDF }, { default: autoTable }, { svg2pdf }]) => ({
    jsPDF,
    autoTable,
    svg2pdf,
  }));
