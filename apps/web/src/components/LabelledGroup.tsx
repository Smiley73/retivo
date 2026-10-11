/**
 * Always-expanded bordered group wrapper for a labelled control cluster.
 *
 * WAI-ARIA labelled group (NOT `<fieldset>`). Visually
 * mirrors the expense form's `AnchorCard` in its expanded state (same
 * `rounded-xl border` frame, `px-4 py-3` semibold heading, `px-4 pb-4`
 * body) so the income and expense schedule pickers read as one system —
 * but always expanded: there is no chevron / summary / disclosure
 * behaviour.
 *
 * Promoted out of `IncomeSchedulePickers.tsx` so the non-collapsible
 * `ScheduleAnchorPicker` branch (income Start) and the income End picker
 * can share it without a component importing from a page.
 */
import React from 'react';

export const LabelledGroup: React.FC<{
  id: string;
  heading: React.ReactNode;
  children: React.ReactNode;
}> = ({ id, heading, children }) => (
  <div
    role="group"
    aria-labelledby={id}
    className="flex min-w-0 flex-col rounded-xl border border-line"
  >
    <header id={id} className="px-4 py-3 text-sm font-semibold text-ink">
      {heading}
    </header>
    <div className="px-4 pb-4">{children}</div>
  </div>
);
