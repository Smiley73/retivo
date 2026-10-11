/**
 * Group a year's per-account required minimum distributions (RMDs) into the
 * LEGAL IRS aggregation groups a retiree may actually satisfy them from
 * (Projected withdrawals page). Pure + display-only — no engine math.
 *
 * The deterministic drawdown output stamps `DrawdownYear.perAccountRmdCents`
 * (a proportional per-account decomposition of the household `rmdFloorCents`).
 * The per-account split is a display convenience; the BINDING legal requirement
 * is the per-owner aggregation-GROUP total, which is what this helper surfaces:
 *
 *   - Traditional IRAs (`RETIREMENT_IRA`) aggregate per owner → one combined IRA
 *     RMD the owner may take from ANY of their IRAs (IRS Pub 590-B).
 *   - 403(b)s (`RETIREMENT_403B`) aggregate per owner → one combined 403(b) RMD
 *     the owner may take from ANY of their 403(b)s.
 *   - Each employer defined-contribution plan — `RETIREMENT_401K`,
 *     `RETIREMENT_457B`, `RETIREMENT_TSP`, `RETIREMENT_CASH_BALANCE` — is its OWN
 *     per-plan group; its RMD must be taken from that specific account (no
 *     cross-plan aggregation).
 *
 * A group's required RMD = `Σ perAccountRmdCents` over the accounts in it.
 * Roth-designated / HSA / taxable accounts never carry an RMD entry, so they
 * never appear here.
 */
import type { AccountType } from '../db/types';

/** Whether a group's RMD may be satisfied from any account in it (aggregatable)
 *  or must come from the one named account (per-plan). */
type RmdAggregationKind = 'aggregatable' | 'per-plan';

/** Per-account metadata the grouping needs (id keys `perAccountRmdCents`). */
export interface RmdGroupingAccount {
  readonly id: string;
  readonly name: string;
  readonly type: AccountType;
  /** Owner member id — IRA / 403(b) aggregation is PER OWNER. */
  readonly ownerId: string;
  /**
   * `true` for a beneficiary-held INHERITED account. An inherited account
   * NEVER aggregates: IRS Pub 590-B forbids pooling an inherited IRA with the
   * beneficiary's own IRAs or with an IRA inherited from a different decedent, so
   * it is presented as its own per-plan group ("must come from this account").
   * This also lets an inherited Roth IRA — which owes a beneficiary distribution
   * its living owner never would — appear as a group instead of being dropped.
   */
  readonly inherited?: boolean;
}

/** One account inside an aggregation group. */
interface RmdGroupAccount {
  readonly id: string;
  readonly name: string;
  /** This account's share of the group's required RMD, integer cents. */
  readonly requiredCents: number;
}

/** A legal RMD aggregation group for one owner. */
export interface RmdAggregationGroup {
  /** Stable key: `${ownerId}:${kind}:${aggregationType|accountId}`. */
  readonly key: string;
  readonly ownerId: string;
  readonly kind: RmdAggregationKind;
  /** The account type that defines the group (e.g. `RETIREMENT_IRA`). */
  readonly accountType: AccountType;
  /** Combined required RMD for the group, integer cents (`Σ` of `accounts`). */
  readonly requiredCents: number;
  /** Accounts in the group (one for a per-plan group, ≥ 1 for aggregatable). */
  readonly accounts: ReadonlyArray<RmdGroupAccount>;
}

/** Account types whose RMDs aggregate per owner (satisfiable from any). */
const AGGREGATABLE_TYPES: ReadonlySet<AccountType> = new Set<AccountType>([
  'RETIREMENT_IRA',
  'RETIREMENT_403B',
]);

/** Account types whose RMD must be taken from that specific plan. */
const PER_PLAN_TYPES: ReadonlySet<AccountType> = new Set<AccountType>([
  'RETIREMENT_401K',
  'RETIREMENT_457B',
  'RETIREMENT_TSP',
  'RETIREMENT_CASH_BALANCE',
]);

/**
 * Build the legal RMD aggregation groups for one year's per-account RMD map.
 *
 * @param perAccountRmdCents - `DrawdownYear.perAccountRmdCents` for the year
 *   (id → required RMD cents). Only RMD-bearing accounts are present.
 * @param accountsById - metadata for every account that can appear in the map.
 *   An id present in the RMD map but absent here is skipped (its dollars are
 *   surfaced as the returned `unmappedCents` so the caller can disclose them).
 * @returns the per-owner groups (sorted owner → type → name for stable render)
 *   plus the total of any RMD cents whose account id had no metadata.
 */
export function buildRmdAggregationGroups(
  perAccountRmdCents: Readonly<Record<string, number>>,
  accountsById: ReadonlyMap<string, RmdGroupingAccount>,
): {
  readonly groups: ReadonlyArray<RmdAggregationGroup>;
  readonly unmappedCents: number;
} {
  // Accumulate accounts into their group key first, then fold to the public
  // shape. Aggregatable group key folds all of an owner's IRAs (or 403(b)s)
  // together; a per-plan key is unique per account.
  const byKey = new Map<
    string,
    {
      ownerId: string;
      kind: RmdAggregationKind;
      accountType: AccountType;
      accounts: RmdGroupAccount[];
    }
  >();
  let unmappedCents = 0;

  for (const [accountId, requiredCents] of Object.entries(perAccountRmdCents)) {
    if (requiredCents <= 0) continue;
    const meta = accountsById.get(accountId);
    if (meta === undefined) {
      unmappedCents += requiredCents;
      continue;
    }
    // An inherited account is ALWAYS its own group (no legal aggregation).
    const inherited = meta.inherited === true;
    const aggregatable = !inherited && AGGREGATABLE_TYPES.has(meta.type);
    const perPlan = inherited || PER_PLAN_TYPES.has(meta.type);
    // A type that is neither aggregatable nor a known per-plan DC type should
    // not carry an RMD (RMD applies only to qualifying tax-deferred plans). Fold
    // it into `unmappedCents` so no dollars are silently dropped.
    if (!aggregatable && !perPlan) {
      unmappedCents += requiredCents;
      continue;
    }
    const kind: RmdAggregationKind = aggregatable ? 'aggregatable' : 'per-plan';
    const key = aggregatable
      ? `${meta.ownerId}:aggregatable:${meta.type}`
      : `${meta.ownerId}:per-plan:${meta.id}`;
    const entry = byKey.get(key) ?? {
      ownerId: meta.ownerId,
      kind,
      accountType: meta.type,
      accounts: [] as RmdGroupAccount[],
    };
    entry.accounts.push({ id: meta.id, name: meta.name, requiredCents });
    byKey.set(key, entry);
  }

  const groups: RmdAggregationGroup[] = [...byKey.entries()].map(
    ([key, entry]) => ({
      key,
      ownerId: entry.ownerId,
      kind: entry.kind,
      accountType: entry.accountType,
      requiredCents: entry.accounts.reduce((s, a) => s + a.requiredCents, 0),
      accounts: [...entry.accounts].sort((a, b) => a.name.localeCompare(b.name)),
    }),
  );

  // Stable render order: owner, then type, then (per-plan) account name.
  groups.sort(
    (a, b) =>
      a.ownerId.localeCompare(b.ownerId) ||
      a.accountType.localeCompare(b.accountType) ||
      (a.accounts[0]?.name ?? '').localeCompare(b.accounts[0]?.name ?? ''),
  );

  return { groups, unmappedCents };
}
