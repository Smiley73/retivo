/**
 * Live projection preview of the expense being edited in the create/edit form, reusing `<ExpensesProjectionChart>`
 * over `lib/expense-preview-projection`.
 */
import React, { useMemo } from 'react';
import {
  buildPreview,
  type PreviewResult,
} from '../lib/expense-preview-projection';
import { useTheme } from '../contexts/ThemeContext';
import { ExpensesProjectionChart } from './ExpensesProjectionChart';
import { Muted } from './Muted';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import type {
  Aggregate,
  ExpensePayload,
  HouseholdMemberPayload,
} from '../db/types';

interface Props {
  /** Draft built from live form state; null until the debounce has a value. */
  draft: ExpensePayload | null;
  members: Aggregate<HouseholdMemberPayload>[];
  scenarios: ScenarioAggregate[];
  /**
   * Target scenario id for scenario-patch / scenario-add, or null to resolve under the primary
   * scenario.
   */
  targetScenarioId: string | null;
}

function renderPreviewBody(result: PreviewResult): React.ReactNode {
  if (result.kind === 'no-amount') {
    return (
      <Muted as="p" className="m-0">
        Enter an amount to preview this expense.
      </Muted>
    );
  }
  if (result.kind === 'unresolvable') {
    return (
      <Muted as="p" className="m-0">
        Add a retirement age and birthdate to preview.
      </Muted>
    );
  }
  if (result.kind === 'invalid-glide') {
    return (
      // Visible error text, not `role="alert"`: a live region would re-announce on every memoised
      // re-render, and the form's on-Save error keeps the single assertive region.
      <p className="m-0 text-sm font-medium text-negative">
        {result.message}
      </p>
    );
  }
  return (
    <ExpensesProjectionChart
      rows={result.rows}
      markers={result.markers}
      members={result.members}
      singleSeriesLabel="This expense"
      enableZoom={false}
    />
  );
}

const ExpenseProjectionPreviewImpl: React.FC<Props> = ({
  draft,
  members,
  scenarios,
  targetScenarioId,
}) => {
  // A memo dep so a live theme toggle re-runs the builder and re-flips marker colours despite
  // stable projection props.
  const { resolvedTheme } = useTheme();
  const result = useMemo(
    () => buildPreview(draft, members, scenarios, targetScenarioId, resolvedTheme),
    [draft, members, scenarios, targetScenarioId, resolvedTheme],
  );

  return (
    <section
      className="mt-4 mb-4 rounded-lg border border-line bg-surface-sunken p-5"
      aria-labelledby="expense-preview-heading"
    >
      <header className="mb-2">
        <h2
          id="expense-preview-heading"
          className="m-0 text-base font-semibold text-ink"
        >
          Projection preview
        </h2>
      </header>
      {renderPreviewBody(result)}
    </section>
  );
};

// Memoised because the parent re-renders per keystroke while `draft` is stable between debounced
// updates.
export const ExpenseProjectionPreview = React.memo(
  ExpenseProjectionPreviewImpl,
);
