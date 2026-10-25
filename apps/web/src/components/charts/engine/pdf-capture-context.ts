/**
 * `true` only while the off-screen Export PDF host captures a chart's `<svg>`; `ChartFrame` then renders an in-SVG
 * legend band, since svg2pdf never captures the HTML `ChartLegend`.
 */
import React from 'react';

export const PdfCaptureContext = React.createContext<boolean>(false);
