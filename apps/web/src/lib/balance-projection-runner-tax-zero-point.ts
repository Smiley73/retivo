/**
 * A Fill-converted year priced again without its conversion, on a copy of the
 * row and copies of the running tax state, so the Roth suggestion's year table
 * can say what income the conversion was added to.
 */
import type { DrawdownAccountYear, DrawdownYear } from './drawdown-engine-types';

const CENTS_PER_DOLLAR = 100;

/** The row with nothing converted and no draw to pay a conversion tax. */
function withoutConversion(
  year: DrawdownYear,
  fundingCentsByAccount: ReadonlyMap<string, number>,
): DrawdownYear {
  let fundedCents = 0;
  let accountBalances: Map<string, DrawdownAccountYear> | undefined;
  if (year.accountBalances !== undefined) {
    accountBalances = new Map();
    for (const [id, account] of year.accountBalances) {
      const cents = fundingCentsByAccount.get(id) ?? 0;
      fundedCents += cents;
      accountBalances.set(
        id,
        cents === 0
          ? account
          : {
              ...account,
              balance: account.balance + cents / CENTS_PER_DOLLAR,
              postEnd: account.postEnd + cents / CENTS_PER_DOLLAR,
              withdrawn: account.withdrawn - cents / CENTS_PER_DOLLAR,
              ...(account.postWithdrawnCents === undefined
                ? {}
                : { postWithdrawnCents: account.postWithdrawnCents - cents }),
            },
      );
    }
  }
  const out: DrawdownYear = {
    ...year,
    withdrawn: year.withdrawn - fundedCents / CENTS_PER_DOLLAR,
    ...(accountBalances === undefined ? {} : { accountBalances }),
  };
  delete out.rothConvertedCents;
  delete out.rothConversionTaxFundingCentsByAccount;
  return out;
}

/** Stamp the zero-conversion MAGI and taxable Social Security on a year that
 *  converted; `reprice` runs the tax pass over the copy on copies of the state. */
export function stampZeroConversionPoint(
  year: DrawdownYear,
  reprice: (copy: DrawdownYear) => void,
): void {
  const funding = year.rothConversionTaxFundingCentsByAccount;
  if (funding === undefined || (year.rothConvertedCents ?? 0) <= 0) return;
  const copy = withoutConversion(year, funding);
  reprice(copy);
  if (copy.magiCents === undefined || copy.taxableSsCents === undefined) return;
  year.rothZeroConversionMagiCents = copy.magiCents;
  year.rothZeroConversionTaxableSsCents = copy.taxableSsCents;
}
