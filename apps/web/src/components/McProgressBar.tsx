/**
 * Reusable determinate Monte-Carlo progress bar — a React Aria
 * `ProgressBar` driven by `done` / `total` path counts. The verbatim
 * "Simulating market histories — X of Y paths" label rides on
 * `aria-label`; sighted users see a short text line + the visual bar.
 *
 * When `total` is 0 or unknown (the worker hasn't reported a path total
 * yet), the bar renders in indeterminate mode (no `value`/`maxValue`,
 * an animated full-width sweep) so the running state still reads as
 * "working" without a misleading 0 %.
 *
 * Mirrors the SS-optimizer MC progress-bar a11y pattern
 * (`ss-optimizer-mc-progress-bar.tsx`): label on `aria-label`, a small
 * visible text line, and the `valueText` exposed `sr-only`.
 */
import React from 'react';
import { ProgressBar } from 'react-aria-components';

export interface McProgressBarProps {
  /** Paths completed so far. */
  readonly done: number;
  /** Total paths in the sweep. `0` (or unknown) → indeterminate mode. */
  readonly total: number;
  /** Override the accessible/visible label prefix. Defaults to
   *  "Simulating market histories". */
  readonly label?: string;
  /** What `done`/`total` are counted in, for the "X of Y <unit>" reading.
   *  Defaults to "paths". Pass this whenever the bar counts something else
   *  (cases, scenarios) so the label does not claim path units it isn't in. */
  readonly unit?: string;
  /** Hide the visible text line (the bar shows alone); the label still
   *  rides `aria-label` + the `sr-only` value for assistive tech. Use when
   *  the surrounding context already names what is running. */
  readonly hideLabel?: boolean;
  /** Override the wrapper className (sizing/layout). Defaults to a
   *  `min-w-48` stacked bar; pass a narrower width for inline placements. */
  readonly className?: string;
}

const DEFAULT_LABEL = 'Simulating market histories';

/** Compact thousands-grouped count (e.g. `6,200`). */
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
