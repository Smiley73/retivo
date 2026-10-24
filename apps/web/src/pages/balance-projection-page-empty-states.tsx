/** Early-state renderers (error, loading and the three no-projection CTAs), each keeping the aria-labelledby="balance-projection-heading" landmark wiring. */
import React from 'react';
import { Link } from 'react-router';
import { Alert } from '../components/Alert';
import { Card } from '../components/Card';
import { PageHeader } from '../components/PageHeader';
import { textLinkClass } from '../components/TextLink';

const CTA_LINK_CLASS = `mt-2 inline-block ${textLinkClass}`;

function StateShell({
  heading,
  children,
}: {
  heading: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section aria-labelledby="balance-projection-heading">
      <PageHeader title={heading} />
      {children}
    </section>
  );
}

export function BalanceProjectionErrorState({
  heading,
  error,
}: {
  heading: React.ReactNode;
  error: string;
}): React.ReactElement {
  return (
    <StateShell heading={heading}>
      <Alert tone="error">{error}</Alert>
    </StateShell>
  );
}

export function BalanceProjectionLoadingState({
  heading,
}: {
  heading: React.ReactNode;
}): React.ReactElement {
  return (
    <StateShell heading={heading}>
      <p aria-busy="true" className="text-muted">
        Loading…
      </p>
    </StateShell>
  );
}

export function BalanceProjectionNoRetirementAgeState({
  heading,
  scenarioId,
  scenarioName,
}: {
  heading: React.ReactNode;
  scenarioId: string | null;
  scenarioName: string | null;
}): React.ReactElement {
  return (
    <StateShell heading={heading}>
      <Card>
        <p className="m-0">Set a retirement age on this scenario to project.</p>
        {scenarioId && (
          <Link to={`/scenarios/${scenarioId}`} className={CTA_LINK_CLASS}>
            Configure {scenarioName}
          </Link>
        )}
      </Card>
    </StateShell>
  );
}

export function BalanceProjectionNoAccountState({
  heading,
}: {
  heading: React.ReactNode;
}): React.ReactElement {
  return (
    <StateShell heading={heading}>
      <Card>
        <p className="m-0">Add an account to see projections.</p>
        <Link to="/accounts?new" className={CTA_LINK_CLASS}>
          Add an account
        </Link>
      </Card>
    </StateShell>
  );
}

export function BalanceProjectionNoHistoryState({
  heading,
}: {
  heading: React.ReactNode;
}): React.ReactElement {
  return (
    <StateShell heading={heading}>
      <Card>
        <p className="m-0">
          Enter at least one year of balance for an account to see projections.
        </p>
        <Link to="/account-balances" className={CTA_LINK_CLASS}>
          Go to Account Balances
        </Link>
      </Card>
    </StateShell>
  );
}
