/**
 * Household-wide account balances overview.
 *
 * Reads `account` + `accountBalance` + `householdMember` aggregates
 * from IndexedDB; portfolio TWR / GainLoss come from
 * `apps/web/src/lib/balance-calc.ts`. Edit on a row jumps to the
 * per-account annual entries page.
 */
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

// A summary-card label paired with an info (i) tooltip giving a plain-English
// description of what the figure means. The whole label (text + icon) is the
// hover/focus target, so the icon stays decorative (aria-hidden) and the
// trigger's accessible name is just the label text, with the description wired
// in via the tooltip's `aria-describedby` (React Aria owns that contract).
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
  // Reactive reads: each store re-reads on any write to its type (single
  // saves/deletes via the per-store fine signal, sync bootstrap / demo fill
  // via the coarse workspace event), so the household summary + history chart
  // refresh without a manual reload dep.
  const accountQuery = useAggregates('account');
  const balanceQuery = useAggregates('accountBalance');
  const memberQuery = useAggregates('householdMember');

  const ready = accountQuery.ready && balanceQuery.ready && memberQuery.ready;
  const error =
    accountQuery.error || balanceQuery.error || memberQuery.error
      ? 'Failed to load account balances'
      : null;

  // Raw aggregates retained for the bottom "Account balances over time" chart
  // (historical-only, all accounts incl. inactive), name-sorted.
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

  // Household portfolio summary — derived from the reactive hook outputs;
  // `null` until every slice settles so the page keeps its loading copy.
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

  // Historical-only timeline rows for the bottom chart: all
  // accounts incl. inactive, nominal (no display toggle on this page), zone
  // 'actual' so every span renders as recorded history (no projected region).
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

  // Render the chart only when ≥ 2 distinct balance years exist.
  const showStackChart = distinctBalanceYearCount(rawBalances, rawAccounts) >= 2;

  if (data === null && error === null) {
    return (
      <section aria-labelledby="account-balances-heading">
        <PageHeader title={<span id="account-balances-heading">Account Balances</span>} />
        <p aria-busy="true">Loading…</p>
      </section>
    );
  }

  // No header add-action here: adding a balance year is a per-account act, so
  // it lives only on the individual account's balances sub-page (reached via the
  // per-row Edit). The list page is a read-only overview across all accounts.

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
              {/* Same 2×4 arrangement as the per-account Account Balances
                  page: headline figures up top, pre-/post-tax split below. */}
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
                  {/* Tax-free bucket (Roth + HSA). HSA accounts carry the
                      'HSA' treatment, so they sit here rather than in the
                      pre/post split — the three buckets reconstitute the
                      total. */}
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
                  {/* scroll={false}: this table's rows use the hover-revealed
                      `.row-actions` cluster, and WebKit leaves a row's :hover
                      stuck while it sits inside an overflow container (see
                      "Tables" in docs/ui-conventions.md). */}
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
                              {/* Name cell hosts the absolutely-positioned
                                  bucket bar, so it must be `relative`. */}
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
                                {/* Single action: edit (active) or view
                                    (inactive), as an icon button.
                                    The aria-label keeps the prior
                                    "Edit/View balances for X" accessible name
                                    (a11y + the existing tests). The eye glyph
                                    is the inactive view-only affordance. */}
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

      {/* Bottom "Account balances over time" chart — historical-only,
          all accounts incl. inactive, no Show-excluded toggle and no
          method suffix. Omitted with < 2 distinct balance years. */}
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
