/**
 * Annual contributions.
 *
 * Reads `account` + `accountBalance` + `householdMember` aggregates
 * from IndexedDB; computes planned/actual/remaining via
 * `apps/web/src/lib/contributions-calc.ts` (same shape the legacy
 * server returned). Saves the per-row planned values by queueing an
 * `update` mutation on each dirty `Account` aggregate.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Cell,
  Row,
  Table,
  TableBody,
} from 'react-aria-components';
import { useAuth } from '../auth/AuthContext';
import { MoneyInput } from '../components/MoneyInput';
import { PercentInput } from '../components/PercentInput';
import { TableScroll } from '../components/TableScroll';
import { useUnsavedChangesGuard } from '../components/UnsavedChangesGuard';
import { useSync } from '../sync/SyncContext';
import { getAggregate, listAggregates } from '../db/store';
import { queueLocalMutation } from '../sync/mutation-queue';
import {
  computeContributionSummary,
  isTreatmentEditablePreTax,
  isTreatmentEditablePostTax,
  type AccountContributionRow,
  type ContributionSummary,
} from '../lib/contributions-calc';
import { formatCurrency } from '../lib/format-currency';
import {
  MAX_CONTRIBUTION_GROWTH_PCT,
  MIN_CONTRIBUTION_GROWTH_PCT_INPUT,
  isValidContributionGrowthPct,
} from '../lib/contribution-growth';
import { ACCOUNT_TYPE_LABELS } from '../api/types';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
} from '../db/types';
import { EmptyState } from '../components/EmptyState';
import { TextLink } from '../components/TextLink';
import { LoadingState } from '../components/Skeleton';
import { Badge, badgeToneForBucket } from '../components/Badge';
import { accountBucket } from '../lib/account-bucket';
import { Alert } from '../components/Alert';
import { Muted } from '../components/Muted';
import { NotesIndicator } from '../components/NotesIndicator';
import { PageHeader } from '../components/PageHeader';
import { CheckIcon, XIcon, RefreshIcon } from '../components/icons';
import { StatGrid, Stat } from '../components/StatGrid';
import {
  btnDangerSmClass,
  BucketBar,
  ContributionsTableHead,
  inactiveRowCellClass,
  remainingLabel,
  remainingText,
  tableClass,
  tdClass,
  tdNumClass,
  valueNegativeClass,
  valuePositiveClass,
} from './accounts-page-chrome';

interface PlannedDraft {
  preTax: number;
  postTax: number;
  /** Per-account annual-increase rate (percent). `undefined` = tracks
   *  inflation (the "Match inflation" placeholder); an explicit number
   *  (incl. `0` = flat-nominal) overrides. Mirrors the optional
   *  `AccountPayload.contributionGrowthPct` field. */
  growthPct?: number;
}

// HSA accounts show the PRE-TAX contribution field ONLY: an HSA contribution is
// made pre-tax (payroll deduction), so it is stored on the pre-tax side
// (`plannedContributionPreTax`, e.g. the demo $4,150) and the post-tax field is
// hidden. Tax-free withdrawals are handled separately by `taxTreatment === 'HSA'`
// (and, for Roth, `taxTreatment === 'ROTH'`), independent of the contribution
// field. The app does not enforce IRS
// contribution limits.
// Treatment-editability rules live in contributions-calc.ts (shared with the
// scenario contributions page).
const isEditablePreTax = isTreatmentEditablePreTax;
const isEditablePostTax = isTreatmentEditablePostTax;

export const AccountContributionsPage: React.FC = () => {
  const { householdId } = useAuth();
  const { notifyPending } = useSync();

  const [data, setData] = useState<ContributionSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, PlannedDraft>>({});
  const [saving, setSaving] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const baselineRef = useRef<Record<string, PlannedDraft>>({});

  useEffect(() => {
    let active = true;
    setError(null);
    (async () => {
      try {
        const [accounts, balances, members] = await Promise.all([
          listAggregates('account') as Promise<Aggregate<AccountPayload>[]>,
          listAggregates('accountBalance') as Promise<Aggregate<AccountBalancePayload>[]>,
          listAggregates('householdMember') as Promise<Aggregate<HouseholdMemberPayload>[]>,
        ]);
        if (!active) return;
        const memberById = new Map<string, HouseholdMemberPayload>();
        for (const m of members) memberById.set(m.id, m.payload);
        const accountInputs = accounts
          .slice()
          .sort((a, b) => a.payload.name.localeCompare(b.payload.name))
          .map((a) => ({
            account: a,
            ownerDisplayName:
              a.payload.ownershipType === 'JOINT'
                ? 'Joint'
                : ((m) => (m ? (m.firstName?.trim() || 'Member') : '—'))(memberById.get(a.payload.ownerId)),
          }));
        const year = new Date().getUTCFullYear();
        const summary = computeContributionSummary(accountInputs, balances, memberById, year);
        setData(summary);

        // The growth rate lives on the raw `AccountPayload` (not on the
        // computed contribution row), so map it by id here. An out-of-band
        // stored value is dropped to absent (tracks inflation) so the draft
        // never seeds a corrupt rate.
        const growthById = new Map<string, number | undefined>();
        for (const a of accounts) {
          const pct = a.payload.contributionGrowthPct;
          growthById.set(a.id, isValidContributionGrowthPct(pct) ? pct : undefined);
        }

        const baseline: Record<string, PlannedDraft> = {};
        const initialDrafts: Record<string, PlannedDraft> = {};
        for (const a of summary.accounts) {
          const growthPct = growthById.get(a.id);
          baseline[a.id] = { preTax: a.plannedPreTax, postTax: a.plannedPostTax, growthPct };
          initialDrafts[a.id] = { preTax: a.plannedPreTax, postTax: a.plannedPostTax, growthPct };
        }
        baselineRef.current = baseline;
        setDrafts(initialDrafts);
      } catch {
        if (active) setError('Failed to load contributions');
      }
    })();
    return () => {
      active = false;
    };
  }, [reloadToken]);

  const dirtyAccountIds = useMemo(() => {
    const dirty: string[] = [];
    for (const id of Object.keys(drafts)) {
      const base = baselineRef.current[id];
      const draft = drafts[id];
      if (!base) continue;
      if (
        base.preTax !== draft.preTax ||
        base.postTax !== draft.postTax ||
        base.growthPct !== draft.growthPct
      ) {
        dirty.push(id);
      }
    }
    return dirty;
  }, [drafts]);

  const isDirty = dirtyAccountIds.length > 0;
  const { pendingNavModal } = useUnsavedChangesGuard(isDirty);

  const updateDraft = useCallback(
    (accountId: string, side: 'preTax' | 'postTax', value: number) => {
      setDrafts((prev) => ({
        ...prev,
        [accountId]: { ...prev[accountId], [side]: value },
      }));
    },
    [],
  );

  // Set an explicit annual-increase rate (incl. `0` = flat-nominal). Passing
  // `undefined` clears it back to the tracks-inflation default ("Match
  // inflation").
  const updateGrowth = useCallback(
    (accountId: string, value: number | undefined) => {
      setDrafts((prev) => ({
        ...prev,
        [accountId]: { ...prev[accountId], growthPct: value },
      }));
    },
    [],
  );

  const handleSave = useCallback(async () => {
    if (!data || !householdId) return;
    setSaving(true);
    setError(null);
    try {
      for (const id of dirtyAccountIds) {
        const row = data.accounts.find((a) => a.id === id);
        if (!row) continue;
        const draft = drafts[id];
        const existing = (await getAggregate('account', id)) as Aggregate<AccountPayload> | null;
        if (!existing) continue;
        const nextPlannedPre = isEditablePreTax(row.taxTreatment) ? draft.preTax : 0;
        const nextPlannedPost = isEditablePostTax(row.taxTreatment) ? draft.postTax : 0;
        const payload: AccountPayload = {
          ...existing.payload,
          plannedContributionPreTax: nextPlannedPre,
          plannedContributionPostTax: nextPlannedPost,
        };
        // `undefined` growth = tracks inflation → omit the field entirely so
        // the resolver falls back to the default. An explicit number (incl.
        // `0` = flat-nominal) is stored; an out-of-band value is dropped.
        if (isValidContributionGrowthPct(draft.growthPct)) {
          payload.contributionGrowthPct = draft.growthPct;
        } else {
          delete payload.contributionGrowthPct;
        }
        await queueLocalMutation<AccountPayload>({
          type: 'account',
          aggregateId: id,
          householdId,
          operation: 'update',
          expectedVersion: existing.version,
          payload,
        });
      }
      notifyPending();
      setReloadToken((n) => n + 1);
    } catch {
      setError('Failed to save planned contributions');
    } finally {
      setSaving(false);
    }
  }, [data, householdId, dirtyAccountIds, drafts, notifyPending]);

  if (data === null && error === null) {
    return (
      <section aria-labelledby="contributions-heading">
        <PageHeader title={<span id="contributions-heading">Annual Contributions</span>} />
        <LoadingState label="Loading your contributions…" variant="table" />
      </section>
    );
  }

  return (
    <section aria-labelledby="contributions-heading">
      <PageHeader
        title={<span id="contributions-heading">Annual Contributions</span>}
        subtitle="Plan annual contributions for each household account. Remaining planned amount subtracts what's already been recorded for the current year."
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
                  // Revert edits: bumping the reload token re-reads the
                  // saved values and resets the drafts, flipping isDirty off.
                  onClick: () => setReloadToken((n) => n + 1),
                  disabled: saving,
                  tone: 'neutral',
                },
              ]
            : undefined
        }
      />

      {error && <Alert tone="error">{error}</Alert>}

      {data &&
        (() => {
          const { accounts, summary } = data;
          const colorTotal = (v: number) =>
            v < 0 ? valueNegativeClass : v > 0 ? valuePositiveClass : undefined;
          // `remainingLabel` / `remainingText` (the Overpaid relabel +
          // absolute-amount display) live in accounts-page-chrome so
          // this page stays under the ≤400-line shape limit.
          const remainingTile = (v: number) => remainingText(v, formatCurrency);
          const formatRemaining = (planned: number, remaining: number) => {
            if (planned === 0) return { text: '—', cls: undefined };
            return {
              text: formatCurrency(remaining),
              cls: remaining < 0 ? valueNegativeClass : undefined,
            };
          };
          const statValue = (text: string, cls?: string) =>
            cls ? <span className={cls}>{text}</span> : text;
          return (
            <>
              <div className="mb-5" aria-label="Annual contributions summary">
                <StatGrid cols="six">
                  <Stat
                    label="Total Contributions"
                    value={formatCurrency(summary.totalPlanned)}
                  />
                  <Stat
                    label="Total Pre-Tax"
                    value={formatCurrency(summary.totalPlannedPreTax)}
                  />
                  <Stat
                    label="Total Post-Tax"
                    value={formatCurrency(summary.totalPlannedPostTax)}
                  />
                  <Stat
                    label={remainingLabel('Total', summary.totalRemaining)}
                    value={statValue(
                      remainingTile(summary.totalRemaining),
                      colorTotal(summary.totalRemaining),
                    )}
                  />
                  <Stat
                    label={remainingLabel(
                      'Pre-Tax',
                      summary.totalRemainingPreTax,
                    )}
                    value={statValue(
                      remainingTile(summary.totalRemainingPreTax),
                      colorTotal(summary.totalRemainingPreTax),
                    )}
                  />
                  <Stat
                    label={remainingLabel(
                      'Post-Tax',
                      summary.totalRemainingPostTax,
                    )}
                    value={statValue(
                      remainingTile(summary.totalRemainingPostTax),
                      colorTotal(summary.totalRemainingPostTax),
                    )}
                  />
                </StatGrid>
              </div>

              {accounts.length === 0 ? (
                <EmptyState
                  action={<TextLink to="/accounts">Go to Accounts</TextLink>}
                >
                  No accounts yet. Add a retirement or savings account first,
                  then track each year&apos;s contributions against your planned
                  target here.
                </EmptyState>
              ) : (
                <>
                  {/* Canonical scrolling TableScroll card + sticky headers
                      matching the other data tables. */}
                  <TableScroll label="Annual contributions per account">
                  <Table
                    aria-label="Annual contributions per account"
                    className={tableClass}
                  >
                    <ContributionsTableHead />
                    <TableBody>
                      {accounts.map((a: AccountContributionRow) => {
                        const draft =
                          drafts[a.id] ?? { preTax: a.plannedPreTax, postTax: a.plannedPostTax };
                        const draftRemainingPre = draft.preTax - a.actualPreTax;
                        const draftRemainingPost = draft.postTax - a.actualPostTax;
                        const draftRemainingTotal = draftRemainingPre + draftRemainingPost;
                        const remainingPre = formatRemaining(draft.preTax, draftRemainingPre);
                        const remainingPost = formatRemaining(draft.postTax, draftRemainingPost);
                        const totalPlanned = draft.preTax + draft.postTax;
                        const remainingTotal = formatRemaining(totalPlanned, draftRemainingTotal);
                        const editablePre = isEditablePreTax(a.taxTreatment);
                        const editablePost = isEditablePostTax(a.taxTreatment);
                        const cell = a.active
                          ? tdClass
                          : `${tdClass} ${inactiveRowCellClass}`;
                        const bucket = accountBucket(a.type);
                        return (
                          <Row key={a.id} id={a.id}>
                            {/* Name cell hosts the absolutely-positioned
                                bucket bar, so it must be `relative` — matching
                                Accounts / Account Balances. */}
                            <Cell className={`${cell} relative`}>
                              <BucketBar bucket={bucket} />
                              {a.name}
                              <NotesIndicator notes={a.notes} />
                              {!a.active && (
                                <Badge tone="muted" className="ml-2">
                                  Inactive
                                </Badge>
                              )}
                            </Cell>
                            <Cell className={cell}>{a.ownerDisplayName}</Cell>
                            <Cell className={cell}>
                              <Badge tone={badgeToneForBucket(bucket)}>
                                {ACCOUNT_TYPE_LABELS[a.type]}
                              </Badge>
                            </Cell>
                            {/* Editable amount columns are kept narrow (the
                                input no longer claims full cell width) so the
                                Name / Owner / Type text columns get the slack.
                                tdNumClass right-aligns the box under its
                                right-aligned header. */}
                            <Cell className={tdNumClass}>
                              {editablePre && (
                                <span className="inline-block w-28">
                                  <MoneyInput
                                    variant="cell"
                                    ariaLabel={`${a.name} planned pre-tax`}
                                    value={draft.preTax}
                                    onChange={(v) => updateDraft(a.id, 'preTax', v)}
                                    disabled={!a.active}
                                  />
                                </span>
                              )}
                            </Cell>
                            <Cell className={tdNumClass}>
                              {editablePost && (
                                <span className="inline-block w-28">
                                  <MoneyInput
                                    variant="cell"
                                    ariaLabel={`${a.name} planned post-tax`}
                                    value={draft.postTax}
                                    onChange={(v) => updateDraft(a.id, 'postTax', v)}
                                    disabled={!a.active}
                                  />
                                </span>
                              )}
                            </Cell>
                            {/* Annual-increase rate. Absent = the
                                non-numeric "Match inflation" placeholder
                                (this page has no scenario context, so no
                                resolved %); an explicit number (incl. 0 =
                                flat-nominal) overrides. */}
                            <Cell className={tdNumClass}>
                              {draft.growthPct === undefined ? (
                                <button
                                  type="button"
                                  className="text-xs text-accent-link underline underline-offset-2 hover:no-underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:text-muted disabled:no-underline"
                                  onClick={() => updateGrowth(a.id, 0)}
                                  disabled={!a.active}
                                  aria-label={`${a.name} annual increase — match inflation (set a rate)`}
                                >
                                  Match inflation
                                </button>
                              ) : (
                                <span className="inline-flex items-center justify-end gap-1.5">
                                  <span className="inline-block w-20 text-left">
                                    <PercentInput
                                      variant="cell"
                                      ariaLabel={`${a.name} annual increase`}
                                      value={draft.growthPct}
                                      onChange={(v) => updateGrowth(a.id, v)}
                                      allowNegative
                                      min={MIN_CONTRIBUTION_GROWTH_PCT_INPUT}
                                      max={MAX_CONTRIBUTION_GROWTH_PCT}
                                      disabled={!a.active}
                                    />
                                  </span>
                                  <button
                                    type="button"
                                    className={`${btnDangerSmClass} gap-1.5`}
                                    onClick={() => updateGrowth(a.id, undefined)}
                                    disabled={!a.active}
                                    aria-label={`${a.name} annual increase — clear (match inflation)`}
                                  >
                                    <RefreshIcon />
                                  </button>
                                </span>
                              )}
                            </Cell>
                            <Cell
                              className={`${tdNumClass} ${remainingPre.cls ?? ''}`}
                            >
                              {editablePre ? remainingPre.text : ''}
                            </Cell>
                            <Cell
                              className={`${tdNumClass} ${remainingPost.cls ?? ''}`}
                            >
                              {editablePost ? remainingPost.text : ''}
                            </Cell>
                            <Cell
                              className={`${tdNumClass} font-medium ${remainingTotal.cls ?? ''}`}
                            >
                              {remainingTotal.text}
                            </Cell>
                          </Row>
                        );
                      })}
                    </TableBody>
                  </Table>
                  </TableScroll>
                  <Muted as="p" className="mt-2 text-sm">
                    Personal and company contributions should be combined when entering planned
                    amounts. Remaining planned amount subtracts what's already been recorded for
                    the current year (personal + company).
                  </Muted>
                  <Muted as="p" className="mt-1 text-sm">
                    These are your own planning targets. The app does not enforce the statutory IRS
                    contribution limits, so you can plan above or below them.
                  </Muted>
                  {accounts.some((a) => !a.active) && (
                    <Muted as="p" className="mt-1 text-sm">
                      Totals include data from inactive accounts.
                    </Muted>
                  )}
                </>
              )}
            </>
          );
        })()}

      {pendingNavModal}
    </section>
  );
};
