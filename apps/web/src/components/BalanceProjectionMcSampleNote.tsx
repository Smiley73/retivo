/**
 * Warning that the Monte Carlo basis line is one example path, so its depletion age can differ from the percentile
 * cards. `role="status"` so a basis change announces politely.
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
