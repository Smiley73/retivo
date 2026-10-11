/**
 * The account-delete warning the read-time §408A pool made necessary. A pure
 * predicate, so its trigger is testable without a DOM; the page owns only the
 * dialog copy.
 *
 * It exists because a person's Roth-IRA contribution basis is no longer a stored
 * per-account number: it is derived from whatever accounts and balance rows the
 * household still has (see `roth-basis-derivation.ts`). Deleting an account
 * therefore moved from "removes one account" to "changes the household's
 * tax-free figure", and nothing said so.
 *
 * This module no longer warns on a retype into a Roth IRA — every case that
 * warning fired for is a type change on an account with real history, which the
 * universal retype block (`lib/account-retype-block.ts`) now blocks outright, so
 * nothing loses protection.
 */
import type { AccountBalancePayload, AccountPayload } from '../db/types';
import { buildRothDistributionFacts } from './balance-projection-runner-tax-helpers';
import { rothIraPoolKey, type RothDistributionFacts } from './roth-distribution-tax';

/** The account type whose history the §408A pool credits as contribution basis.
 *  A designated-Roth employer plan's basis is its recorded in-plan-rollover
 *  principal, so the delete warning has nothing to say about one. */
const ROTH_IRA_TYPE = 'RETIREMENT_ROTH_IRA';

/**
 * One pool's tax-free figure in cents: the remaining pooled contribution basis
 * PLUS the remaining conversion-lot principal — the per-person line
 * the report prints and the dollars the §408A ordering rules hand out before any
 * earnings. An absent pool reads as zero.
 *
 * Contribution basis alone would be the wrong comparison: a deleted account's own
 * conversion lots leave with it, so the household's tax-free total can FALL while
 * its contribution basis rises.
 */
function pooledTaxFreeCents(facts: RothDistributionFacts, poolKey: string): number {
  const pool = facts.rothIraByPool.get(poolKey)?.rothIra;
  if (pool === undefined) return 0;
  let cents = pool.regularContributionBasisCents;
  for (const lot of pool.conversionLots) {
    cents += lot.taxableConvertedPrincipalCents + lot.nontaxableConvertedPrincipalCents;
  }
  return cents;
}

/**
 * True when DELETING this account would RAISE its owner's resolved
 * pooled tax-free figure, irreversibly.
 *
 * The pool is one walk over the Roth IRAs that remain, and deleting an account
 * removes its recorded outflows along with its contributions — so a Roth IRA
 * that was a net consumer of its owner's pool leaves the household with MORE
 * tax-free money than before, in the tax-understating direction.
 *
 * Deliberately NOT a "does this account record outflows" heuristic. The charges
 * this project invents are IMPUTED, recorded nowhere in the payload: a row taking
 * a positive starting balance to a $0 ending and a shortfall netted
 * across skipped rows both consume pooled basis while `distributions` stays
 * blank, so a recorded-outflow test stays silent for exactly the shapes that most
 * need the warning. Resolving the pool twice is the only test that agrees with
 * the projection.
 *
 * Resolution runs through `buildRothDistributionFacts`, the same fact builder
 * both engines read, rather than the derivation directly — it already owns the
 * account scoping (every non-deleted Roth IRA the member owns, active or not),
 * the inherited exclusion, the pool keying and the cents arithmetic, so the
 * warning agrees with the projection by construction.
 *
 * @param accountId the account the user asked to delete.
 * @param accounts the household's NON-DELETED accounts, active and inactive
 *   alike — never a pre-filtered active-only list.
 * @param balances the household's non-deleted annual balance rows. Rows belonging
 *   to the removed account are ignored once it leaves the account set, so the
 *   caller does not have to filter them.
 */
export function deletingRothIraRaisesPooledTaxFree(
  accountId: string,
  accounts: ReadonlyArray<{ id: string; payload: AccountPayload }>,
  balances: ReadonlyArray<{ payload: AccountBalancePayload }>,
): boolean {
  const account = accounts.find((a) => a.id === accountId);
  if (account === undefined) return false;
  if (account.payload.type !== ROTH_IRA_TYPE) return false;
  // An inherited Roth IRA has no pool at all — it contributes nothing to its
  // owner's figure, so removing it can move nothing.
  if (account.payload.rmdInheritedAccount === true) return false;
  const poolKey = rothIraPoolKey(account.payload.ownerId, accountId, false);
  const withAccount = pooledTaxFreeCents(
    buildRothDistributionFacts(accounts, balances),
    poolKey,
  );
  const withoutAccount = pooledTaxFreeCents(
    buildRothDistributionFacts(
      accounts.filter((a) => a.id !== accountId),
      balances,
    ),
    poolKey,
  );
  return withoutAccount > withAccount;
}
