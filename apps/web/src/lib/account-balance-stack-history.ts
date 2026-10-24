// Turns recorded `accountBalance` aggregates into per-year, per-account rows for the Account Balance Stack chart (routing in `routeBalance`).
// A band holds its last `endingBalance` flat (`carriedForward: true`) to the latest actual year; a $0 last entry drops it.

import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
} from '../db/types';

interface HistoryAccountYear {
  readonly balance: number;
  readonly preEnd: number;
  readonly postEnd: number;
  readonly carriedForward: boolean;
}

export interface HistoryYearRow {
  readonly year: number;
  readonly accountBalances: ReadonlyMap<string, HistoryAccountYear>;
}

function routeBalance(
  account: AccountPayload,
  bal: AccountBalancePayload,
): { balance: number; preEnd: number; postEnd: number } {
  const balance = bal.endingBalance;
  if (account.taxTreatment === 'MIXED') {
    const preEnd = bal.endingBalancePreTax ?? 0;
    const postEnd = bal.endingBalancePostTax ?? 0;
    // With both splits absent, route the full balance to pre-tax (the dominant bucket) so the account is not dropped.
    if (preEnd === 0 && postEnd === 0 && balance > 0) {
      return { balance, preEnd: balance, postEnd: 0 };
    }
    return { balance, preEnd, postEnd };
  }
  // Only PRE_TAX goes to preEnd; POST_TAX, ROTH and HSA go to postEnd.
  if (account.taxTreatment === 'PRE_TAX') {
    return { balance, preEnd: balance, postEnd: 0 };
  }
  return { balance, preEnd: 0, postEnd: balance };
}

function distinctBalanceYears(
  balances: ReadonlyArray<Aggregate<AccountBalancePayload>>,
  liveIds?: ReadonlySet<string>,
): number[] {
  const years = new Set<number>();
  for (const b of balances) {
    if (b.deletedAt) continue;
    if (liveIds && !liveIds.has(b.payload.accountId)) continue;
    years.add(b.payload.year);
  }
  return [...years].sort((a, b) => a - b);
}

/** Latest year any live account has a balance row, or null; rows of deleted accounts are excluded when `accounts` is given. */
export function latestActualBalanceYear(
  balances: ReadonlyArray<Aggregate<AccountBalancePayload>>,
  accounts?: ReadonlyArray<Aggregate<AccountPayload>>,
): number | null {
  const liveIds = accounts
    ? new Set(accounts.filter((a) => !a.deletedAt).map((a) => a.id))
    : null;
  let latest: number | null = null;
  for (const b of balances) {
    if (b.deletedAt) continue;
    if (liveIds && !liveIds.has(b.payload.accountId)) continue;
    if (latest === null || b.payload.year > latest) latest = b.payload.year;
  }
  return latest;
}

/** Count of distinct years with a balance row (the chart renders at 2 or more); deleted-account rows are excluded when `accounts` is given. */
export function distinctBalanceYearCount(
  balances: ReadonlyArray<Aggregate<AccountBalancePayload>>,
  accounts?: ReadonlyArray<Aggregate<AccountPayload>>,
): number {
  const liveIds = accounts
    ? new Set(accounts.filter((a) => !a.deletedAt).map((a) => a.id))
    : undefined;
  return distinctBalanceYears(balances, liveIds).length;
}

/** Rows from the earliest balance year to the latest actual year; empty when there are no live balance rows. */
export function buildAccountBalanceStackHistory(
  accounts: ReadonlyArray<Aggregate<AccountPayload>>,
  balances: ReadonlyArray<Aggregate<AccountBalancePayload>>,
): HistoryYearRow[] {
  const accountById = new Map<string, AccountPayload>();
  for (const a of accounts) {
    if (a.deletedAt) continue;
    accountById.set(a.id, a.payload);
  }

  // From the live accounts, so deleted-account rows cannot extend the window.
  const years = distinctBalanceYears(balances, new Set(accountById.keys()));
  if (years.length === 0) return [];
  const latestYear = years[years.length - 1];
  const earliestYear = years[0];

  const byAccount = new Map<string, Map<number, AccountBalancePayload>>();
  for (const b of balances) {
    if (b.deletedAt) continue;
    const accountId = b.payload.accountId;
    if (!accountById.has(accountId)) continue; // orphan / deleted account
    let m = byAccount.get(accountId);
    if (!m) {
      m = new Map();
      byAccount.set(accountId, m);
    }
    m.set(b.payload.year, b.payload);
  }

  const rows: HistoryYearRow[] = [];
  for (let year = earliestYear; year <= latestYear; year++) {
    const accountBalances = new Map<string, HistoryAccountYear>();
    for (const [accountId, yearMap] of byAccount) {
      const account = accountById.get(accountId);
      if (!account) continue;
      const firstYear = Math.min(...yearMap.keys());
      // A band starts at the account's own first entry.
      if (year < firstYear) continue;
      const actual = yearMap.get(year);
      if (actual) {
        const routed = routeBalance(account, actual);
        accountBalances.set(accountId, { ...routed, carriedForward: false });
        continue;
      }
      let priorYear = -Infinity;
      for (const y of yearMap.keys()) {
        if (y < year && y > priorYear) priorYear = y;
      }
      if (priorYear === -Infinity) continue; // before the band's first entry
      const prior = yearMap.get(priorYear)!;
      if (prior.endingBalance === 0) continue;
      const routed = routeBalance(account, prior);
      accountBalances.set(accountId, { ...routed, carriedForward: true });
    }
    rows.push({ year, accountBalances });
  }
  return rows;
}
