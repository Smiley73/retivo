/**
 * First-paint loading placeholders; `LoadingState` owns the `role="status"` announcement and the blocks are
 * `aria-hidden`, so AT hears the state once. The pulse respects `prefers-reduced-motion`.
 */
import React from 'react';

const SKELETON_BLOCK =
  'animate-pulse rounded bg-surface-sunken motion-reduce:animate-none';

interface SkeletonProps {
  className?: string;
}

export const Skeleton: React.FC<SkeletonProps> = ({ className = '' }) => (
  <div aria-hidden="true" className={`${SKELETON_BLOCK} ${className}`} />
);

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
  label: string;
  variant?: LoadingVariant;
  className?: string;
}

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
