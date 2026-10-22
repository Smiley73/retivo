/**
 * Strategy-aware drawdown helpers: per-account run state, floor and drawable helpers, strategy tiers and the
 * MAGI-cap runtime types. Pure; no engine state.
 */

/**
 * Sentinel id of the synthetic POST_TAX cash-like account that holds RMD surplus when no real POST_TAX
 * non-Roth account exists.
 * It is a modeling artifact excluded from the per-account breakdown, and the tax post-pass treats it as
 * cash-like ($0 MAGI).
 */
export const RMD_OVERFLOW_CASH_ACCOUNT_ID = '__rmd-overflow-cash';

/** True for the synthetic RMD-overflow cash carrier. */
export function isRmdOverflowCashAccountId(id: string): boolean {
  return id === RMD_OVERFLOW_CASH_ACCOUNT_ID;
}

/** Per-account runtime state used inside the strategy-aware loop. */
export interface AccountRunState {
  readonly id: string;
  pre: number;
  post: number;
  readonly annualRatePct: number;
  readonly monthlyRate: number;
  readonly taxTreatment: 'PRE_TAX' | 'POST_TAX' | 'MIXED' | 'HSA' | 'ROTH';
  readonly accountType: string;
  /**
   * Targeted deposit dollars per step by destination treatment (`pre` for PRE_TAX/MIXED, else `post`), plus
   * the post-primary spouse contribution's pre-tax slice.
   */
  readonly deposits: Float64Array;
  /**
   * Post-primary spouse post-tax (designated-Roth) contribution slice, always credited to `post`; a MIXED
   * account's Roth slice stays RMD-exempt (§325).
   */
  readonly depositsPost: Float64Array;
  /** Per-month return percent, on Monte Carlo paths only; absent means scalar-rate growth. */
  readonly returnPctByMonth?: Float64Array;
  /**
   * Minimum-balance floor in dollars, effective only on floor-eligible accounts; read it through
   * `floorEligibleDollars`.
   */
  readonly floorDollars?: number;
  /**
   * HSA floor mode: `'strict'` blocks all HSA draws at the floor, `'emergencyOnly'` (default) blocks only the
   * emergency pass. Ignored on non-HSA accounts.
   */
  readonly floorHsaMode?: 'emergencyOnly' | 'strict';
  /**
   * The account is inherited: an inherited Roth IRA draw is classified into the tax-free subset the funding
   * solver excludes from the §408A carrier.
   */
  readonly inheritedAccount?: boolean;
}

/**
 * True when a per-account floor is honored: only `POST_TAX` and `HSA` accounts; a floor on any other
 * treatment is ignored at the engine boundary.
 */
export function isFloorEligibleTreatment(
  taxTreatment: AccountRunState['taxTreatment'],
): boolean {
  return taxTreatment === 'POST_TAX' || taxTreatment === 'HSA';
}

function isFloorEligible(st: AccountRunState): boolean {
  return isFloorEligibleTreatment(st.taxTreatment);
}

/**
 * Effective floor in dollars: `floorDollars` when the account is floor-eligible and the floor is positive and
 * finite, else 0.
 */
export function floorEligibleDollars(st: AccountRunState): number {
  if (!isFloorEligible(st)) return 0;
  const f = st.floorDollars ?? 0;
  return Number.isFinite(f) && f > 0 ? f : 0;
}

/**
 * Portion of the combined (pre + post) balance above the floor, `max(0, pre + post - floor)`; discretionary
 * draws never exceed it.
 */
export function discretionaryDrawable(st: AccountRunState): number {
  const pool = combinedBalance(st);
  const floor = floorEligibleDollars(st);
  return floor > 0 ? Math.max(0, pool - floor) : pool;
}

function combinedBalance(st: AccountRunState): number {
  return st.pre + st.post;
}

/**
 * Last-resort reserve: the full combined balance of a floor-eligible account with an active floor, else 0.
 * Used only by `drawFloorReserve` and the `drawLaterCapSafe` POST_TAX fallback.
 */
export function reserveDrawable(st: AccountRunState): number {
  if (floorEligibleDollars(st) <= 0) return 0;
  return Math.max(0, combinedBalance(st));
}

/**
 * Applies a floor-aware withdrawal `share` to `st` in place and returns the pre/post split, proportional to
 * the current bucket ratio (MIXED-safe); the caller has already capped `share` at the discretionary drawable.
 */
export function applyFloorAwareShare(
  st: AccountRunState,
  share: number,
): { preShare: number; postShare: number } {
  const realPool = st.pre + st.post;
  const preShare = realPool > 0 ? share * (st.pre / realPool) : 0;
  const postShare = share - preShare;
  st.pre = Math.max(0, st.pre - preShare);
  st.post = Math.max(0, st.post - postShare);
  return { preShare, postShare };
}

/**
 * Result of the per-year RMD floor pre-pass (the mandatory forced draw); the surplus disposition is computed
 * after the tax solve so the tax portion is not reinvested.
 */
export interface RmdFloorPrePassResult {
  /** Forced PRE_TAX withdrawal per account, in dollars. */
  readonly preTaxWithdrawn: number[];
  readonly totalForcedPreTaxWithdrawn: number;
}

/**
 * Result of the post-tax-solve RMD surplus disposition (`disposeRmdSurplus`); the retained surplus excludes
 * the dollars that must pay taxes.
 */
export interface RmdSurplusDispositionResult {
  /** Surplus deposit per account into POST_TAX-non-Roth, in dollars. */
  readonly postTaxNonRothDeposit: number[];
  /**
   * RMD surplus reinvested into a real POST_TAX non-Roth account (never the synthetic carrier); surfaces as
   * `rmdReinvestedCents`.
   */
  readonly reinvestedDollars: number;
  /**
   * RMD surplus credited to the synthetic cash-like carrier when no real POST_TAX non-Roth account exists;
   * surfaces as `rmdOverflowToCashCents`.
   */
  readonly overflowToCashDollars: number;
}

/**
 * True when a targeted deposit lands in the pre-tax sub-bucket (PRE_TAX or MIXED); POST_TAX, ROTH and HSA
 * deposits land in `post`. The household-share proportional spread stays in `post`.
 */
export function isPreTaxTargetedDeposit(st: AccountRunState): boolean {
  return st.taxTreatment === 'PRE_TAX' || st.taxTreatment === 'MIXED';
}

/**
 * True for an HSA-treatment account; HSA is held out of the ordinary withdrawal tiers and drawn only by the
 * medical and emergency passes.
 */
export function isHsaAccount(st: AccountRunState): boolean {
  return st.taxTreatment === 'HSA';
}

/** State indices of the HSA accounts, built once per run. */
export function hsaStateIndices(state: ReadonlyArray<AccountRunState>): number[] {
  const out: number[] = [];
  for (let a = 0; a < state.length; a += 1) {
    if (isHsaAccount(state[a])) out.push(a);
  }
  return out;
}

/**
 * True for a POST_TAX non-Roth account, the landing site for RMD surplus; the type-prefix guard also excludes
 * Roth-designated types still on POST_TAX.
 */
export function isPostTaxNonRoth(st: AccountRunState): boolean {
  if (st.taxTreatment !== 'POST_TAX') return false;
  return !st.accountType.startsWith('RETIREMENT_ROTH_');
}

export type StrategyAwareKind = 'taxEfficient' | 'rothFirst' | 'proportional' | 'customOrder';

/**
 * Runtime MAGI-cap config for one window of the cap schedule, with account ids mapped to state indices; the
 * year loop picks the active window (`selectActiveMagiCapWindow`).
 */
export interface MagiCapRuntimeConfig {
  /**
   * Maximum pre-tax taxable income (withdrawals + conversions) in dollars per year while the cap is active.
   */
  readonly capDollars: number;
  /**
   * Calendar year at which the window's cap stops (exclusive); 0 for a window whose anchor could not be
   * resolved, which is never active.
   */
  readonly capOffYear: number;
  /** Behavior mode. `'fill'` auto-converts leftover cap room into the
   *  target Roth after spending withdrawals; `'minimize'` converts $0. */
  readonly capMode: 'minimize' | 'fill';
  /** MAGI line the ceiling targets: federal/IRMAA or ACA-PTC. */
  readonly capMagiLine: 'irmaa' | 'aca';
  /**
   * Account id of the target Roth for Fill conversions; undefined or dangling degrades Fill to
   * withdrawal-only.
   */
  readonly targetRothAccountId?: string;
  /**
   * Resolves the target Roth's state index; `undefined` when no target is configured or the id is dangling,
   * deleted or non-Roth.
   */
  readonly findTargetRothIndex: (
    state: ReadonlyArray<AccountRunState>,
  ) => number | undefined;
  /**
   * First cap-safe state index (POST_TAX including Roth, or MIXED with post > 0) at or after tier t+1,
   * skipping `visited`; Roth is cap-safe because its draw adds $0 to MAGI.
   */
  readonly findLaterTaxableIndex: (
    tiers: ReadonlyArray<ReadonlyArray<number>>,
    afterTierIdx: number,
    state: ReadonlyArray<AccountRunState>,
    visited: ReadonlySet<number>,
  ) => number | undefined;
}

/**
 * One resolved MAGI-cap window: `[startYear, endYear)` is the half-open active span, `originalIndex` the
 * final tie-break in the order `(startYear, endYear, originalIndex)`, and `brokenAnchor` marks a window whose
 * anchor could not resolve (inactive every year, never aborts the run).
 */
export interface MagiCapWindowRuntime {
  readonly startYear: number;
  readonly endYear: number;
  readonly originalIndex: number;
  readonly config: MagiCapRuntimeConfig;
  readonly brokenAnchor?: boolean;
}

/**
 * Selects the cap window active in `calendarYear` from a pre-sorted list (`startYear <= year < endYear`,
 * broken anchors skipped); on overlap the earliest-start window wins. `undefined` in a gap year.
 */
export function selectActiveMagiCapWindow(
  windows: ReadonlyArray<MagiCapWindowRuntime>,
  calendarYear: number,
): MagiCapWindowRuntime | undefined {
  for (const w of windows) {
    if (w.brokenAnchor) continue;
    if (calendarYear >= w.startYear && calendarYear < w.endYear) return w;
  }
  return undefined;
}

/**
 * Builds the strategy-priority tiers: `proportional` returns one tier, `taxEfficient` and `rothFirst` three,
 * in that strategy's order. HSA is held out of every tier because the medical and emergency passes cover it.
 * @throws {Error} if `kind === 'customOrder'`; callers route that to the custom-tier path.
 */
export function buildStrategyTiers(
  state: ReadonlyArray<AccountRunState>,
  kind: StrategyAwareKind,
): number[][] {
  if (kind === 'customOrder') {
    throw new Error(
      'buildStrategyTiers: customOrder kind must be routed through the custom-tier path; ' +
        'check strategyKind !== "customOrder" before calling this function.',
    );
  }
  if (kind === 'proportional') {
    const indices: number[] = [];
    for (let a = 0; a < state.length; a += 1) {
      if (!isHsaAccount(state[a])) indices.push(a);
    }
    return [indices];
  }
  const tier0: number[] = [];
  const tier1: number[] = [];
  const tier2: number[] = [];
  for (let a = 0; a < state.length; a += 1) {
    const st = state[a];
    const isRoth = st.accountType.startsWith('RETIREMENT_ROTH_');
    if (st.taxTreatment === 'HSA') continue;
    if (kind === 'taxEfficient') {
      if (!isRoth && st.taxTreatment === 'POST_TAX') tier0.push(a);
      else if (st.taxTreatment === 'PRE_TAX' || st.taxTreatment === 'MIXED') tier1.push(a);
      else tier2.push(a); // Roth
    } else {
      if (isRoth) tier0.push(a);
      else if (st.taxTreatment === 'PRE_TAX' || st.taxTreatment === 'MIXED') tier1.push(a);
      else tier2.push(a); // POST_TAX non-Roth
    }
  }
  return [tier0, tier1, tier2];
}

/**
 * Distributes `target` dollars across accounts in strategy-priority order, balance-proportional within a
 * tier; returns the total drawn (below `target` under depletion).
 * Writes per-account pre/post withdrawn into the accumulators; an optional prebuilt `tiers` avoids rebuilding
 * per call.
 */
export function distributeWithdrawalByStrategy(args: {
  state: AccountRunState[];
  strategyKind: StrategyAwareKind;
  target: number;
  yearWithdrawnByAcct: number[];
  yearPreWithdrawnByAcct: number[];
  yearPostWithdrawnByAcct: number[];
  tiers?: ReadonlyArray<ReadonlyArray<number>>;
}): number {
  const { state, strategyKind, target, yearWithdrawnByAcct,
    yearPreWithdrawnByAcct, yearPostWithdrawnByAcct } = args;
  if (target <= 0) return 0;

  const tiers = args.tiers ?? buildStrategyTiers(state, strategyKind);
  let remaining = target;
  let totalDrawn = 0;

  for (const tier of tiers) {
    if (remaining <= 0) break;
    // Only balance above each account's floor counts toward the tier pool, so a floored account's shortfall
    // routes to the next tier.
    let tierBalance = 0;
    for (const a of tier) tierBalance += discretionaryDrawable(state[a]);
    if (tierBalance <= 0) continue;
    const drawn = Math.min(remaining, tierBalance);
    for (const a of tier) {
      const acctPool = discretionaryDrawable(state[a]);
      if (acctPool <= 0) continue;
      let share = drawn * (acctPool / tierBalance);
      if (share > acctPool) share = acctPool;
      const { preShare, postShare } = applyFloorAwareShare(state[a], share);
      yearWithdrawnByAcct[a] += share;
      yearPreWithdrawnByAcct[a] += preShare;
      yearPostWithdrawnByAcct[a] += postShare;
      totalDrawn += share;
    }
    remaining -= drawn;
  }
  return totalDrawn;
}

/**
 * Distributes `target` dollars across caller-supplied tier index arrays (custom order), skipping excluded
 * indices; returns the total drawn and writes the pre/post accumulators.
 * With `sequentialWithinTier` accounts drain in listed order; otherwise the within-tier split is
 * balance-proportional.
 */
export function distributeWithdrawalByCustomTiers(args: {
  state: AccountRunState[];
  /** Pre-built tier index arrays (state indices). Tier[0] drained first. */
  tiers: ReadonlyArray<ReadonlyArray<number>>;
  /** State indices of accounts excluded from drawdown (e.g. HSA reserve). */
  excludedIndices: ReadonlySet<number>;
  target: number;
  yearWithdrawnByAcct: number[];
  yearPreWithdrawnByAcct: number[];
  yearPostWithdrawnByAcct: number[];
  /**
   * Drain accounts within each tier in listed order (customOrder) instead of balance-proportionally; default
   * false.
   */
  sequentialWithinTier?: boolean;
}): number {
  const { state, tiers, excludedIndices, target,
    yearWithdrawnByAcct, yearPreWithdrawnByAcct, yearPostWithdrawnByAcct,
    sequentialWithinTier = false } = args;
  if (target <= 0) return 0;
  let remaining = target;
  let totalDrawn = 0;

  for (const tier of tiers) {
    if (remaining <= 0) break;
    if (sequentialWithinTier) {
      const drawn = drainTierSequential({
        state, tier, excludedIndices, target: remaining,
        yearWithdrawnByAcct, yearPreWithdrawnByAcct, yearPostWithdrawnByAcct,
      });
      remaining -= drawn;
      totalDrawn += drawn;
      continue;
    }
    let tierBalance = 0;
    for (const a of tier) {
      if (!excludedIndices.has(a)) tierBalance += discretionaryDrawable(state[a]);
    }
    if (tierBalance <= 0) continue;
    const drawn = Math.min(remaining, tierBalance);
    for (const a of tier) {
      if (excludedIndices.has(a)) continue;
      const acctPool = discretionaryDrawable(state[a]);
      if (acctPool <= 0) continue;
      let share = drawn * (acctPool / tierBalance);
      if (share > acctPool) share = acctPool;
      const { preShare, postShare } = applyFloorAwareShare(state[a], share);
      yearWithdrawnByAcct[a] += share;
      yearPreWithdrawnByAcct[a] += preShare;
      yearPostWithdrawnByAcct[a] += postShare;
      totalDrawn += share;
    }
    remaining -= drawn;
  }
  return totalDrawn;
}

/**
 * Drains `target` dollars from one sub-bucket (`pre` or `post`) of a tier in listed order, emptying `tier[0]`
 * before `tier[1]` and skipping excluded and empty accounts; writes `bucketWithdrawnByAcct`. Returns dollars
 * drawn.
 * `drainTierSequential` is the both-bucket variant.
 */
export function drainTierSequentialOneBucket(
  args: {
    state: AccountRunState[];
    tier: ReadonlyArray<number>;
    excludedIndices: ReadonlySet<number>;
    target: number;
    yearWithdrawnByAcct: number[];
    bucketWithdrawnByAcct: number[];
  },
  bucket: 'pre' | 'post',
): number {
  const { state, tier, excludedIndices, target,
    yearWithdrawnByAcct, bucketWithdrawnByAcct } = args;
  let remaining = target;
  let totalDrawn = 0;
  for (const a of tier) {
    if (remaining <= 0) break;
    if (excludedIndices.has(a) || state[a][bucket] <= 0) continue;
    const bucketDrawable = Math.min(state[a][bucket], discretionaryDrawable(state[a]));
    if (bucketDrawable <= 0) continue;
    const share = Math.min(remaining, bucketDrawable);
    state[a][bucket] = Math.max(0, state[a][bucket] - share);
    yearWithdrawnByAcct[a] += share;
    bucketWithdrawnByAcct[a] += share;
    totalDrawn += share;
    remaining -= share;
  }
  return totalDrawn;
}

export function drainTierSequential(args: {
  state: AccountRunState[];
  tier: ReadonlyArray<number>;
  excludedIndices: ReadonlySet<number>;
  target: number;
  yearWithdrawnByAcct: number[];
  yearPreWithdrawnByAcct: number[];
  yearPostWithdrawnByAcct: number[];
}): number {
  const { state, tier, excludedIndices, target,
    yearWithdrawnByAcct, yearPreWithdrawnByAcct, yearPostWithdrawnByAcct } = args;
  let remaining = target;
  let totalDrawn = 0;
  for (const a of tier) {
    if (remaining <= 0) break;
    if (excludedIndices.has(a)) continue;
    const acctPool = discretionaryDrawable(state[a]);
    if (acctPool <= 0) continue;
    const share = Math.min(remaining, acctPool);
    const { preShare, postShare } = applyFloorAwareShare(state[a], share);
    yearWithdrawnByAcct[a] += share;
    yearPreWithdrawnByAcct[a] += preShare;
    yearPostWithdrawnByAcct[a] += postShare;
    totalDrawn += share;
    remaining -= share;
  }
  return totalDrawn;
}
