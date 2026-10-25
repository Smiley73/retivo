/**
 * MAGI-cap-aware tier distribution and the trial year-draw classifier for the strategy-aware engine.
 * See `docs/math-withdrawals.md` ("The MAGI cap").
 */
import { isRothDesignatedPostBucket } from './balance-calc';
import type { AccountType } from '../db/types';
import {
  applyFloorAwareShare,
  buildStrategyTiers,
  discretionaryDrawable,
  distributeWithdrawalByCustomTiers,
  distributeWithdrawalByStrategy,
  drainTierSequential,
  drainTierSequentialOneBucket,
  isPreTaxTargetedDeposit,
  isRmdOverflowCashAccountId,
  reserveDrawable,
  type AccountRunState,
  type MagiCapRuntimeConfig,
  type StrategyAwareKind,
} from './drawdown-engine-per-account-strategy-helpers';
import {
  consumeOverflowCashFirst,
  drawFloorReserve,
  drawHsaEmergency,
  drawHsaMedical,
} from './drawdown-engine-per-account-qcd-hsa';
import type { TaxCashflowYearClassification } from './drawdown-engine-types';

function distributeOneTier(args: {
  state: AccountRunState[];
  tier: ReadonlyArray<number>;
  excludedIndices: ReadonlySet<number>;
  target: number;
  yearWithdrawnByAcct: number[];
  yearPreWithdrawnByAcct: number[];
  yearPostWithdrawnByAcct: number[];
  sequentialWithinTier?: boolean;
}): number {
  const { state, tier, excludedIndices, target,
    yearWithdrawnByAcct, yearPreWithdrawnByAcct, yearPostWithdrawnByAcct,
    sequentialWithinTier = false } = args;
  if (sequentialWithinTier) {
    return drainTierSequential({
      state, tier, excludedIndices, target,
      yearWithdrawnByAcct, yearPreWithdrawnByAcct, yearPostWithdrawnByAcct,
    });
  }
  // Only balance above the floor counts, in both the trial classifier and the committing draw, so the
  // MAGI/tax gross-up sees the floor-constrained split.
  let tierBalance = 0;
  for (const a of tier) {
    if (!excludedIndices.has(a)) tierBalance += discretionaryDrawable(state[a]);
  }
  if (tierBalance <= 0) return 0;
  const drawn = Math.min(target, tierBalance);
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
  }
  return drawn;
}

/**
 * Mutable draw context shared by the per-tier helpers, so each can update `remaining` and
 * `localCapRemaining`.
 */
interface TierCapCtx {
  state: AccountRunState[];
  tiers: ReadonlyArray<ReadonlyArray<number>>;
  excludedIndices: ReadonlySet<number>;
  yearWithdrawnByAcct: number[];
  yearPreWithdrawnByAcct: number[];
  yearPostWithdrawnByAcct: number[];
  magiCapConfig: MagiCapRuntimeConfig;
  onCapBreachDollars: (d: number) => void;
  onTierOverrideDollars: (d: number) => void;
  onPreTaxDrawn: (d: number) => void;
  /** Dollars still needed this call; decremented by each tier helper. */
  remaining: number;
  /** Pre-tax budget left for the year; decremented as pre-tax is drawn. */
  localCapRemaining: number;
  /**
   * Drain accounts within each tier in listed order (customOrder); the over-cap dollar still diverts to a
   * later cap-safe source at the breach point. False for preset strategies.
   * @183 delete
   */
  sequentialWithinTier: boolean;
}

function handleNonPreTaxTier(
  ctx: TierCapCtx,
  tier: ReadonlyArray<number>,
): number {
  const drawn = distributeOneTier({
    state: ctx.state, tier, excludedIndices: ctx.excludedIndices,
    target: ctx.remaining,
    yearWithdrawnByAcct: ctx.yearWithdrawnByAcct,
    yearPreWithdrawnByAcct: ctx.yearPreWithdrawnByAcct,
    yearPostWithdrawnByAcct: ctx.yearPostWithdrawnByAcct,
    sequentialWithinTier: ctx.sequentialWithinTier,
  });
  ctx.remaining -= drawn;
  return drawn;
}

function routeViaCtx(
  ctx: TierCapCtx,
  tier: ReadonlyArray<number>,
  tierIdx: number,
): number {
  const routed = routeOverflowToTaxableOrBreach({
    state: ctx.state, tiers: ctx.tiers, tierIdx, tier,
    excludedIndices: ctx.excludedIndices, need: ctx.remaining,
    yearWithdrawnByAcct: ctx.yearWithdrawnByAcct,
    yearPreWithdrawnByAcct: ctx.yearPreWithdrawnByAcct,
    yearPostWithdrawnByAcct: ctx.yearPostWithdrawnByAcct,
    magiCapConfig: ctx.magiCapConfig,
    onTierOverrideDollars: ctx.onTierOverrideDollars,
    onPreTaxDrawn: ctx.onPreTaxDrawn,
    onCapBreachDollars: ctx.onCapBreachDollars,
    sequentialWithinTier: ctx.sequentialWithinTier,
  });
  ctx.remaining -= routed;
  return routed;
}

function drawPreTaxPhase2(
  ctx: TierCapCtx,
  tier: ReadonlyArray<number>,
  tierIdx: number,
): number {
  if (ctx.localCapRemaining <= 0) {
    return routeViaCtx(ctx, tier, tierIdx);
  }
  const allowedTarget = Math.min(ctx.remaining, ctx.localCapRemaining);
  const preDrawn = drawPreOnlyFromTier({
    state: ctx.state, tier, excludedIndices: ctx.excludedIndices,
    target: allowedTarget,
    yearWithdrawnByAcct: ctx.yearWithdrawnByAcct,
    yearPreWithdrawnByAcct: ctx.yearPreWithdrawnByAcct,
    sequentialWithinTier: ctx.sequentialWithinTier,
  });
  ctx.remaining -= preDrawn;
  ctx.localCapRemaining = Math.max(0, ctx.localCapRemaining - preDrawn);
  if (preDrawn > 0) ctx.onPreTaxDrawn(preDrawn);
  const overflow = (ctx.remaining > 0 && preDrawn === allowedTarget)
    ? routeViaCtx(ctx, tier, tierIdx)
    : 0;
  return preDrawn + overflow;
}

function handlePreTaxTierWithCap(
  ctx: TierCapCtx,
  tier: ReadonlyArray<number>,
  tierIdx: number,
): number {
  const postDrawn = drawPostOnlyFromTier({
    state: ctx.state, tier, excludedIndices: ctx.excludedIndices,
    target: ctx.remaining,
    yearWithdrawnByAcct: ctx.yearWithdrawnByAcct,
    yearPostWithdrawnByAcct: ctx.yearPostWithdrawnByAcct,
    sequentialWithinTier: ctx.sequentialWithinTier,
  });
  ctx.remaining -= postDrawn;
  if (ctx.remaining <= 0) return postDrawn;
  return postDrawn + drawPreTaxPhase2(ctx, tier, tierIdx);
}

/**
 * Monthly withdrawal with MAGI-cap enforcement, for custom-order tiers and preset strategies when a cap is
 * active. A purely pre-tax tier draws up to `localCapRemaining`; the rest diverts to the first cap-safe
 * account in a later tier (emits `onTierOverrideDollars`), else a breach is recorded (`onCapBreachDollars`)
 * and pre-tax is drawn anyway.
 */
export function distributeWithdrawalByCustomTiersWithCap(args: {
  state: AccountRunState[];
  tiers: ReadonlyArray<ReadonlyArray<number>>;
  excludedIndices: ReadonlySet<number>;
  target: number;
  yearWithdrawnByAcct: number[];
  yearPreWithdrawnByAcct: number[];
  yearPostWithdrawnByAcct: number[];
  /** Remaining pre-tax cap dollars for the year; null means the cap is not active. */
  capRemainingDollars: number | null;
  magiCapConfig?: MagiCapRuntimeConfig;
  onCapBreachDollars: (d: number) => void;
  onTierOverrideDollars: (d: number) => void;
  onPreTaxDrawn: (d: number) => void;
  /**
   * Drain accounts within each tier in listed order (customOrder); default false is balance-proportional.
   */
  sequentialWithinTier?: boolean;
}): number {
  const { state, tiers, excludedIndices, target,
    yearWithdrawnByAcct, yearPreWithdrawnByAcct, yearPostWithdrawnByAcct,
    capRemainingDollars, magiCapConfig,
    onCapBreachDollars, onTierOverrideDollars, onPreTaxDrawn,
    sequentialWithinTier = false } = args;

  if (capRemainingDollars === null || magiCapConfig === undefined) {
    return distributeWithdrawalByCustomTiers({
      state, tiers, excludedIndices, target,
      yearWithdrawnByAcct, yearPreWithdrawnByAcct, yearPostWithdrawnByAcct,
      sequentialWithinTier,
    });
  }

  // `localCapRemaining` is a copy, so each pre-tax tier in one call sees the updated budget.
  const ctx: TierCapCtx = {
    state, tiers, excludedIndices,
    yearWithdrawnByAcct, yearPreWithdrawnByAcct, yearPostWithdrawnByAcct,
    magiCapConfig, onCapBreachDollars, onTierOverrideDollars, onPreTaxDrawn,
    remaining: target,
    localCapRemaining: capRemainingDollars,
    sequentialWithinTier,
  };

  let totalDrawn = 0;
  for (let t = 0; t < tiers.length; t += 1) {
    if (ctx.remaining <= 0) break;
    const tier = tiers[t];
    // Pre-tax exposure means a non-excluded account with a non-zero pre-tax sub-bucket, which covers MIXED as
    // well as pure PRE_TAX.
    const tierHasPreTaxExposure = tier.some(
      (a) => !excludedIndices.has(a) && state[a].pre > 0,
    );
    totalDrawn += tierHasPreTaxExposure
      ? handlePreTaxTierWithCap(ctx, tier, t)
      : handleNonPreTaxTier(ctx, tier);
  }
  return totalDrawn;
}

function drawPostOnlyFromTier(args: {
  state: AccountRunState[];
  tier: ReadonlyArray<number>;
  excludedIndices: ReadonlySet<number>;
  target: number;
  yearWithdrawnByAcct: number[];
  yearPostWithdrawnByAcct: number[];
  /** Drain post sub-buckets in listed order instead of proportionally. */
  sequentialWithinTier?: boolean;
}): number {
  const { state, tier, excludedIndices, target,
    yearWithdrawnByAcct, yearPostWithdrawnByAcct, sequentialWithinTier = false } = args;
  if (sequentialWithinTier) {
    return drainTierSequentialOneBucket(
      { state, tier, excludedIndices, target,
        yearWithdrawnByAcct, bucketWithdrawnByAcct: yearPostWithdrawnByAcct },
      'post',
    );
  }
  // Capped at each account's above-floor drawable: for a pure post-tax floored account that is
  // `max(0, post - floor)`.
  const postDrawable = (a: number): number =>
    Math.min(state[a].post, discretionaryDrawable(state[a]));
  let postPool = 0;
  for (const a of tier) {
    if (!excludedIndices.has(a)) postPool += postDrawable(a);
  }
  if (postPool <= 0) return 0;
  const drawn = Math.min(target, postPool);
  for (const a of tier) {
    if (excludedIndices.has(a)) continue;
    const avail = postDrawable(a);
    if (avail <= 0) continue;
    const share = drawn * (avail / postPool);
    state[a].post = Math.max(0, state[a].post - share);
    yearWithdrawnByAcct[a] += share;
    yearPostWithdrawnByAcct[a] += share;
  }
  return drawn;
}

function drawPreOnlyFromTier(args: {
  state: AccountRunState[];
  tier: ReadonlyArray<number>;
  excludedIndices: ReadonlySet<number>;
  target: number;
  yearWithdrawnByAcct: number[];
  yearPreWithdrawnByAcct: number[];
  /** Drain pre sub-buckets in listed order, up to `target` (the cap-allowed amount). */
  sequentialWithinTier?: boolean;
}): number {
  const { state, tier, excludedIndices, target,
    yearWithdrawnByAcct, yearPreWithdrawnByAcct, sequentialWithinTier = false } = args;
  if (sequentialWithinTier) {
    return drainTierSequentialOneBucket(
      { state, tier, excludedIndices, target,
        yearWithdrawnByAcct, bucketWithdrawnByAcct: yearPreWithdrawnByAcct },
      'pre',
    );
  }
  let prePool = 0;
  for (const a of tier) {
    if (!excludedIndices.has(a)) prePool += state[a].pre;
  }
  if (prePool <= 0) return 0;
  const drawn = Math.min(target, prePool);
  for (const a of tier) {
    if (excludedIndices.has(a) || state[a].pre <= 0) continue;
    const share = drawn * (state[a].pre / prePool);
    state[a].pre = Math.max(0, state[a].pre - share);
    yearWithdrawnByAcct[a] += share;
    yearPreWithdrawnByAcct[a] += share;
  }
  return drawn;
}

// Routes `need` to the first cap-safe account in a later tier (POST_TAX, Roth or MIXED post), spending none
// of the pre-tax cap budget, and otherwise breaches. A POST_TAX or MIXED-post draw still realizes LTCG into
// MAGI, so `drawCapSafeTaxFunding` restricts to MAGI-neutral buckets.
function drawLaterCapSafe(args: {
  state: AccountRunState[];
  tiers: ReadonlyArray<ReadonlyArray<number>>;
  tierIdx: number;
  need: number;
  yearWithdrawnByAcct: number[];
  yearPostWithdrawnByAcct: number[];
  magiCapConfig: MagiCapRuntimeConfig;
  onTierOverrideDollars: (d: number) => void;
}): number {
  const { state, tiers, tierIdx, yearWithdrawnByAcct,
    yearPostWithdrawnByAcct, magiCapConfig, onTierOverrideDollars } = args;
  let need = args.need;
  let satisfied = 0;
  // Draw only from `post`: a MIXED account's pre-tax sub-bucket must not be drawn beyond the cap. `visited`
  // also guards against a resolver that re-returns an exhausted account.
  const visitedAcctIndices = new Set<number>();
  while (need > 0) {
    const idx = magiCapConfig.findLaterTaxableIndex(tiers, tierIdx, state, visitedAcctIndices);
    if (idx === undefined || visitedAcctIndices.has(idx)) break;
    visitedAcctIndices.add(idx);
    // A floored cap-safe account diverts only its above-floor balance, as `min(post, discretionaryDrawable)`
    // so a MIXED account's pre sub-bucket stays untouched.
    const aboveFloorPost = Math.min(state[idx].post, discretionaryDrawable(state[idx]));
    // A later-tier POST_TAX floor reserve also diverts its below-floor balance, so it drains as cap-safe
    // before an avoidable pre-tax breach is recorded. The fallback is POST_TAX-only: HSA below-floor dollars
    // are nonqualified ordinary income and are never cap-safe.
    const postDrawable = state[idx].taxTreatment === 'POST_TAX'
      ? Math.max(aboveFloorPost, Math.min(state[idx].post, reserveDrawable(state[idx])))
      : aboveFloorPost;
    const divert = Math.min(need, postDrawable);
    if (divert > 0) {
      state[idx].post = Math.max(0, state[idx].post - divert);
      yearWithdrawnByAcct[idx] += divert;
      yearPostWithdrawnByAcct[idx] += divert;
      satisfied += divert;
      need -= divert;
      onTierOverrideDollars(divert);
    }
  }
  return satisfied;
}

// Routes `need` to a later cap-safe account via `drawLaterCapSafe`; any residual is drawn from the pre-tax
// tier and a breach is emitted. Returns the dollars satisfied.
function routeOverflowToTaxableOrBreach(args: {
  state: AccountRunState[];
  tiers: ReadonlyArray<ReadonlyArray<number>>;
  tierIdx: number;
  tier: ReadonlyArray<number>;
  excludedIndices: ReadonlySet<number>;
  need: number;
  yearWithdrawnByAcct: number[];
  yearPreWithdrawnByAcct: number[];
  yearPostWithdrawnByAcct: number[];
  magiCapConfig: MagiCapRuntimeConfig;
  onTierOverrideDollars: (d: number) => void;
  onPreTaxDrawn: (d: number) => void;
  onCapBreachDollars: (d: number) => void;
  sequentialWithinTier?: boolean;
}): number {
  const {
    state, tiers, tierIdx, tier, excludedIndices, yearWithdrawnByAcct,
    yearPreWithdrawnByAcct, yearPostWithdrawnByAcct,
    magiCapConfig, onTierOverrideDollars, onPreTaxDrawn, onCapBreachDollars,
    sequentialWithinTier = false,
  } = args;
  const fromCapSafe = drawLaterCapSafe({
    state, tiers, tierIdx, need: args.need,
    yearWithdrawnByAcct, yearPostWithdrawnByAcct,
    magiCapConfig, onTierOverrideDollars,
  });
  const residual = args.need - fromCapSafe;
  if (residual <= 0) return fromCapSafe;
  // Cap-safe accounts exhausted or none found: breach and draw the residual pre-tax.
  const breachDrawn = distributeOneTier({
    state, tier, excludedIndices, target: residual,
    yearWithdrawnByAcct, yearPreWithdrawnByAcct, yearPostWithdrawnByAcct,
    sequentialWithinTier,
  });
  onPreTaxDrawn(breachDrawn);
  onCapBreachDollars(breachDrawn);
  return fromCapSafe + breachDrawn;
}

/** Sums the year-window net need (expense minus income) over 12 months. */
export function sumYearWindow(
  expense: Float64Array,
  income: Float64Array,
  y: number,
): number {
  let need = 0;
  for (let m = 0; m < 12; m += 1) {
    const i = y * 12 + m;
    need += Math.max(0, expense[i] - income[i]);
  }
  return need;
}

/** Applies per-account targeted and household-proportional deposits for one month. */
export function applyMonthlyDeposits(args: {
  state: AccountRunState[];
  stepIdx: number;
  householdDepositAmount: number;
  yearDepositByAcct: number[];
}): number {
  const { state, stepIdx, householdDepositAmount, yearDepositByAcct } = args;
  // The synthetic RMD-overflow cash carrier is excluded from the household pro-rata pool: only RMD surplus
  // may credit it.
  let poolBefore = 0;
  let realAcctCount = 0;
  for (const st of state) {
    if (isRmdOverflowCashAccountId(st.id)) continue;
    poolBefore += st.pre + st.post;
    realAcctCount += 1;
  }
  let aggDeposit = 0;
  for (let a = 0; a < state.length; a += 1) {
    const st = state[a];
    const isCarrier = isRmdOverflowCashAccountId(st.id);
    const targeted = st.deposits[stepIdx] ?? 0;
    // The post-primary designated-Roth slice always credits `post`, so a MIXED account's Roth slice stays out
    // of the RMD floor (§325).
    const targetedPost = isCarrier ? 0 : st.depositsPost[stepIdx] ?? 0;
    const householdShare = isCarrier
      ? 0
      : poolBefore > 0 && householdDepositAmount > 0
        ? householdDepositAmount * ((st.pre + st.post) / poolBefore)
        : householdDepositAmount / Math.max(1, realAcctCount);
    // A targeted deposit routes by destination treatment (PRE_TAX/MIXED to `pre`, else `post`); the
    // household-share spread always goes to `post`.
    const targetedToPre = !isCarrier && isPreTaxTargetedDeposit(st);
    if (targetedToPre) {
      st.pre += targeted;
    } else {
      st.post += targeted;
    }
    st.post += targetedPost + householdShare;
    const dep = targeted + targetedPost + householdShare;
    yearDepositByAcct[a] += dep;
    aggDeposit += dep;
  }
  return aggDeposit;
}

/**
 * Applies one month of compound growth to all accounts and returns the aggregate growth. With `stepIdx`, an
 * account that carries `returnPctByMonth` (Monte Carlo) grows by `1 + returnPctByMonth[stepIdx] / 100`;
 * otherwise by the scalar monthly rate.
 */
export function applyMonthlyGrowth(state: AccountRunState[], stepIdx?: number): number {
  let agg = 0;
  for (const st of state) {
    const factor =
      st.returnPctByMonth !== undefined && stepIdx !== undefined
        ? 1 + st.returnPctByMonth[stepIdx] / 100
        : 1 + st.monthlyRate / 100;
    const preBefore = st.pre;
    const postBefore = st.post;
    st.pre = preBefore * factor;
    st.post = postBefore * factor;
    agg += st.pre - preBefore + (st.post - postBefore);
  }
  return agg;
}

// POST_TAX cash-like account types (return-of-principal, $0 taxable, $0 MAGI); mirrors
// `CASH_LIKE_ACCOUNT_TYPES` in the tax helpers.
const CASH_LIKE_TYPES: ReadonlySet<string> = new Set([
  'SAVINGS',
  'MONEY_MARKET',
  'CD',
  'HSA',
]);

/**
 * True when a draw from the account's `post` sub-bucket adds $0 to MAGI: Roth, Roth-designated MIXED post, or
 * cash-like return-of-principal. A brokerage, other POST_TAX or MIXED-post draw is not, since its gain is
 * LTCG feeding MAGI.
 */
export function isMagiNeutralPostBucket(st: AccountRunState): boolean {
  if (st.taxTreatment === 'HSA') return true;
  if (st.accountType.startsWith('RETIREMENT_ROTH_')) return true;
  if (isRothDesignatedPostBucket(st.taxTreatment, st.accountType as AccountType) && st.taxTreatment === 'MIXED') return true;
  return CASH_LIKE_TYPES.has(st.accountType);
}

// `rothInherited` and `rothDesignated` are disjoint subsets of `roth`, not extra buckets (see
// `classifyAccountDraw`).
interface DrawBuckets {
  preTax: number;
  postTaxNonRoth: number;
  postTaxCashLike: number;
  roth: number;
  rothInherited: number;
  rothDesignated: number;
  // Inherited designated-Roth dollars: a third disjoint subset of `roth`, routed to the solver's inherited
  // slice (death is a qualifying event, §72(t)(2)(A)(ii)), never the §408A carrier.
  rothInheritedDesignated: number;
  // Per-account attribution of the stateful Roth slices by ledger account id, so the funding solver charges
  // each owner's basis and lots with that owner's own dollars.
  rothIraByAccountId: Map<string, number>;
  rothDesignatedByAccountId: Map<string, number>;
  rothInheritedDesignatedByAccountId: Map<string, number>;
}

function classifyAccountDraw(
  st: AccountRunState,
  drawn: number,
  cls: DrawBuckets,
): void {
  if (drawn <= 0) return;
  // Each dollar is charged to the owner it left, never a housemate picked by ledger order.
  const attribute = (map: Map<string, number>): void => {
    map.set(st.id, (map.get(st.id) ?? 0) + drawn);
  };
  if (st.taxTreatment === 'PRE_TAX') {
    cls.preTax += drawn;
    return;
  }
  if (st.taxTreatment === 'HSA') {
    // Qualified HSA withdrawals add $0 to MAGI and classify as cash-like; the pre-65 nonqualified income and
    // 20% additional tax are layered on by account type downstream.
    cls.postTaxCashLike += drawn;
    return;
  }
  if (st.accountType.startsWith('RETIREMENT_ROTH_')) {
    cls.roth += drawn;
    // An inherited Roth IRA's dollars are wholesale tax-free and hold no §408A basis, so they stay in `roth`
    // and are recorded as a subset the solver subtracts before touching the carrier. Inherited
    // designated-Roth plans take the third branch (§402A death-event treatment).
    if (st.inheritedAccount === true && st.accountType === 'RETIREMENT_ROTH_IRA') {
      cls.rothInherited += drawn;
    } else if (st.accountType !== 'RETIREMENT_ROTH_IRA' && st.inheritedAccount !== true) {
      // Non-inherited designated-Roth dollars: the §402A slice, charged against the pooled designated state.
      cls.rothDesignated += drawn;
      attribute(cls.rothDesignatedByAccountId);
    } else if (st.accountType !== 'RETIREMENT_ROTH_IRA') {
      // Inherited designated-Roth dollars carry no recapture-bearing pooled state (§72(t)(2)(A)(ii)), and the
      // §408A carrier would score them as earnings excess and charge a 10% the statute waives; they run the
      // solver's inherited slice.
      cls.rothInheritedDesignated += drawn;
      attribute(cls.rothInheritedDesignatedByAccountId);
    } else {
      // Non-inherited Roth IRA: the §408A remainder slice.
      attribute(cls.rothIraByAccountId);
    }
    return;
  }
  // MIXED Roth-designated (401k/403b/457b/TSP): the post sub-bucket routes to `roth` and the matching
  // designated subset; the pre sub-bucket is ordinary income, handled by the PRE_TAX branch.
  if (isRothDesignatedPostBucket(st.taxTreatment, st.accountType as AccountType) && st.taxTreatment === 'MIXED') {
    cls.roth += drawn;
    if (st.inheritedAccount !== true) {
      cls.rothDesignated += drawn;
      attribute(cls.rothDesignatedByAccountId);
    } else {
      cls.rothInheritedDesignated += drawn;
      attribute(cls.rothInheritedDesignatedByAccountId);
    }
    return;
  }
  // POST_TAX non-Roth and MIXED OTHER post split by cash-like versus brokerage; the proportional pre/post
  // split is approximate, which the within-year solve tolerates.
  if (CASH_LIKE_TYPES.has(st.accountType)) cls.postTaxCashLike += drawn;
  else cls.postTaxNonRoth += drawn;
}

interface TrialAccumulators {
  readonly yearWithdrawnByAcct: number[];
  readonly yearPreWithdrawnByAcct: number[];
  readonly yearPostWithdrawnByAcct: number[];
  /**
   * Per-account HSA medical-qualified dollars drawn this trial year, so the trial carries the same
   * medical/emergency split as the committing post-pass.
   */
  readonly yearMedicalQualifiedByAcct: number[];
}

// Classifies the committed per-account pre/post split into the tax-bucket totals the conversion solve uses as
// its MAGI-at-conv=0 basis.
export function classifyCommittedYearDraw(
  state: ReadonlyArray<AccountRunState>,
  yearPreWithdrawnByAcct: ReadonlyArray<number>,
  yearPostWithdrawnByAcct: ReadonlyArray<number>,
): TaxCashflowYearClassification {
  const cls: DrawBuckets = {
    preTax: 0, postTaxNonRoth: 0, postTaxCashLike: 0, roth: 0, rothInherited: 0,
    rothDesignated: 0, rothInheritedDesignated: 0,
    rothIraByAccountId: new Map(), rothDesignatedByAccountId: new Map(),
    rothInheritedDesignatedByAccountId: new Map(),
  };
  for (let a = 0; a < state.length; a += 1) {
    if (yearPreWithdrawnByAcct[a] > 0) cls.preTax += yearPreWithdrawnByAcct[a];
    classifyAccountDraw(state[a], yearPostWithdrawnByAcct[a] ?? 0, cls);
  }
  // The Roth subsets are not summed: they are already inside `roth`.
  const totalDrawn = cls.preTax + cls.postTaxNonRoth + cls.postTaxCashLike + cls.roth;
  return {
    preTaxDollars: cls.preTax,
    postTaxNonRothDollars: cls.postTaxNonRoth,
    postTaxCashLikeDollars: cls.postTaxCashLike,
    rothDollars: cls.roth,
    fundedDollars: totalDrawn,
    ...(cls.rothInherited > 0
      ? { rothInheritedTaxFreeDollars: cls.rothInherited }
      : {}),
    ...(cls.rothDesignated > 0 ? { rothDesignatedDollars: cls.rothDesignated } : {}),
    ...(cls.rothInheritedDesignated > 0
      ? { rothInheritedDesignatedDollars: cls.rothInheritedDesignated }
      : {}),
    ...rothAttributionFields(cls),
  };
}

// Each map is emitted only when it holds dollars.
function rothAttributionFields(cls: DrawBuckets): Pick<
  TaxCashflowYearClassification,
  | 'rothIraDollarsByAccountId'
  | 'rothDesignatedDollarsByAccountId'
  | 'rothInheritedDesignatedDollarsByAccountId'
> {
  return {
    ...(cls.rothIraByAccountId.size > 0
      ? { rothIraDollarsByAccountId: cls.rothIraByAccountId }
      : {}),
    ...(cls.rothDesignatedByAccountId.size > 0
      ? { rothDesignatedDollarsByAccountId: cls.rothDesignatedByAccountId }
      : {}),
    ...(cls.rothInheritedDesignatedByAccountId.size > 0
      ? { rothInheritedDesignatedDollarsByAccountId: cls.rothInheritedDesignatedByAccountId }
      : {}),
  };
}

// Distributes one month's `target` through the same distributor as the committing path, with the cap-aware
// one when a cap is active; breach and override callbacks are no-ops because the committing path owns the
// diagnostics.
function distributeTrialMonthTarget(args: {
  readonly trial: AccountRunState[];
  readonly strategyKind: StrategyAwareKind;
  readonly tiers: ReadonlyArray<ReadonlyArray<number>>;
  readonly excludedIndices?: ReadonlySet<number>;
  readonly magiCapConfig?: MagiCapRuntimeConfig;
  readonly capRemaining: number | null;
  readonly target: number;
  readonly acc: TrialAccumulators;
  readonly onPreTaxDrawn: (d: number) => void;
}): number {
  const { trial, strategyKind, tiers, excludedIndices,
    magiCapConfig, capRemaining, target, acc, onPreTaxDrawn } = args;
  if (target <= 0) return 0;

  // Mirror the committing within-tier sequential drain so the classification matches the real year.
  const sequentialWithinTier = strategyKind === 'customOrder';
  if (capRemaining !== null && magiCapConfig !== undefined) {
    return distributeWithdrawalByCustomTiersWithCap({
      state: trial, tiers, excludedIndices: excludedIndices ?? new Set(),
      target,
      yearWithdrawnByAcct: acc.yearWithdrawnByAcct,
      yearPreWithdrawnByAcct: acc.yearPreWithdrawnByAcct,
      yearPostWithdrawnByAcct: acc.yearPostWithdrawnByAcct,
      capRemainingDollars: capRemaining,
      magiCapConfig,
      onCapBreachDollars: () => {},
      onTierOverrideDollars: () => {},
      onPreTaxDrawn,
      sequentialWithinTier,
    });
  }
  if (strategyKind === 'customOrder') {
    return distributeWithdrawalByCustomTiers({
      state: trial, tiers, excludedIndices: excludedIndices ?? new Set(),
      target,
      yearWithdrawnByAcct: acc.yearWithdrawnByAcct,
      yearPreWithdrawnByAcct: acc.yearPreWithdrawnByAcct,
      yearPostWithdrawnByAcct: acc.yearPostWithdrawnByAcct,
      sequentialWithinTier,
    });
  }
  return distributeWithdrawalByStrategy({
    state: trial, strategyKind, target,
    yearWithdrawnByAcct: acc.yearWithdrawnByAcct,
    yearPreWithdrawnByAcct: acc.yearPreWithdrawnByAcct,
    yearPostWithdrawnByAcct: acc.yearPostWithdrawnByAcct,
  });
}

/**
 * The within-year deposit, income and expense context the trial simulation needs to mirror the committing
 * month sequence.
 */
export interface TrialWithinYearInputs {
  /** Year index (0-based) into the per-month series. */
  readonly yearIndex: number;
  /** Per-month gross expense series (full run length). */
  readonly expense: Float64Array;
  /** Per-month non-portfolio income series (full run length). */
  readonly income: Float64Array;
  /** Per-month household deposit series (full run length). */
  readonly householdDeposit: Float64Array;
  /** Sum of ordinary monthly net need over the year (`sumYearWindow`). */
  readonly yearNetNeed: number;
  /**
   * HSA state indices, so the trial mirrors the two-pass HSA routing; empty or absent means no HSA routing.
   */
  readonly hsaIndices?: ReadonlyArray<number>;
  /** Per-month medical demand in dollars; absent means 0. */
  readonly medicalDemand?: Float64Array;
}

// Monthly discretionary target as in `runOneStrategyYear`: ordinary net need plus the tax add-on's monthly
// share, less the RMD credit's.
function trialMonthTarget(
  wy: TrialWithinYearInputs,
  monthIdx: number,
  taxAddedNeed: number,
  rmdForcedTotal: number,
): number {
  const { expense, income, yearNetNeed } = wy;
  const ordinaryMonthlyNeed = Math.max(0, expense[monthIdx] - income[monthIdx]);
  const taxMonthShare = yearNetNeed > 0 ? ordinaryMonthlyNeed / yearNetNeed : 1 / 12;
  const monthlyNetNeed = ordinaryMonthlyNeed + taxAddedNeed * taxMonthShare;
  const monthShareOfYearNeed = yearNetNeed > 0 ? ordinaryMonthlyNeed / yearNetNeed : 0;
  const monthRmdCredit = rmdForcedTotal * monthShareOfYearNeed;
  return Math.max(0, monthlyNetNeed - monthRmdCredit);
}

// Non-committing 12-month trial on `trial`, mirroring the committing month sequence (deposits, growth,
// strategy or cap withdrawal) and tracking the cap budget across months. Accumulates the pre/post split into
// `acc` and returns the discretionary dollars drawn.
// @965 delete
function runTrialYearSim(args: {
  readonly trial: AccountRunState[];
  readonly strategyKind: StrategyAwareKind;
  readonly customTiers?: ReadonlyArray<ReadonlyArray<number>>;
  readonly excludedIndices?: ReadonlySet<number>;
  readonly magiCapConfig?: MagiCapRuntimeConfig;
  readonly capRemainingDollars: number | null;
  readonly rmdForcedTotal: number;
  readonly taxAddedNeed: number;
  readonly within: TrialWithinYearInputs;
  readonly acc: TrialAccumulators;
}): number {
  const { trial, strategyKind, customTiers, excludedIndices, magiCapConfig,
    capRemainingDollars, rmdForcedTotal, taxAddedNeed, within, acc } = args;
  const tiers = strategyKind === 'customOrder' ? customTiers
    : buildStrategyTiers(trial, strategyKind);
  if (tiers === undefined) return 0;
  // Deposits are not withdrawals, so they go to a throwaway sink instead of `acc`.
  const depositSink = new Array<number>(trial.length).fill(0);
  let capRemaining = capRemainingDollars;
  let drawn = 0;
  for (let m = 0; m < 12; m += 1) {
    const i = within.yearIndex * 12 + m;
    applyMonthlyDeposits({
      state: trial, stepIdx: i,
      householdDepositAmount: within.householdDeposit[i] ?? 0,
      yearDepositByAcct: depositSink,
    });
    applyMonthlyGrowth(trial, i);
    const targetGross = trialMonthTarget(within, i, taxAddedNeed, rmdForcedTotal);
    // Spend-first parity: the consumed cash is tax-free return-of-principal, so it drains into the sink, not
    // `acc`, but still counts toward `drawn`.
    const cashSpent = consumeOverflowCashFirst({
      state: trial,
      target: targetGross,
      yearWithdrawnByAcct: depositSink,
      yearPostWithdrawnByAcct: depositSink,
    });
    drawn += cashSpent;
    // HSA medical pass parity: draws into the real `acc` (HSA counts as cash-like, $0 MAGI).
    const afterCashTarget = targetGross - cashSpent;
    const hsaIndices = within.hsaIndices ?? [];
    const medicalHsaSpent = hsaIndices.length > 0
      ? drawHsaMedical({
          state: trial, hsaIndices,
          target: afterCashTarget,
          demand: within.medicalDemand?.[i] ?? 0,
          yearWithdrawnByAcct: acc.yearWithdrawnByAcct,
          yearPostWithdrawnByAcct: acc.yearPostWithdrawnByAcct,
          medicalQualifiedByAcct: acc.yearMedicalQualifiedByAcct,
        })
      : 0;
    drawn += medicalHsaSpent;
    const routerTarget = afterCashTarget - medicalHsaSpent;
    const routerDrawn = distributeTrialMonthTarget({
      trial, strategyKind, tiers, excludedIndices, magiCapConfig,
      capRemaining, target: routerTarget, acc,
      onPreTaxDrawn: (d) => {
        if (capRemaining !== null) capRemaining = Math.max(0, capRemaining - d);
      },
    });
    drawn += routerDrawn;
    // HSA emergency parity: the router holds HSA out, so a residual means non-HSA is exhausted.
    const emergencyResidual = routerTarget - routerDrawn;
    const emergencyHsaSpent = (emergencyResidual > 1e-9 && hsaIndices.length > 0)
      ? drawHsaEmergency({
          state: trial, hsaIndices,
          target: emergencyResidual,
          yearWithdrawnByAcct: acc.yearWithdrawnByAcct,
          yearPostWithdrawnByAcct: acc.yearPostWithdrawnByAcct,
        })
      : 0;
    drawn += emergencyHsaSpent;
    // Last-resort floor-reserve parity: the same `drawFloorReserve`, tier layout and HSA indices as the
    // committing path.
    const reserveResidual = emergencyResidual - emergencyHsaSpent;
    if (reserveResidual > 1e-9) {
      drawn += drawFloorReserve({
        state: trial,
        tiers,
        hsaIndices,
        excludedIndices: excludedIndices ?? new Set(),
        target: reserveResidual,
        yearWithdrawnByAcct: acc.yearWithdrawnByAcct,
        yearPreWithdrawnByAcct: acc.yearPreWithdrawnByAcct,
        yearPostWithdrawnByAcct: acc.yearPostWithdrawnByAcct,
        sequentialWithinTier: strategyKind === 'customOrder',
      });
    }
  }
  return drawn;
}

/**
 * Trial classification of a year's withdrawal for the tax-cashflow solver: deep-copies `state` and runs a
 * 12-month simulation in the committing `runOneStrategyYear` order, returning the per-tax-bucket split and
 * the dollars the portfolio could supply.
 * Deposits and growth are mirrored so classification uses the committing draw's balances; with a MAGI cap the
 * cap-aware distributor is used. The real run state is never mutated.
 */
export function classifyTrialYearDraw(args: {
  readonly state: ReadonlyArray<AccountRunState>;
  readonly strategyKind: StrategyAwareKind;
  readonly customTiers?: ReadonlyArray<ReadonlyArray<number>>;
  readonly excludedIndices?: ReadonlySet<number>;
  /**
   * Total RMD-forced pre-tax across all accounts, credited toward the target; `state` is already post-RMD.
   */
  readonly rmdForcedTotal: number;
  /** Total year withdrawal target (ordinary + tax), in dollars. */
  readonly totalTargetDollars: number;
  /** Active MAGI-cap config. Undefined → no cap-aware routing. */
  readonly magiCapConfig?: MagiCapRuntimeConfig;
  /** Post-RMD pre-tax cap budget left for the year. Null → no cap. */
  readonly capRemainingDollars: number | null;
  /**
   * Within-year per-month deposit, income and expense context; when absent, the trial uses a single-shot
   * discretionary distribution with no deposits or growth.
   */
  readonly within?: TrialWithinYearInputs;
}): TaxCashflowYearClassification {
  const { state, strategyKind, customTiers, excludedIndices,
    rmdForcedTotal, totalTargetDollars,
    magiCapConfig, capRemainingDollars, within } = args;
  // `state` is already post-RMD (`applyRmdFloorPrePass` mutated it), so do not re-subtract
  // `rmdForcedPreTaxByAcct`: that would understate the pre-tax pool and gross tax against a too-low
  // classification.
  const trial: AccountRunState[] = state.map((s) => ({ ...s }));
  const cls: DrawBuckets = {
    preTax: rmdForcedTotal, postTaxNonRoth: 0, postTaxCashLike: 0, roth: 0, rothInherited: 0,
    rothDesignated: 0, rothInheritedDesignated: 0,
    rothIraByAccountId: new Map(), rothDesignatedByAccountId: new Map(),
    rothInheritedDesignatedByAccountId: new Map(),
  };
  const acc: TrialAccumulators = {
    yearWithdrawnByAcct: new Array<number>(trial.length).fill(0),
    yearPreWithdrawnByAcct: new Array<number>(trial.length).fill(0),
    yearPostWithdrawnByAcct: new Array<number>(trial.length).fill(0),
    yearMedicalQualifiedByAcct: new Array<number>(trial.length).fill(0),
  };
  const drawn = runTrialDraw({
    trial, strategyKind, customTiers, excludedIndices, magiCapConfig,
    capRemainingDollars, rmdForcedTotal, totalTargetDollars, within, acc,
  });
  let hsaMedicalQualifiedDollars = 0;
  // The exact per-account HSA total lets `buildSolverPenaltyAccountsForYear` size the §223(f)(4) emergency
  // basis instead of using the balance-share estimate.
  let hsaWithdrawalDollars = 0;
  for (let a = 0; a < trial.length; a += 1) {
    if (acc.yearPreWithdrawnByAcct[a] > 0) cls.preTax += acc.yearPreWithdrawnByAcct[a];
    classifyAccountDraw(trial[a], acc.yearPostWithdrawnByAcct[a], cls);
    hsaMedicalQualifiedDollars += acc.yearMedicalQualifiedByAcct[a];
    if (trial[a].taxTreatment === 'HSA') hsaWithdrawalDollars += acc.yearWithdrawnByAcct[a];
  }
  return {
    preTaxDollars: cls.preTax,
    postTaxNonRothDollars: cls.postTaxNonRoth,
    postTaxCashLikeDollars: cls.postTaxCashLike,
    rothDollars: cls.roth,
    fundedDollars: rmdForcedTotal + drawn,
    // The inherited Roth IRA subset of `rothDollars`, so the solver leaves the owner's §408A basis carrier
    // alone for it.
    ...(cls.rothInherited > 0
      ? { rothInheritedTaxFreeDollars: cls.rothInherited }
      : {}),
    // The designated-Roth subset, so the solver runs it through the pooled §402A pro-rata regime.
    ...(cls.rothDesignated > 0 ? { rothDesignatedDollars: cls.rothDesignated } : {}),
    // The inherited designated-Roth subset, for the solver's death-qualifying-event slice.
    ...(cls.rothInheritedDesignated > 0
      ? { rothInheritedDesignatedDollars: cls.rothInheritedDesignated }
      : {}),
    ...rothAttributionFields(cls),
    // Medical-qualified HSA dollars narrow the §223 nonqualified basis to the emergency residual, as in the
    // committing post-pass.
    ...(hsaMedicalQualifiedDollars > 0 ? { hsaMedicalQualifiedDollars } : {}),
    ...(hsaWithdrawalDollars > 0 ? { hsaWithdrawalDollars } : {}),
  };
}

/**
 * Dispatches the trial draw: the 12-month sim when the within-year context is supplied, else a single-shot
 * discretionary distribution. Mutates `acc` and returns the discretionary dollars drawn.
 */
function runTrialDraw(args: {
  readonly trial: AccountRunState[];
  readonly strategyKind: StrategyAwareKind;
  readonly customTiers?: ReadonlyArray<ReadonlyArray<number>>;
  readonly excludedIndices?: ReadonlySet<number>;
  readonly magiCapConfig?: MagiCapRuntimeConfig;
  readonly capRemainingDollars: number | null;
  readonly rmdForcedTotal: number;
  readonly totalTargetDollars: number;
  readonly within?: TrialWithinYearInputs;
  readonly acc: TrialAccumulators;
}): number {
  const { trial, strategyKind, customTiers, excludedIndices, magiCapConfig,
    capRemainingDollars, rmdForcedTotal, totalTargetDollars, within, acc } = args;
  if (within !== undefined) {
    // The tax add-on is the total target minus the ordinary year net need; it can be negative when the
    // premium credit lowers the draw.
    const taxAddedNeed = Math.max(-within.yearNetNeed, totalTargetDollars - within.yearNetNeed);
    return runTrialYearSim({
      trial, strategyKind, customTiers, excludedIndices, magiCapConfig,
      capRemainingDollars, rmdForcedTotal, taxAddedNeed, within, acc,
    });
  }
  return distributeTrialMonthTarget({
    trial, strategyKind,
    tiers: strategyKind === 'customOrder'
      ? (customTiers ?? [])
      : buildStrategyTiers(trial, strategyKind),
    excludedIndices, magiCapConfig, capRemaining: capRemainingDollars,
    target: Math.max(0, totalTargetDollars - rmdForcedTotal),
    acc, onPreTaxDrawn: () => {},
  });
}
