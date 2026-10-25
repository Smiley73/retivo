/**
 * HTML tooltip overlay positioned at the hovered datum; the caller supplies the body. The absolute `left` cannot be
 * an SVG attribute, so this is the engine's inline-style carve-out (AGENTS.md "UI coding standards").
 */
import React from 'react';

interface ChartTooltipProps {
  px: number;
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
