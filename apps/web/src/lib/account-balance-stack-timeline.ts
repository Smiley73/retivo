/**
 * Pure assembly: stitch the recorded historical balances, the saving-years
 * accumulation projection, and the retirement drawdown into ONE continuous,
 * display-deflated timeline for the "Account balances over time" stacked band.
 *
 * Regions, in order:
 *   1. Historical actuals — earliest recorded balance year → last actual year,
 *      ALWAYS nominal; zone `actual`, per-account `carriedForward`
 *      markers preserved.
 *   2. Accumulation (saving years) — last-actual-year+1 → retirement, deflated
 *      by the active path (`basisDeflator`); zone `projected`. Source is the MC
 *      representative run's `accumulationAccountBalances` under an MC basis,
 *      else the deterministic per-account projection (`ProjectionYear`).
 *   3. Drawdown — retirement → horizon, deflated by `basisDeflator`; zone
 *      `projected`.
 *
 * A year that appears in more than one region is taken from the LATER region
 * (accumulation overrides historical carry-forward, drawdown overrides
 * accumulation) so each calendar year is emitted exactly once.
 */
import type { DrawdownYear, DrawdownAccountYear } from './drawdown-engine-types';
import type {
  HistoryYearRow,
} from './account-balance-stack-history';

/** One per-account year-end value in a unified band row. */
export interface StackBandAccountYear {
  readonly balance: number;
  readonly preEnd: number;
  readonly postEnd: number;
  /** True when this year's value was held flat from a prior entry. */
  readonly carriedForward?: boolean;
}

/** One year of the unified timeline. `zone` discriminates the historical
 *  (actual) region from the projected region (accumulation + drawdown). Dollar
 *  values are already in DISPLAY dollars — the caller deflates the projected
 *  region and leaves the historical region nominal. */
export interface StackBandYear {
  readonly year: number;
  readonly accountBalances: ReadonlyMap<string, StackBandAccountYear>;
  readonly zone: 'actual' | 'projected';
}

/** One accumulation calendar year's per-account stacking trio (the shape both
 *  the MC `accumulationAccountBalances` field and the deterministic projection
 *  reduce to). */
export interface AccumulationYearRow {
  readonly year: number;
  readonly accountBalances: ReadonlyMap<
    string,
    Pick<DrawdownAccountYear, 'balance' | 'preEnd' | 'postEnd'>
  >;
}

export interface AssembleStackTimelineArgs {
  /** Historical rows (nominal) from `buildAccountBalanceStackHistory`. */
  readonly historical: ReadonlyArray<HistoryYearRow>;
  /** Accumulation (saving-years) rows — MC representative run or deterministic
   *  per-account projection, already reduced to the stacking trio. */
  readonly accumulation: ReadonlyArray<AccumulationYearRow>;
  /** Drawdown years from the resolved method/representative run. */
  readonly drawdown: ReadonlyArray<DrawdownYear>;
  /** The last actual (historical) year — the boundary. Null when no history. */
  readonly lastActualYear: number | null;
  /** Display deflator for the PROJECTED region only (path-own CPI under an MC
   *  basis + Today's, the flat view deflator otherwise). Historical rows stay
   *  nominal. */
  readonly basisDeflator: (year: number) => number;
}

export interface AssembledStackTimeline {
  readonly rows: StackBandYear[];
  /** The dashed boundary year (= `lastActualYear`), or null when no history. */
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

/**
 * Assemble the unified, display-deflated timeline + the boundary year.
 */
export function assembleAccountBalanceStackTimeline(
  args: AssembleStackTimelineArgs,
): AssembledStackTimeline {
  const { historical, accumulation, drawdown, lastActualYear, basisDeflator } =
    args;

  const byYear = new Map<number, StackBandYear>();

  // 1. Historical (nominal, zone actual).
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

  // 2. Accumulation (deflated, zone projected). Only years strictly after the
  //    last actual year — the historical region owns the years it covers.
  for (const a of accumulation) {
    if (lastActualYear != null && a.year <= lastActualYear) continue;
    const f = basisDeflator(a.year);
    const accountBalances = new Map<string, StackBandAccountYear>();
    for (const [id, ay] of a.accountBalances) {
      accountBalances.set(id, deflateAccountYear(ay, f));
    }
    byYear.set(a.year, { year: a.year, accountBalances, zone: 'projected' });
  }

  // 3. Drawdown (deflated, zone projected). Overrides any prior region.
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
