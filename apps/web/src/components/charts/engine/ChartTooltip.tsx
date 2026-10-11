/**
 * HTML tooltip overlay for the SVG chart engine. Positioned absolutely
 * over the chart at the hovered datum's pixel x. The chart-specific body
 * (the rows of series values) is supplied by the caller as `children` —
 * the engine only owns positioning + the theme-reactive surface chrome.
 *
 * The absolute `left`/`top` of an HTML overlay div cannot be expressed
 * as SVG presentation attributes, so this is the one place the engine
 * uses an inline `style` (the chart engine's runtime-geometry carve-out in
 * the UI coding standards of AGENTS.md).
 */
import React from 'react';

interface ChartTooltipProps {
  /** Pixel x within the chart container where the tooltip anchors. */
  px: number;
  /** Container width, to flip the tooltip left of the cursor near the edge. */
  containerWidth: number;
  children: React.ReactNode;
}

const TOOLTIP_OFFSET = 12;
const ESTIMATED_WIDTH = 200;

export const ChartTooltip: React.FC<ChartTooltipProps> = ({
  px,
  containerWidth,
  children,
}) => {
  const flip = px + TOOLTIP_OFFSET + ESTIMATED_WIDTH > containerWidth;
  const left = flip ? px - TOOLTIP_OFFSET - ESTIMATED_WIDTH : px + TOOLTIP_OFFSET;
  return (
    <div
      className="pointer-events-none absolute top-2 z-10"
      // eslint-disable-next-line no-restricted-syntax -- runtime tooltip/crosshair geometry, chart-engine carve-out
      style={{ left: `${Math.max(0, left)}px` }}
    >
      {children}
    </div>
  );
};
