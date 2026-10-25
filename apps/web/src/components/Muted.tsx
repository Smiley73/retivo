/**
 * De-emphasized text wrapper; a `<span>` by default, `as="p"` / `"div"` for block flow. The `muted` token clears the
 * AA contrast allowlist.
 */
import React from 'react';

interface MutedProps {
  children: React.ReactNode;
  id?: string;
  as?: 'span' | 'p' | 'div';
  className?: string;
  /**
   * Live-region role for muted text that must be announced, e.g. a "Copied" confirmation; `status`
   * is polite.
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
