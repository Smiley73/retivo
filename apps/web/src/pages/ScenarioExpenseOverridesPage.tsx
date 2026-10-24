/** Scenario expense-overrides sub-screen at /scenarios/:id/expenses, hosting the full ExpenseOverridesCard. */
import React, { useMemo } from 'react';
import { textLinkClass } from '../components/TextLink';
import { Link, useParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { useAggregates } from '../lib/use-aggregates';
import { useSync } from '../sync/SyncContext';
import { ExpenseOverridesCard } from './ScenarioExpenseOverridesCard';
import { PageHeader } from '../components/PageHeader';
import { Alert } from '../components/Alert';
import { Muted } from '../components/Muted';
import { breadcrumbNavClass } from './scenarios-page-chrome';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import type { ScenarioPayload, Aggregate } from '../db/types';

export const ScenarioExpenseOverridesPage: React.FC = () => {
  const { id = '' } = useParams<{ id: string }>();
  const { householdId } = useAuth();
  const { notifyPending } = useSync();
  // The card writes scenario update mutations whose fine signal flows back through this hook, so there is no separate post-save reload token.
  const scenarioQuery = useAggregates('scenario');

  const scenarios = useMemo(
    () => scenarioQuery.aggregates as Aggregate<ScenarioPayload>[],
    [scenarioQuery.aggregates],
  );
  const scenario = useMemo<ScenarioAggregate | null>(
    () => scenarios.find((s) => s.id === id) ?? null,
    [scenarios, id],
  );
  const loading = !scenarioQuery.ready;
  const error = scenarioQuery.error
    ? 'Failed to load scenarios.'
    : !loading && !scenario
      ? `Scenario ${id} not found.`
      : null;

  if (loading) {
    return (
      <section aria-labelledby="scenario-expenses-heading">
        <PageHeader title={<span id="scenario-expenses-heading">Expenses</span>} />
        <Muted as="p">Loading…</Muted>
      </section>
    );
  }

  if (error || !scenario) {
    return (
      <section aria-labelledby="scenario-expenses-heading">
        <PageHeader title={<span id="scenario-expenses-heading">Expenses</span>} />
        <Alert tone="error">{error ?? 'Scenario not available.'}</Alert>
        <p>
          <Link to="/scenarios" className={textLinkClass}>
            ← All scenarios
          </Link>
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby="scenario-expenses-heading">
      <nav aria-label="Breadcrumb" className={breadcrumbNavClass}>
        <Link to={`/scenarios/${id}`}>← Back to scenario</Link>
      </nav>

      {householdId ? (
        <ExpenseOverridesCard
          scenario={scenario}
          scenarios={scenarios}
          householdId={householdId}
          onChanged={() => {
            // The write's fine signal refreshes the card and page reactively; onChanged only nudges the sync indicator.
            notifyPending();
          }}
        />
      ) : (
        <PageHeader
          title={
            <span id="scenario-expenses-heading">
              Expenses: {scenario.payload.name}
            </span>
          }
        />
      )}
    </section>
  );
};
