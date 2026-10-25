/**
 * Account-delete warning: removing a Roth IRA can raise its owner's pooled tax-free figure, because
 * the §408A pool is derived at read time from the accounts that remain (roth-basis-derivation.ts).
 */
import type { AccountBalancePayload, AccountPayload } from '../db/types';
import { buildRothDistributionFacts } from './balance-projection-runner-tax-helpers';
import { rothIraPoolKey, type RothDistributionFacts } from './roth-distribution-tax';

const ROTH_IRA_TYPE = 'RETIREMENT_ROTH_IRA';

// The figure includes conversion-lot principal: a deleted account's lots leave with it, so the total
// can fall while contribution basis rises.
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
 * True when deleting this account would raise its owner's pooled tax-free figure: a Roth IRA that was
 * a net consumer of the pool takes its outflows with it. Resolves the pool twice through
 * `buildRothDistributionFacts` (imputed outflows are recorded nowhere, so a recorded-outflow test
 * would stay silent), which agrees with the projection by construction.
 *
 * @param accounts the household's non-deleted accounts, active and inactive alike
 * @param balances the household's non-deleted annual balance rows; rows of the removed account are ignored
 */
export function deletingRothIraRaisesPooledTaxFree(
  accountId: string,
  accounts: ReadonlyArray<{ id: string; payload: AccountPayload }>,
  balances: ReadonlyArray<{ payload: AccountBalancePayload }>,
): boolean {
  const account = accounts.find((a) => a.id === accountId);
  if (account === undefined) return false;
  if (account.payload.type !== ROTH_IRA_TYPE) return false;
  // An inherited Roth IRA has no pool, so removing it moves nothing.
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
