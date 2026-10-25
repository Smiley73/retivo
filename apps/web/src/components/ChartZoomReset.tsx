/**
 * "Reset view" button for zoomed charts; renders null when not zoomed. A raw `<button>`, since AGENTS.md "ask before"
 * flags only input, select, table and details.
 */
import React from 'react';
import { btnSecondarySmClass } from './dialog-chrome';

export interface ChartZoomResetProps {
  isZoomed: boolean;
  onReset: () => void;
}

export const ChartZoomReset: React.FC<ChartZoomResetProps> = ({
  isZoomed,
  onReset,
}) => {
  if (!isZoomed) return null;
  return (
    <button type="button" className={btnSecondarySmClass} onClick={onReset}>
      Reset view
    </button>
  );
};
