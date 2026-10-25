/** Household-wide account balances overview from account, accountBalance and householdMember aggregates; Edit on a row jumps to the per-account entries page. */
import React, { useMemo } from 'react';
import { useNavigate } from 'react-router';
import {
  Cell,
  Column,
  Row,
  Table,
  TableBody,
  TableHeader,
} from 'react-aria-components';
import { useAggregates } from '../lib/use-aggregates';
import { computePortfolioSummary, type SummaryResult } from '../lib/balance-calc';
import { formatCurrency } from '../lib/format-currency';
import { formatDate } from '../lib/format-date';
import { formatPercent } from '../components/PercentInput';
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
} from '../db/types';
import { ACCOUNT_TYPE_LABELS } from '../api/types';
import { EmptyState } from '../components/EmptyState';
import { TextLink } from '../components/TextLink';
import { Badge, badgeToneForBucket } from '../components/Badge';
import { Alert } from '../components/Alert';
import { NotesIndicator } from '../components/NotesIndicator';
import { Muted } from '../components/Muted';
import { PageHeader } from '../components/PageHeader';
import { TableScroll } from '../components/TableScroll';
import { StatGrid, Stat } from '../components/StatGrid';
import { Tooltip } from '../components/Tooltip';
import { InfoCircleIcon } from '../components/InfoCircleIcon';
import { accountBucket } from '../lib/account-bucket';
import {
  buildAccountBalanceStackHistory,
  distinctBalanceYearCount,
} from '../lib/account-balance-stack-history';
import {
  AccountBalanceStackBand,
  type StackBandYear,
} from './balance-projection-page-account-balance-stack';
import { CARD_SECTION_CLASS } from './balance-projection-page-constants';
import {
  BucketBar,
  EyeIcon,
  PencilIcon,
  iactEditClass,
  iactViewClass,
  inactiveRowCellClass,
  tableClass,
  tdClass,
  tdNumClass,
  thClass,
  thNumClass,
  valueNegativeClass,
  valuePositiveClass,
} from './accounts-page-chrome';

function ownerDisplay(
  payload: AccountPayload,
  members: Map<string, HouseholdMemberPayload>,
): string {
  if (payload.ownershipType === 'JOINT') return 'Joint';
  const m = members.get(payload.ownerId);
  if (!m) return '—';
  return m.firstName?.trim() || 'Member';
}

// The whole label (text + icon) is the hover/focus target, so the icon stays aria-hidden and the accessible name is the label text, with the description wired via the tooltip's aria-describedby.
function statLabel(text: string, hint: string): React.ReactNode {
  return (
    <Tooltip multiline content={hint}>
      <span className="inline-flex items-center gap-1">
        {text}
        <InfoCircleIcon width={12} height={12} className="text-muted" />
      </span>
    </Tooltip>
  );
}

export const AccountBalancesListPage: React.FC = () => {
  const navigate = useNavigate();
  const accountQuery = useAggregates('account');
  const balanceQuery = useAggregates('accountBalance');
  const memberQuery = useAggregates('householdMember');

  const ready = accountQuery.ready && balanceQuery.ready && memberQuery.ready;
  const error =
    accountQuery.error || balanceQuery.error || memberQuery.error
      ? 'Failed to load account balances'
      : null;

  const rawAccounts = useMemo<ReadonlyArray<Aggregate<AccountPayload>>>(
    () =>
      [...(accountQuery.aggregates as ReadonlyArray<Aggregate<AccountPayload>>)].sort(
        (a, b) => a.payload.name.localeCompare(b.payload.name),
      ),
    [accountQuery.aggregates],
  );
  const rawBalances = balanceQuery.aggregates as ReadonlyArray<
    Aggregate<AccountBalancePayload>
  >;

  const data = useMemo<SummaryResult | null>(() => {
    if (!ready) return null;
    const members = memberQuery.aggregates as ReadonlyArray<
      Aggregate<HouseholdMemberPayload>
    >;
    const memberById = new Map<string, HouseholdMemberPayload>();
    for (const m of members) memberById.set(m.id, m.payload);
    return computePortfolioSummary(
      rawAccounts.map((a) => ({
        account: a,
        ownerDisplayName: ownerDisplay(a.payload, memberById),
      })),
      rawBalances as Aggregate<AccountBalancePayload>[],
    );
  }, [ready, memberQuery.aggregates, rawAccounts, rawBalances]);

  // Historical-only rows (zone 'actual', nominal) so every span renders as recorded history with no projected region.
  const stackRows = React.useMemo<StackBandYear[]>(() => {
    return buildAccountBalanceStackHistory(rawAccounts, rawBalances).map(
      (h) => ({
        year: h.year,
        accountBalances: h.accountBalances,
        zone: 'actual' as const,
      }),
    );
  }, [rawAccounts, rawBalances]);

  const stackAccounts = React.useMemo(
    () =>
      rawAccounts
        .filter((a) => !a.deletedAt)
        .map((a) => ({
          id: a.id,
          name: a.payload.name,
          type: a.payload.type,
          taxTreatment: a.payload.taxTreatment,
        })),
    [rawAccounts],
  );

  const showStackChart = distinctBalanceYearCount(rawBalances, rawAccounts) >= 2;

  if (data === null && error === null) {
    return (
      <section aria-labelledby="account-balances-heading">
        <PageHeader title={<span id="account-balances-heading">Account Balances</span>} />
        <p aria-busy="true">Loading…</p>
      </section>
    );
  }

  // No header add-action: adding a balance year is a per-account act, on the account's balances sub-page.

  return (
    <section aria-labelledby="account-balances-heading">
      <PageHeader
        title={<span id="account-balances-heading">Account Balances</span>}
        subtitle="Current balance for every household account. Click Edit on a row to enter or update annual entries."
      />

      {error && <Alert tone="error">{error}</Alert>}

      {data &&
        (() => {
          const { accounts, summary } = data;
          const fmtPct = (v: number | null) => (v === null ? '—' : formatPercent(v));
          const colorPct = (v: number | null) => {
            if (v === null) return undefined;
            return v < 0 ? valueNegativeClass : valuePositiveClass;
          };
          const colored = (text: string, cls?: string) =>
            cls ? <span className={cls}>{text}</span> : text;
          return (
            <>
              <div className="mb-5" aria-label="Portfolio summary">
                <StatGrid cols="four">
                  <Stat
                    label={statLabel(
                      'Contributions',
                      'The total money you and any employer have put into all your accounts over time. Investment growth is not included here.',
                    )}
                    value={formatCurrency(summary.totalContributions)}
                  />
                  <Stat
                    label={statLabel(
                      'Current Balance',
                      'What all your household accounts are worth today, added together.',
                    )}
                    value={formatCurrency(summary.totalCurrentBalance)}
                  />
                  <Stat
                    label={statLabel(
                      'Gain/Loss',
                      "How much your accounts have grown or shrunk: today's balance minus everything you put in. Green is a gain, red a loss.",
                    )}
                    value={colored(
                      formatCurrency(summary.totalGainLoss),
                      summary.totalGainLoss < 0
                        ? valueNegativeClass
                        : valuePositiveClass,
                    )}
                  />
                  <Stat
                    label={statLabel(
                      'Ann. Return',
                      'Your average yearly growth rate across all accounts, with the timing of your deposits and withdrawals factored out (time-weighted return).',
                    )}
                    value={
                      summary.twr === null
                        ? '—'
                        : colored(
                            formatPercent(summary.twr),
                            summary.twr < 0
                              ? valueNegativeClass
                              : valuePositiveClass,
                          )
                    }
                  />
                  <Stat
                    label={statLabel(
                      'Tax-Deferred Balance',
                      "Money in traditional 401(k)s, IRAs, and similar accounts. You haven't paid income tax on it yet — it's taxed as income when you withdraw in retirement.",
                    )}
                    value={formatCurrency(summary.totalPreTaxBalance)}
                  />
                  <Stat
                    label={statLabel(
                      'Tax-Deferred %',
                      'The share of your total savings held in tax-deferred accounts.',
                    )}
                    value={formatPercent(summary.preTaxPct)}
                  />
                  <Stat
                    label={statLabel(
                      'Taxable Balance',
                      "Money in regular brokerage or savings accounts. You've already paid income tax on it; you only owe tax on future gains, interest, and dividends.",
                    )}
                    value={formatCurrency(summary.totalPostTaxBalance)}
                  />
                  <Stat
                    label={statLabel(
                      'Taxable %',
                      'The share of your total savings held in ordinary taxable accounts.',
                    )}
                    value={formatPercent(summary.postTaxPct)}
                  />
                  {/* HSA accounts carry the HSA treatment, so they sit in this tax-free bucket rather than the pre/post split; the three buckets reconstitute the total. */}
                  <Stat
                    label={statLabel(
                      'Tax-Free Balance',
                      'Money in Roth accounts and HSAs. Qualified withdrawals come out completely tax-free in retirement.',
                    )}
                    value={formatCurrency(summary.totalTaxFreeBalance)}
                  />
                  <Stat
                    label={statLabel(
                      'Tax-Free %',
                      'The share of your total savings you can withdraw tax-free.',
                    )}
                    value={formatPercent(summary.taxFreePct)}
                  />
                </StatGrid>
              </div>

              {accounts.length === 0 ? (
                <EmptyState
                  action={<TextLink to="/accounts">Go to Accounts</TextLink>}
                >
                  No accounts yet. Add a retirement or savings account first,
                  then enter each account&apos;s year-end balance history here.
                </EmptyState>
              ) : (
                <>
                  {/* scroll={false}: WebKit leaves a row's :hover stuck inside an overflow container (see "Tables" in docs/ui-conventions.md). */}
                  <TableScroll label="Household account balances" scroll={false}>
                    <Table
                      aria-label="Household account balances"
                      className={tableClass}
                    >
                      <TableHeader>
                        <Column isRowHeader className={thClass}>Name</Column>
                        <Column className={thClass}>Owner</Column>
                        <Column className={thClass}>Type</Column>
                        <Column className={thNumClass}>Current Balance</Column>
                        <Column className={`${thClass} text-right`}>As of</Column>
                        <Column className={thNumClass}>Historical</Column>
                        <Column className={thClass}>
                          <span className="sr-only">Actions</span>
                        </Column>
                      </TableHeader>
                      <TableBody>
                        {accounts.map((a) => {
                          const cell = a.active
                            ? tdClass
                            : `${tdClass} ${inactiveRowCellClass}`;
                          const bucket = accountBucket(a.type);
                          return (
                            <Row key={a.id} id={a.id} className="group/row">
                              <Cell className={`${cell} relative`}>
                                <BucketBar bucket={bucket} />
                                <span className="inline-flex items-center gap-1.5">
                                  {a.name}
                                  <NotesIndicator notes={a.notes} />
                                </span>
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
                              <Cell className={tdNumClass}>
                                {a.currentBalance === null
                                  ? '—'
                                  : formatCurrency(a.currentBalance)}
                              </Cell>
                              <Cell className={`${cell} text-right text-muted`}>
                                {a.currentBalanceAsOf
                                  ? formatDate(a.currentBalanceAsOf)
                                  : '—'}
                              </Cell>
                              <Cell className={tdNumClass}>
                                {colored(fmtPct(a.twr), colorPct(a.twr))}
                              </Cell>
                              <Cell className={cell}>
                                {/* The aria-label keeps the "Edit/View balances for X" accessible name; the eye glyph is the inactive view-only affordance. */}
                                <div className="row-actions items-center">
                                  <button
                                    type="button"
                                    className={a.active ? iactEditClass : iactViewClass}
                                    onClick={() =>
                                      navigate(`/accounts/${a.id}/balances`)
                                    }
                                    aria-label={
                                      a.active
                                        ? `Edit balances for ${a.name}`
                                        : `View balances for ${a.name}`
                                    }
                                  >
                                    {a.active ? <PencilIcon /> : <EyeIcon />}
                                  </button>
                                </div>
                              </Cell>
                            </Row>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </TableScroll>
                  {accounts.some((a) => !a.active) && (
                    <Muted as="p" className="mt-2 text-sm">
                      Totals include data from inactive accounts.
                    </Muted>
                  )}
                </>
              )}
            </>
          );
        })()}

      {showStackChart && (
        <section
          className={`${CARD_SECTION_CLASS} mt-6`}
          aria-labelledby="acct-balance-stack-heading"
        >
          <AccountBalanceStackBand
            accounts={stackAccounts}
            rows={stackRows}
            showExcludedToggle={false}
          />
        </section>
      )}
    </section>
  );
};
