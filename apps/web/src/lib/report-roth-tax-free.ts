// Builder for the PDF "Roth tax-free amounts" table: a row per qualifying Roth-IRA §408A pool and employer designated-Roth plan, from the engines' own `buildRothDistributionFacts` calls.
// The person figure is contribution basis plus conversion-lot principal; the employer figure is recorded basis, not an amount withdrawable tax-free. Recorded dollars, never deflated.

import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
} from '../db/types';
import {
  buildRothAccountFactInputs,
  buildRothDistributionFacts,
} from './balance-projection-runner-tax-helpers';
import type { RothDistributionFacts } from './roth-distribution-tax';
import { reportAccountOwnerDisplayName } from './report-account-metrics';
import { memberName } from './report-format';
import { compareReportNameThenId, sortReportAccounts } from './report-table-ordering';

/** `kind` separates the two halves, which the table adapter describes differently. */
export interface ReportRothTaxFreeRow {
  readonly id: string;
  readonly kind: 'person' | 'employer';
  readonly label: string;
  readonly amount: number;
}

export interface BuildRothTaxFreeRowsInput {
  readonly accounts: ReadonlyArray<Aggregate<AccountPayload>>;
  readonly balances: ReadonlyArray<Aggregate<AccountBalancePayload>>;
  readonly members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
}

/**
 * One row per §408A pool, ordered by display name then member id. Omitted: a
 * person whose only Roth IRA is inherited (`rothIraByPool` never carries a pool for
 * one), and a pool flagged `allAccountsInactive`, whose basis neither engine can
 * credit since every account behind it is closed and never drawn.
 */
function buildPersonRows(
  facts: RothDistributionFacts,
  liveMembers: ReadonlyArray<Aggregate<HouseholdMemberPayload>>,
): ReportRothTaxFreeRow[] {
  const memberById = new Map(liveMembers.map((member) => [member.id, member]));
  const entries = [...facts.rothIraByPool.values()]
    .filter((pool) => pool.rothIra !== undefined && pool.allAccountsInactive !== true)
    .map((pool) => {
      const rothIra = pool.rothIra!;
      const lotsCents = rothIra.conversionLots.reduce(
        (sum, lot) =>
          sum + lot.taxableConvertedPrincipalCents + lot.nontaxableConvertedPrincipalCents,
        0,
      );
      // Labelled from the member record: `reportAccountOwnerDisplayName` answers "Joint" for a jointly-marked account.
      return {
        ownerId: pool.ownerId,
        label: memberName(memberById.get(pool.ownerId), 'Unknown member'),
        amountCents: rothIra.regularContributionBasisCents + lotsCents,
      };
    })
    .sort((a, b) =>
      compareReportNameThenId({ id: a.ownerId, name: a.label }, { id: b.ownerId, name: b.label }),
    );
  return entries.map((entry) => ({
    id: `roth-tax-free-person-${entry.ownerId}`,
    kind: 'person' as const,
    label: entry.label,
    amount: entry.amountCents / 100,
  }));
}

/** One row per designated-Roth account, ordered by `sortReportAccounts`; a recorded $0 basis is a computed figure and is kept. */
function buildEmployerRows(
  facts: RothDistributionFacts,
  accounts: ReadonlyArray<Aggregate<AccountPayload>>,
  liveMembers: ReadonlyArray<Aggregate<HouseholdMemberPayload>>,
): ReportRothTaxFreeRow[] {
  const membersByIdPayload = new Map(liveMembers.map((member) => [member.id, member.payload]));
  const accountById = new Map(accounts.map((account) => [account.id, account.payload]));
  const orderFields = [...facts.designatedByAccount.keys()]
    .map((accountId) => {
      const payload = accountById.get(accountId);
      if (!payload) return null;
      return {
        id: accountId,
        name: payload.name,
        ownerDisplayName: reportAccountOwnerDisplayName(payload, membersByIdPayload),
      };
    })
    .filter(
      (entry): entry is { id: string; name: string; ownerDisplayName: string } =>
        entry !== null,
    );
  return sortReportAccounts(orderFields).map((entry) => ({
    id: `roth-tax-free-employer-${entry.id}`,
    kind: 'employer' as const,
    label: entry.name,
    amount: facts.designatedByAccount.get(entry.id)!.basisCents / 100,
  }));
}

/** Person rows, then employer rows. */
export function buildRothTaxFreeRows({
  accounts,
  balances,
  members,
}: BuildRothTaxFreeRowsInput): ReportRothTaxFreeRow[] {
  const facts = buildRothDistributionFacts(buildRothAccountFactInputs(accounts), balances);
  const liveMembers = members.filter((member) => !member.deletedAt);
  return [
    ...buildPersonRows(facts, liveMembers),
    ...buildEmployerRows(facts, accounts, liveMembers),
  ];
}
