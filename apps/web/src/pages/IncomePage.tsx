/**
 * /income — canonical IncomeStream list (one row per pension /
 * part-time / one-off windfall the household expects). Header cards
 * show annual recurring income (from pension annuities + part-time)
 * and the cumulative one-time / lump-sum total. Rows grouped by
 * household member; alphabetical within member.
 *
 * Per-row: name + kind badge + amount + schedule summary + Edit /
 * Delete actions.
 */
import React, { useEffect, useMemo, useRef } from 'react';
import { PlusIcon } from '../components/icons';
import { useNavigate, useSearchParams } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { useConfirm } from '../components/ConfirmDialog';
import { useSync } from '../sync/SyncContext';
import { queueLocalMutation } from '../sync/mutation-queue';
import { useAggregates } from '../lib/use-aggregates';
import { PageHeader } from '../components/PageHeader';
import { LoadingState } from '../components/Skeleton';
import { Alert } from '../components/Alert';
import { Muted } from '../components/Muted';
import {
  IncomePageMemberSection,
  type IncomeRow,
} from './IncomePageMemberSection';
import { memberDisplayName } from '../lib/income-format';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
  IncomeStreamPayload,
} from '../db/types';
import {
  DEFAULT_INFLATION_PCT,
  DEFAULT_LIFE_EXPECTANCY_AGE,
} from '../db/types';
import {
  resolveScenario,
  type ScenarioAggregate,
} from '../lib/scenario-resolution';
import { resolveMemberRetirementDates } from '../lib/retirement-date-math';
import {
  buildIncomeContext,
  oneOffMonth,
} from '../lib/income-projection';
import { project } from '../lib/projection';

interface MemberGroup {
  memberId: string;
  ownerName: string;
  rows: IncomeRow[];
}

/** For every linked-CBP lump-sum income stream, project the source CBP
 *  account's balance forward from its latest known value to the lump-
 *  sum's event month and return the resulting amount keyed by stream
 *  id. Resolves event months via the same `oneOffMonth` helper the
 *  engines use, so the magnitude on the row matches the dollars the
 *  Balance Projection page actually transfers.
 *
 *  Uses the **base scenario** for retirement-age resolution — the
 *  Income page is scenario-independent; per-scenario projected
 *  transfer values live on the Balance Projection page instead.
 *  Streams that resolve to a missing event month, a missing CBP
 *  account, or a CBP without any AccountBalance history are skipped
 *  (the row falls back to formatIncomeAmount's default $0 once). */
function computeLinkedCbpProjections(input: {
  incomeStreams: ReadonlyArray<Aggregate<IncomeStreamPayload>>;
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
  accounts: ReadonlyArray<Aggregate<AccountPayload>>;
  balances: ReadonlyArray<Aggregate<AccountBalancePayload>>;
  scenarios: ReadonlyArray<ScenarioAggregate>;
}): Map<string, number> {
  const out = new Map<string, number>();
  if (input.scenarios.length === 0 || input.members.length === 0) return out;

  const base = input.scenarios.find(
    (s) => s.payload.parentScenarioId === null,
  );
  if (!base) return out;
  const resolved = resolveScenario(base.id, [...input.scenarios]);
  const memberRetirementById = resolveMemberRetirementDates(
    resolved.retirementAge,
    input.members.map((m) => ({
      id: m.id,
      isPrimary: m.payload.isPrimary,
      birthdate: m.payload.birthdate,
    })),
  );
  const retirementDateByMember = new Map<
    string,
    { year: number; month0?: number }
  >();
  memberRetirementById.forEach((iso, memberId) => {
    if (!iso) return;
    const y = Number(iso.slice(0, 4));
    const m = Number(iso.slice(5, 7));
    if (!Number.isFinite(y)) return;
    retirementDateByMember.set(memberId, {
      year: y,
      month0: Number.isFinite(m) && m >= 1 && m <= 12 ? m - 1 : undefined,
    });
  });

  const primary = input.members.find((m) => m.payload.isPrimary);
  const primaryIso = primary
    ? memberRetirementById.get(primary.id) ?? null
    : null;
  const primaryRetirementYear = primaryIso
    ? Number(primaryIso.slice(0, 4))
    : new Date().getFullYear();
  const now = new Date();
  const incomeCtx = buildIncomeContext(
    input.members as Aggregate<HouseholdMemberPayload>[],
    {
      retirementStartYear: primaryRetirementYear,
      lifeExpectancyPrimary:
        resolved.lifeExpectancy?.primary ?? DEFAULT_LIFE_EXPECTANCY_AGE,
      lifeExpectancySecondary: resolved.lifeExpectancy?.secondary,
      retirementDateByMember,
      todayYear: now.getFullYear(),
      todayMonthIndex: now.getMonth(),
      inflationPct: resolved.inflation?.ratePct ?? DEFAULT_INFLATION_PCT,
    },
  );

  const balancesByAccount = new Map<string, Aggregate<AccountBalancePayload>[]>();
  for (const b of input.balances) {
    const list = balancesByAccount.get(b.payload.accountId) ?? [];
    list.push(b);
    balancesByAccount.set(b.payload.accountId, list);
  }
  const accountById = new Map(input.accounts.map((a) => [a.id, a]));

  for (const stream of input.incomeStreams) {
    const p = stream.payload;
    if (p.kind !== 'pension' || p.payoutType !== 'lumpSum') continue;
    const linkedId = p.linkedCbpAccountId;
    if (typeof linkedId !== 'string' || linkedId.length === 0) continue;
    const cbpAccount = accountById.get(linkedId);
    if (!cbpAccount) continue;
    const cbpBalances = balancesByAccount.get(linkedId) ?? [];
    if (cbpBalances.length === 0) continue;
    const eventMonth = oneOffMonth(p, incomeCtx);
    if (!eventMonth) continue;
    const eventIso = `${eventMonth.year}-${String(eventMonth.month0 + 1).padStart(
      2,
      '0',
    )}-01`;
    const projOut = project({
      account: cbpAccount,
      balances: cbpBalances,
      ratePct: cbpAccount.payload.planningReturnPct,
      retirementDate: eventIso,
      stopContributionsToday: false,
      todayYear: now.getFullYear(),
    });
    if (projOut && projOut.total > 0) {
      out.set(stream.id, projOut.total);
    }
  }
  return out;
}

export const IncomePage: React.FC = () => {
  const { householdId } = useAuth();
  const { notifyPending } = useSync();
  const { confirm, dialog } = useConfirm();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Reactive reads: the income list + its derived projections re-read on any
  // write to the subscribed stores (single saves/deletes via the per-store
  // fine signal, sync bootstrap / demo fill via the coarse workspace event),
  // so the page refreshes without a manual reload dep.
  const incomeQuery = useAggregates('incomeStream');
  const memberQuery = useAggregates('householdMember');
  const accountQuery = useAggregates('account');
  const balanceQuery = useAggregates('accountBalance');
  const scenarioQuery = useAggregates('scenario');
  const loading =
    !incomeQuery.ready ||
    !memberQuery.ready ||
    !accountQuery.ready ||
    !balanceQuery.ready ||
    !scenarioQuery.ready;
  const error =
    incomeQuery.error ||
    memberQuery.error ||
    accountQuery.error ||
    balanceQuery.error ||
    scenarioQuery.error
      ? 'Failed to load income sources.'
      : null;
  // Run-once guard: restore fires at most once per navigation.
  const focusRestoredRef = useRef(false);

  const householdMembers = memberQuery.aggregates as ReadonlyArray<
    Aggregate<HouseholdMemberPayload>
  > as Aggregate<HouseholdMemberPayload>[];

  /** Stream id → projected CBP balance at the lump-sum's event month.
   *  Only populated for `payoutType: 'lumpSum'` streams with
   *  `linkedCbpAccountId` set. Drives the row's "~$X" rendering so the
   *  income overview surfaces the dynamic transfer magnitude instead
   *  of the stored zero. Derived from the BASE scenario's retirement ages
   *  (the Income overview is scenario-independent). */
  const projectedLumpSumByStreamId = useMemo<Map<string, number>>(
    () =>
      computeLinkedCbpProjections({
        incomeStreams: incomeQuery.aggregates as ReadonlyArray<
          Aggregate<IncomeStreamPayload>
        >,
        members: householdMembers,
        accounts: accountQuery.aggregates as ReadonlyArray<
          Aggregate<AccountPayload>
        >,
        balances: balanceQuery.aggregates as ReadonlyArray<
          Aggregate<AccountBalancePayload>
        >,
        scenarios: scenarioQuery.aggregates as ReadonlyArray<ScenarioAggregate>,
      }),
    [
      incomeQuery.aggregates,
      householdMembers,
      accountQuery.aggregates,
      balanceQuery.aggregates,
      scenarioQuery.aggregates,
    ],
  );

  // Group income rows by member. Stable ordering: primary first, then
  // secondary, then anything else by name; orphan rows (member unresolved)
  // land last.
  const groups = useMemo<MemberGroup[]>(() => {
    const incomeStreams = incomeQuery.aggregates as ReadonlyArray<
      Aggregate<IncomeStreamPayload>
    >;
    const memberById = new Map<string, Aggregate<HouseholdMemberPayload>>();
    for (const m of householdMembers) memberById.set(m.id, m);

    const rows: IncomeRow[] = incomeStreams.map((i) => ({
      id: i.id,
      version: i.version,
      payload: i.payload,
      ownerName: memberDisplayName(memberById.get(i.payload.memberId)),
    }));

    const groupByMember = new Map<string, IncomeRow[]>();
    for (const r of rows) {
      const list = groupByMember.get(r.payload.memberId) ?? [];
      list.push(r);
      groupByMember.set(r.payload.memberId, list);
    }

    const ordered: MemberGroup[] = [];
    const orderedMembers = [...householdMembers].sort((a, b) => {
      if (a.payload.isPrimary && !b.payload.isPrimary) return -1;
      if (!a.payload.isPrimary && b.payload.isPrimary) return 1;
      return memberDisplayName(a).localeCompare(memberDisplayName(b));
    });
    for (const m of orderedMembers) {
      const list = groupByMember.get(m.id);
      if (!list || list.length === 0) continue;
      list.sort((a, b) => a.payload.name.localeCompare(b.payload.name));
      ordered.push({
        memberId: m.id,
        ownerName: memberDisplayName(m),
        rows: list,
      });
    }
    // Orphan rows whose member couldn't be resolved.
    for (const [mid, list] of groupByMember) {
      if (orderedMembers.some((m) => m.id === mid)) continue;
      ordered.push({ memberId: mid, ownerName: '(unknown member)', rows: list });
    }

    return ordered;
  }, [incomeQuery.aggregates, householdMembers]);

  // Post-load focus restoration: fires once after the first
  // successful data load (keyed off the `loading→false` transition via the
  // `focusRestoredRef` run-once guard — NOT `groups.length`, which is `[]`
  // for both not-loaded and loaded-empty). Validates `focusIncomeId` against a
  // safe format, scrolls the matching row into view, focuses its
  // Edit button, and strips the param via replaceState. A
  // missing/invalid/unmatched id is a no-op: the param is still stripped
  // so the URL stays clean.
  useEffect(() => {
    if (loading) return;
    if (focusRestoredRef.current) return;
    focusRestoredRef.current = true;

    const rawId = searchParams.get('focusIncomeId');
    // Always strip the param from the URL.
    if (rawId !== null) {
      const url = new URL(window.location.href);
      url.searchParams.delete('focusIncomeId');
      window.history.replaceState(null, '', url.pathname + (url.search === '?' ? '' : url.search));
    }
    if (!rawId) return;
    // Validate: aggregate ids are random UUIDs; reject selector metacharacters.
    if (!/^[\w-]{1,128}$/.test(rawId)) return;
    // Defer the DOM query one tick so React Aria Table's internal
    // useLayoutEffect state-update re-render finishes before we look
    // for the row. waitFor in tests polls until the spy fires.
    const captured = rawId;
    const timer = setTimeout(() => {
      // React Aria Table manages focus at the row (<tr>) level via its grid
      // pattern — focusing a button inside a cell causes the grid's onFocus
      // handler to redirect to the active row, so we focus the row directly
      // data-income-id is passed through to the rendered <tr>.
      const row = document.querySelector<HTMLElement>(`tr[data-income-id="${captured}"]`);
      if (!row) return;
      // Scroll the row into view (reduced-motion safe).
      row.scrollIntoView({ behavior: 'instant', block: 'nearest' });
      // Focus the row so React Aria's grid navigation registers it as the
      // active item (tabIndex=-1 rows are still programmatically focusable).
      row.focus({ preventScroll: true });
    }, 0);
    // Cancel the pending query if we unmount within the tick.
    return () => clearTimeout(timer);
  }, [loading, searchParams]);

  const onDelete = async (row: IncomeRow): Promise<void> => {
    if (!householdId) return;
    const ok = await confirm(
      `Delete "${row.payload.name}"?`,
      'This income source will no longer count toward retirement projections. This cannot be undone.',
    );
    if (!ok) return;
    await queueLocalMutation<IncomeStreamPayload>({
      type: 'incomeStream',
      aggregateId: row.id,
      householdId,
      operation: 'delete',
      expectedVersion: row.version,
      payload: row.payload,
    });
    notifyPending();
    // The delete tombstone is an `incomeStream` write, so the reactive read
    // re-runs and drops the row — no manual reload.
  };

  if (loading) {
    return (
      <section aria-labelledby="income-heading">
        <PageHeader title={<span id="income-heading">Income</span>} />
        <LoadingState label="Loading your income sources…" variant="table" />
      </section>
    );
  }

  return (
    <section aria-labelledby="income-heading">
      <PageHeader
        title={<span id="income-heading">Income</span>}
        subtitle="Pensions, part-time work, inheritance, and other money coming in during retirement. Used by the projection to reduce how much you draw from savings each year."
        action={{
          label: 'Add income',
          onClick: () => navigate('/income/new'),
          ariaLabel: 'Add income source',
        }}
        actionIcon={<PlusIcon />}
      />

      {error && <Alert tone="error">{error}</Alert>}

      {groups.length === 0 ? (
        <div className="mb-4 flex flex-col items-start gap-4 rounded-2xl border border-line bg-surface-raised p-6 shadow-sm">
          <Muted as="p" className="m-0 max-w-prose">
            No income sources yet. Add a pension, part-time gig, or expected
            inheritance from the button above, and the drawdown projection
            counts that money before it taps your savings.
          </Muted>
        </div>
      ) : (
        <>
          {groups.map((g) => (
            <IncomePageMemberSection
              key={g.memberId}
              ownerName={g.ownerName}
              rows={g.rows}
              householdMembers={householdMembers}
              projectedLumpSumByStreamId={projectedLumpSumByStreamId}
              onEdit={(r) =>
                navigate(
                  `/income/${r.id}/edit?returnTo=${encodeURIComponent(`/income?focusIncomeId=${r.id}`)}`,
                )
              }
              onDelete={onDelete}
            />
          ))}
        </>
      )}

      {dialog}
    </section>
  );
};
