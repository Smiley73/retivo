/** /scenarios/:id/qcd: list editor for per-scenario Qualified Charitable Distributions, each a fixed real annual gift from a traditional IRA to charity at 70½+ that stays out of taxable income and counts toward RMDs.
* Mount-only load: an explicit-Save guarded editor must not remount mid-edit and drop the draft. */
import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { useSync } from '../sync/SyncContext';
import { listAggregates } from '../db/store';
import { PageHeader } from '../components/PageHeader';
import { Alert } from '../components/Alert';
import { LoadingState } from '../components/Skeleton';
import { textLinkClass } from '../components/TextLink';
import { InlineDisclaimerCard } from '../components/InlineDisclaimerCard';
import { TAX_SNAPSHOT_NOTE } from '../lib/disclaimer-fragments';
import { breadcrumbNavClass } from './scenarios-page-chrome';
import { QcdEditor } from './scenario-qcd-editor';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import type {
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
  ScenarioPayload,
} from '../db/types';

export const ScenarioQcdPage: React.FC = () => {
  const { id = '' } = useParams<{ id: string }>();
  const { householdId } = useAuth();
  const { notifyPending } = useSync();

  const [scenarios, setScenarios] = useState<ScenarioAggregate[]>([]);
  const [scenario, setScenario] = useState<ScenarioAggregate | null>(null);
  const [accounts, setAccounts] = useState<Aggregate<AccountPayload>[]>([]);
  const [members, setMembers] = useState<Aggregate<HouseholdMemberPayload>[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Throws on failure so the post-save caller can surface the distinct "saved; refresh failed" state.
  const loadData = useCallback(async () => {
    const [allScenarios, allMembers, allAccounts] = await Promise.all([
      listAggregates('scenario') as Promise<Aggregate<ScenarioPayload>[]>,
      listAggregates('householdMember') as Promise<Aggregate<HouseholdMemberPayload>[]>,
      listAggregates('account') as Promise<Aggregate<AccountPayload>[]>,
    ]);
    setScenarios(allScenarios);
    setMembers(allMembers);
    setAccounts(allAccounts);
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

  useEffect(() => {
    void reload();
  }, [reload]);

  if (loading) {
    return (
      <section aria-labelledby="scenario-qcd-heading">
        <PageHeader
          title={<span id="scenario-qcd-heading">Charitable distributions</span>}
        />
        <LoadingState label="Loading charitable distributions…" variant="table" />
      </section>
    );
  }

  if (error || !scenario || !householdId) {
    return (
      <section aria-labelledby="scenario-qcd-heading">
        <PageHeader
          title={<span id="scenario-qcd-heading">Charitable distributions</span>}
        />
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
    <section aria-labelledby="scenario-qcd-heading">
      <nav aria-label="Breadcrumb" className={breadcrumbNavClass}>
        <Link to={backPath}>← Back to scenario</Link>
      </nav>
      <PageHeader
        title={
          <span id="scenario-qcd-heading">
            Charitable distributions (QCDs): {scenario.payload.name}
          </span>
        }
        subtitle={
          <>
            Give directly from a traditional IRA to charity at{' '}
            <span className="underline">70½ or older</span>. The gift stays out
            of your taxable income, and once required minimum distributions
            apply it counts toward them.
          </>
        }
      />
      <InlineDisclaimerCard
        ariaLabel="Tax estimate disclaimer"
        variant="line"
        className="mb-4"
      >
        {TAX_SNAPSHOT_NOTE}
      </InlineDisclaimerCard>
      {/* Keyed to the just-saved version so a successful save reload remounts the editor clean and Save re-disables. */}
      <QcdEditor
        key={`qcd-${scenario.id}-${scenario.version}`}
        scenario={scenario}
        scenarios={scenarios}
        householdId={householdId}
        accounts={accounts}
        members={members}
        backPath={backPath}
        onSaved={async () => {
          notifyPending();
          // Propagate a reload failure so the editor can show "saved; refresh failed": the save is already durable.
          await loadData();
        }}
      />
    </section>
  );
};
