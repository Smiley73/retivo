/**
 * Scenario withdrawal-strategy sub-screen at /scenarios/:id/withdrawal-strategy.
 *
 * Route component: loads the scenario data + chrome (breadcrumb + PageHeader),
 * then hosts the non-modal WithdrawalStrategyEditor. The main scenario detail
 * page renders only a summary card with a Configure link to this page so its
 * surface stays small. Mirrors ScenarioReturnsPage's data-load shape.
 *
 * The load is MOUNT-ONLY (`reload` deps on `[id]`; no reactive
 * `useAggregates` seed read, no workspace-revision dep). A form page with an
 * explicit-Save guarded editor must not re-read on a mid-edit change: the
 * re-render would remount the editor and silently discard the draft. The
 * remount key therefore changes only on our own save-triggered reload.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { textLinkClass } from '../components/TextLink';
import { Link, useParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { useSync } from '../sync/SyncContext';
import { listAggregates } from '../db/store';
import { PageHeader } from '../components/PageHeader';
import { Alert } from '../components/Alert';
import { LoadingState } from '../components/Skeleton';
import { breadcrumbNavClass } from './scenarios-page-chrome';
import { WithdrawalStrategyEditor } from './scenario-withdrawal-strategy-editor';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import type {
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
  IncomeStreamPayload,
  ScenarioPayload,
} from '../db/types';

export const ScenarioWithdrawalStrategyPage: React.FC = () => {
  const { id = '' } = useParams<{ id: string }>();
  const { householdId } = useAuth();
  const { notifyPending } = useSync();

  const [scenarios, setScenarios] = useState<ScenarioAggregate[]>([]);
  const [scenario, setScenario] = useState<ScenarioAggregate | null>(null);
  const [accounts, setAccounts] = useState<Aggregate<AccountPayload>[]>([]);
  const [members, setMembers] = useState<Aggregate<HouseholdMemberPayload>[]>([]);
  const [incomeStreams, setIncomeStreams] = useState<Aggregate<IncomeStreamPayload>[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Reads + applies the workspace data. THROWS on failure so the post-save
  // caller (onSaved) can surface the distinct "saved; refresh failed" state.
  // The mount loader below wraps this in its own try/catch.
  const loadData = useCallback(async () => {
    const [allScenarios, allMembers, allAccounts, allIncomeStreams] = await Promise.all([
      listAggregates('scenario') as Promise<Aggregate<ScenarioPayload>[]>,
      listAggregates('householdMember') as Promise<Aggregate<HouseholdMemberPayload>[]>,
      listAggregates('account') as Promise<Aggregate<AccountPayload>[]>,
      listAggregates('incomeStream') as Promise<Aggregate<IncomeStreamPayload>[]>,
    ]);
    setScenarios(allScenarios);
    setMembers(allMembers);
    setAccounts(allAccounts);
    setIncomeStreams(allIncomeStreams);
    const found = allScenarios.find((s) => s.id === id) ?? null;
    setScenario(found);
    setError(found ? null : `Scenario ${id} not found.`);
  }, [id]);

  const reload = useCallback(async () => {
    try {
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load.');
    } finally {
      setLoading(false);
    }
  }, [loadData]);

  // Mount-only load (dep [reload], reload dep [id]); no workspace revision
  // so a mid-edit bulk event cannot remount the editor and drop the draft.
  useEffect(() => {
    void reload();
  }, [reload]);

  if (loading) {
    return (
      <section aria-labelledby="scenario-withdrawal-heading">
        <PageHeader title={<span id="scenario-withdrawal-heading">Withdrawal strategy</span>} />
        <LoadingState label="Loading withdrawal strategy…" variant="table" />
      </section>
    );
  }

  if (error || !scenario || !householdId) {
    return (
      <section aria-labelledby="scenario-withdrawal-heading">
        <PageHeader title={<span id="scenario-withdrawal-heading">Withdrawal strategy</span>} />
        <Alert tone="error">{error ?? 'Scenario not available.'}</Alert>
        <p>
          <Link to="/scenarios" className={textLinkClass}>
            ← All scenarios
          </Link>
        </p>
      </section>
    );
  }

  const backPath = `/scenarios/${id}`;

  return (
    <section aria-labelledby="scenario-withdrawal-heading">
      <nav aria-label="Breadcrumb" className={breadcrumbNavClass}>
        <Link to={backPath}>← Back to scenario</Link>
      </nav>
      <PageHeader
        title={
          <span id="scenario-withdrawal-heading">
            Withdrawal strategy: {scenario.payload.name}
          </span>
        }
        subtitle="Decide the order your accounts are tapped to cover retirement spending. The order affects how much tax you pay each year and how long your money lasts."
      />
      {/* Remount key keyed to the just-saved version: a successful save
          reload re-fetches the version-bumped scenario, the key changes, and
          the editor remounts clean so Save re-disables. */}
      <WithdrawalStrategyEditor
        key={`wsd-${scenario.id}-${scenario.version}`}
        scenario={scenario}
        scenarios={scenarios}
        householdId={householdId}
        accounts={accounts}
        members={members}
        incomeStreams={incomeStreams}
        backPath={backPath}
        onSaved={async () => {
          notifyPending();
          // Propagate a reload failure so the editor can show the
          // "saved; refresh failed" state — the save is already durable.
          await loadData();
        }}
      />
    </section>
  );
};
