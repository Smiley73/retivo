/**
 * Backdoor-Roth informational callout. Rendered only when the household's
 * aggregated CURRENT (latest stored) pre-tax IRA balance is $0 — the point at
 * which a pro-rata-free backdoor Roth (IRC §408(d)(2)) may become available.
 */
import React from 'react';
import { Alert } from '../../components/Alert';

export const BackdoorRothCallout: React.FC = () => (
  <Alert tone="info">
    <strong>Backdoor Roth might be available.</strong> Your current pre-tax IRA
    balance is $0 — backdoor Roth contributions might be available without
    triggering the pro-rata rule. This tool cannot confirm your eligibility, and
    the pro-rata test looks at your IRA balances as of December 31, not today.
    Consult an appropriately qualified professional for Form 8606 guidance
    before acting.
  </Alert>
);
