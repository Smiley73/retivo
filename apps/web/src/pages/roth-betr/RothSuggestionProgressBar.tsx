/** Progress bar for a running Roth conversion comparison; ticks are finished candidate plans. */
import React from 'react';
import { ProgressBar } from 'react-aria-components';

interface RothSuggestionProgressBarProps {
  /** Candidate plans finished. */
  readonly done: number;
  /** Candidate plans in the comparison. */
  readonly total: number;
}

export const RothSuggestionProgressBar: React.FC<RothSuggestionProgressBarProps> = ({
  done,
  total,
}) => {
  const current = Math.min(done + 1, Math.max(1, total));
  return (
    <ProgressBar
      minValue={0}
      maxValue={Math.max(1, total)}
      value={Math.min(done, Math.max(1, total))}
      aria-label={`candidate ${current} / ${total}`}
      className="flex min-w-80 flex-col gap-1"
    >
      {({ percentage, valueText }) => (
        <>
          <span className="text-xs text-ink">
            Plan {current} of {total} · {Math.round(percentage ?? 0)}%
          </span>
          <div className="h-2 w-full overflow-hidden rounded-full bg-surface-sunken">
            <div
              className="h-full bg-accent w-[var(--roth-suggestion-progress-pct)]"
              // eslint-disable-next-line no-restricted-syntax -- runtime-dynamic progress width bridged via --roth-suggestion-progress-pct
              style={{ ['--roth-suggestion-progress-pct' as string]: `${percentage ?? 0}%` }}
            />
          </div>
          <span className="sr-only">{valueText}</span>
        </>
      )}
    </ProgressBar>
  );
};
