/**
 * Pure per-account metric adapter for PDF report inventories.
 */
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
  HouseholdMemberPayload,
} from '../db/types';
import {
  accountReturns,
  gainLoss,
  isRothDesignatedRetirementType,
  totalContributions,
} from './balance-calc';

/** Historical and current values consumed by one PDF report account row. */
export interface ReportAccountMetrics {
  readonly ownerDisplayName: string;
  readonly historicalReturnPct: number | null;
  readonly totalContributions: number;
  readonly totalGains: number;
  readonly currentBalance: number;
  readonly currentBalancePreTax: number | null;
  readonly currentBalancePostTax: number | null;
  readonly currentBalanceTaxFree: number | null;
  readonly balanceAsOfYear: number | null;
  readonly balanceAsOfDate: string | null;
}

interface TaxBuckets {
  readonly currentBalancePreTax: number | null;
  readonly currentBalancePostTax: number | null;
  readonly currentBalanceTaxFree: number | null;
}

/** Resolve report owner copy with same rules as account list surfaces. */
export function reportAccountOwnerDisplayName(
  account: AccountPayload,
  membersById: ReadonlyMap<string, HouseholdMemberPayload>,
): string {
  if (account.ownershipType === 'JOINT') return 'Joint';
  const member = membersById.get(account.ownerId);
  if (!member) return '—';
  return member.firstName?.trim() || 'Member';
}

function reportTaxBuckets(
  account: AccountPayload,
  latest: Aggregate<AccountBalancePayload> | null,
): TaxBuckets {
  const endingBalance = latest?.payload.endingBalance ?? 0;
  const treatment = account.taxTreatment;
  const designatedRoth = isRothDesignatedRetirementType(account.type);

  if (treatment === 'PRE_TAX') {
    return {
      currentBalancePreTax: endingBalance,
      currentBalancePostTax: null,
      currentBalanceTaxFree: null,
    };
  }
  if (treatment === 'POST_TAX') {
    return designatedRoth
      ? {
          currentBalancePreTax: null,
          currentBalancePostTax: null,
          currentBalanceTaxFree: endingBalance,
        }
      : {
          currentBalancePreTax: null,
          currentBalancePostTax: endingBalance,
          currentBalanceTaxFree: null,
        };
  }
  if (treatment === 'ROTH' || treatment === 'HSA') {
    return {
      currentBalancePreTax: null,
      currentBalancePostTax: null,
      currentBalanceTaxFree: endingBalance,
    };
  }

  let preTax = latest?.payload.endingBalancePreTax ?? 0;
  const postTax = latest?.payload.endingBalancePostTax ?? 0;
  // Imported legacy MIXED rows can carry a total without either split. Match
  // the projection chart's dominant-bucket convention so value is not lost.
  if (preTax === 0 && postTax === 0 && endingBalance > 0) preTax = endingBalance;
  return designatedRoth
    ? {
        currentBalancePreTax: preTax,
        currentBalancePostTax: null,
        currentBalanceTaxFree: postTax,
      }
    : {
        currentBalancePreTax: preTax,
        currentBalancePostTax: postTax,
        currentBalanceTaxFree: null,
      };
}

function laterBalance(
  current: Aggregate<AccountBalancePayload> | null,
  candidate: Aggregate<AccountBalancePayload>,
): Aggregate<AccountBalancePayload> {
  if (!current || candidate.payload.year > current.payload.year) return candidate;
  if (candidate.payload.year < current.payload.year) return current;
  if (candidate.payload.lastUpdated > current.payload.lastUpdated) return candidate;
  if (candidate.payload.lastUpdated < current.payload.lastUpdated) return current;
  return candidate.updatedAt > current.updatedAt ? candidate : current;
}

function accountMetric(
  account: Aggregate<AccountPayload>,
  rows: ReadonlyArray<Aggregate<AccountBalancePayload>>,
  membersById: ReadonlyMap<string, HouseholdMemberPayload>,
): ReportAccountMetrics {
  const latest = rows.reduce<Aggregate<AccountBalancePayload> | null>(
    laterBalance,
    null,
  );
  const buckets = reportTaxBuckets(account.payload, latest);
  const asOfDate = latest?.payload.lastUpdated.slice(0, 10) || null;
  return {
    ownerDisplayName: reportAccountOwnerDisplayName(account.payload, membersById),
    historicalReturnPct: accountReturns([...rows]).twr,
    totalContributions: rows.reduce(
      (sum, row) => sum + totalContributions(row.payload),
      0,
    ),
    totalGains: rows.reduce((sum, row) => sum + gainLoss(row.payload), 0),
    currentBalance: latest?.payload.endingBalance ?? 0,
    ...buckets,
    balanceAsOfYear: latest?.payload.year ?? null,
    balanceAsOfDate: asOfDate,
  };
}

/**
 * Build metrics for non-tombstoned accounts from live balance history.
 * Tombstoned/orphaned rows and tombstoned members never affect report output.
 */
export function buildReportAccountMetrics(
  accounts: ReadonlyArray<Aggregate<AccountPayload>>,
  balances: ReadonlyArray<Aggregate<AccountBalancePayload>>,
  members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>,
): ReadonlyMap<string, ReportAccountMetrics> {
  const liveAccounts = accounts.filter((account) => !account.deletedAt);
  const liveAccountIds = new Set(liveAccounts.map((account) => account.id));
  const membersById = new Map(
    members
      .filter((member) => !member.deletedAt)
      .map((member) => [member.id, member.payload]),
  );
  const balancesByAccountId = new Map<
    string,
    Aggregate<AccountBalancePayload>[]
  >();
  for (const balance of balances) {
    if (balance.deletedAt || !liveAccountIds.has(balance.payload.accountId)) continue;
    const rows = balancesByAccountId.get(balance.payload.accountId);
    if (rows) rows.push(balance);
    else balancesByAccountId.set(balance.payload.accountId, [balance]);
  }

  const metrics = new Map<string, ReportAccountMetrics>();
  for (const account of liveAccounts) {
    metrics.set(
      account.id,
      accountMetric(
        account,
        balancesByAccountId.get(account.id) ?? [],
        membersById,
      ),
    );
  }
  return metrics;
}
