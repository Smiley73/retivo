/** /scenarios/:id/contributions: per-account planned-contribution overrides. Rows whose draft equals the baseline on both sides are trimmed on save, keeping the "overridden accounts" count honest; per-row Reset wipes only that account's entry. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { textLinkClass } from '../components/TextLink';
import {
  Cell,
  Column,
  Row,
  Table,
  TableBody,
  TableHeader,
} from 'react-aria-components';
import { Link, useParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { MoneyInput } from '../components/MoneyInput';
import { PercentInput, formatPercent } from '../components/PercentInput';
import { useUnsavedChangesGuard } from '../components/UnsavedChangesGuard';
import { PageHeader } from '../components/PageHeader';
import { LoadingState } from '../components/Skeleton';
import { TableScroll } from '../components/TableScroll';
import { Alert } from '../components/Alert';
import { Badge } from '../components/Badge';
import { Card } from '../components/Card';
import { Muted } from '../components/Muted';
import { NotesIndicator } from '../components/NotesIndicator';
import { RefreshIcon, CheckIcon, XIcon } from '../components/icons';
import {
  btnDangerSmClass,
  tableClass,
  thStickyClass,
  tdClass,
  tdNumClass,
  breadcrumbNavClass,
  footNoteClass,
  noteClass,
} from './scenarios-page-chrome';
import { BucketBar } from './accounts-page-chrome';
import { accountBucket } from '../lib/account-bucket';
import {
  isTreatmentEditablePreTax,
  isTreatmentEditablePostTax,
} from '../lib/contributions-calc';
import {
  MAX_CONTRIBUTION_GROWTH_PCT,
  MIN_CONTRIBUTION_GROWTH_PCT_INPUT,
  isValidContributionGrowthPct,
} from '../lib/contribution-growth';
import { listAggregates } from '../db/store';
import { saveScenario } from '../lib/scenario-mutations';
import type {
  ResolvedContributionGrowth,
  ScenarioAggregate,
} from '../lib/scenario-resolution';
import { useSync } from '../sync/SyncContext';
import type {
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
  ScenarioPayload,
} from '../db/types';

import {
  buildInheritedGrowthMap,
  buildInheritedMap,
  buildInitialDrafts,
  memberDisplay,
  type DraftRow,
} from './scenario-contributions-helpers';
import { formatCurrency } from '../lib/format-currency';

// Placeholder for an inherited growth: a tracks-inflation account reads "Match inflation (X%)" (the resolved general rate), an explicit inherited rate reads "Inherited (Y%)".
function growthPlaceholder(
  inherited: ResolvedContributionGrowth | undefined,
): string {
  if (!inherited) return 'Match inflation';
  return inherited.mode === 'tracks-inflation'
    ? `Match inflation (${formatPercent(inherited.ratePct)})`
    : `Inherited (${formatPercent(inherited.ratePct)})`;
}

export const ScenarioContributionsPage: React.FC = () => {
  const { id = '' } = useParams<{ id: string }>();
  const { householdId } = useAuth();
  const { notifyPending } = useSync();

  const [scenario, setScenario] = useState<ScenarioAggregate | null>(null);
  const [accounts, setAccounts] = useState<Aggregate<AccountPayload>[]>([]);
  const [members, setMembers] = useState<Aggregate<HouseholdMemberPayload>[]>([]);
  const [drafts, setDrafts] = useState<Map<string, DraftRow>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const baselineRef = useRef<Map<string, DraftRow>>(new Map());
  // Independent of this scenario's own override; drives the placeholder and the reset fallback.
  const inheritedGrowthRef = useRef<Map<string, ResolvedContributionGrowth>>(
    new Map(),
  );

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
      inheritedGrowthRef.current = buildInheritedGrowthMap(
        found,
        allScenarios,
        activeAccounts,
      );
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
    const own =
      scenario?.payload.overrides.accountContributions?.perAccount ?? {};
    const dirty: string[] = [];
    for (const a of accounts) {
      const d = drafts.get(a.id);
      const o = own[a.id];
      const inh = baselineRef.current.get(a.id);
      if (!d || !inh) continue;
      const storedPre = o?.plannedContributionPreTax ?? inh.preTax;
      const storedPost = o?.plannedContributionPostTax ?? inh.postTax;
      const storedGrowth = isValidContributionGrowthPct(o?.contributionGrowthPct)
        ? o?.contributionGrowthPct
        : undefined;
      if (
        d.preTax !== storedPre ||
        d.postTax !== storedPost ||
        d.growthPct !== storedGrowth
      ) {
        dirty.push(a.id);
      }
    }
    return dirty;
  }, [accounts, drafts, scenario]);

  const isDirty = dirtyAccountIds.length > 0;
  const { pendingNavModal } = useUnsavedChangesGuard(isDirty);

  const updateDraft = useCallback(
    (accountId: string, side: 'preTax' | 'postTax', value: number) => {
      setDrafts((prev) => {
        const next = new Map(prev);
        const cur = next.get(accountId) ?? { preTax: 0, postTax: 0 };
        next.set(accountId, { ...cur, [side]: value });
        return next;
      });
    },
    [],
  );

  const updateGrowth = useCallback(
    (accountId: string, value: number | undefined) => {
      setDrafts((prev) => {
        const next = new Map(prev);
        const cur = next.get(accountId) ?? { preTax: 0, postTax: 0 };
        next.set(accountId, { ...cur, growthPct: value });
        return next;
      });
    },
    [],
  );

  const resetRow = useCallback(
    (accountId: string) => {
      const inh = baselineRef.current.get(accountId);
      if (!inh) return;
      updateDraft(accountId, 'preTax', inh.preTax);
      updateDraft(accountId, 'postTax', inh.postTax);
      updateGrowth(accountId, undefined);
    },
    [updateDraft, updateGrowth],
  );

  const handleSave = useCallback(async () => {
    if (!scenario || !householdId) return;
    setSaving(true);
    setError(null);
    try {
      // An amount differing from the inherited baseline or an explicit growth override (incl. 0 = flat-nominal) becomes an entry; the draft's own growthPct is the source of truth.
      const perAccount: Record<
        string,
        {
          plannedContributionPreTax?: number;
          plannedContributionPostTax?: number;
          contributionGrowthPct?: number;
        }
      > = {};
      for (const a of accounts) {
        const d = drafts.get(a.id);
        const inh = baselineRef.current.get(a.id);
        if (!d || !inh) continue;
        const preDiffers = d.preTax !== inh.preTax;
        const postDiffers = d.postTax !== inh.postTax;
        const hasGrowthOverride = isValidContributionGrowthPct(d.growthPct);
        if (!preDiffers && !postDiffers && !hasGrowthOverride) continue;
        const entry: {
          plannedContributionPreTax?: number;
          plannedContributionPostTax?: number;
          contributionGrowthPct?: number;
        } = {};
        if (preDiffers) entry.plannedContributionPreTax = d.preTax;
        if (postDiffers) entry.plannedContributionPostTax = d.postTax;
        if (hasGrowthOverride) entry.contributionGrowthPct = d.growthPct;
        perAccount[a.id] = entry;
      }
      const nextOverrides = { ...scenario.payload.overrides };
      if (Object.keys(perAccount).length === 0) {
        delete nextOverrides.accountContributions;
      } else {
        nextOverrides.accountContributions = { perAccount };
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
    if (scenario.payload.overrides.accountContributions === undefined) return;
    setSaving(true);
    setError(null);
    try {
      const nextOverrides = { ...scenario.payload.overrides };
      delete nextOverrides.accountContributions;
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
      <section aria-labelledby="scenario-contributions-heading">
        <PageHeader title={<span id="scenario-contributions-heading">Account contributions</span>} />
        <LoadingState label="Loading contributions…" variant="table" />
      </section>
    );
  }

  if (error || !scenario) {
    return (
      <section aria-labelledby="scenario-contributions-heading">
        <PageHeader title={<span id="scenario-contributions-heading">Account contributions</span>} />
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
  const own = scenario.payload.overrides.accountContributions?.perAccount ?? {};
  const overriddenCount = Object.keys(own).length;
  const resetAllLabel = 'Reset all';

  const headCentered = `${thStickyClass} text-center`;
  return (
    <section aria-labelledby="scenario-contributions-heading">
      <nav aria-label="Breadcrumb" className={breadcrumbNavClass}>
        <Link to={`/scenarios/${id}`}>← Back to scenario</Link>
      </nav>
      <PageHeader
        title={
          <span id="scenario-contributions-heading">
            Account contributions: {scenario.payload.name}
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
            aria-label="Reset all account contribution overrides"
          >
            <RefreshIcon />
            {resetAllLabel}
          </button>
        </div>
      )}

      <div className={noteClass}>
        <p className="m-0">
          Override the planned annual contribution per account for this
          scenario. Blank / matching the baseline column means &quot;use the
          inherited value.&quot;{' '}
          <strong className="font-bold text-ink">
            Stop contributions today
          </strong>{' '}
          (set on the scenario detail page) still wins globally when enabled.
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
        <TableScroll label="Per-account contribution overrides">
        <Table className={tableClass} aria-label="Per-account contribution overrides">
            <TableHeader>
              <Column isRowHeader className={thStickyClass}>Account</Column>
              <Column className={thStickyClass}>Owner</Column>
              <Column className={headCentered}>Baseline pre-tax</Column>
              <Column className={headCentered}>Scenario pre-tax</Column>
              <Column className={headCentered}>Baseline post-tax</Column>
              <Column className={headCentered}>Scenario post-tax</Column>
              <Column className={headCentered}>Annual increase</Column>
              <Column className={thStickyClass}>
                <span className="sr-only">Actions</span>
              </Column>
            </TableHeader>
            <TableBody>
              {accounts.map((a) => {
                const inh = baselineRef.current.get(a.id);
                const d = drafts.get(a.id);
                if (!inh || !d) return null;
                const owner = memberDisplay(memberById.get(a.payload.ownerId));
                const editablePre = isTreatmentEditablePreTax(a.payload.taxTreatment);
                const editablePost = isTreatmentEditablePostTax(a.payload.taxTreatment);
                const isLocallyOverridden = own[a.id] !== undefined;
                return (
                  <Row key={a.id} id={a.id}>
                    <Cell className={`${tdClass} relative`}>
                      <BucketBar bucket={accountBucket(a.payload.type)} />
                      {a.payload.name}
                      <NotesIndicator notes={a.payload.notes} />
                      {isLocallyOverridden && (
                        <Badge tone="modified" className="ml-2">
                          Override
                        </Badge>
                      )}
                    </Cell>
                    <Cell className={tdClass}>{a.payload.ownershipType === 'JOINT' ? 'Joint' : owner}</Cell>
                    <Cell className={tdNumClass}>
                      {editablePre ? formatCurrency(inh.preTax) : ''}
                    </Cell>
                    <Cell className={tdClass}>
                      {editablePre && (
                        <span className="inline-block w-28">
                          <MoneyInput
                            variant="cell"
                            ariaLabel={`${a.payload.name} scenario pre-tax`}
                            value={d.preTax}
                            onChange={(v) => updateDraft(a.id, 'preTax', v)}
                          />
                        </span>
                      )}
                    </Cell>
                    <Cell className={tdNumClass}>
                      {editablePost ? formatCurrency(inh.postTax) : ''}
                    </Cell>
                    <Cell className={tdClass}>
                      {editablePost && (
                        <span className="inline-block w-28">
                          <MoneyInput
                            variant="cell"
                            ariaLabel={`${a.payload.name} scenario post-tax`}
                            value={d.postTax}
                            onChange={(v) => updateDraft(a.id, 'postTax', v)}
                          />
                        </span>
                      )}
                    </Cell>
                    {/* undefined inherits (the placeholder); an explicit number, including 0 = flat-nominal, overrides and shows the editable PercentInput. */}
                    <Cell className={tdNumClass}>
                      {d.growthPct === undefined ? (
                        <button
                          type="button"
                          className="text-xs text-accent-link underline underline-offset-2 hover:no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:text-muted disabled:no-underline"
                          onClick={() => updateGrowth(a.id, 0)}
                          disabled={saving}
                          aria-label={`${a.payload.name} annual increase — ${growthPlaceholder(
                            inheritedGrowthRef.current.get(a.id),
                          )} (set a rate)`}
                        >
                          {growthPlaceholder(
                            inheritedGrowthRef.current.get(a.id),
                          )}
                        </button>
                      ) : (
                        <span className="inline-flex items-center justify-end gap-1.5">
                          <span className="inline-block w-20 text-left">
                            <PercentInput
                              variant="cell"
                              ariaLabel={`${a.payload.name} scenario annual increase`}
                              value={d.growthPct}
                              onChange={(v) => updateGrowth(a.id, v)}
                              allowNegative
                              min={MIN_CONTRIBUTION_GROWTH_PCT_INPUT}
                              max={MAX_CONTRIBUTION_GROWTH_PCT}
                            />
                          </span>
                          <button
                            type="button"
                            className={`${btnDangerSmClass} gap-1.5`}
                            onClick={() => updateGrowth(a.id, undefined)}
                            disabled={saving}
                            aria-label={`Clear ${a.payload.name} annual increase override`}
                          >
                            <RefreshIcon />
                          </button>
                        </span>
                      )}
                    </Cell>
                    <Cell className={tdClass}>
                      {isLocallyOverridden && (
                        <button
                          type="button"
                          className={`${btnDangerSmClass} gap-1.5`}
                          onClick={() => resetRow(a.id)}
                          disabled={saving}
                          aria-label={`Reset ${a.payload.name} contribution override`}
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

