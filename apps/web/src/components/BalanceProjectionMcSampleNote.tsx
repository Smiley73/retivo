/**
 * Monte Carlo sample-line disclosure banner for the Balance Projection
 * page's per-year line chart.
 *
 * When a Monte Carlo basis (Typical / Pessimistic / Bad-luck) is active
 * the per-year chart draws ONE representative simulated path. Read as
 * "the typical/pessimistic outcome", the line alarms users when it looks
 * far worse than the matching summary card (which reports a percentile
 * rank across thousands of paths, not a single path). This banner
 * explains, in plain English, that the line is one example and the
 * depletion age can differ from the cards above.
 *
 * Rendered via the typed `Alert` component (`tone="warning"`) for the
 * warning visual treatment the user asked for, but with the
 * `role="status"` override so it announces *politely* — a static,
 * user-triggered disclosure should not interrupt assistive tech with an
 * assertive `role="alert"` on every basis change. The caller gates
 * visibility on `activeMcBasis`; the banner itself takes no props.
 *
 * Body copy renders at the `text-sm` page baseline (Alert's BASE_CLASS,
 * per "Typography" in docs/ui-conventions.md).
 */
import React from 'react';
import { Alert } from './Alert';

export const BalanceProjectionMcSampleNote: React.FC = () => (
  <Alert tone="warning" role="status">
    <strong>This is one example, not an average.</strong> Monte Carlo tries
    thousands of possible futures. This line follows just one of them at this
    tier, so the age your money runs out can look better or worse than the
    summary cards above. Press &ldquo;Recalculate&rdquo; to draw a different
    example.
  </Alert>
);
