/**
 * Account-bucket classifier (Graphite Spectrum palette).
 *
 * Maps the domain `AccountType` enum to one of the five visual buckets
 * the UI colour-codes the account tables by. Replicates the mock's
 * `RP.bucketOf` (rp-data.js) with the HSA exception: Roth IRA → roth;
 * Brokerage → taxable; cash-equivalent holdings (Savings / Money Market /
 * CD) → cash; HSA → tax_free (its own teal tint — triple-tax-advantaged);
 * everything else (every pre-tax retirement vehicle, plus Other) → pretax.
 *
 * The bucket is purely a visual / grouping affordance (drives the
 * left bucket-bar colour and the type-chip tint) — it is NOT the same as
 * the account's `taxTreatment` (PRE_TAX / POST_TAX / MIXED / HSA / ROTH),
 * which is a separate financial field. Pure function; no behavioural contract.
 */
import type { AccountType } from '../db/types';

export type AccountBucket = 'pretax' | 'roth' | 'taxable' | 'cash' | 'tax_free';

/** Plain-language bucket names, in the user guide's own words ("tax-deferred",
 *  not the Dashboard's tax-treatment partition). Shown where a bucket is named
 *  as such, e.g. the Compare tab's years-of-withdrawals rows. */
export const ACCOUNT_BUCKET_LABEL: Readonly<Record<AccountBucket, string>> = {
  pretax: 'Tax-deferred',
  roth: 'Roth',
  taxable: 'Taxable',
  cash: 'Cash',
  tax_free: 'HSA',
};

export function accountBucket(type: AccountType): AccountBucket {
  switch (type) {
    case 'RETIREMENT_ROTH_IRA':
    case 'RETIREMENT_ROTH_401K':
    case 'RETIREMENT_ROTH_403B':
    case 'RETIREMENT_ROTH_457B':
    case 'RETIREMENT_ROTH_TSP':
      return 'roth';
    case 'BROKERAGE':
      return 'taxable';
    case 'SAVINGS':
    case 'MONEY_MARKET':
    case 'CD':
      return 'cash';
    case 'HSA':
      return 'tax_free';
    // RETIREMENT_401K / RETIREMENT_IRA / RETIREMENT_CASH_BALANCE /
    // RETIREMENT_403B / RETIREMENT_457B / RETIREMENT_TSP / OTHER
    default:
      return 'pretax';
  }
}
