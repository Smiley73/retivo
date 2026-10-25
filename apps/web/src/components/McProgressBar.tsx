/**
 * Determinate Monte Carlo progress bar on React Aria `ProgressBar`, indeterminate while `total` is 0 or unknown; the
 * label rides on `aria-label` and the `valueText` is `sr-only`.
 */
import React from 'react';
import { ProgressBar } from 'react-aria-components';

export interface McProgressBarProps {
  readonly done: number;
  /** Total in the sweep; `0` or unknown renders indeterminate. */
  readonly total: number;
  /** Label prefix; defaults to "Simulating market histories". */
  readonly label?: string;
  /**
   * Unit `done` / `total` are counted in; defaults to "paths". Set it when the bar counts cases or
   * scenarios.
   */
  readonly unit?: string;
  /** Hides the visible text line; the label still rides `aria-label` and the `sr-only` value. */
  readonly hideLabel?: boolean;
  /** Wrapper className; defaults to a `min-w-48` stacked bar. */
  readonly className?: string;
}

const DEFAULT_LABEL = 'Simulating market histories';

function fmtCount(n: number): string {
  return n.toLocaleString('en-US');
}

export const McProgressBar: React.FC<McProgressBarProps> = ({
  done,
  total,
  label = DEFAULT_LABEL,
  unit = 'paths',
  hideLabel = false,
  className = 'flex min-w-48 flex-col gap-1',
}) => {
  const indeterminate = !(total > 0);
  const countText = `${label}: ${fmtCount(done)} of ${fmtCount(total)} ${unit}`;
  const ariaLabel = indeterminate ? `${label}: preparing simulation` : countText;

  return (
    <ProgressBar
      isIndeterminate={indeterminate}
      minValue={0}
      maxValue={indeterminate ? undefined : total}
      value={indeterminate ? undefined : done}
      aria-label={ariaLabel}
      className={className}
    >
      {({ percentage, valueText }) => (
        <>
          {!hideLabel && (
            <span className="text-xs text-muted">
              {indeterminate ? `${label}…` : countText}
            </span>
          )}
          <div className="h-2 w-full overflow-hidden rounded-full bg-surface-sunken">
            {indeterminate ? (
              <div className="h-full w-1/3 animate-pulse rounded-full bg-accent" />
            ) : (
              <div
                className="h-full rounded-full bg-accent w-[var(--mc-progress-pct)]"
                // eslint-disable-next-line no-restricted-syntax -- runtime-dynamic progress width bridged via --mc-progress-pct (mirrors ss-optimizer-mc-progress-bar)
                style={{ ['--mc-progress-pct' as string]: `${percentage ?? 0}%` }}
              />
            )}
          </div>
          <span className="sr-only">
            {indeterminate ? `${label}…` : valueText}
          </span>
        </>
      )}
    </ProgressBar>
  );
};
