/**
 * Vertical dashed reference markers with slot-staggered labels in the top margin; each line carries
 * `data-marker-label` for tests, and the colour comes from the caller already theme-resolved.
 */
import React from 'react';
import { labelAnchorForX, markerSlotDy } from '../../../lib/chart-markers';
import type { ChartGeometry, MarkerSpec } from './types';
import { xToPx } from './scales';

interface MarkersProps {
  markers: MarkerSpec[];
  geometry: ChartGeometry;
  xDomain: [number, number];
}

const LABEL_FONT = 11;

export const Markers: React.FC<MarkersProps> = ({ markers, geometry, xDomain }) => {
  const { plot } = geometry;
  const bottom = plot.y + plot.height;
  return (
    <g aria-hidden="true">
      {markers.map((m) => {
        if (m.clipToDomain && (m.x < xDomain[0] || m.x > xDomain[1])) return null;
        const px = xToPx(m.x, xDomain, plot);
        const labelY = plot.y + markerSlotDy(m.slot);
        const anchor = labelAnchorForX(m.x, xDomain[0], xDomain[1]);
        return (
          <g key={`${m.label}-${m.x}`}>
            <line
              data-marker-label={m.label}
              x1={px}
              y1={plot.y}
              x2={px}
              y2={bottom}
              stroke={m.color}
              strokeDasharray="4 4"
            />
            <text
              x={px}
              y={labelY}
              fill={m.color}
              fontSize={LABEL_FONT}
              textAnchor={anchor}
              className="chart-marker-label"
            >
              {m.label}
            </text>
          </g>
        );
      })}
    </g>
  );
};
