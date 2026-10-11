/**
 * PDF-capture flag for the bespoke chart engine. `true` only while the
 * off-screen Export PDF render host is capturing a chart's `<svg>`; default
 * `false` everywhere else. `ChartFrame` reads it to render an in-SVG legend
 * band (svg2pdf captures only the `<svg>`, so the on-screen HTML `ChartLegend`
 * never reaches the PDF). On screen the flag is false and the SVG is unchanged.
 */
import React from 'react';

export const PdfCaptureContext = React.createContext<boolean>(false);
