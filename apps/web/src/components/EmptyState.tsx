/**
 * Empty-state block — a teaching placeholder for a list/detail surface that
 * has no rows yet. One short line that says what the surface holds and why it
 * matters, plus an optional primary call to action (a `TextLink` route or a
 * `<button>` styled with `textLinkClass`) so the next step lives in the empty
 * space, not only in the page header.
 *
 * Left-aligned to match the page's reading flow — a centered block in an
 * otherwise left-aligned layout reads as a separate surface. Renders inside a
 * `<Card>` by default so every empty state shares the one card radius +
 * padding (`rounded-2xl p-6`); pass `bare` when the caller already supplies a
 * Card or other framed container.
 *
 * Visual style only — no behavioral contract.
 */
import React from 'react';
import { Card } from './Card';

interface EmptyStateProps {
  /** Teaching copy: what this surface holds and why it matters. One or two short sentences. */
  children: React.ReactNode;
  /** Optional primary CTA — a `TextLink` or a `<button className={textLinkClass}>`. */
  action?: React.ReactNode;
  /** Skip the wrapping `<Card>` when the caller already renders a framed container. */
  bare?: boolean;
  /** Extra layout-only classes appended to the outer element. */
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
