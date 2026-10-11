/**
 * Notes indicator — small info-icon that surfaces a row's hidden notes
 * / comment field on hover or keyboard focus. Adopted by the list-view
 * surfaces whose notes are not rendered inline (account balances rows,
 * accounts, account-balances list, scenarios, income streams, SS
 * benefits).
 *
 * A11y design: the trigger is the shared
 * `<Tooltip>`'s focusable wrapper (`<Focusable>` + `<span tabIndex={0}>`),
 * NOT a nested `<button>` — nesting a button inside Tooltip's wrapper
 * would create double-focusable invalid markup. The icon SVG carries
 * `role="img" aria-label="Notes"` so the trigger has an accessible
 * name; Tooltip wires `aria-describedby` to the bubble text. Screen
 * reader announces "Notes, [note text]".
 *
 * Render rule: nothing when `(notes ?? '').trim()` is empty — handles
 * null / undefined / whitespace uniformly.
 */
import React from 'react';
import { InfoCircleIcon } from './InfoCircleIcon';
import { Tooltip } from './Tooltip';

interface NotesIndicatorProps {
  notes: string | null | undefined;
}

// The `muted` token on the card surface — an AA pair already in
// `contrast.ts`. Dark mode is the `.dark` variable swap.
const ICON_CLASS =
  'inline-flex items-center text-muted align-middle';

export const NotesIndicator: React.FC<NotesIndicatorProps> = ({ notes }) => {
  const trimmed = (notes ?? '').trim();
  if (trimmed.length === 0) return null;
  return (
    <Tooltip content={trimmed} multiline>
      <span className={ICON_CLASS}>
        {/* role="img" + aria-label are the accessible-name source for
            the Tooltip's focusable wrapper; the bubble text rides
            aria-describedby. */}
        <InfoCircleIcon role="img" ariaLabel="Notes" />
      </span>
    </Tooltip>
  );
};
