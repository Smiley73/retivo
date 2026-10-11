/**
 * Per-account sampling helpers for the Monte Carlo runner. Sibling to
 * `monte-carlo.ts` — extracted to keep the runner file under the shape
 * cap. Each function is pure and consumes / mutates only the
 * data passed in.
 */
import { type HistoricalColumns } from './projection-engine/historical.js';
import { type KernelAccount } from './projection-engine/kernel.js';
import { monthlyEquivalent } from './projection-engine/monthly-conversion.js';
import type { MonteCarloAccountLedger } from './monte-carlo.js';
import type { MonteCarloInput, MonteCarloPortfolioEvent } from './monte-carlo-types.js';

export type { MonteCarloAccountLedger };
// Single canonical declaration lives in `monte-carlo-types.ts`; re-exported
// here so the sibling routing helpers + their tests keep one import surface.
export type { MonteCarloPortfolioEvent };

/** Build per-account `KernelAccount` entries from the MC ledger.
 *  Allocates a fresh `returnPct` per call and references the bundle-side
 *  `contribPre`/`contribPost`/`deposit` arrays DIRECTLY (no clone) for
 *  `'fixed'`-growth accounts. The kernel only reads these arrays; the sole
 *  per-path mutation is `routePreRetirementEvent`, which clones-on-write
 *  before its first `+=` so the shared bundle stays pristine across paths.
 *
 *  For a `'tracks-inflation'` account the today's-dollars base
 *  contribution is scaled by the path's own `cumCpi[i]` into FRESH arrays
 *  (so it stays flat-real on every inflation path); the post-tax planned
 *  base (`plannedContribPostBase`) is scaled while any nominal targeted
 *  event dollars already routed onto `contribPost` pass through unscaled. */
export function buildPerAccountKernelInputs(args: {
  ledger: ReadonlyArray<MonteCarloAccountLedger>;
  stepCount: number;
  /** Sampled historical dataset ROW INDICES for this path, or `null`
   *  in injected-returns mode. Paired with `columns` — index into those packed
   *  arrays instead of an array of per-row objects. */
  sampledIdx: Int32Array | null;
  /** Struct-of-arrays view of the historical dataset, or `null` in
   *  injected-returns mode. */
  columns: HistoricalColumns | null;
  injectedReturnPct: Float64Array | null;
  /** Path's own cumulative CPI factor by step. Omitted → no
   *  per-path scaling (flat-nominal), used by narrow unit tests
   *  that don't exercise tracks-inflation growth. */
  cumCpi?: Float64Array;
  /** Today-anchor month (0..11). Tracks-inflation contributions are scaled so
   *  they equal their today's-dollars base at step `todayMonthIndex` (the
   *  MC analogue of the deterministic `asOfMonth` anchor). Omitted → 0
   *  (January), the anchor used by narrow unit tests. */
  todayMonthIndex?: number;
  /** Market-stress annual investment-cost drag (%). 0 → no drag. */
  annualInvestmentCostPct?: number;
  /** Market-stress per-asset annual pp return shock. Absent → none. */
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
      // `'fixed'` accounts reference the shared bundle arrays directly —
      // `routePreRetirementEvent` clones `contribPost` on first write;
      // `contribPre`/`deposit` are never mutated per path. `'tracks-
      // inflation'` accounts get fresh per-path CPI-scaled arrays.
      contribPre: scaled.contribPre,
      contribPost: scaled.contribPost,
      deposit: entry.deposit,
      // The post-primary post-tax (Roth) slice — read by the named-strategy
      // slice only; the kernel reads the summed `deposit`. The pre slice
      // is reconstructed there as `deposit − depositPost`, so it is not carried
      // on the kernel account. Reference the shared bundle array directly (the
      // kernel never mutates it).
      depositPost: entry.depositPost,
      returnPct,
      // HSA withdrawal reserve: mark HSA so the kernel holds it out of the
      // proportional pool + runs the medical/emergency two-pass.
      isHsa: entry.taxTreatment === 'HSA',
    };
  }
  return accounts;
}

/** Per-path CPI scaling of a tracks-inflation account's today's-dollars
 *  base contribution. `'fixed'` accounts (growth already baked) +
 *  ledgers without growth metadata return the shared arrays unchanged.
 *  For tracks-inflation:
 *  - `contribPre` is entirely planned base (no events route to it) → scale
 *    the whole array by `cumCpi[i]`.
 *  - `contribPost` may carry routed nominal event dollars on top of the
 *    planned base → scale only the `plannedContribPostBase` portion,
 *    leaving the event delta nominal:
 *    `post[i] = base[i]*cumCpi[i] + (contribPost[i] − base[i])`. */
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
  // Anchor the per-path CPI scaling at TODAY, not at step 0. The
  // START-of-month cumulative CPI factor `startFactor(i) = (i===0 ? 1 :
  // cumCpi[i-1])` grows the contribution by exactly i months of inflation
  // from January-of-firstYear; the deterministic engine instead anchors at
  // `asOfMonth = firstYear*12 + todayMonthIndex` via `(1+rate)^((firstYear*12
  // + i − asOfMonth)/12)`. Dividing each step's start-of-month factor by the
  // anchor factor `startFactor(todayMonthIndex)` re-bases the series so it
  // equals 1 at step `todayMonthIndex` — matching the deterministic exponent
  // `(i − todayMonthIndex)/12` and restoring cross-engine parity for a
  // non-January "today". (`cumCpi` covers the full horizon and
  // todayMonthIndex is 0..11, so `cumCpi[todayMonthIndex-1]` is always in
  // range.) `cumCpi[i]` (end-of-month) would over-count by one month;
  // expense/income use it because they are flows consumed during the month,
  // but a contribution lands at the month's start.
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

/** Per-account monthly return series: CBP-planning-rate ledger entries
 *  ignore the sampled tuple and use a constant monthly factor;
 *  non-CBP entries apply the sampled tuple to their own `assetMix`;
 *  injected mode short-circuits both via a caller-supplied series. */
function buildPerAccountReturnSeries(
  entry: MonteCarloAccountLedger,
  stepCount: number,
  sampledIdx: Int32Array | null,
  columns: HistoricalColumns | null,
  injectedReturnPct: Float64Array | null,
  /** Market-stress annual investment-cost drag (%), subtracted from
   *  every market-sampled month as `−annualInvestmentCostPct/12`. 0 → no drag. */
  annualInvestmentCostPct: number = 0,
  /** Market-stress per-asset annual pp return shock; applied as the
   *  blended per-step mean-shift on the sampled return. `null` → no shock. */
  returnShock: MonteCarloInput['returnShock'] | null = null,
): Float64Array {
  // Fail fast on an inconsistent SoA pairing. `sampledIdx` + `columns` are a
  // single unit (both null in injected-returns mode, both provided in sampled
  // mode); a lone non-null would silently fall through to an all-zero series
  // and corrupt every percentile with no error. Catch it at the boundary.
  if ((sampledIdx === null) !== (columns === null)) {
    throw new Error(
      'buildPerAccountReturnSeries: sampledIdx and columns must both be null or both be provided together',
    );
  }
  const returnPct = new Float64Array(stepCount);
  if (entry.cbpPlanningReturnPct !== null) {
    // CBP fixed planning return — a contractual cash-balance credit rate, not a
    // market draw; the fee/return market stress does not apply.
    const monthly = monthlyEquivalent(entry.cbpPlanningReturnPct);
    returnPct.fill(monthly);
    return returnPct;
  }
  if (injectedReturnPct !== null) {
    // Injected-parity mode (cross-engine pin) — the caller supplies the exact
    // return series; leave it untouched so both engines stay bit-identical.
    returnPct.set(injectedReturnPct);
    return returnPct;
  }
  if (sampledIdx !== null && columns !== null) {
    // Index the packed SoA columns by the sampled row index. `sc[k]` etc.
    // read the SAME doubles the per-row `sampled[i].stockPct` reads would — the
    // blend expression shape is byte-for-byte unchanged.
    const sc = columns.stockPct;
    const bc = columns.bondPct;
    const cc = columns.cashPct;
    // Market stress: a per-month cost drag (the "Higher fees" stress —
    // there is no base-plan cost) is a flat
    // scalar; the per-asset return shock becomes a per-step BLENDED mean-shift
    // that honours each account's own (possibly gliding) mix. When neither is
    // active the shocked branch is skipped entirely, so the frozen parity
    // fixtures reproduce the unshocked output bit-for-bit.
    const costMonthly = annualInvestmentCostPct / 12;
    const shocked = costMonthly !== 0 || returnShock !== null;
    const shockStocks = returnShock ? returnShock.stocksPct / 12 : 0;
    const shockBonds = returnShock ? returnShock.bondsPct / 12 : 0;
    const shockCash = returnShock ? returnShock.cashPct / 12 : 0;
    if (entry.assetMixSeries !== null) {
      // Fail fast — a mis-sized series produces undefined `mix` and
      // silently corrupts every percentile with NaN. Catch at the boundary.
      if (entry.assetMixSeries.length !== stepCount) {
        throw new Error(
          `assetMixSeries length mismatch: expected ${stepCount}, got ${entry.assetMixSeries.length}`,
        );
      }
      // Per-step glide-derived mix — apply assetMixSeries[i] each step.
      // Inline the `blendedReturnMonthly` expression (drops call overhead);
      // op order matches it exactly: (pct/100)*x summed stock→bond→cash.
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
      // Flat mix — hoist the three weight fractions out of the loop. Each
      // `w = pct/100` then `w*x` is bit-identical to `blendedReturnMonthly`
      // (never reorder to `pct*x/100`).
      const ws = entry.assetMix.stocksPct / 100;
      const wb = entry.assetMix.bondsPct / 100;
      const wc = entry.assetMix.cashPct / 100;
      // The blended per-account mean-shift is constant across steps for a flat
      // mix — hoist it out of the loop.
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

/** Route household-level event dollars (no `targetAccountId`, or a
 *  target that isn't in the ledger) into either the household deposit
 *  series (post-retirement — kernel splits proportional to current
 *  balance at deposit time) or proportionally across the ledger's
 *  `contribPost` arrays (pre-retirement — accumulation phase, no
 *  household-level deposit series is consumed by the per-account
 *  kernel branch). In practice every event the production bundle
 *  factory emits carries a `targetAccountId`; this fallback exists so
 *  tests + the cross-engine-pin scenarios that hand-roll events
 *  without a target continue to compose correctly. */
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
      // Targeted event already routed into the ledger entry by the
      // bundle factory — skip.
      continue;
    }
    if (ev.month >= args.retirementStepIdx) {
      // Post-retirement: feed the household deposit series; kernel
      // splits proportional to current balance at deposit time.
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
    // Clone-on-write: `buildPerAccountKernelInputs` references the shared
    // bundle `contribPost` directly. Before the first `+=` this run, swap
    // in a private copy so the bundle stays pristine across paths.
    const acc = accounts[a];
    let contribPost = acc.contribPost;
    if (contribPost === ledger[a].contribPost) {
      contribPost = new Float64Array(contribPost);
      accounts[a] = { ...acc, contribPost };
    }
    contribPost[ev.month] += share;
  }
}
