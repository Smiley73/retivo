/**
 * Left-aligned teaching placeholder for a surface with no rows yet, with an optional primary action. Renders in a
 * `<Card>` unless `bare`, so empty states share one radius and padding.
 */
import React from 'react';
import { Card } from './Card';

interface EmptyStateProps {
  children: React.ReactNode;
  action?: React.ReactNode;
  bare?: boolean;
  className?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  children,
  action,
  bare = false,
  className = '',
}) => {
  const body = (
    <div className="flex flex-col items-start gap-3">
      <p className="m-0 max-w-prose text-muted">{children}</p>
      {action}
    </div>
  );
  return bare ? (
    <div className={className}>{body}</div>
  ) : (
    <Card className={className}>{body}</Card>
  );
};
