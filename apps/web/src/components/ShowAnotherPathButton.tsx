/**
 * "Show another likely path" reroll beside the Monte Carlo basis selector. Disabled uses `aria-disabled`, not native
 * `disabled`, so the control stays focusable and its reason reachable (WCAG 2.2 AA).
 */
import React, { useCallback } from 'react';
import { btnSecondarySmClass } from './dialog-chrome';

const DISABLED_REASON = 'Only one likely path for this outcome';
const HINT_ID = 'show-another-path-hint';

export function ShowAnotherPathButton({
  enabled,
  onShowAnotherPath,
}: {
  readonly enabled: boolean;
  readonly onShowAnotherPath: () => void;
}) {
  const onClick = useCallback(() => {
    if (enabled) onShowAnotherPath();
  }, [enabled, onShowAnotherPath]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (enabled) onShowAnotherPath();
      }
    },
    [enabled, onShowAnotherPath],
  );

  return (
    <>
      <button
        type="button"
        // Appearance keys off `aria-disabled` and overrides the secondary button's hover so a
        // disabled hover is not mistaken for interactive.
        className={`${btnSecondarySmClass} aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-surface-raised`}
        aria-disabled={enabled ? undefined : 'true'}
        aria-describedby={enabled ? undefined : HINT_ID}
        onClick={onClick}
        onKeyDown={onKeyDown}
      >
        Show another likely path
      </button>
      {!enabled && (
        <span id={HINT_ID} className="sr-only">
          {DISABLED_REASON}
        </span>
      )}
    </>
  );
}
