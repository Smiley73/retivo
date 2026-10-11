/**
 * ChartZoomReset — "Reset view" button for zoomed SVG-engine charts.
 *
 * Returns null when the chart is not zoomed, so the button only appears
 * after a drag-zoom. The visible text "Reset view" is the accessible name;
 * no aria-label needed.
 *
 * Raw <button> + btnSecondarySmClass (dialog-chrome.ts).
 * React Aria Button not needed — AGENTS.md "ask before" only flags
 * <input>/<select>/<table>/<details>, not <button>.
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
