/**
 * Info icon that surfaces a row's hidden notes on hover or focus; renders nothing for empty notes. The trigger is the
 * shared `<Tooltip>`'s focusable wrapper, not a nested `<button>`, which would be double-focusable invalid markup.
 */
import React from 'react';
import { InfoCircleIcon } from './InfoCircleIcon';
import { Tooltip } from './Tooltip';

interface NotesIndicatorProps {
  notes: string | null | undefined;
}

const ICON_CLASS =
  'inline-flex items-center text-muted align-middle';

export const NotesIndicator: React.FC<NotesIndicatorProps> = ({ notes }) => {
  const trimmed = (notes ?? '').trim();
  if (trimmed.length === 0) return null;
  return (
    <Tooltip content={trimmed} multiline>
      <span className={ICON_CLASS}>
        <InfoCircleIcon role="img" ariaLabel="Notes" />
      </span>
    </Tooltip>
  );
};
