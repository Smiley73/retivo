/**
 * Marker for the plan last saved to the selected scenario from this page:
 * which plan and when, and "Out of date" when an input the comparison used has
 * changed since. The stale state is text first (a prefix in the sentence), with
 * the warning tone on top, never colour alone. Kept on this device only.
 */
import React from 'react';
import { Alert } from '../../components/Alert';
import { formatDate } from '../../lib/format-date';
import type { SavedPlanStatus } from './roth-suggestion-saved-plan';

export const RothSavedPlanMarker: React.FC<{ readonly status: SavedPlanStatus | null }> = ({
  status,
}) => {
  if (status === null) return null;
  const saved = `Saved plan: ${status.label}, saved ${formatDate(status.savedOn)}.`;
  return status.stale ? (
    <Alert tone="warning" role="status">
      <strong>Out of date.</strong> {saved} Your data changed after it was saved, and the
      ceilings are fixed dollar amounts, so run the comparison again to see how the plan looks
      now.
    </Alert>
  ) : (
    <Alert tone="info" role="status">
      {saved} It is remembered on this device only.
    </Alert>
  );
};
