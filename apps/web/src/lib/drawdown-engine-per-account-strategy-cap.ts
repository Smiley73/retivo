/**
 * MAGI-cap-aware tier distribution extracted from
 * `drawdown-engine-per-account-strategy.ts` to keep each file near the
 * 800-line shape cap (CODING_STANDARDS shape limits).
 *
 * The MAGI-cap overlay is active for all named strategies; see
 * `docs/math-withdrawals.md` ("The MAGI cap").
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

// ---------------------------------------------------------------------------
// Single-tier distributor (shared by cap + non-cap paths)
// ---------------------------------------------------------------------------

/** Distribute `target` within a single tier; returns dollars drawn.
 *  When `sequentialWithinTier` is true, drain accounts in listed order
 *  (customOrder) via `drainTierSequential` instead of balance-proportional. */
export function distributeOneTier(args: {
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
  // The drawable pool counts only balance above the
  // floor. Applied in both the trial classifier and the committing draw (same
  // helpers), so the MAGI/tax gross-up sees the floor-constrained split.
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

// ---------------------------------------------------------------------------
// MAGI-cap-aware tier distribution
// ---------------------------------------------------------------------------

/**
 * Shared mutable draw context threaded through per-tier helpers so each
 * sub-function can update `remaining` and `localCapRemaining` without
 * returning multiple values via tuples.
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
  /** Within each tier drain accounts in the listed order (customOrder)
   *  rather than balance-proportional. The cap deviation (route the over-cap
   *  dollar to a later cap-safe source) still fires at the breach dollar;
   *  only the in-tier ordering changes. False for preset strategies. */
  sequentialWithinTier: boolean;
}

/**
 * Handle a pure post-tax tier (brokerage / Roth) — standard distribution,
 * no cap impact. Updates `ctx.remaining` and returns dollars drawn.
 */
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

/**
 * Thin wrapper: route `ctx.remaining` overflow for tier at `tierIdx` via
 * taxable or breach, updating `ctx.remaining`. Returns dollars satisfied.
 */
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

/**
 * Phase 2 of a pre-tax tier: draw pre-tax up to cap, route overflow when needed.
 * Cap exhausted → route all; cap has room → draw up to cap then route remainder
 * if cap was the binding constraint. Updates ctx; returns dollars satisfied.
 */
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
  // Cap was the binding constraint (not account exhaustion) — route remainder.
  const overflow = (ctx.remaining > 0 && preDrawn === allowedTarget)
    ? routeViaCtx(ctx, tier, tierIdx)
    : 0;
  return preDrawn + overflow;
}

/**
 * Handle a tier with pre-tax exposure under the MAGI cap.
 * Phase 1: post-tax sub-buckets first (MIXED accounts; no-op for pure PRE_TAX).
 * Phase 2: pre-tax draw up to cap via `drawPreTaxPhase2`.
 * Updates `ctx.remaining` and `ctx.localCapRemaining`; returns dollars drawn.
 */
function handlePreTaxTierWithCap(
  ctx: TierCapCtx,
  tier: ReadonlyArray<number>,
  tierIdx: number,
): number {
  // Phase 1: post-tax sub-buckets of MIXED accounts (pure PRE_TAX = no-op).
  const postDrawn = drawPostOnlyFromTier({
    state: ctx.state, tier, excludedIndices: ctx.excludedIndices,
    target: ctx.remaining,
    yearWithdrawnByAcct: ctx.yearWithdrawnByAcct,
    yearPostWithdrawnByAcct: ctx.yearPostWithdrawnByAcct,
    sequentialWithinTier: ctx.sequentialWithinTier,
  });
  ctx.remaining -= postDrawn;
  if (ctx.remaining <= 0) return postDrawn;
  // Phase 2: pre-tax draw up to cap (may route overflow to taxable/breach).
  return postDrawn + drawPreTaxPhase2(ctx, tier, tierIdx);
}

/**
 * Monthly withdrawal with MAGI-cap enforcement. Applies to both the
 * custom-order path (caller-built tiers) and preset strategies when a cap
 * is active (the cap is orthogonal to strategy kind).
 *
 * When the cap is active (`capRemainingDollars !== null`) and the
 * current tier is purely pre-tax, the engine:
 *   1. Draws up to `localCapRemaining` from the pre-tax tier.
 *   2. For the remaining need, scans LATER tiers for the first cap-safe
 *      account — any already-taxed bucket (POST_TAX or Roth, or MIXED
 *      post) whose draw adds $0 to MAGI — and diverts there via skip-ahead
 *      (emits `onTierOverrideDollars`). Roth is included per the
 *      taxable/Roth sourcing precedence.
 *   3. If no cap-safe account remains in later tiers, records a breach
 *      (`onCapBreachDollars`) and draws from the pre-tax tier anyway.
 */
export function distributeWithdrawalByCustomTiersWithCap(args: {
  state: AccountRunState[];
  tiers: ReadonlyArray<ReadonlyArray<number>>;
  excludedIndices: ReadonlySet<number>;
  target: number;
  yearWithdrawnByAcct: number[];
  yearPreWithdrawnByAcct: number[];
  yearPostWithdrawnByAcct: number[];
  /** Remaining pre-tax cap dollars for the year; null = cap not active. */
  capRemainingDollars: number | null;
  magiCapConfig?: MagiCapRuntimeConfig;
  onCapBreachDollars: (d: number) => void;
  onTierOverrideDollars: (d: number) => void;
  onPreTaxDrawn: (d: number) => void;
  /** Drain accounts within each tier in listed order (customOrder).
   *  Default false → balance-proportional (preset strategies). */
  sequentialWithinTier?: boolean;
}): number {
  const { state, tiers, excludedIndices, target,
    yearWithdrawnByAcct, yearPreWithdrawnByAcct, yearPostWithdrawnByAcct,
    capRemainingDollars, magiCapConfig,
    onCapBreachDollars, onTierOverrideDollars, onPreTaxDrawn,
    sequentialWithinTier = false } = args;

  // No cap or cap inactive → standard custom-tier distribution.
  if (capRemainingDollars === null || magiCapConfig === undefined) {
    return distributeWithdrawalByCustomTiers({
      state, tiers, excludedIndices, target,
      yearWithdrawnByAcct, yearPreWithdrawnByAcct, yearPostWithdrawnByAcct,
      sequentialWithinTier,
    });
  }

  // Mutable context threaded through per-tier helpers (localCapRemaining
  // is a copy so multiple pre-tax tiers within one call each see the updated budget).
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
    // A tier has pre-tax exposure when at least one non-excluded account
    // carries a non-zero pre-tax sub-bucket (covers pure PRE_TAX AND MIXED; a
    // "purely pre-tax" predicate would miss MIXED accounts).
    const tierHasPreTaxExposure = tier.some(
      (a) => !excludedIndices.has(a) && state[a].pre > 0,
    );
    totalDrawn += tierHasPreTaxExposure
      ? handlePreTaxTierWithCap(ctx, tier, t)
      : handleNonPreTaxTier(ctx, tier);
  }
  return totalDrawn;
}

// ---------------------------------------------------------------------------
// Phase-split helpers for MIXED tiers
// ---------------------------------------------------------------------------

/**
 * Draw from post-tax sub-buckets only within a tier (no pre-tax touched).
 * Used in phase-1 of the MAGI-cap path so MIXED accounts' post portion is
 * consumed before the cap-gated pre portion is considered.
 */
function drawPostOnlyFromTier(args: {
  state: AccountRunState[];
  tier: ReadonlyArray<number>;
  excludedIndices: ReadonlySet<number>;
  target: number;
  yearWithdrawnByAcct: number[];
  yearPostWithdrawnByAcct: number[];
  /** Drain post sub-buckets in listed order instead of proportional. */
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
  // The post-bucket drawable is capped at each
  // account's floor-respecting drawable (combined balance above floor). For a
  // pure post-tax floored account (brokerage/HSA, pre == 0) this is
  // `max(0, post − floor)`; an unfloored / ineligible account is unchanged.
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

/**
 * Draw from pre-tax sub-buckets only within a tier (post-tax not touched).
 * Used in phase-2 of the MAGI-cap path so only the cap-gated pre portion is
 * drawn, up to the caller-supplied allowedTarget.
 */
function drawPreOnlyFromTier(args: {
  state: AccountRunState[];
  tier: ReadonlyArray<number>;
  excludedIndices: ReadonlySet<number>;
  target: number;
  yearWithdrawnByAcct: number[];
  yearPreWithdrawnByAcct: number[];
  /** Drain pre sub-buckets in listed order, up to `target` (the
   *  cap-allowed amount). The cap deviation to a later cap-safe source then
   *  fires for the over-cap remainder — handled by the caller. */
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

// ---------------------------------------------------------------------------
// Shared overflow router (shared by cap-exhausted + leftover)
// ---------------------------------------------------------------------------

/**
 * When the MAGI cap blocks a pre-tax tier, route `need` to the first cap-safe
 * account in a later tier (any already-taxed bucket — POST_TAX or Roth, or
 * MIXED post — is pre-tax-cap-sparing: its withdrawal does not consume the
 * pre-tax MAGI-cap budget; taxable/Roth sourcing precedence). NB only Roth + cash-like
 * post are truly MAGI-neutral; a POST_TAX / MIXED-post withdrawal still realizes
 * LTCG into MAGI (the LTCG proxy in `tax-integration.ts`), which is why conversion-tax
 * funding (`drawCapSafeTaxFunding`) restricts to MAGI-neutral buckets only. If
 * none exists, or the cap-safe accounts are exhausted before `need` is met, the
 * residual is drawn from the pre-tax tier and a breach is emitted.
 *
 * Returns total dollars satisfied (from cap-safe overflow + breach combined).
 */
/**
 * Draw `need` from later-tier cap-safe (already-taxed, post-only) accounts via
 * skip-ahead. Scans the resolver iteratively with a `visited` set so multiple
 * cap-safe accounts in the same later tier are each exhausted before the
 * caller falls back to a breach. Returns dollars satisfied from cap-safe tiers.
 */
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
  // For each later cap-safe account, draw ONLY from the post-tax bucket. MIXED
  // accounts' pre-tax sub-bucket must not be drawn beyond the cap (post-only
  // avoids a silent pre-tax draw). `visited` lets the resolver return
  // additional cap-safe accounts in the SAME later tier and guards against an
  // infinite loop (resolver re-returning an exhausted MIXED account).
  const visitedAcctIndices = new Set<number>();
  while (need > 0) {
    const idx = magiCapConfig.findLaterTaxableIndex(tiers, tierIdx, state, visitedAcctIndices);
    // Safety belt: a resolver that ignores `visited` would otherwise loop forever.
    if (idx === undefined || visitedAcctIndices.has(idx)) break;
    visitedAcctIndices.add(idx);
    // A floored cap-safe account diverts only its
    // balance above the floor. Draw ONLY from the post bucket — a MIXED
    // cap-safe account carries a pre-tax sub-bucket that must NOT be drawn beyond
    // the cap, so this is `min(post, discretionaryDrawable)` rather than the raw
    // `discretionaryDrawable` (which counts pre + post). For a pure POST_TAX/HSA
    // cap-safe account (pre == 0) the two coincide; the `min` keeps the floor
    // read uniform with every other distributor while preserving the post-only
    // post-only invariant. Unfloored / ineligible → full post (unchanged).
    const aboveFloorPost = Math.min(state[idx].post, discretionaryDrawable(state[idx]));
    // A LATER-tier POST_TAX floor
    // reserve diverts its BELOW-floor balance too, so a floor-only-remaining
    // POST_TAX account drains as cap-safe BEFORE recording an avoidable pre-tax
    // breach. The reserve fallback is POST_TAX-ONLY (the load-bearing
    // gate): `findLaterTaxableIndex` also resolves HSA (floor-eligible, so
    // `reserveDrawable > 0`), whose below-floor dollars are nonqualified ORDINARY
    // income and must NEVER be treated as cap-safe; ROTH/MIXED are
    // naturally reserve-0 (not floor-eligible). `reserveDrawable = pre + post`,
    // so `min(post, reserveDrawable)` collapses to `post` for a floored POST_TAX
    // account; `Math.max` keeps an UNFLOORED POST_TAX account (reserve-0) on the
    // existing full-`post` read. Non-POST_TAX keeps the above-floor-only read.
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

/**
 * When the MAGI cap blocks a pre-tax tier, route `need` to the first cap-safe
 * account in a later tier (any already-taxed bucket — POST_TAX or Roth, or
 * MIXED post — is pre-tax-cap-sparing: its withdrawal does not consume the
 * pre-tax MAGI-cap budget; taxable/Roth sourcing precedence). NB only Roth + cash-like
 * post are truly MAGI-neutral; a POST_TAX / MIXED-post withdrawal still realizes
 * LTCG into MAGI (the LTCG proxy in `tax-integration.ts`), which is why conversion-tax
 * funding (`drawCapSafeTaxFunding`) restricts to MAGI-neutral buckets only. If
 * none exists, or the cap-safe accounts are exhausted before `need` is met, the
 * residual is drawn from the pre-tax tier and a breach is emitted.
 *
 * Returns total dollars satisfied (from cap-safe overflow + breach combined).
 */
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
  // Cap-safe exhausted or none found — breach: draw residual from pre-tax.
  const breachDrawn = distributeOneTier({
    state, tier, excludedIndices, target: residual,
    yearWithdrawnByAcct, yearPreWithdrawnByAcct, yearPostWithdrawnByAcct,
    sequentialWithinTier,
  });
  onPreTaxDrawn(breachDrawn);
  onCapBreachDollars(breachDrawn);
  return fromCapSafe + breachDrawn;
}

// ---------------------------------------------------------------------------
// Monthly step helpers (also consumed by drawdown-engine-per-account-strategy)
// ---------------------------------------------------------------------------

/** Sum the year-window net need (expense minus income) over 12 months. */
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

/** Apply per-account targeted + household-proportional deposits for one month. */
export function applyMonthlyDeposits(args: {
  state: AccountRunState[];
  stepIdx: number;
  householdDepositAmount: number;
  yearDepositByAcct: number[];
}): number {
  const { state, stepIdx, householdDepositAmount, yearDepositByAcct } = args;
  // Household deposit splits proportional to current pool balance, but the
  // synthetic RMD-overflow cash carrier is EXCLUDED from both the pro-rata
  // pool and the per-account split: only RMD surplus may credit it
  // (via its targeted `deposits[]`/pre-pass route), never a share of real
  // household deposits (pension lump-sums, secondary contributions) — those
  // belong wholly to the real accounts and the carrier is a hidden
  // 0%-growth holding excluded from the account-stack UI.
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
    // Post-primary spouse contribution's designated-Roth (post-tax) slice
    // — always credited to `post` regardless of destination treatment, so a
    // MIXED account's Roth slice stays out of the RMD floor (§325). Carriers
    // never receive a post-primary contribution.
    const targetedPost = isCarrier ? 0 : st.depositsPost[stepIdx] ?? 0;
    const householdShare = isCarrier
      ? 0
      : poolBefore > 0 && householdDepositAmount > 0
        ? householdDepositAmount * ((st.pre + st.post) / poolBefore)
        : householdDepositAmount / Math.max(1, realAcctCount);
    // The TARGETED per-account deposit (CBP lump-sum / one-off, and a
    // post-primary contribution's PRE-tax slice) routes by the destination
    // account's tax treatment — a pre-tax pension rollover or pre-tax-designated
    // contribution into a PRE_TAX/MIXED account is pre-tax principal (→ `pre`);
    // POST_TAX / ROTH / HSA destinations land in `post`. The household-share
    // proportional spread is UNCHANGED — it stays routed to `post`.
    const targetedToPre = !isCarrier && isPreTaxTargetedDeposit(st);
    if (targetedToPre) {
      st.pre += targeted;
    } else {
      st.post += targeted;
    }
    // The post-primary designated-Roth slice + the household share both land
    // in `post`.
    st.post += targetedPost + householdShare;
    const dep = targeted + targetedPost + householdShare;
    yearDepositByAcct[a] += dep;
    aggDeposit += dep;
  }
  return aggDeposit;
}

/** Apply one month of compound growth to all accounts; returns aggregate growth.
 *
 *  `stepIdx`: when supplied AND an account carries a
 *  per-month `returnPctByMonth` series (Monte Carlo paths only), that account
 *  grows by `1 + returnPctByMonth[stepIdx] / 100` for the month. Otherwise it
 *  grows by the scalar `1 + monthlyRate / 100` exactly as before, so the
 *  deterministic / optimizer call path (which passes neither the series nor a
 *  step index, or passes the index without a series) is byte-for-byte
 *  unchanged. */
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

// ---------------------------------------------------------------------------
// Trial year-draw classifier for the tax-cashflow solver
// ---------------------------------------------------------------------------

/** POST_TAX cash-like account types (return-of-principal — $0 taxable, $0
 *  MAGI). Mirrors `CASH_LIKE_ACCOUNT_TYPES` in the tax helpers. */
const CASH_LIKE_TYPES: ReadonlySet<string> = new Set([
  'SAVINGS',
  'MONEY_MARKET',
  'CD',
  'HSA',
]);

/**
 * True when a draw from this account's `post` sub-bucket adds $0 to MAGI —
 * i.e. the account's post dollars classify as Roth or cash-like
 * return-of-principal (`classifyAccountDraw` routes them to `roth` /
 * `postTaxCashLike`). A BROKERAGE / OTHER POST_TAX or MIXED-post `post` draw is
 * NOT MAGI-neutral: its gain is LTCG that feeds otherAGI → MAGI
 * (tax-integration.ts §"Step 1"), so it is excluded here. Single source of
 * truth for the conversion-tax funding seam and `classifyAccountDraw`.
 *
 * MIXED Roth-designated (401k/403b/457b/TSP): the post sub-bucket is
 * Roth-designated — tax-free, MAGI-neutral.
 */
export function isMagiNeutralPostBucket(st: AccountRunState): boolean {
  if (st.taxTreatment === 'HSA') return true;
  if (st.accountType.startsWith('RETIREMENT_ROTH_')) return true;
  if (isRothDesignatedPostBucket(st.taxTreatment, st.accountType as AccountType) && st.taxTreatment === 'MIXED') return true;
  return CASH_LIKE_TYPES.has(st.accountType);
}

/** Per-bucket accumulator the two classifiers below share. `rothInherited` and
 *  `rothDesignated` are SUBSETS of `roth` (mutually disjoint — the first is
 *  Roth-IRA-only, the second designated-plan-only), never extra buckets — see
 *  `classifyAccountDraw`. */
interface DrawBuckets {
  preTax: number;
  postTaxNonRoth: number;
  postTaxCashLike: number;
  roth: number;
  rothInherited: number;
  rothDesignated: number;
  /** INHERITED designated-Roth dollars — a third disjoint subset of `roth`,
   *  routed to the funding solver's inherited slice (death qualifying event,
   *  §72(t)(2)(A)(ii)); never the §408A carrier, never the pooled state. */
  rothInheritedDesignated: number;
  /** Per-ACCOUNT attribution of the three STATEFUL Roth slices (the §408A
   *  Roth-IRA remainder, the §402A designated subset, the inherited designated
   *  subset), keyed by ledger account id. The aggregate totals above carry no
   *  owner information, so the funding solver needs these to charge each
   *  owner's basis/lots with that owner's OWN drawn dollars instead of picking
   *  one ledger owner for the whole household slice. The inherited-Roth-IRA
   *  subset needs no map: those dollars are wholesale tax-free and consume no
   *  state. */
  rothIraByAccountId: Map<string, number>;
  rothDesignatedByAccountId: Map<string, number>;
  rothInheritedDesignatedByAccountId: Map<string, number>;
}

/** Bucket one account's withdrawn dollars into the tax classification. */
function classifyAccountDraw(
  st: AccountRunState,
  drawn: number,
  cls: DrawBuckets,
): void {
  if (drawn <= 0) return;
  // Attribution for the stateful Roth slices: the funding solver maps each
  // account id to its real owner, so every dollar is charged to the owner it
  // actually left — never a housemate picked by ledger order.
  const attribute = (map: Map<string, number>): void => {
    map.set(st.id, (map.get(st.id) ?? 0) + drawn);
  };
  if (st.taxTreatment === 'PRE_TAX') {
    cls.preTax += drawn;
    return;
  }
  if (st.taxTreatment === 'HSA') {
    // Qualified HSA withdrawals add $0 to taxable income / MAGI — classify
    // with the cash-like post-tax bucket, the same bucket the HSA
    // account TYPE maps to. Pre-65 nonqualified income + 20% additional tax
    // is layered on by account TYPE downstream, not here.
    cls.postTaxCashLike += drawn;
    return;
  }
  if (st.accountType.startsWith('RETIREMENT_ROTH_')) {
    cls.roth += drawn;
    // An INHERITED Roth IRA's dollars are wholesale tax-free and hold no §408A
    // basis state, so the funding solver must not consume the owner's basis
    // carrier with them. They stay counted in `roth` (and so in
    // `rothWithdrawalDollars` / `fundedDollars`, whose totals do not move) and are
    // recorded here as a SUBSET the solver subtracts before touching the carrier.
    // Scoped to the Roth-IRA type: an inherited designated-Roth plan carries its
    // own subset (third branch below) with §402A death-event treatment instead.
    if (st.inheritedAccount === true && st.accountType === 'RETIREMENT_ROTH_IRA') {
      cls.rothInherited += drawn;
    } else if (st.accountType !== 'RETIREMENT_ROTH_IRA' && st.inheritedAccount !== true) {
      // Non-inherited DESIGNATED-Roth dollars — the §402A slice of the Roth
      // bucket, so the funding solver charges them (and only them) against the
      // pooled designated state.
      cls.rothDesignated += drawn;
      attribute(cls.rothDesignatedByAccountId);
    } else if (st.accountType !== 'RETIREMENT_ROTH_IRA') {
      // INHERITED designated-Roth dollars: the solver holds no recapture-bearing
      // pooled state for them (§72(t)(2)(A)(ii)), and the §408A carrier must
      // never see them either (its ordering would score them as earnings excess
      // and charge a 10% the statute waives). They run the solver's dedicated
      // INHERITED designated slice, where the original owner's death is the
      // qualifying event.
      cls.rothInheritedDesignated += drawn;
      attribute(cls.rothInheritedDesignatedByAccountId);
    } else {
      // NON-inherited Roth IRA — the §408A remainder slice, charged against the
      // owner-keyed basis carrier.
      attribute(cls.rothIraByAccountId);
    }
    return;
  }
  // MIXED Roth-designated (401k/403b/457b/TSP): the post sub-bucket is
  // Roth-designated — route to `roth`, and its dollars to the matching
  // designated subset with it (non-inherited vs inherited, same routing as the
  // pure Roth employer types above). The pre sub-bucket is ordinary income and
  // is handled by the PRE_TAX branch above via the proportional pre/post split
  // in the trial distributor.
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
  // POST_TAX non-Roth + MIXED OTHER post bucket both follow the cash-like vs
  // brokerage split. (MIXED pre/post split is approximated proportionally
  // by the trial distributor — acceptable for the within-year solve which
  // only needs the tax-bucket totals, not committed balances.)
  if (CASH_LIKE_TYPES.has(st.accountType)) cls.postTaxCashLike += drawn;
  else cls.postTaxNonRoth += drawn;
}

interface TrialAccumulators {
  readonly yearWithdrawnByAcct: number[];
  readonly yearPreWithdrawnByAcct: number[];
  readonly yearPostWithdrawnByAcct: number[];
  /** Per-account HSA medical-qualified dollars drawn this trial year, so
   *  the trial classification carries the same medical/emergency split the
   *  committing post-pass does (the funding solver narrows the §223 basis). */
  readonly yearMedicalQualifiedByAcct: number[];
}

/**
 * Classify a year's COMMITTED per-account pre/post withdrawal split into the
 * tax-bucket totals the conversion solve needs as its "MAGI at conv=0" basis.
 * Mirrors the trial classifier: every committed pre-tax dollar is
 * ordinary `preTax`; committed post dollars route by account type
 * (Roth / cash-like / brokerage). Pure — reads the accumulators only.
 */
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
  // `rothInherited` / `rothDesignated` are SUBSETS of `roth`, so they are
  // deliberately NOT summed here.
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

/** The per-account Roth-slice attribution fields shared by both classifiers —
 *  each map is emitted only when it holds dollars, so an attribution-free
 *  classification keeps its exact prior shape. */
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

/**
 * Distribute one month's `target` across `trial` state, routing through the
 * SAME distributor the committing path uses. When a MAGI cap is active
 * the cap-aware distributor is used with the caller's running `capRemaining`
 * budget; `onPreTaxDrawn` lets the caller decrement that budget across months
 * exactly as `runOneStrategyYear` does. Cap breach/override callbacks are
 * no-ops here — the committing path owns the row diagnostics. Returns dollars
 * drawn this month.
 */
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

  // The customOrder trial mirrors the committing within-tier sequential
  // drain so the tax classification matches the real year's pre/post split.
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

/** The within-year per-month deposit/income/expense context the trial sim
 *  needs to mirror the committing `runOneStrategyYear` month sequence. */
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
  /** HSA state indices so the trial mirrors the committing path's two-pass
   *  HSA routing — medical-qualified before the ordinary drain, emergency after.
   *  Empty / absent ⇒ no HSA routing (legacy / unit-test callers). */
  readonly hsaIndices?: ReadonlyArray<number>;
  /** Per-month medical demand in DOLLARS, full run length. Absent ⇒ 0. */
  readonly medicalDemand?: Float64Array;
}

/** Compute one month's discretionary withdrawal target the same way
 *  `runOneStrategyYear` does: ordinary net need + the tax add-on's monthly
 *  share, less the RMD credit's monthly share. */
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

/**
 * Run a NON-COMMITTING 12-month trial simulation on `trial`, mirroring the
 * committing `runOneStrategyYear` month sequence: each month applies
 * deposits → growth → the strategy/cap withdrawal of that month's discretionary
 * share. Accumulates the per-account pre/post withdrawal split into `acc` and
 * returns total discretionary dollars drawn. Tracks the cap budget across
 * months exactly as the committing path does.
 */
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
  // No tiers resolvable (customOrder without a layout) → nothing discretionary.
  if (tiers === undefined) return 0;
  // Throwaway deposit accumulator — deposits are NOT a withdrawal, so they
  // must not pollute the per-account withdrawal split `acc` feeds classification.
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
    // Spend-first parity: mirror the committing path's synthetic-cash
    // pre-consumption so the trial's discretionary target (and the resulting
    // tax classification) reflects the cash-first draw the real year does. The
    // consumed cash is return-of-principal (tax-free), so it never enters the
    // taxable pre/post split the classifier reads — drain it (into the throwaway
    // sink, not `acc`) before the router. It still FUNDS need, so it counts
    // toward `drawn`.
    const cashSpent = consumeOverflowCashFirst({
      state: trial,
      target: targetGross,
      yearWithdrawnByAcct: depositSink,
      yearPostWithdrawnByAcct: depositSink,
    });
    drawn += cashSpent;
    // HSA medical-qualified pass parity: mirror the committing path's
    // medical-first HSA draw so the trial classifies the SAME reduced ordinary
    // draw. Routed into the real `acc` accumulators (HSA → postTaxCashLike,
    // $0 MAGI) so the classifier reflects the medical funding.
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
    // HSA emergency-reserve pass parity: the ordinary router holds HSA out,
    // so a residual after it means non-HSA is exhausted — draw the remainder
    // from HSA (emergency).
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
    // LAST-RESORT floor-reserve pass parity: the trial runs the SAME `drawFloorReserve` the committing path
    // does so the trial classifier's tax-bucket totals match the committed year
    // for reserve-funded years. Uses the same tier layout + HSA indices.
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
 * Trial (non-committing) classification of a year's withdrawal for the
 * tax-cashflow solver. Deep-copies `state`, then runs a faithful
 * 12-month trial simulation in the SAME order as the committing
 * `runOneStrategyYear` (per month: deposits → growth → the strategy/cap
 * withdrawal of that month's discretionary share) — returning the
 * per-tax-bucket split the real year would produce, plus the dollars the
 * portfolio could actually supply.
 *
 * The trial mirrors within-year deposits + growth so a year funded
 * partly by post-retirement cash inflows (CBP pension lump sums, targeted
 * one-off deposits, post-primary contributions) classifies the draw against
 * the SAME post-deposit/post-growth balances the committing draw sees —
 * copying year-START state with no deposits/growth would over-count the
 * pre-tax draw.
 *
 * When a MAGI cap is active the trial routes through the cap-aware
 * distributor (taxable / Roth before capped pre-tax), matching the committing
 * path so the grossed-up tax reflects the capped MAGI.
 *
 * The trial is NON-COMMITTING — it operates only on the deep-copied state +
 * its own accumulators and never mutates the real run state. The committing
 * draw runs once afterward in `runOneStrategyYear`.
 */
export function classifyTrialYearDraw(args: {
  readonly state: ReadonlyArray<AccountRunState>;
  readonly strategyKind: StrategyAwareKind;
  readonly customTiers?: ReadonlyArray<ReadonlyArray<number>>;
  readonly excludedIndices?: ReadonlySet<number>;
  /** Total RMD-forced pre-tax across all accounts (credited toward target).
   *  Already drawn from the live `state` by `applyRmdFloorPrePass` before
   *  this classifier runs — `state` here is post-RMD. */
  readonly rmdForcedTotal: number;
  /** Total year withdrawal target (ordinary + tax), in dollars. */
  readonly totalTargetDollars: number;
  /** Active MAGI-cap config. Undefined → no cap-aware routing. */
  readonly magiCapConfig?: MagiCapRuntimeConfig;
  /** Post-RMD pre-tax cap budget left for the year. Null → no cap. */
  readonly capRemainingDollars: number | null;
  /** Within-year per-month deposit/income/expense context. When absent
   *  (legacy / unit-test callers), the trial falls back to a single-shot
   *  discretionary distribution with no deposits/growth. */
  readonly within?: TrialWithinYearInputs;
}): TaxCashflowYearClassification {
  const { state, strategyKind, customTiers, excludedIndices,
    rmdForcedTotal, totalTargetDollars,
    magiCapConfig, capRemainingDollars, within } = args;
  // Deep-copy state so the trial draw never mutates the real run state.
  // `state` is ALREADY post-RMD here — `applyRmdFloorPrePass` mutated the
  // live run state (`state[a].pre -= rmdDraw`) before this classifier is
  // called. Copy as-is; do NOT re-subtract `rmdForcedPreTaxByAcct`
  // (double-subtracting would understate the pre-tax pool, so the solver would gross
  // tax against a too-low pre-tax classification).
  const trial: AccountRunState[] = state.map((s) => ({ ...s }));
  const cls: DrawBuckets = {
    preTax: rmdForcedTotal, postTaxNonRoth: 0, postTaxCashLike: 0, roth: 0, rothInherited: 0,
    rothDesignated: 0, rothInheritedDesignated: 0,
    rothIraByAccountId: new Map(), rothDesignatedByAccountId: new Map(),
    rothInheritedDesignatedByAccountId: new Map(),
  };
  // The RMD floor already covers `rmdForcedTotal` of the target.
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
  // Classify the discretionary draw from the per-account pre/post split.
  let hsaMedicalQualifiedDollars = 0;
  // Sum the EXACT per-account HSA TOTAL (medical-first qualified +
  // emergency residual + any ordinary HSA draw) the trial actually produced.
  // HSA accounts carry `taxTreatment === 'HSA'` (same predicate the two-pass
  // uses to run drawHsaMedical/drawHsaEmergency). Surfacing the exact total on
  // `hsaWithdrawalDollars` lets `buildSolverPenaltyAccountsForYear` use it for
  // the §223(f)(4) emergency basis on named strategies instead of the
  // balance-share estimate — matching the committing post-pass exactly.
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
    // The inherited Roth IRA subset of `rothDollars`, so the funding solver
    // leaves the owner's own §408A basis carrier alone for those dollars.
    ...(cls.rothInherited > 0
      ? { rothInheritedTaxFreeDollars: cls.rothInherited }
      : {}),
    // The committed designated-Roth subset, so the funding solver runs it (and
    // only it) through the pooled §402A pro-rata regime.
    ...(cls.rothDesignated > 0 ? { rothDesignatedDollars: cls.rothDesignated } : {}),
    // The committed INHERITED designated-Roth subset, so the funding solver
    // runs it through the death-qualifying-event inherited slice.
    ...(cls.rothInheritedDesignated > 0
      ? { rothInheritedDesignatedDollars: cls.rothInheritedDesignated }
      : {}),
    // Per-account attribution of the three stateful Roth slices, so the funding
    // solver charges each owner's basis/lots with that owner's OWN dollars.
    ...rothAttributionFields(cls),
    // Medical-qualified HSA dollars (subset of the cash-like draw) so the
    // funding solver narrows the §223 nonqualified basis to the emergency
    // residual, matching the committing post-pass.
    ...(hsaMedicalQualifiedDollars > 0 ? { hsaMedicalQualifiedDollars } : {}),
    // The EXACT HSA total so the named-strategy solver uses it (not the
    // balance-share fallback).
    ...(hsaWithdrawalDollars > 0 ? { hsaWithdrawalDollars } : {}),
  };
}

/**
 * Dispatch the trial draw: the faithful 12-month within-year sim when
 * the within-year context is supplied, else the legacy single-shot
 * discretionary distribution (no deposits/growth — unit-test callers). Mutates
 * `acc`; returns total discretionary dollars drawn.
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
    // The tax add-on this trial pass funds = total target minus the ordinary
    // year net need (the solver grows the total target each pass); negative when
    // the credit applied to premiums lowers the draw, bounded like the committing path.
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
