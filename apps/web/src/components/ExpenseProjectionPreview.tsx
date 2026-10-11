/**
 * Live single-expense projection preview for the Expense create/edit
 * form. Charts ONLY the currently-edited draft expense over retirement,
 * reusing `<ExpensesProjectionChart>` verbatim so the axes, markers,
 * tooltip, and today's-dollars basis are identical to the main Expenses
 * page chart.
 *
 * All projection logic lives in the pure
 * `lib/expense-preview-projection` module (same builder the Expenses
 * page uses, resolved under the form's TARGET scenario); this file is
 * the thin `React.memo` wrapper that calls it and renders the result.
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
  /** Draft built from the live form state via the shared
   *  `buildExpensePayload`; null while the debounce has no value yet. */
  draft: ExpensePayload | null;
  members: Aggregate<HouseholdMemberPayload>[];
  scenarios: ScenarioAggregate[];
  /** Resolved target scenario id (scenario-patch / scenario-add), or
   *  null to resolve under the primary scenario. */
  targetScenarioId: string | null;
}

/**
 * The four-arm result body: no-amount / unresolvable guard copy, the
 * shared invalid-glide validator message, or the reused projection
 * chart. The persistent invalid-glide message is rendered as visible
 * error text, NOT `role="alert"`; the visual style is Tailwind
 * defaults.
 */
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
      // Persistent preview state (not an action-triggered
      // announcement) → visible error text, NOT `role="alert"`.
      // The form's on-Save error keeps the single assertive live
      // region; a live region here would re-announce on every
      // memoised re-render. Same message as the Save block (one
      // shared validator).
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
  // `resolvedTheme` is a useMemo dep so a live theme toggle
  // re-runs the builder and re-flips the marker colors on this
  // `React.memo` component even though the projection props are
  // referentially stable — ExpensesPage's projection useMemo is keyed
  // on `resolvedTheme` for the same reason.
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

/**
 * Memoised on purpose. The parent Expense form re-renders on every
 * keystroke; the `draft` prop is referentially stable between debounced
 * updates (the parent memoises it on the debounced form state), and
 * `members` / `scenarios` / `targetScenarioId` are stable too. Shallow-
 * prop memo therefore skips the per-keystroke re-render of this heavy
 * lazy projection chart entirely — without it, typing in a field
 * churns the chart and the form feels sluggish even though the
 * projection itself only recomputes on the debounce.
 */
export const ExpenseProjectionPreview = React.memo(
  ExpenseProjectionPreviewImpl,
);
