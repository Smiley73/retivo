// Stitches recorded history, the accumulation projection and the drawdown into one display-deflated timeline for the
// "Account balances over time" band. A year in several regions is taken from the later one, so each year is emitted once.

import type { DrawdownYear, DrawdownAccountYear } from './drawdown-engine-types';
import type {
  HistoryYearRow,
} from './account-balance-stack-history';

export interface StackBandAccountYear {
  readonly balance: number;
  readonly preEnd: number;
  readonly postEnd: number;
  readonly carriedForward?: boolean;
}

/** `zone` separates the historical (nominal) region from the projected one; projected values are already display-deflated. */
export interface StackBandYear {
  readonly year: number;
  readonly accountBalances: ReadonlyMap<string, StackBandAccountYear>;
  readonly zone: 'actual' | 'projected';
}

export interface AccumulationYearRow {
  readonly year: number;
  readonly accountBalances: ReadonlyMap<
    string,
    Pick<DrawdownAccountYear, 'balance' | 'preEnd' | 'postEnd'>
  >;
}

export interface AssembleStackTimelineArgs {
  readonly historical: ReadonlyArray<HistoryYearRow>;
  /** MC representative run or deterministic projection, reduced to the stacking trio. */
  readonly accumulation: ReadonlyArray<AccumulationYearRow>;
  readonly drawdown: ReadonlyArray<DrawdownYear>;
  /** The boundary year; null when no history. */
  readonly lastActualYear: number | null;
  /** Deflator for the projected region only: path-own CPI under an MC basis with Today's, else the flat view deflator. */
  readonly basisDeflator: (year: number) => number;
}

export interface AssembledStackTimeline {
  readonly rows: StackBandYear[];
  readonly boundaryYear: number | null;
}

function deflateAccountYear(
  ay: Pick<DrawdownAccountYear, 'balance' | 'preEnd' | 'postEnd'>,
  f: number,
): StackBandAccountYear {
  return {
    balance: ay.balance * f,
    preEnd: ay.preEnd * f,
    postEnd: ay.postEnd * f,
    carriedForward: false,
  };
}

export function assembleAccountBalanceStackTimeline(
  args: AssembleStackTimelineArgs,
): AssembledStackTimeline {
  const { historical, accumulation, drawdown, lastActualYear, basisDeflator } =
    args;

  const byYear = new Map<number, StackBandYear>();

  // Historical: nominal.
  for (const h of historical) {
    const accountBalances = new Map<string, StackBandAccountYear>();
    for (const [id, ay] of h.accountBalances) {
      accountBalances.set(id, {
        balance: ay.balance,
        preEnd: ay.preEnd,
        postEnd: ay.postEnd,
        carriedForward: ay.carriedForward,
      });
    }
    byYear.set(h.year, { year: h.year, accountBalances, zone: 'actual' });
  }

  // Accumulation: only years after the last actual year, which the historical region owns.
  for (const a of accumulation) {
    if (lastActualYear != null && a.year <= lastActualYear) continue;
    const f = basisDeflator(a.year);
    const accountBalances = new Map<string, StackBandAccountYear>();
    for (const [id, ay] of a.accountBalances) {
      accountBalances.set(id, deflateAccountYear(ay, f));
    }
    byYear.set(a.year, { year: a.year, accountBalances, zone: 'projected' });
  }

  // Drawdown overrides any earlier region.
  for (const dy of drawdown) {
    if (!dy.accountBalances) continue;
    if (lastActualYear != null && dy.year <= lastActualYear) continue;
    const f = basisDeflator(dy.year);
    const accountBalances = new Map<string, StackBandAccountYear>();
    for (const [id, ay] of dy.accountBalances) {
      accountBalances.set(id, deflateAccountYear(ay, f));
    }
    byYear.set(dy.year, { year: dy.year, accountBalances, zone: 'projected' });
  }

  const rows = [...byYear.values()].sort((a, b) => a.year - b.year);
  return { rows, boundaryYear: lastActualYear };
}
