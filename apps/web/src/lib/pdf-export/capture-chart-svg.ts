/** Embeds a mounted `SVGElement` into a jsPDF doc as a vector via svg2pdf.js; not testable in jsdom (needs real SVG layout and canvas). */
import type { jsPDF } from 'jspdf';

type Svg2pdfFn = typeof import('svg2pdf.js').svg2pdf;

/** Embed `svgElement` into `doc` at `(x, y)` scaled to `width` × `height` points; errors propagate. */
export async function captureChartSvg(
  svgElement: SVGElement,
  doc: jsPDF,
  svg2pdf: Svg2pdfFn,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<void> {
  await svg2pdf(svgElement, doc, { x, y, width, height });
}
