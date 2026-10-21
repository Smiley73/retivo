/**
 * A Fill-converted year priced again without its conversion, so the Roth
 * suggestion's year table can say what income the conversion was added to.
 *
 * The year's tax pass runs on a copy of the row with the conversion marked off
 * and the draws that paid the conversion's tax taken back out, against copies
 * of the running tax state, so the real pass over the row is untouched. It is
 * the same pass the row was priced with, which is why the figures equal the
 * engine's own year with the conversion removed: that year's withdrawals are
 * the ones the Fill step already committed, and what the tax pass adds on top
 * (interest, dividends, gains on the withdrawals) does not depend on the
 * conversion. The Fill solve's own zero probe cannot stand in for this: it
 * leaves those additions out.
 */
import type { DrawdownAccountYear, DrawdownYear } from './drawdown-engine-types';

const CENTS_PER_DOLLAR = 100;

/** The row as the engine would have committed it with no conversion: nothing
 *  converted, and no draw to pay a conversion tax. */
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

/**
 * Stamp `rothZeroConversionMagiCents` and `rothZeroConversionTaxableSsCents`
 * on a year that converted. `reprice` runs the tax pass over the copy it is
 * given, on copies of the running state, and annotates that copy. A year with
 * no recorded draws, or one the pass could not price, is left unstamped.
 */
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
