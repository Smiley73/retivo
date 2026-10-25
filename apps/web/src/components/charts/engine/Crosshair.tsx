/**
 * Pointer crosshair for the chart engine: an SVG vertical line at the hovered datum plus a drag-marquee `<rect>`
 * during zoom selection.
 */
import React from 'react';
import { useChartChrome } from '../../../lib/use-chart-tokens';
import type { ChartGeometry } from './types';
import { xToPx } from './scales';

interface CrosshairProps {
  hoverX: number | null;
  geometry: ChartGeometry;
  xDomain: [number, number];
  dragSelection: [number, number] | null;
  marqueeFill: string;
  marqueeStroke: string;
}

export const Crosshair: React.FC<CrosshairProps> = ({
  hoverX,
  geometry,
  xDomain,
  dragSelection,
  marqueeFill,
  marqueeStroke,
}) => {
  const chrome = useChartChrome();
  const { plot } = geometry;
  const bottom = plot.y + plot.height;
  return (
    <g aria-hidden="true">
      {hoverX !== null && (
        <line
          data-testid="chart-crosshair"
          x1={xToPx(hoverX, xDomain, plot)}
          y1={plot.y}
          x2={xToPx(hoverX, xDomain, plot)}
          y2={bottom}
          stroke={chrome.axis}
          strokeDasharray="2 2"
        />
      )}
      {dragSelection && (
        <rect
          data-testid="chart-drag-marquee"
          x={Math.min(
            xToPx(dragSelection[0], xDomain, plot),
            xToPx(dragSelection[1], xDomain, plot),
          )}
          y={plot.y}
          width={Math.abs(
            xToPx(dragSelection[1], xDomain, plot) -
              xToPx(dragSelection[0], xDomain, plot),
          )}
          height={plot.height}
          fill={marqueeFill}
          stroke={marqueeStroke}
          strokeOpacity={0.6}
          strokeDasharray="2 2"
        />
      )}
    </g>
  );
};
