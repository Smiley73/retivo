/**
 * Injectable dynamic-import loader for jspdf, jspdf-autotable and svg2pdf.js, kept out of the main bundle.
 * Tests substitute a mock so real jsPDF (canvas, fonts) never loads under jsdom.
 */

interface PdfLibs {
  readonly jsPDF: typeof import('jspdf').jsPDF;
  readonly autoTable: typeof import('jspdf-autotable').default;
  readonly svg2pdf: typeof import('svg2pdf.js').svg2pdf;
}

/** Loads the PDF library trio. */
export type PdfLibLoader = () => Promise<PdfLibs>;

/** The production loader. */
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
