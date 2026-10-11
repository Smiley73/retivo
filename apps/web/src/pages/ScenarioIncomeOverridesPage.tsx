/**
 * Scenario income-overrides sub-screen at /scenarios/:id/income.
 *
 * Hosts the full IncomeOverridesCard for a single scenario. The main
 * scenario detail page renders only a summary link card to keep its
 * surface small. Mirrors ScenarioExpenseOverridesPage one-for-one.
 */
import React, { useMemo } from 'react';
import { textLinkClass } from '../components/TextLink';
import { Link, useParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { useAggregates } from '../lib/use-aggregates';
import { useSync } from '../sync/SyncContext';
import { IncomeOverridesCard } from './ScenarioIncomeOverridesCard';
import { PageHeader } from '../components/PageHeader';
import { Alert } from '../components/Alert';
import { LoadingState } from '../components/Skeleton';
import { breadcrumbNavClass } from './scenarios-page-chrome';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import type { ScenarioPayload, Aggregate } from '../db/types';

export const ScenarioIncomeOverridesPage: React.FC = () => {
  const { id = '' } = useParams<{ id: string }>();
  const { householdId } = useAuth();
  const { notifyPending } = useSync();
  // Reactive read: the `scenario` store re-reads on any write — single
  // edits via the fine signal, bulk fills via the coarse workspace event.
  // The card writes scenario `update` mutations, whose fine signal flows
  // back through this hook, so there is no separate post-save reload token.
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
      <section aria-labelledby="scenario-income-heading">
        <PageHeader title={<span id="scenario-income-heading">Income</span>} />
        <LoadingState label="Loading income…" variant="table" />
      </section>
    );
  }

  if (error || !scenario) {
    return (
      <section aria-labelledby="scenario-income-heading">
        <PageHeader title={<span id="scenario-income-heading">Income</span>} />
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
    <section aria-labelledby="scenario-income-heading">
      <nav aria-label="Breadcrumb" className={breadcrumbNavClass}>
        <Link to={`/scenarios/${id}`}>← Back to scenario</Link>
      </nav>

      {householdId ? (
        // The card owns the page header (title + Reset / Add actions) and
        // the footer summary; it carries the `scenario-income-heading` id
        // this section is labelled by.
        <IncomeOverridesCard
          scenario={scenario}
          scenarios={scenarios}
          householdId={householdId}
          onChanged={() => {
            // The scenario `update` write's fine signal flows back through
            // `useAggregates('scenario')`, so the card + this page refresh
            // reactively — `onChanged` only nudges the sync indicator.
            notifyPending();
          }}
        />
      ) : (
        <PageHeader
          title={
            <span id="scenario-income-heading">
              Income: {scenario.payload.name}
            </span>
          }
        />
      )}
    </section>
  );
};
