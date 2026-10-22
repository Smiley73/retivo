/**
 * Groups a year's per-account RMDs into the IRS aggregation groups a retiree may satisfy them from
 * (display-only): IRAs and 403(b)s aggregate per owner (IRS Pub 590-B), each employer plan is its own group.
 */
import type { AccountType } from '../db/types';

type RmdAggregationKind = 'aggregatable' | 'per-plan';

export interface RmdGroupingAccount {
  readonly id: string;
  readonly name: string;
  readonly type: AccountType;
  readonly ownerId: string;
  /**
   * Beneficiary-held inherited account: never aggregates (IRS Pub 590-B forbids pooling it with
   * the beneficiary's own IRAs or another decedent's), so it is its own per-plan group.
   */
  readonly inherited?: boolean;
}

interface RmdGroupAccount {
  readonly id: string;
  readonly name: string;
  readonly requiredCents: number;
}

export interface RmdAggregationGroup {
  readonly key: string;
  readonly ownerId: string;
  readonly kind: RmdAggregationKind;
  readonly accountType: AccountType;
  readonly requiredCents: number;
  readonly accounts: ReadonlyArray<RmdGroupAccount>;
}

const AGGREGATABLE_TYPES: ReadonlySet<AccountType> = new Set<AccountType>([
  'RETIREMENT_IRA',
  'RETIREMENT_403B',
]);

const PER_PLAN_TYPES: ReadonlySet<AccountType> = new Set<AccountType>([
  'RETIREMENT_401K',
  'RETIREMENT_457B',
  'RETIREMENT_TSP',
  'RETIREMENT_CASH_BALANCE',
]);

/**
 * Builds the per-owner groups (sorted owner, type, name) from `DrawdownYear.perAccountRmdCents`.
 * An id with no metadata in `accountsById` is skipped and its cents are returned as `unmappedCents`.
 */
export function buildRmdAggregationGroups(
  perAccountRmdCents: Readonly<Record<string, number>>,
  accountsById: ReadonlyMap<string, RmdGroupingAccount>,
): {
  readonly groups: ReadonlyArray<RmdAggregationGroup>;
  readonly unmappedCents: number;
} {
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
    const inherited = meta.inherited === true;
    const aggregatable = !inherited && AGGREGATABLE_TYPES.has(meta.type);
    const perPlan = inherited || PER_PLAN_TYPES.has(meta.type);
    // A type that cannot carry an RMD folds into unmappedCents so no dollars are dropped.
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

  groups.sort(
    (a, b) =>
      a.ownerId.localeCompare(b.ownerId) ||
      a.accountType.localeCompare(b.accountType) ||
      (a.accounts[0]?.name ?? '').localeCompare(b.accounts[0]?.name ?? ''),
  );

  return { groups, unmappedCents };
}
