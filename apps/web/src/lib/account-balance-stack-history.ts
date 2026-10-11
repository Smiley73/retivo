/**
 * Pure helper: turn recorded `accountBalance` aggregates into the per-year,
 * per-account historical rows the Account Balance Stack chart consumes.
 *
 * The output row shape mirrors the band's drawdown-row shape:
 *   `{ year, accountBalances: Map<id, { balance, preEnd, postEnd, carriedForward }> }`
 * so the existing per-AccountType / per-account bucketing path renders the
 * historical prefix exactly as it renders the projected suffix.
 *
 * Routing follows the canonical tax-bucket table, NOT a naive
 * route-by-`taxTreatment`: for a non-MIXED account `preEnd = balance` ONLY
 * when `taxTreatment === 'PRE_TAX'`, otherwise `preEnd = 0` and
 * `postEnd = balance` (HSA → post / tax-free, ROTH → post, POST_TAX → post).
 * MIXED accounts seed `preEnd` / `postEnd` from the recorded
 * `endingBalancePreTax` / `endingBalancePostTax` split.
 *
 * Carry-forward: a per-account band holds its last known
 * `endingBalance` flat across any year it has no entry, through to the latest
 * actual year (internal gaps between entries AND years after the account's own
 * last entry). An account whose last recorded entry is `$0` (closed)
 * contributes `0` thereafter (drops out of the stack). Soft-deleted accounts
 * (`deletedAt`) are excluded entirely.
 *
 * Carried-forward marking: every per-account-year whose value is held
 * flat from a prior entry — internal gaps AND post-last-entry hold years —
 * carries `carriedForward: true`. Years with an actual recorded entry carry
 * `carriedForward: false`.
 *
 * Historical rows carry ONLY the stacking trio (`balance` / `preEnd` /
 * `postEnd`) plus the `carriedForward` marker — no tax / RMD / conversion
 * cent fields — so no display consumer deflates an absent field.
 */
import type {
  AccountBalancePayload,
  AccountPayload,
  Aggregate,
} from '../db/types';

/** One per-account year-end balance in a historical row — the band's stacking
 *  trio plus the carried-forward marker. */
interface HistoryAccountYear {
  readonly balance: number;
  readonly preEnd: number;
  readonly postEnd: number;
  /** True when this year's value was held flat from a prior entry. */
  readonly carriedForward: boolean;
}

/** One historical calendar year across every contributing account. */
export interface HistoryYearRow {
  readonly year: number;
  readonly accountBalances: ReadonlyMap<string, HistoryAccountYear>;
}

/** Split a single recorded balance into the band's pre/post stacking trio
 *  following the canonical routing table. */
function routeBalance(
  account: AccountPayload,
  bal: AccountBalancePayload,
): { balance: number; preEnd: number; postEnd: number } {
  const balance = bal.endingBalance;
  if (account.taxTreatment === 'MIXED') {
    const preEnd = bal.endingBalancePreTax ?? 0;
    const postEnd = bal.endingBalancePostTax ?? 0;
    // When both explicit splits are absent but a total balance exists, route the
    // full balance to the pre-tax bucket (dominant-bucket convention) so the
    // account isn't silently dropped from the stack.
    if (preEnd === 0 && postEnd === 0 && balance > 0) {
      return { balance, preEnd: balance, postEnd: 0 };
    }
    return { balance, preEnd, postEnd };
  }
  // Non-MIXED: pre-tax buckets all balance into preEnd; everything else
  // (POST_TAX / ROTH / HSA) routes the full balance to the post bucket.
  if (account.taxTreatment === 'PRE_TAX') {
    return { balance, preEnd: balance, postEnd: 0 };
  }
  return { balance, preEnd: 0, postEnd: balance };
}

/** Sorted distinct years across every (non-deleted) balance row. When
 *  `liveIds` is supplied, balance rows for accounts absent from that set
 *  (deleted accounts) are skipped so they cannot extend the window. */
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

/** The latest calendar year any (non-deleted) account balance has. Null
 *  when no balance rows exist. When `accounts` is supplied, balance rows for
 *  deleted accounts are excluded so they cannot extend the window. */
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

/** Count of distinct years that carry at least one (non-deleted) balance row —
 *  the render gate (≥ 2 to render the Account Balances page chart). When
 *  `accounts` is supplied, deleted-account balance rows are excluded. */
export function distinctBalanceYearCount(
  balances: ReadonlyArray<Aggregate<AccountBalancePayload>>,
  accounts?: ReadonlyArray<Aggregate<AccountPayload>>,
): number {
  const liveIds = accounts
    ? new Set(accounts.filter((a) => !a.deletedAt).map((a) => a.id))
    : undefined;
  return distinctBalanceYears(balances, liveIds).length;
}

/**
 * Build the historical per-year, per-account rows.
 *
 * @returns rows from the earliest balance year through the latest actual year,
 *   each carrying the contributing accounts' year-end stacking trios + the
 *   carried-forward marker. Empty when there are no (non-deleted) balance rows.
 */
export function buildAccountBalanceStackHistory(
  accounts: ReadonlyArray<Aggregate<AccountPayload>>,
  balances: ReadonlyArray<Aggregate<AccountBalancePayload>>,
): HistoryYearRow[] {
  // Per-account map of year → recorded balance payload (latest-deleted excluded).
  const accountById = new Map<string, AccountPayload>();
  for (const a of accounts) {
    if (a.deletedAt) continue;
    accountById.set(a.id, a.payload);
  }

  // Built from the live-account set so deleted-account balance rows cannot
  // extend the timeline window.
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
      // No band before the account's first recorded entry (a band starts
      // at its first entry, not the global earliest year).
      if (year < firstYear) continue;
      const actual = yearMap.get(year);
      if (actual) {
        const routed = routeBalance(account, actual);
        accountBalances.set(accountId, { ...routed, carriedForward: false });
        continue;
      }
      // No entry this year → carry the most recent prior entry forward.
      let priorYear = -Infinity;
      for (const y of yearMap.keys()) {
        if (y < year && y > priorYear) priorYear = y;
      }
      if (priorYear === -Infinity) continue; // before the band's first entry
      const prior = yearMap.get(priorYear)!;
      // A $0 last-known balance drops out (closed account).
      if (prior.endingBalance === 0) continue;
      const routed = routeBalance(account, prior);
      accountBalances.set(accountId, { ...routed, carriedForward: true });
    }
    rows.push({ year, accountBalances });
  }
  return rows;
}
