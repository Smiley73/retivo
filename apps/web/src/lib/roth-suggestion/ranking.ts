/**
 * Ranks candidates on after-tax ending balance in today's dollars. Only a
 * candidate whose cap was met is ranked. Ties (to the cent) go to fewer
 * dollars converted, then the lower bracket (the reference, which has none,
 * counts as lowest), then grid order, which puts the guarded plan first.
 */
export interface RankInput {
  readonly id: string;
  readonly ranked: boolean;
  readonly afterTaxTodayDollars: number;
  readonly totalConvertedTodayDollars: number;
  readonly bracketRate: number | null;
}

const CENTS = 100;

function cents(dollars: number): number {
  return Math.round(dollars * CENTS);
}

/** Ids of the ranked candidates, best first. */
export function rankedOrder(inputs: readonly RankInput[]): string[] {
  return inputs
    .map((input, gridIndex) => ({ input, gridIndex }))
    .filter(({ input }) => input.ranked)
    .sort((a, b) => {
      const byBalance = cents(b.input.afterTaxTodayDollars) - cents(a.input.afterTaxTodayDollars);
      if (byBalance !== 0) return byBalance;
      const byConverted =
        cents(a.input.totalConvertedTodayDollars) - cents(b.input.totalConvertedTodayDollars);
      if (byConverted !== 0) return byConverted;
      const byBracket = (a.input.bracketRate ?? -1) - (b.input.bracketRate ?? -1);
      return byBracket !== 0 ? byBracket : a.gridIndex - b.gridIndex;
    })
    .map(({ input }) => input.id);
}
