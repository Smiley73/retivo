/** /income: canonical income stream list grouped by household member, with annual recurring and one-time totals and per-row Edit / Delete. */
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

// Projects each linked-CBP lump sum's source balance to its event month (the engines' oneOffMonth helper) so the row matches the Balance Projection transfer; uses the base scenario's retirement ages, and unresolvable streams are skipped.
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
  const focusRestoredRef = useRef(false);

  const householdMembers = memberQuery.aggregates as ReadonlyArray<
    Aggregate<HouseholdMemberPayload>
  > as Aggregate<HouseholdMemberPayload>[];

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
    for (const [mid, list] of groupByMember) {
      if (orderedMembers.some((m) => m.id === mid)) continue;
      ordered.push({ memberId: mid, ownerName: '(unknown member)', rows: list });
    }

    return ordered;
  }, [incomeQuery.aggregates, householdMembers]);

  // Restore focus once after the first successful load (keyed off the loading → false transition, not groups.length, which is [] for both not-loaded and loaded-empty); strip the param either way.
  useEffect(() => {
    if (loading) return;
    if (focusRestoredRef.current) return;
    focusRestoredRef.current = true;

    const rawId = searchParams.get('focusIncomeId');
    if (rawId !== null) {
      const url = new URL(window.location.href);
      url.searchParams.delete('focusIncomeId');
      window.history.replaceState(null, '', url.pathname + (url.search === '?' ? '' : url.search));
    }
    if (!rawId) return;
    // Validate: aggregate ids are random UUIDs; reject selector metacharacters.
    if (!/^[\w-]{1,128}$/.test(rawId)) return;
    // Defer one tick so React Aria Table's internal useLayoutEffect re-render finishes before the row lookup.
    const captured = rawId;
    const timer = setTimeout(() => {
      // Focus the row, not a button in a cell: React Aria Table's grid redirects cell focus to the active row. data-income-id is passed through to the <tr>.
      const row = document.querySelector<HTMLElement>(`tr[data-income-id="${captured}"]`);
      if (!row) return;
      // Scroll the row into view (reduced-motion safe).
      row.scrollIntoView({ behavior: 'instant', block: 'nearest' });
      row.focus({ preventScroll: true });
    }, 0);
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
