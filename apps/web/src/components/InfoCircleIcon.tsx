/**
 * Shared info-circle SVG icon. Extracted from NotesIndicator so
 * MonteCarloMethodologyModal's trigger can share the same glyph
 * without duplicating the path.
 *
 * Renders a Heroicons-style information-circle outline at 14×14 px.
 * Callers own the `role` + accessible-name wiring (aria-label /
 * aria-labelledby / aria-hidden) appropriate for their context:
 *   - NotesIndicator: role="img" aria-label="Notes" (descriptive icon)
 *   - MC modal trigger: aria-hidden="true" (button carries the label)
 */
import React from 'react';

interface InfoCircleIconProps {
  /** SVG role — "img" for descriptive icons, omit (defaults to none)
   *  when the parent button carries the accessible name. */
  role?: 'img' | 'presentation';
  /** Accessible label. Required when role="img"; omit when decorative. */
  ariaLabel?: string;
  /** Width in px. Default 14. */
  width?: number;
  /** Height in px. Default 14. */
  height?: number;
  className?: string;
}

export const InfoCircleIcon: React.FC<InfoCircleIconProps> = ({
  role,
  ariaLabel,
  width = 14,
  height = 14,
  className,
}) => (
  <svg
    role={role}
    aria-label={ariaLabel}
    aria-hidden={role ? undefined : true}
    focusable="false"
    viewBox="0 0 20 20"
    fill="currentColor"
    width={width}
    height={height}
    className={className}
  >
    {/* Heroicons information-circle outline glyph. */}
    <path
      fillRule="evenodd"
      d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-11.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zM9 9a.75.75 0 000 1.5h.25v3.25a.75.75 0 001.5 0V10a1 1 0 00-1-1H9z"
      clipRule="evenodd"
    />
  </svg>
);
