/**
 * Helpers for the strategy-aware drawdown engine
 * (`drawdown-engine-per-account-strategy.ts`). Extracted for shape-cap
 * compliance — pure functions, no engine state.
 *
 * Covers:
 *   - `AccountRunState` shape (per-account runtime bookkeeping).
 *   - Floor-eligibility / drawable helpers and the strategy tier builders.
 *   - `isPostTaxNonRoth` / `isPreTaxTargetedDeposit` predicates.
 *
 * The per-owner RMD floor builder plus the QCD / RMD / HSA forced-outflow pass
 * live in the sibling `drawdown-engine-per-account-qcd-hsa.ts` module (which
 * imports the shared `AccountRunState` / floor helpers from here).
 */

/**
 * Sentinel account id for the synthetic POST_TAX cash-like account that holds
 * RMD surplus when the household has no real POST_TAX-non-Roth landing site.
 * It is materialized once at run START (a zero-balance member of
 * `state[]`), credited by `applyRmdFloorPrePass` on overflow, spent first via
 * the net-need pre-step, and EXCLUDED from the per-account breakdown UI
 * (it is a modeling artifact, not a user account — it is never in
 * `ctx.accountProjections`/`accountMeta`, so the account-stack chart ignores
 * it; it rolls into `DrawdownYear.balance` totals only). The tax post-pass
 * recognizes this id as cash-like ($0 MAGI, tax-free return-of-principal).
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
  /** Per-step targeted deposit dollars routed by destination treatment
   *  (CBP lump-sum / one-off → `pre` for PRE_TAX/MIXED, else `post`) PLUS the
   *  post-primary spouse contribution's PRE-tax slice (always → `pre`). */
  readonly deposits: Float64Array;
  /** Per-step post-primary spouse contribution POST-tax (designated-Roth)
   *  slice — always credited to `post` regardless of treatment (a MIXED
   *  account's Roth slice stays RMD-exempt, §325). */
  readonly depositsPost: Float64Array;
  /** Per-month per-account return percent. Copied from
   *  `DrawdownAccountInput.returnPctByMonth`. Present on Monte Carlo paths
   *  only; when set, `applyMonthlyGrowth(state, stepIdx)` grows by
   *  `1 + returnPctByMonth[stepIdx] / 100` rather than the scalar
   *  `monthlyRate`. Absent → scalar-rate growth (deterministic / optimizer
   *  path, unchanged). */
  readonly returnPctByMonth?: Float64Array;
  /** Per-account minimum-balance floor in DOLLARS.
   *  Copied from `DrawdownAccountInput.floorDollars`. Effective ONLY on
   *  floor-eligible accounts (`taxTreatment ∈ {POST_TAX, HSA}`) — read it
   *  through `floorEligibleDollars(st)` / `discretionaryDrawable(st)`, never
   *  raw, so the eligibility predicate is applied uniformly. Absent / 0 ⇒ no
   *  floor. */
  readonly floorDollars?: number;
  /** HSA floor mode. `'strict'` blocks all HSA
   *  draws at the floor (PASS A + PASS B); `'emergencyOnly'` (default) blocks
   *  only PASS B. Ignored on non-HSA accounts. */
  readonly floorHsaMode?: 'emergencyOnly' | 'strict';
  /** The account is INHERITED (`RmdAccountProfileFacts.inheritedAccount`).
   *  Copied from the run's RMD context, which both engines already carry, so no
   *  new serialized Monte Carlo input field is introduced. Read ONLY by
   *  `classifyAccountDraw`, which routes an inherited `RETIREMENT_ROTH_IRA` draw
   *  into the tax-free subset the funding solver excludes from the §408A carrier.
   *  Absent → an owner account. */
  readonly inheritedAccount?: boolean;
}

/**
 * Floor-eligibility predicate: a per-account floor
 * is honored ONLY when the account's tax treatment is `POST_TAX` or `HSA`.
 * PRE_TAX / MIXED / ROTH accounts carry RMDs or are otherwise out of scope, so
 * an `accountFloors` entry on them is ignored at the engine boundary (the UI
 * type-gate is presentational only and never substitutes for this predicate).
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
 * The effective floor in dollars for `st`. Returns
 * the account's `floorDollars` when it is floor-eligible and the floor is
 * a positive finite number; otherwise `0` (no floor). Single read point so the
 * eligibility predicate is applied uniformly across every distributor.
 */
export function floorEligibleDollars(st: AccountRunState): number {
  if (!isFloorEligible(st)) return 0;
  const f = st.floorDollars ?? 0;
  return Number.isFinite(f) && f > 0 ? f : 0;
}

/**
 * Discretionary drawable for `st`: the portion
 * of the COMBINED (pre + post) balance above the effective floor, i.e.
 * `max(0, pre + post − floor)`. Floor re-entry is automatic — when returns lift
 * the balance above the floor in a later year, the surplus re-enters the draw.
 * Accounts with no floor return the full combined balance. Discretionary
 * withdrawals must never draw more than this from `st`.
 */
export function discretionaryDrawable(st: AccountRunState): number {
  const pool = combinedBalance(st);
  const floor = floorEligibleDollars(st);
  return floor > 0 ? Math.max(0, pool - floor) : pool;
}

/** Combined drawable balance (pre + post). */
function combinedBalance(st: AccountRunState): number {
  return st.pre + st.post;
}

/**
 * Last-resort reserve drawable for `st`:
 * the FULL remaining combined balance (`pre + post`) of a floor-eligible account
 * that carries an active floor — i.e. the protected reserve the ordinary path
 * left untouched below the floor. Returns 0 for any account with no effective
 * floor (`floorEligibleDollars(st) <= 0`): an unfloored / ineligible account was
 * already fully drawable in the ordinary path, so it holds no separate reserve
 * for `drawFloorReserve` to drain. Used ONLY by the last-resort `drawFloorReserve`
 * pass (and the `drawLaterCapSafe` POST_TAX cap-safe fallback), never by
 * `discretionaryDrawable` / `applyFloorAwareShare` (the ordinary above-floor
 * path stays byte-identical). Since `reserveDrawable = pre + post >= post`,
 * `min(post, reserveDrawable)` collapses to `post` in practice.
 */
export function reserveDrawable(st: AccountRunState): number {
  if (floorEligibleDollars(st) <= 0) return 0;
  return Math.max(0, combinedBalance(st));
}

/**
 * Apply a floor-aware withdrawal `share` to `st`
 * in place and return the pre/post split. The split stays proportional to the
 * CURRENT real bucket ratio (MIXED-safe); the caller has already capped `share`
 * at the account's floor-respecting discretionary drawable, so this only routes
 * the split. The returned `preShare`/`postShare` feed the per-account
 * accumulators at each call site (sum == `share`).
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

/** Result of the per-year RMD floor pre-pass (mandatory forced draw only).
 *  The surplus disposition is computed separately by `disposeRmdSurplus`
 *  AFTER the tax solve, so the tax portion of the forced RMD is not
 *  reinvested back into the portfolio. */
export interface RmdFloorPrePassResult {
  /** Forced PRE_TAX withdrawal per account, in dollars. Length == state.length. */
  readonly preTaxWithdrawn: number[];
  /** Sum of forced PRE_TAX withdrawals across all accounts. */
  readonly totalForcedPreTaxWithdrawn: number;
}

/** Result of the post-tax-solve RMD surplus disposition (`disposeRmdSurplus`).
 *  Computed AFTER the year's tax cashflow need is known so the surplus
 *  retained in the portfolio excludes the dollars that must pay taxes. */
export interface RmdSurplusDispositionResult {
  /** Surplus deposit per account into POST_TAX-non-Roth, in dollars. */
  readonly postTaxNonRothDeposit: number[];
  /** RMD surplus reinvested into a REAL POST_TAX-non-Roth account (a pre-
   *  existing taxable account, never the synthetic carrier). Surfaces as
   *  `rmdReinvestedCents`. */
  readonly reinvestedDollars: number;
  /** RMD surplus credited to the synthetic cash-like carrier because the
   *  household has no real POST_TAX-non-Roth account. Surfaces as
   *  `rmdOverflowToCashCents` — held as cash, PRESERVED in the balance. */
  readonly overflowToCashDollars: number;
}

/**
 * A TARGETED per-account deposit lands in the pre-tax sub-bucket iff the
 * destination account's tax treatment is pre-tax-capable (`PRE_TAX` or
 * `MIXED`). `POST_TAX` / `ROTH` / `HSA` targeted deposits land in the post-tax
 * sub-bucket. Drives the bucket routing in `applyMonthlyDeposits` — the income
 * form restricts a targeted deposit so its tax character always matches
 * the destination, so the treatment alone determines the bucket (no per-deposit
 * source tag). The household-share proportional spread does NOT use this — it
 * stays routed to `post`.
 */
export function isPreTaxTargetedDeposit(st: AccountRunState): boolean {
  return st.taxTreatment === 'PRE_TAX' || st.taxTreatment === 'MIXED';
}

/** True for an HSA-treatment account (the HSA medical-reserve routing).
 *  HSA is held OUT of the ordinary withdrawal tiers and drawn only via the two
 *  dedicated passes — medical-qualified (tax-free, against modeled medical
 *  demand) and emergency-after-non-HSA-exhaustion. */
export function isHsaAccount(st: AccountRunState): boolean {
  return st.taxTreatment === 'HSA';
}

/** State indices of the HSA-treatment accounts. Built once per run so
 *  the ordinary router can exclude them and the two HSA passes can target them.
 *  Synthetic carriers (`RMD_OVERFLOW_CASH_ACCOUNT_ID`) are POST_TAX, never HSA,
 *  so they are not included. */
export function hsaStateIndices(state: ReadonlyArray<AccountRunState>): number[] {
  const out: number[] = [];
  for (let a = 0; a < state.length; a += 1) {
    if (isHsaAccount(state[a])) out.push(a);
  }
  return out;
}

/** A POST_TAX-non-Roth account is the landing site for RMD surplus.
 *  Roth IRA carries `taxTreatment === 'ROTH'` (v2→v3 migration), so the
 *  treatment check already excludes it; the type-prefix guard stays as
 *  defense-in-depth (e.g. a future Roth-designated type still on POST_TAX).
 *  Roth growth is tax-free and would be wasted on what is effectively cash. */
export function isPostTaxNonRoth(st: AccountRunState): boolean {
  if (st.taxTreatment !== 'POST_TAX') return false;
  return !st.accountType.startsWith('RETIREMENT_ROTH_');
}

// ---------------------------------------------------------------------------
// Strategy tier construction
// ---------------------------------------------------------------------------

export type StrategyAwareKind = 'taxEfficient' | 'rothFirst' | 'proportional' | 'customOrder';

// ---------------------------------------------------------------------------
// MAGI-cap runtime config — lives here to avoid circular deps
// between drawdown-engine-per-account-strategy.ts and
// drawdown-engine-per-account-strategy-cap.ts.
// ---------------------------------------------------------------------------

/**
 * Runtime-resolved MAGI-cap config passed into the year-by-year engine
 * after the caller maps account IDs → state indices. Computed once by
 * `simulatePerAccountMonthly` for the entire run.
 *
 * `capDollars` — max pre-tax withdrawal per calendar year while cap is
 * active. This config describes ONE window of the cap schedule: the cap applies
 * to calendar years before `capOffYear`, the window's exclusive `endYear`, and
 * the year loop picks which window is active in a given year
 * (`selectActiveMagiCapWindow`). A year outside every window has no cap.
 *
 * Skip-ahead: when the active tier is purely pre-tax and the cap
 * is binding, the engine scans later tiers for the first taxable account
 * and diverts there. `findLaterTaxableIndex(tiers, t, state, visited)`
 * returns the first taxable state index found at or after tier t+1,
 * skipping any indices in `visited` (lets the cap router exhaust
 * every taxable account in a later tier before advancing, including a
 * second taxable account in the same tier as a previously-routed one).
 * `undefined` = no such account remains. Provided as a resolver fn to
 * avoid stale-state issues.
 */
export interface MagiCapRuntimeConfig {
  /** Maximum pre-tax taxable income (withdrawals + conversions) dollars per
   *  year while the cap is active. */
  readonly capDollars: number;
  /** Calendar year at which this window's cap stops (exclusive): the
   *  window's `endYear`, resolved from its end age or end year (0 for a
   *  window whose anchor could not be resolved, which is never active). */
  readonly capOffYear: number;
  /** Behavior mode. `'fill'` auto-converts leftover cap room into the
   *  target Roth after spending withdrawals; `'minimize'` converts $0. */
  readonly capMode: 'minimize' | 'fill';
  /** MAGI line the ceiling targets: federal/IRMAA or ACA-PTC. */
  readonly capMagiLine: 'irmaa' | 'aca';
  /** Account id of the user-designated target Roth for Fill conversions.
   *  Undefined / dangling → Fill degrades to withdrawal-only (no conversion). */
  readonly targetRothAccountId?: string;
  /** Resolve the target Roth's state index by equality to an own-household
   *  live Roth account in `state[]`. `undefined` when no target is
   *  configured or the id is dangling / deleted / non-Roth (degrade). */
  readonly findTargetRothIndex: (
    state: ReadonlyArray<AccountRunState>,
  ) => number | undefined;
  /** For each tier index t, the first cap-safe state index (POST_TAX —
   *  incl. Roth — or MIXED, with post>0) at or after tier t+1, excluding any
   *  index in `visited`. Roth is cap-safe because its draw adds $0 to MAGI
   *  (taxable/Roth sourcing precedence). Recomputed each call —
   *  provided as a resolver fn to avoid stale state and to support iterative
   *  tier-internal exhaustion. */
  readonly findLaterTaxableIndex: (
    tiers: ReadonlyArray<ReadonlyArray<number>>,
    afterTierIdx: number,
    state: ReadonlyArray<AccountRunState>,
    visited: ReadonlySet<number>,
  ) => number | undefined;
}

/**
 * One resolved MAGI-cap window for the engine year loop. The per-window `config` is built ONCE per run (not per path-year)
 * by `buildMagiCapConfig`; `[startYear, endYear)` is the half-open active span
 * the deterministic + MC engines select against. `originalIndex` is the
 * stored ladder position, used only as the final tie-break in the total order
 * `(startYear, endYear, originalIndex)`. `brokenAnchor` flags a window
 * whose anchor could not resolve (member with no birthdate) — it is INACTIVE
 * every year but never aborts the run.
 */
export interface MagiCapWindowRuntime {
  readonly startYear: number;
  readonly endYear: number;
  readonly originalIndex: number;
  readonly config: MagiCapRuntimeConfig;
  readonly brokenAnchor?: boolean;
}

/**
 * Select the cap window active in `calendarYear` from a PRE-SORTED window list
 * (sorted by the total order `(startYear, endYear, originalIndex)`). A
 * window is active iff `startYear ≤ calendarYear < endYear` (half-open);
 * broken-anchor windows are skipped. On a residual resolved overlap the
 * EARLIEST-start window wins — guaranteed because the list is sorted and we
 * return the FIRST match. Returns `undefined` in a gap year (cap off).
 * Mirrored bit-for-bit by the deterministic + MC engines.
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
 * Build the strategy-priority tier list for the per-account ledger.
 * `proportional` returns one tier with all accounts (balance-proportional
 * within); `taxEfficient` / `rothFirst` return four tiers.
 *
 *   taxEfficient: tier0 = POST_TAX-non-Roth, tier1 = PRE_TAX + MIXED,
 *                 tier2 = Roth.
 *   rothFirst:    tier0 = Roth, tier1 = PRE_TAX + MIXED,
 *                 tier2 = POST_TAX-non-Roth.
 *
 * HSA (`'HSA'` treatment) is HELD OUT of every ordinary tier: it is not
 * drained as ordinary retirement funds. The HSA medical-reserve routing
 * funds it in two dedicated passes orchestrated by the year loop — a
 * medical-qualified pass (tax-free, against modeled `isMedical` demand) BEFORE
 * the ordinary drain, and an emergency-reserve pass AFTER all non-HSA accounts
 * are exhausted. So `buildStrategyTiers` returns only the three non-HSA tiers;
 * HSA has no ordinary-last tier of its own; the two-pass routing covers it.
 * The pre-65 nonqualified
 * 20% penalty is enforced at the withdrawal level by account TYPE on the
 * emergency portion only, not by tier placement.
 *
 * Callers MUST NOT pass `customOrder` — guard at the call site with a
 * `strategyKind !== 'customOrder'` check and use the custom-tier path.
 * @throws {Error} if `kind === 'customOrder'` (fail-fast; indicates a
 *   caller logic error — routing must be resolved before this call).
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
    // HSA is held OUT of the proportional pool too — it is never drained as
    // ordinary funds. The year loop runs the medical + emergency two-pass for it.
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
    // HSA / `'HSA'` treatment is HELD OUT of the ordinary tiers — the
    // year loop runs the medical + emergency two-pass routing for it. It is
    // never drained as ordinary retirement funds, so it never appears here.
    if (st.taxTreatment === 'HSA') continue;
    if (kind === 'taxEfficient') {
      if (!isRoth && st.taxTreatment === 'POST_TAX') tier0.push(a);
      else if (st.taxTreatment === 'PRE_TAX' || st.taxTreatment === 'MIXED') tier1.push(a);
      else tier2.push(a); // Roth
    } else {
      // rothFirst
      if (isRoth) tier0.push(a);
      else if (st.taxTreatment === 'PRE_TAX' || st.taxTreatment === 'MIXED') tier1.push(a);
      else tier2.push(a); // POST_TAX non-Roth
    }
  }
  return [tier0, tier1, tier2];
}

/**
 * Distribute `target` dollars across accounts in strategy-priority
 * order. Top tier consumed before next tier; within a tier, balance-
 * proportional split.
 *
 * MIXED accounts: drain proportionally from both pre/post buckets.
 * Returns the total drawn (may be less than `target` under depletion).
 *
 * Writes per-account pre/post withdrawn into the supplied
 * accumulators so the tax post-pass can route MIXED dollars correctly.
 *
 * The optional `tiers` argument lets a caller that already built the tier
 * layout once per run (`runYearByYearStrategyAware`'s `prebuiltTiers`) reuse
 * it instead of rebuilding every call; existing callers that omit it are
 * unchanged (tiers still built here, same as before).
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
    // The tier's drawable pool counts only each
    // account's balance ABOVE its floor, so a floored account contributes
    // `max(0, pre+post − floor)` and the strategy routes the shortfall to the
    // next tier exactly as if the account were depleted.
    let tierBalance = 0;
    for (const a of tier) tierBalance += discretionaryDrawable(state[a]);
    if (tierBalance <= 0) continue;
    const drawn = Math.min(remaining, tierBalance);
    for (const a of tier) {
      const acctPool = discretionaryDrawable(state[a]);
      if (acctPool <= 0) continue;
      let share = drawn * (acctPool / tierBalance);
      if (share > acctPool) share = acctPool;
      // Drain pre + post proportional to the CURRENT bucket ratio (MIXED-safe).
      // The pre+post denominator is the real balance (the floor caps the total
      // share, not the bucket ratio).
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
 * Distribute `target` dollars across accounts in caller-supplied
 * tier order (custom-order path). Tiers are pre-built index arrays
 * (state indices) from the caller's ID→index map. Excluded accounts
 * (index in `excludedIndices`) are skipped entirely.
 *
 * Within-tier ordering: when `sequentialWithinTier` is true (the
 * `customOrder` strategy), accounts drain in the order the tier array lists
 * them — fully draining account `tier[0]` before touching `tier[1]`, and so
 * on. The user explicitly ordered the accounts inside the tier, so the engine
 * honors that order rather than splitting balance-proportional. When the flag
 * is false (the default — every NON-customOrder caller: `taxEfficient`,
 * `rothFirst`, `proportional`, and the preset-strategy tiers routed through
 * the cap distributor) the within-tier split stays balance-proportional,
 * byte-for-byte unchanged.
 *
 * Returns the total drawn (may be less than `target` under depletion).
 * Writes per-account pre/post withdrawn into the supplied accumulators
 * (the per-account accumulator invariant is maintained).
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
  /** Drain accounts within each tier in the listed order (customOrder)
   *  instead of balance-proportional. Defaults to false (proportional) so
   *  non-customOrder callers stay byte-identical. */
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
    // The drawable pool counts only balance above floor.
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
 * Drain `target` dollars from one tier in the listed account order:
 * fully empty `tier[0]` (both pre + post sub-buckets) before touching
 * `tier[1]`, and so on. Within a single account the pre/post split stays
 * balance-proportional (the per-account MIXED handling is unchanged — only
 * the across-account ordering becomes sequential). Excluded accounts are
 * skipped. Returns dollars drawn (≤ target). Writes the per-account
 * pre/post accumulators.
 */
/**
 * Drain `target` dollars from ONE sub-bucket (`pre` or `post`) of a tier in the
 * listed account order: fully empty `tier[0]`'s chosen bucket before
 * touching `tier[1]`, and so on. Excluded accounts and accounts with a
 * zero/negative chosen bucket are skipped. Writes the matching per-account
 * accumulator (`bucketWithdrawnByAcct`). Returns dollars drawn (≤ target).
 * Shared by the MAGI-cap path's post-only (phase 1) and pre-only (phase 2)
 * single-bucket sequential drains.
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
    // Cap the single-bucket draw at the account's
    // floor-respecting drawable. The drawable counts the COMBINED balance above
    // floor, so the per-bucket draw is min(this bucket, combined drawable).
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
    // The per-account drawable counts only the
    // balance above floor; the pre/post split stays balance-proportional.
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
