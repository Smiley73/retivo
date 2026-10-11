/**
 * Working-years Roth-conversions sub-screen at
 * /scenarios/:id/roth-conversions.
 *
 * A dedicated list editor for the per-scenario working-years (still-employed)
 * Roth conversions: each entry moves money from the pre-tax side of a PRE_TAX
 * or MIXED account into a Roth IRA, or from the pre-tax side of a MIXED
 * employer plan into that same account's Roth-designated side (an in-plan Roth
 * conversion), in the chosen working-year window. The page shows the extra
 * income tax that move would create — at an assumed rate, NOT taken out of the
 * plan. Plus the scenario-level assumed tax-rate field. The annual
 * amount is a flat nominal figure converted as-is each working year.
 *
 * Mirrors ScenarioWithdrawalStrategyPage's data-load shape: a mount-only load
 * (no workspace-revision dep: an
 * explicit-Save guarded editor must not remount mid-edit and drop the draft),
 * then hosts the non-modal RothConversionsEditor keyed to the scenario version
 * so a successful save reload remounts it clean.
 */
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
import { RothConversionsEditor } from './scenario-roth-conversions-editor';
import type { ScenarioAggregate } from '../lib/scenario-resolution';
import type {
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
  ScenarioPayload,
} from '../db/types';

export const ScenarioRothConversionsPage: React.FC = () => {
  const { id = '' } = useParams<{ id: string }>();
  const { householdId } = useAuth();
  const { notifyPending } = useSync();

  const [scenarios, setScenarios] = useState<ScenarioAggregate[]>([]);
  const [scenario, setScenario] = useState<ScenarioAggregate | null>(null);
  const [accounts, setAccounts] = useState<Aggregate<AccountPayload>[]>([]);
  const [members, setMembers] = useState<Aggregate<HouseholdMemberPayload>[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Reads + applies the workspace data. THROWS on failure so the post-save
  // caller can surface the distinct "saved; refresh failed" state. The mount
  // loader below wraps this in its own try/catch.
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

  // Mount-only load (no workspace revision) so a mid-edit bulk event cannot
  // remount the editor and drop the draft.
  useEffect(() => {
    void reload();
  }, [reload]);

  if (loading) {
    return (
      <section aria-labelledby="scenario-roth-conversions-heading">
        <PageHeader
          title={
            <span id="scenario-roth-conversions-heading">Roth conversions</span>
          }
        />
        <LoadingState label="Loading Roth conversions…" variant="table" />
      </section>
    );
  }

  if (error || !scenario || !householdId) {
    return (
      <section aria-labelledby="scenario-roth-conversions-heading">
        <PageHeader
          title={
            <span id="scenario-roth-conversions-heading">Roth conversions</span>
          }
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
    <section aria-labelledby="scenario-roth-conversions-heading">
      <nav aria-label="Breadcrumb" className={breadcrumbNavClass}>
        <Link to={backPath}>← Back to scenario</Link>
      </nav>
      <PageHeader
        title={
          <span id="scenario-roth-conversions-heading">
            Roth conversions while working: {scenario.payload.name}
          </span>
        }
        subtitle={
          <>
            Model moving money from the pre-tax side of an account into a Roth
            IRA, or into the same account&apos;s Roth-designated side for a
            mixed employer plan, during your{' '}
            <span className="underline">working years</span>. See how it changes
            your retirement outlook — and the extra income tax each move would
            create.
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
      {/* Remount key keyed to the just-saved version: a successful save reload
          re-fetches the version-bumped scenario, the key changes, and the
          editor remounts clean so Save re-disables. */}
      <RothConversionsEditor
        key={`prc-${scenario.id}-${scenario.version}`}
        scenario={scenario}
        scenarios={scenarios}
        householdId={householdId}
        accounts={accounts}
        members={members}
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
