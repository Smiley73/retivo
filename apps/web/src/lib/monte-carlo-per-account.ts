/** Per-account sampling helpers for the Monte Carlo runner; each function is pure and touches only the data passed in. */
import { type HistoricalColumns } from './projection-engine/historical.js';
import { type KernelAccount } from './projection-engine/kernel.js';
import { monthlyEquivalent } from './projection-engine/monthly-conversion.js';
import type { MonteCarloAccountLedger } from './monte-carlo.js';
import type { MonteCarloInput, MonteCarloPortfolioEvent } from './monte-carlo-types.js';

export type { MonteCarloAccountLedger };
export type { MonteCarloPortfolioEvent };

/**
 * Builds per-account `KernelAccount` entries from the MC ledger. `'fixed'` accounts reference the shared bundle
 * arrays without cloning (`routePreRetirementEvent` clones `contribPost` on first write); `'tracks-inflation'`
 * accounts get fresh arrays scaled by the path's `cumCpi`.
 */
export function buildPerAccountKernelInputs(args: {
  ledger: ReadonlyArray<MonteCarloAccountLedger>;
  stepCount: number;
  /** Sampled dataset row indices for this path, or `null` in injected-returns mode; paired with `columns`. */
  sampledIdx: Int32Array | null;
  columns: HistoricalColumns | null;
  injectedReturnPct: Float64Array | null;
  /** Path's cumulative CPI factor by step; omitted means no per-path scaling. */
  cumCpi?: Float64Array;
  /** Today-anchor month (0..11): tracks-inflation contributions equal their today's-dollars base at this step; omitted is January. */
  todayMonthIndex?: number;
  annualInvestmentCostPct?: number;
  returnShock?: MonteCarloInput['returnShock'];
}): KernelAccount[] {
  const { ledger, stepCount, sampledIdx, columns, injectedReturnPct, cumCpi, todayMonthIndex } =
    args;
  const accounts: KernelAccount[] = new Array(ledger.length);
  for (let a = 0; a < ledger.length; a += 1) {
    const entry = ledger[a];
    const returnPct = buildPerAccountReturnSeries(
      entry,
      stepCount,
      sampledIdx,
      columns,
      injectedReturnPct,
      args.annualInvestmentCostPct ?? 0,
      args.returnShock ?? null,
    );
    const scaled = scaleTracksInflationContrib(entry, stepCount, cumCpi, todayMonthIndex ?? 0);
    accounts[a] = {
      id: entry.id,
      initialPre: entry.initialPre,
      initialPost: entry.initialPost,
      contribPre: scaled.contribPre,
      contribPost: scaled.contribPost,
      deposit: entry.deposit,
      // Spouse post-tax (Roth) slice, read only by the named-strategy slice, which rebuilds the pre slice as `deposit - depositPost`.
      depositPost: entry.depositPost,
      returnPct,
      isHsa: entry.taxTreatment === 'HSA',
    };
  }
  return accounts;
}

// `contribPre` is all planned base, so it scales whole; `contribPost` scales only `plannedContribPostBase`,
// leaving routed nominal event dollars unscaled: `post[i] = base[i]*cumCpi[i] + (contribPost[i] - base[i])`.
function scaleTracksInflationContrib(
  entry: MonteCarloAccountLedger,
  stepCount: number,
  cumCpi: Float64Array | undefined,
  todayMonthIndex: number,
): { contribPre: Float64Array; contribPost: Float64Array } {
  if (entry.contribGrowthMode !== 'tracks-inflation' || cumCpi === undefined) {
    return { contribPre: entry.contribPre, contribPost: entry.contribPost };
  }
  const contribPre = new Float64Array(stepCount);
  const contribPost = new Float64Array(stepCount);
  const base = entry.plannedContribPostBase;
  // Anchor at today, not step 0: dividing the start-of-month factor by `startFactor(todayMonthIndex)` re-bases the series to 1 at
  // `todayMonthIndex`, matching the deterministic `asOfMonth` exponent. A contribution lands at month start, so it uses the
  // start-of-month factor, not the end-of-month `cumCpi[i]`.
  const anchor = todayMonthIndex === 0 ? 1 : cumCpi[todayMonthIndex - 1];
  for (let i = 0; i < stepCount; i += 1) {
    const startFactor = i === 0 ? 1 : cumCpi[i - 1];
    const factor = startFactor / anchor;
    contribPre[i] = entry.contribPre[i] * factor;
    if (base) {
      const eventDelta = entry.contribPost[i] - base[i];
      contribPost[i] = base[i] * factor + eventDelta;
    } else {
      contribPost[i] = entry.contribPost[i] * factor;
    }
  }
  return { contribPre, contribPost };
}

function buildPerAccountReturnSeries(
  entry: MonteCarloAccountLedger,
  stepCount: number,
  sampledIdx: Int32Array | null,
  columns: HistoricalColumns | null,
  injectedReturnPct: Float64Array | null,
  annualInvestmentCostPct: number = 0,
  returnShock: MonteCarloInput['returnShock'] | null = null,
): Float64Array {
  // `sampledIdx` and `columns` are one unit; a lone non-null would fall through to an all-zero series and silently corrupt every percentile.
  if ((sampledIdx === null) !== (columns === null)) {
    throw new Error(
      'buildPerAccountReturnSeries: sampledIdx and columns must both be null or both be provided together',
    );
  }
  const returnPct = new Float64Array(stepCount);
  if (entry.cbpPlanningReturnPct !== null) {
    // CBP planning return is a contractual credit rate, not a market draw; stress does not apply.
    const monthly = monthlyEquivalent(entry.cbpPlanningReturnPct);
    returnPct.fill(monthly);
    return returnPct;
  }
  if (injectedReturnPct !== null) {
    // Injected-parity mode: leave the caller's series untouched so both engines stay bit-identical.
    returnPct.set(injectedReturnPct);
    return returnPct;
  }
  if (sampledIdx !== null && columns !== null) {
    const sc = columns.stockPct;
    const bc = columns.bondPct;
    const cc = columns.cashPct;
    // A cost drag is a flat scalar; the per-asset shock becomes a per-step blended mean-shift honouring each account's own mix.
    // Unshocked paths skip it, keeping the parity fixtures bit-identical.
    const costMonthly = annualInvestmentCostPct / 12;
    const shocked = costMonthly !== 0 || returnShock !== null;
    const shockStocks = returnShock ? returnShock.stocksPct / 12 : 0;
    const shockBonds = returnShock ? returnShock.bondsPct / 12 : 0;
    const shockCash = returnShock ? returnShock.cashPct / 12 : 0;
    if (entry.assetMixSeries !== null) {
      // A mis-sized series would produce undefined `mix` and NaN percentiles.
      if (entry.assetMixSeries.length !== stepCount) {
        throw new Error(
          `assetMixSeries length mismatch: expected ${stepCount}, got ${entry.assetMixSeries.length}`,
        );
      }
      // Inlines `blendedReturnMonthly`; bit-identity needs its op order: `(pct/100)*x` summed stock, bond, cash, never `pct*x/100`.
      const series = entry.assetMixSeries;
      for (let i = 0; i < stepCount; i += 1) {
        const mix = series[i];
        const k = sampledIdx[i];
        const gross =
          (mix.stocksPct / 100) * sc[k] +
          (mix.bondsPct / 100) * bc[k] +
          (mix.cashPct / 100) * cc[k];
        returnPct[i] = shocked
          ? gross -
            costMonthly -
            ((mix.stocksPct / 100) * shockStocks +
              (mix.bondsPct / 100) * shockBonds +
              (mix.cashPct / 100) * shockCash)
          : gross;
      }
    } else if (entry.assetMix !== null) {
      const ws = entry.assetMix.stocksPct / 100;
      const wb = entry.assetMix.bondsPct / 100;
      const wc = entry.assetMix.cashPct / 100;
      const shiftMonthly = costMonthly + ws * shockStocks + wb * shockBonds + wc * shockCash;
      for (let i = 0; i < stepCount; i += 1) {
        const k = sampledIdx[i];
        const gross = ws * sc[k] + wb * bc[k] + wc * cc[k];
        returnPct[i] = shocked ? gross - shiftMonthly : gross;
      }
    }
  }
  return returnPct;
}

/**
 * Routes household-level events (no `targetAccountId`, or one not in the ledger): post-retirement into the household
 * deposit series, pre-retirement proportionally across the ledger's `contribPost` arrays. The production bundle always
 * targets an account; this is the fallback for hand-rolled events.
 */
export function routeHouseholdLevelEvents(args: {
  events: readonly MonteCarloPortfolioEvent[];
  ledger: ReadonlyArray<MonteCarloAccountLedger>;
  accounts: KernelAccount[];
  stepCount: number;
  retirementStepIdx: number;
  deposit: Float64Array;
}): void {
  const ledgerIds = new Set<string>();
  for (const entry of args.ledger) ledgerIds.add(entry.id);
  const { initialPerAccount, totalInitial } = buildInitialBalanceWeights(args.ledger);
  for (const ev of args.events) {
    if (ev.month < 0 || ev.month >= args.stepCount) continue;
    if (ev.targetAccountId !== undefined && ledgerIds.has(ev.targetAccountId)) {
      continue;
    }
    if (ev.month >= args.retirementStepIdx) {
      args.deposit[ev.month] += ev.amount;
      continue;
    }
    routePreRetirementEvent({
      ev,
      accounts: args.accounts,
      ledger: args.ledger,
      initialPerAccount,
      totalInitial,
    });
  }
}

function buildInitialBalanceWeights(
  ledger: ReadonlyArray<MonteCarloAccountLedger>,
): { initialPerAccount: number[]; totalInitial: number } {
  let totalInitial = 0;
  const initialPerAccount: number[] = new Array(ledger.length);
  for (let a = 0; a < ledger.length; a += 1) {
    const init = ledger[a].initialPre + ledger[a].initialPost;
    initialPerAccount[a] = init;
    totalInitial += init;
  }
  return { initialPerAccount, totalInitial };
}

function routePreRetirementEvent(args: {
  ev: MonteCarloPortfolioEvent;
  accounts: KernelAccount[];
  ledger: ReadonlyArray<MonteCarloAccountLedger>;
  initialPerAccount: number[];
  totalInitial: number;
}): void {
  const { ev, accounts, ledger, initialPerAccount, totalInitial } = args;
  if (accounts.length === 0) return;
  for (let a = 0; a < accounts.length; a += 1) {
    const share =
      totalInitial > 0
        ? ev.amount * (initialPerAccount[a] / totalInitial)
        : ev.amount / accounts.length;
    // Clone-on-write: swap in a private `contribPost` copy before the first `+=` so the shared bundle stays pristine across paths.
    const acc = accounts[a];
    let contribPost = acc.contribPost;
    if (contribPost === ledger[a].contribPost) {
      contribPost = new Float64Array(contribPost);
      accounts[a] = { ...acc, contribPost };
    }
    contribPost[ev.month] += share;
  }
}
