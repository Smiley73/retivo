/**
 * Muted text — the typed Tailwind-defaults replacement for the legacy
 * `.muted` class.
 *
 * A de-emphasized inline/block text wrapper (helper copy, captions,
 * secondary metadata). Renders an inline `<span>` by default; pass
 * `as="p"` / `as="div"` where block flow is needed. The `muted` token
 * clears the WCAG AA contrast allowlist (apps/web/src/lib/contrast.ts —
 * "muted text"); dark mode is the `.dark` variable swap.
 *
 * Visual style only — no behavioral contract.
 */
import React from 'react';

interface MutedProps {
  children: React.ReactNode;
  id?: string;
  /** Element to render. Default `span` (inline). */
  as?: 'span' | 'p' | 'div';
  className?: string;
  /**
   * Optional ARIA live-region role. Muted text is usually decorative, but
   * some callers (e.g. a "Copied to clipboard" confirmation) need it
   * announced; `status` is the polite live region for transient,
   * non-urgent feedback.
   */
  role?: 'status' | 'alert';
}

const MUTED_CLASS = 'text-muted';

export const Muted: React.FC<MutedProps> = ({
  children,
  id,
  as: Tag = 'span',
  className,
  role,
}) => {
  const classes = className ? `${MUTED_CLASS} ${className}` : MUTED_CLASS;
  return (
    <Tag id={id} className={classes} role={role}>
      {children}
    </Tag>
  );
};
