/**
 * Skeleton — the shared first-paint loading placeholder (Graphite
 * Spectrum).
 *
 * Replaces the bare `<p>Loading…</p>` strings that used to stand in for
 * still-loading content across the app. A skeleton previews the *shape*
 * of what is coming (a table, a form, a stack of rows) instead of
 * flashing a single word, which reads as faster and avoids the
 * empty-then-full layout jump.
 *
 * `bg-surface-sunken` is a non-text decorative fill, so there is no
 * contrast pair to register (contrast.ts covers text + meaningful
 * UI boundaries only). The shimmer uses Tailwind `animate-pulse` and
 * respects `prefers-reduced-motion` via `motion-reduce:animate-none`.
 *
 * Accessibility: `LoadingState` owns the announcement — a `role="status"`
 * region with `aria-busy` and an `sr-only` label — while the visual
 * blocks are `aria-hidden` so assistive tech hears the state once, not a
 * stream of empty boxes.
 *
 * Visual style only — no behavioral contract.
 */
import React from 'react';

const SKELETON_BLOCK =
  'animate-pulse rounded bg-surface-sunken motion-reduce:animate-none';

interface SkeletonProps {
  /** Sizing / layout-only classes (width + height live here). */
  className?: string;
}

/** A single dimmed placeholder block. Caller supplies width + height. */
export const Skeleton: React.FC<SkeletonProps> = ({ className = '' }) => (
  <div aria-hidden="true" className={`${SKELETON_BLOCK} ${className}`} />
);

/** A stack of text-line placeholders with tapering widths. */
export const SkeletonText: React.FC<{ lines?: number; className?: string }> = ({
  lines = 3,
  className = '',
}) => {
  const widths = ['w-full', 'w-11/12', 'w-5/6', 'w-2/3', 'w-3/4'];
  return (
    <div aria-hidden="true" className={`flex flex-col gap-2.5 ${className}`}>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className={`h-4 ${widths[i % widths.length]} ${SKELETON_BLOCK}`} />
      ))}
    </div>
  );
};

type LoadingVariant = 'rows' | 'table' | 'form';

interface LoadingStateProps {
  /** Screen-reader announcement, e.g. "Loading your accounts…". */
  label: string;
  /** Which content shape to preview. Defaults to a generic row stack. */
  variant?: LoadingVariant;
  /** Layout-only classes on the announcing wrapper. */
  className?: string;
}

/**
 * Drop-in replacement for a page or section "Loading…" placeholder.
 * Announces the loading state once (`role="status"`) and previews the
 * content shape with `aria-hidden` skeleton blocks.
 */
export const LoadingState: React.FC<LoadingStateProps> = ({
  label,
  variant = 'rows',
  className = '',
}) => (
  <div role="status" aria-busy="true" className={className}>
    <span className="sr-only">{label}</span>
    <SkeletonShape variant={variant} />
  </div>
);

const SkeletonShape: React.FC<{ variant: LoadingVariant }> = ({ variant }) => {
  if (variant === 'table') {
    return (
      <div aria-hidden="true" className="flex flex-col gap-2">
        <div className={`h-9 w-full ${SKELETON_BLOCK}`} />
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className={`h-12 w-full ${SKELETON_BLOCK}`} />
        ))}
      </div>
    );
  }
  if (variant === 'form') {
    return (
      <div aria-hidden="true" className="flex max-w-xl flex-col gap-5">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex flex-col gap-2">
            <div className={`h-4 w-28 ${SKELETON_BLOCK}`} />
            <div className={`h-10 w-full ${SKELETON_BLOCK}`} />
          </div>
        ))}
      </div>
    );
  }
  return <SkeletonText lines={4} />;
};
