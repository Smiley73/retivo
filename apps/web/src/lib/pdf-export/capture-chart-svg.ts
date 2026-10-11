/**
 * Pure SVG-vector capture for the unified PDF export.
 *
 * Takes an already-mounted `SVGElement` (the app's in-house SVG chart engine
 * renders real `<svg>` nodes) plus a jsPDF doc + position params and
 * embeds the chart as a VECTOR via svg2pdf.js (no raster screenshot). No React
 * here — the caller hands in the live DOM node.
 *
 * Thin library-call wrapper: it does nothing but forward to svg2pdf, so it is
 * untestable in jsdom (svg2pdf walks real SVG layout + canvas APIs jsdom lacks)
 * and is listed in `vitest.config.ts` `coverage.exclude`.
 */
import type { jsPDF } from 'jspdf';

/** The svg2pdf.js vector-embed function, injected by the caller (lazy-loaded
 *  via `PdfLibLoader`) so this module carries no static `svg2pdf.js` import. */
type Svg2pdfFn = typeof import('svg2pdf.js').svg2pdf;

/**
 * Embed `svgElement` into `doc` at `(x, y)` scaled to `width` × `height`
 * (PDF points). Resolves once the vector is written. Errors propagate to the
 * caller so the export path can surface a failure.
 */
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
