/** /scenarios/:id/returns: per-account planning-return overrides (Baseline resolved from the parent chain, editable Scenario defaulting to it). Planned method only: the TWR method is empirical from balance history and ignores this override, which a callout says. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { textLinkClass } from '../components/TextLink';
import { Link, useParams } from 'react-router';
import {
  Cell,
  Column,
  Row,
  Table,
  TableBody,
  TableHeader,
} from 'react-aria-components';
import { useAuth } from '../auth/AuthContext';
import { PercentInput, formatPercentDisplay } from '../components/PercentInput';
import { useUnsavedChangesGuard } from '../components/UnsavedChangesGuard';
import { PageHeader } from '../components/PageHeader';
import { LoadingState } from '../components/Skeleton';
import { TableScroll } from '../components/TableScroll';
import { Alert } from '../components/Alert';
import { Badge, badgeToneForBucket } from '../components/Badge';
import { Card } from '../components/Card';
import { Muted } from '../components/Muted';
import { RefreshIcon, CheckIcon, XIcon } from '../components/icons';
import {
  btnDangerSmClass,
  tableClass,
  thStickyClass,
  thStickyNumClass,
  tdClass,
  tdNumClass,
  breadcrumbNavClass,
  footNoteClass,
  noteClass,
} from './scenarios-page-chrome';
import { BucketBar } from './accounts-page-chrome';
import { accountBucket } from '../lib/account-bucket';
import { ACCOUNT_TYPE_LABELS } from '../api/types';
import { listAggregates } from '../db/store';
import { saveScenario } from '../lib/scenario-mutations';
import { PLANNING_RETURN_MAX, PLANNING_RETURN_MIN } from '../lib/scenario-input-bounds';
import {
  resolveAccountReturnsForScenario,
  type ScenarioAggregate,
} from '../lib/scenario-resolution';
import { useSync } from '../sync/SyncContext';
import type {
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
  ScenarioPayload,
} from '../db/types';

function buildInheritedMap(
  scenario: ScenarioAggregate,
  scenarios: ScenarioAggregate[],
  accounts: Aggregate<AccountPayload>[],
): Map<string, number> {
  if (scenario.payload.parentScenarioId === null) {
    return new Map(accounts.map((a) => [a.id, a.payload.planningReturnPct]));
  }
  return resolveAccountReturnsForScenario(
    scenario.payload.parentScenarioId,
    scenarios,
    accounts,
  );
}

function buildInitialDrafts(
  scenario: ScenarioAggregate,
  inherited: Map<string, number>,
): Map<string, number> {
  const own = scenario.payload.overrides.accountReturns?.perAccount ?? {};
  const out = new Map<string, number>();
  for (const [id, inh] of inherited) {
    const o = own[id];
    out.set(id, o?.planningReturnPct ?? inh);
  }
  return out;
}

function memberDisplay(m: HouseholdMemberPayload | undefined): string {
  if (!m) return '—';
  return m.firstName?.trim() || 'Member';
}

export const ScenarioReturnsPage: React.FC = () => {
  const { id = '' } = useParams<{ id: string }>();
  const { householdId } = useAuth();
  const { notifyPending } = useSync();

  const [scenario, setScenario] = useState<ScenarioAggregate | null>(null);
  const [accounts, setAccounts] = useState<Aggregate<AccountPayload>[]>([]);
  const [members, setMembers] = useState<Aggregate<HouseholdMemberPayload>[]>([]);
  const [drafts, setDrafts] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const baselineRef = useRef<Map<string, number>>(new Map());

  const reload = useCallback(async () => {
    try {
      const [allScenarios, allAccounts, allMembers] = await Promise.all([
        listAggregates('scenario') as Promise<Aggregate<ScenarioPayload>[]>,
        listAggregates('account') as Promise<Aggregate<AccountPayload>[]>,
        listAggregates('householdMember') as Promise<Aggregate<HouseholdMemberPayload>[]>,
      ]);
      const activeAccounts = allAccounts
        .filter((a) => a.payload.active)
        .sort((a, b) => a.payload.name.localeCompare(b.payload.name));
      setAccounts(activeAccounts);
      setMembers(allMembers);
      const found = allScenarios.find((s) => s.id === id) ?? null;
      setScenario(found);
      if (!found) {
        setError(`Scenario ${id} not found.`);
        return;
      }
      const inherited = buildInheritedMap(found, allScenarios, activeAccounts);
      const initial = buildInitialDrafts(found, inherited);
      baselineRef.current = inherited;
      setDrafts(initial);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const dirtyAccountIds = useMemo(() => {
    const own = scenario?.payload.overrides.accountReturns?.perAccount ?? {};
    const dirty: string[] = [];
    for (const a of accounts) {
      const d = drafts.get(a.id);
      const inh = baselineRef.current.get(a.id);
      if (d === undefined || inh === undefined) continue;
      const stored = own[a.id]?.planningReturnPct ?? inh;
      if (d !== stored) dirty.push(a.id);
    }
    return dirty;
  }, [accounts, drafts, scenario]);

  const isDirty = dirtyAccountIds.length > 0;
  const { pendingNavModal } = useUnsavedChangesGuard(isDirty);

  const updateDraft = useCallback((accountId: string, value: number) => {
    setDrafts((prev) => {
      const next = new Map(prev);
      next.set(accountId, value);
      return next;
    });
  }, []);

  const resetRow = useCallback(
    (accountId: string) => {
      const inh = baselineRef.current.get(accountId);
      if (inh === undefined) return;
      updateDraft(accountId, inh);
    },
    [updateDraft],
  );

  const handleSave = useCallback(async () => {
    if (!scenario || !householdId) return;
    setSaving(true);
    setError(null);
    try {
      const perAccount: Record<string, { planningReturnPct?: number }> = {};
      for (const a of accounts) {
        const d = drafts.get(a.id);
        const inh = baselineRef.current.get(a.id);
        if (d === undefined || inh === undefined) continue;
        if (d === inh) continue;
        perAccount[a.id] = { planningReturnPct: d };
      }
      const nextOverrides = { ...scenario.payload.overrides };
      if (Object.keys(perAccount).length === 0) {
        delete nextOverrides.accountReturns;
      } else {
        nextOverrides.accountReturns = { perAccount };
      }
      const payload: ScenarioPayload = {
        ...scenario.payload,
        overrides: nextOverrides,
      };
      await saveScenario({ scenario, payload, householdId });
      notifyPending();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save.');
    } finally {
      setSaving(false);
    }
  }, [scenario, householdId, accounts, drafts, notifyPending, reload]);

  const handleResetAll = useCallback(async () => {
    if (!scenario || !householdId) return;
    if (scenario.payload.overrides.accountReturns === undefined) return;
    setSaving(true);
    setError(null);
    try {
      const nextOverrides = { ...scenario.payload.overrides };
      delete nextOverrides.accountReturns;
      const payload: ScenarioPayload = {
        ...scenario.payload,
        overrides: nextOverrides,
      };
      await saveScenario({ scenario, payload, householdId });
      notifyPending();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to reset.');
    } finally {
      setSaving(false);
    }
  }, [scenario, householdId, notifyPending, reload]);

  if (loading) {
    return (
      <section aria-labelledby="scenario-returns-heading">
        <PageHeader title={<span id="scenario-returns-heading">Planned returns</span>} />
        <LoadingState label="Loading planned returns…" variant="table" />
      </section>
    );
  }

  if (error || !scenario) {
    return (
      <section aria-labelledby="scenario-returns-heading">
        <PageHeader title={<span id="scenario-returns-heading">Planned returns</span>} />
        <Alert tone="error">{error ?? 'Scenario not found.'}</Alert>
        <p>
          <Link to="/scenarios" className={textLinkClass}>
            ← All scenarios
          </Link>
        </p>
      </section>
    );
  }

  const memberById = new Map(members.map((m) => [m.id, m.payload]));
  const own = scenario.payload.overrides.accountReturns?.perAccount ?? {};
  const overriddenCount = Object.keys(own).length;
  const resetAllLabel = 'Reset all';

  return (
    <section aria-labelledby="scenario-returns-heading">
      <nav aria-label="Breadcrumb" className={breadcrumbNavClass}>
        <Link to={`/scenarios/${id}`}>← Back to scenario</Link>
      </nav>
      <PageHeader
        title={
          <span id="scenario-returns-heading">
            Planned returns: {scenario.payload.name}
          </span>
        }
        action={
          isDirty
            ? {
                label: saving ? 'Saving…' : 'Save',
                onClick: handleSave,
                disabled: saving,
              }
            : undefined
        }
        actionIcon={<CheckIcon />}
        secondaryActions={
          isDirty
            ? [
                {
                  label: 'Cancel',
                  icon: <XIcon />,
                  onClick: () => {
                    setError(null);
                    void reload();
                  },
                  disabled: saving,
                  tone: 'neutral',
                },
              ]
            : undefined
        }
      />

      {overriddenCount > 0 && (
        <div className="mb-4 flex gap-2">
          <button
            type="button"
            className={`${btnDangerSmClass} gap-1.5`}
            onClick={handleResetAll}
            disabled={saving}
            aria-label="Reset all planned-return overrides"
          >
            <RefreshIcon />
            {resetAllLabel}
          </button>
        </div>
      )}

      <div className={noteClass}>
        <p className="m-0">
          Override the planning return rate per account for this scenario.
          A value matching the baseline column means &quot;inherit.&quot;
          Affects the{' '}
          <strong className="font-bold text-ink">Planned</strong> projection
          method only, the TWR method on the Balance Projection page is
          computed from each account&apos;s own balance history and is
          unaffected.
        </p>
      </div>

      {accounts.length === 0 ? (
        <Card>
          <Muted as="p" className="m-0">
            No active accounts. Add one from{' '}
            <Link to="/accounts?new" className={textLinkClass}>
              Accounts
            </Link>{' '}
            first.
          </Muted>
        </Card>
      ) : (
        // A Cell can hold any focusable element and the row keyboard model still works; typing in the input doesn't steal row focus until blur.
        <TableScroll label="Per-account return overrides">
        <Table className={tableClass} aria-label="Per-account return overrides">
            <TableHeader>
              <Column isRowHeader className={thStickyClass}>Account</Column>
              <Column className={thStickyClass}>Owner</Column>
              <Column className={thStickyClass}>Type</Column>
              <Column className={thStickyNumClass}>Baseline %</Column>
              <Column className={thStickyNumClass}>Scenario %</Column>
              <Column className={thStickyClass}>
                <span className="sr-only">Actions</span>
              </Column>
            </TableHeader>
            <TableBody>
              {accounts.map((a) => {
                const inh = baselineRef.current.get(a.id);
                const d = drafts.get(a.id);
                if (inh === undefined || d === undefined) return null;
                const owner = memberDisplay(memberById.get(a.payload.ownerId));
                const isLocallyOverridden = own[a.id] !== undefined;
                const bucket = accountBucket(a.payload.type);
                return (
                  <Row key={a.id} id={a.id}>
                    <Cell className={`${tdClass} relative`}>
                      <BucketBar bucket={bucket} />
                      {a.payload.name}
                      {isLocallyOverridden && (
                        <Badge tone="modified" className="ml-2">
                          Override
                        </Badge>
                      )}
                    </Cell>
                    <Cell className={tdClass}>{a.payload.ownershipType === 'JOINT' ? 'Joint' : owner}</Cell>
                    <Cell className={tdClass}>
                      <Badge tone={badgeToneForBucket(bucket)}>
                        {ACCOUNT_TYPE_LABELS[a.payload.type]}
                      </Badge>
                    </Cell>
                    <Cell className={tdNumClass}>{formatPercentDisplay(inh)}</Cell>
                    <Cell className={tdNumClass}>
                      <span className="inline-block w-20 text-left">
                        <PercentInput
                          variant="cell"
                          ariaLabel={`${a.payload.name} scenario return`}
                          value={d}
                          onChange={(v) => updateDraft(a.id, v)}
                          allowNegative
                          min={PLANNING_RETURN_MIN}
                          max={PLANNING_RETURN_MAX}
                        />
                      </span>
                    </Cell>
                    <Cell className={tdClass}>
                      {isLocallyOverridden && (
                        <button
                          type="button"
                          className={`${btnDangerSmClass} gap-1.5`}
                          onClick={() => resetRow(a.id)}
                          disabled={saving}
                          aria-label={`Reset ${a.payload.name} return override`}
                        >
                          <RefreshIcon />
                          Reset
                        </button>
                      )}
                    </Cell>
                  </Row>
                );
              })}
            </TableBody>
          </Table>
        </TableScroll>
      )}

      {accounts.length > 0 && (
        <div className={footNoteClass}>
          {overriddenCount} of {accounts.length} accounts overridden.
        </div>
      )}

      {pendingNavModal}
    </section>
  );
};
