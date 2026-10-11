/**
 * Pure builder for the PDF "Roth tax-free amounts" table. One row
 * per qualifying person's own Roth-IRA §408A pool, then one row per
 * qualifying employer designated-Roth plan — not literally every person /
 * every plan; see `buildPersonRows` / `buildEmployerRows` below for the
 * row-emission exceptions (inherited pools, all-inactive pools, closed plans,
 * and an unrecognised designated-Roth account shape).
 *
 * Both halves are resolved by calling `buildRothDistributionFacts` — the
 * SAME function `buildPipelineContext` calls for both engines — over the
 * SAME account-input set (`buildRothAccountFactInputs`), never a
 * report-local account-selection query. That is what keeps this table from
 * ever disagreeing with what the engines actually resolve.
 *
 * The two halves state DIFFERENT things and must not be labelled alike: the
 * person figure is contribution basis plus remaining conversion-lot
 * principal — for a Roth IRA, genuinely what comes out tax-free first. The
 * employer figure is the plan's recorded basis, not an amount withdrawable
 * tax-free (a nonqualified designated-Roth distribution is pro-rata between
 * basis and earnings). See `pdf-tables.ts` → `buildRothTaxFreeTableSpec` for
 * the column copy that keeps this distinction.
 *
 * Recorded-history dollars, never deflated — identical under Today's
 * and Future dollars, like the Accounts inventory and Per-account breakdown.
 */
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

/** One row of the report's Roth tax-free amounts table. `kind` discriminates
 *  the two halves the table adapter must describe differently. */
export interface ReportRothTaxFreeRow {
  readonly id: string;
  readonly kind: 'person' | 'employer';
  readonly label: string;
  /** Dollars, no deflation applied. */
  readonly amount: number;
}

export interface BuildRothTaxFreeRowsInput {
  readonly accounts: ReadonlyArray<Aggregate<AccountPayload>>;
  readonly balances: ReadonlyArray<Aggregate<AccountBalancePayload>>;
  readonly members: ReadonlyArray<Aggregate<HouseholdMemberPayload>>;
}

/** Person rows: one per §408A pool, ordered by display name then member id
 *  (contribution basis PLUS remaining conversion-lot principal). A
 *  person whose only Roth IRA is inherited gets no row: `rothIraByPool`
 *  never carries a pool for one, so there is no absence check to write
 *  here — the row simply never gets built. A pool flagged `allAccountsInactive`
 *  is still emitted by `rothIraByPool` (its recorded basis/lots survive so the
 *  derivation isn't lost), and this builder omits its row because that basis
 *  is unreachable in BOTH engines (they agree by both NOT crediting it).
 *  Monte Carlo excludes
 *  the pool from its aggregate seed explicitly (`mcDrawableRothBasisCentsByOwner`
 *  in `balance-projection-runner-mc.ts`). The deterministic engine never
 *  reaches it at all: its carrier is seeded pool-keyed from `rothIraByPool`,
 *  but basis is credited only through a DRAWN pool (`collectRothDraws` walks
 *  `ctx.accountProjections`, which holds ACTIVE accounts only) and the funding
 *  pass charges only drawn ledger owners — and every account behind an
 *  all-inactive pool is closed, so the pool is never drawn.
 *  `ctx.rothBasisCentsByOwner` still sums the pool's resolved basis, but
 *  nothing consumes that entry: present, and inert. There is no engine
 *  disagreement here to reconcile; printing the row would state a tax-free
 *  amount neither engine can ever credit. */
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
      // Labelled from the MEMBER record for the pool's owner, not
      // `reportAccountOwnerDisplayName` (which answers "Joint" for a
      // jointly-marked account and would mislabel a member-keyed pool).
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

/** Employer rows: one per designated-Roth account, ordered by
 *  `sortReportAccounts` — including a real $0 (unlike an inherited Roth
 *  IRA's absence), since a recorded $0 basis is a computed figure. */
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

/**
 * Build the ordered Roth-tax-free-amounts rows: person rows (by display name
 * then member id), then employer rows (`sortReportAccounts`).
 */
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
