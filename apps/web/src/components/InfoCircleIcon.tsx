/** Shared 14×14 information-circle glyph; callers own the `role` and accessible-name wiring. */
import React from 'react';

interface InfoCircleIconProps {
  /** SVG role: `"img"` for descriptive icons, omit when the parent carries the name. */
  role?: 'img' | 'presentation';
  /** Accessible label; required when `role="img"`. */
  ariaLabel?: string;
  width?: number;
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
    <path
      fillRule="evenodd"
      d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-11.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zM9 9a.75.75 0 000 1.5h.25v3.25a.75.75 0 001.5 0V10a1 1 0 00-1-1H9z"
      clipRule="evenodd"
    />
  </svg>
);
