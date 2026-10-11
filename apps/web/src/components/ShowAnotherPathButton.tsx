/**
 * "Show another likely path" reroll control for the Balance Projection page.
 *
 * Sits beside the chart's Monte Carlo basis selector. When an MC basis is
 * active and the active tier's card-consistent band has ≥2 members, clicking
 * (or pressing Enter/Space) rerolls the basis line to a different
 * representative path from the CURRENT sample — same seed, same depletion
 * cards/percentiles. The depletion cards never move.
 *
 * Disabled state uses `aria-disabled="true"` (NOT native `disabled`) so the
 * control stays keyboard-focusable and its reason ("Only one likely path for
 * this outcome") stays reachable for keyboard / assistive-tech users
 * (WCAG 2.2 AA) — mirroring the disclaimer "I Agree" gate idiom (the
 * native-disabled vs `aria-disabled` split). A guarded no-op handler swallows a
 * pre-gate click / Enter / Space.
 */
import React, { useCallback } from 'react';
import { btnSecondarySmClass } from './dialog-chrome';

const DISABLED_REASON = 'Only one likely path for this outcome';
const HINT_ID = 'show-another-path-hint';

export function ShowAnotherPathButton({
  enabled,
  onShowAnotherPath,
}: {
  /** `true` when an MC basis is active AND its band has ≥2 members. */
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
        // Muted/inert appearance keys off `aria-disabled` — the control stays
        // focusable (never the native `disabled` attribute), so a keyboard / AT
        // user can land on it and hear the reason. The `aria-disabled:` variants
        // override the secondary button's hover so a disabled hover is not
        // mistaken for interactive.
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
