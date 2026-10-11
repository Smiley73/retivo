/**
 * Unit tests for `drawdown-engine-per-account-strategy-cap.ts`.
 *
 * Covers:
 *   - `distributeOneTier`: basic draw, excluded accounts, zero-balance tier.
 *   - `distributeWithdrawalByCustomTiersWithCap`: cap inactive → standard
 *     distribution; cap active with budget → pre-tax drawn, skip-ahead
 *     fires `onTierOverrideDollars`; cap exhausted with taxable → skip-ahead
 *     only; cap exhausted with no later taxable → breach emitted;
 *     `localCapRemaining` decrements across multiple pre-tax tiers.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  applyMonthlyDeposits,
  classifyCommittedYearDraw,
  classifyTrialYearDraw,
  distributeOneTier,
  distributeWithdrawalByCustomTiersWithCap,
  isMagiNeutralPostBucket,
  type TrialWithinYearInputs,
} from './drawdown-engine-per-account-strategy-cap';
import { RMD_OVERFLOW_CASH_ACCOUNT_ID } from './drawdown-engine-per-account-strategy-helpers';
import type { AccountRunState } from './drawdown-engine-per-account-strategy-helpers';
import type { MagiCapRuntimeConfig } from './drawdown-engine-per-account-strategy-helpers';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<AccountRunState>): AccountRunState {
  return {
    id: 'acct-1',
    pre: 0,
    post: 0,
    annualRatePct: 7,
    monthlyRate: 7 / 12,
    taxTreatment: 'PRE_TAX',
    accountType: 'RETIREMENT_401K',
    deposits: new Float64Array(0),
    depositsPost: new Float64Array(0),
    ...overrides,
  };
}

function makeTrackers(n: number): {
  yearWithdrawnByAcct: number[];
  yearPreWithdrawnByAcct: number[];
  yearPostWithdrawnByAcct: number[];
} {
  return {
    yearWithdrawnByAcct: new Array(n).fill(0),
    yearPreWithdrawnByAcct: new Array(n).fill(0),
    yearPostWithdrawnByAcct: new Array(n).fill(0),
  };
}

// ---------------------------------------------------------------------------
// distributeOneTier
// ---------------------------------------------------------------------------

describe('distributeOneTier', () => {
  it('should_draw_from_pre_and_post_buckets_proportionally', () => {
    const state: AccountRunState[] = [
      makeState({ id: 'a0', pre: 60_000, post: 40_000 }),
    ];
    const trackers = makeTrackers(1);

    const drawn = distributeOneTier({
      state,
      tier: [0],
      excludedIndices: new Set(),
      target: 10_000,
      ...trackers,
    });

    expect(drawn).toBeCloseTo(10_000, 5);
    expect(state[0].pre).toBeCloseTo(54_000, 1); // 60% of 10k from pre
    expect(state[0].post).toBeCloseTo(36_000, 1); // 40% of 10k from post
    expect(trackers.yearWithdrawnByAcct[0]).toBeCloseTo(10_000, 5);
    expect(trackers.yearPreWithdrawnByAcct[0]).toBeCloseTo(6_000, 5);
    expect(trackers.yearPostWithdrawnByAcct[0]).toBeCloseTo(4_000, 5);
  });

  it('should_skip_excluded_accounts', () => {
    const state: AccountRunState[] = [
      makeState({ id: 'a0', pre: 50_000 }),
      makeState({ id: 'a1', pre: 50_000 }),
    ];
    const trackers = makeTrackers(2);

    const drawn = distributeOneTier({
      state,
      tier: [0, 1],
      excludedIndices: new Set([0]), // exclude a0
      target: 10_000,
      ...trackers,
    });

    expect(drawn).toBeCloseTo(10_000, 5);
    // a0 untouched; a1 drawn
    expect(state[0].pre).toBe(50_000);
    expect(state[1].pre).toBeCloseTo(40_000, 1);
    expect(trackers.yearWithdrawnByAcct[0]).toBe(0);
    expect(trackers.yearWithdrawnByAcct[1]).toBeCloseTo(10_000, 5);
  });

  it('should_return_zero_for_zero_balance_tier', () => {
    const state: AccountRunState[] = [makeState({ id: 'a0', pre: 0, post: 0 })];
    const trackers = makeTrackers(1);

    const drawn = distributeOneTier({
      state,
      tier: [0],
      excludedIndices: new Set(),
      target: 5_000,
      ...trackers,
    });

    expect(drawn).toBe(0);
    expect(trackers.yearWithdrawnByAcct[0]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// distributeWithdrawalByCustomTiersWithCap — cap inactive path
// ---------------------------------------------------------------------------

describe('distributeWithdrawalByCustomTiersWithCap — cap inactive', () => {
  it('should_use_standard_distribution_when_capRemainingDollars_is_null', () => {
    // One post-tax account, one pre-tax account in separate tiers.
    const state: AccountRunState[] = [
      makeState({ id: 'a0', post: 100_000, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }),
      makeState({ id: 'a1', pre: 100_000, taxTreatment: 'PRE_TAX' }),
    ];
    const trackers = makeTrackers(2);
    const onCapBreachDollars = vi.fn();
    const onTierOverrideDollars = vi.fn();
    const onPreTaxDrawn = vi.fn();

    const drawn = distributeWithdrawalByCustomTiersWithCap({
      state,
      tiers: [[0], [1]],
      excludedIndices: new Set(),
      target: 20_000,
      ...trackers,
      capRemainingDollars: null,
      onCapBreachDollars,
      onTierOverrideDollars,
      onPreTaxDrawn,
    });

    // taxEfficient-style draw from tier 0 (post-tax) first.
    expect(drawn).toBeCloseTo(20_000, 5);
    expect(state[0].post).toBeCloseTo(80_000, 1); // tier 0 drawn
    expect(state[1].pre).toBe(100_000);            // tier 1 untouched
    expect(onCapBreachDollars).not.toHaveBeenCalled();
    expect(onTierOverrideDollars).not.toHaveBeenCalled();
    expect(onPreTaxDrawn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// distributeWithdrawalByCustomTiersWithCap — cap active paths
// ---------------------------------------------------------------------------

describe('distributeWithdrawalByCustomTiersWithCap — cap active', () => {
  function makeCapConfig(
    capDollars: number,
    capOffYear = 2040,
    findLaterTaxableIndex?: MagiCapRuntimeConfig['findLaterTaxableIndex'],
  ): MagiCapRuntimeConfig {
    return {
      capDollars,
      capOffYear,
      capMode: 'minimize',
      capMagiLine: 'irmaa',
      findTargetRothIndex: () => undefined,
      findLaterTaxableIndex: findLaterTaxableIndex ?? (() => undefined),
    };
  }

  it('should_draw_pre_tax_up_to_cap_then_skip_ahead_to_taxable_tier', () => {
    // Tier 0: pre-tax account (a0). Tier 1: post-tax brokerage (a1).
    // Cap = 10k; target = 15k → draw 10k from a0, skip-ahead 5k to a1.
    const state: AccountRunState[] = [
      makeState({ id: 'a0', pre: 50_000, taxTreatment: 'PRE_TAX' }),
      makeState({ id: 'a1', post: 50_000, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }),
    ];
    const trackers = makeTrackers(2);
    const onCapBreachDollars = vi.fn();
    const onTierOverrideDollars = vi.fn();
    const onPreTaxDrawn = vi.fn();

    const magiCapConfig = makeCapConfig(10_000, 2040, () => 1);

    const drawn = distributeWithdrawalByCustomTiersWithCap({
      state,
      tiers: [[0], [1]],
      excludedIndices: new Set(),
      target: 15_000,
      ...trackers,
      capRemainingDollars: 10_000,
      magiCapConfig,
      onCapBreachDollars,
      onTierOverrideDollars,
      onPreTaxDrawn,
    });

    expect(drawn).toBeCloseTo(15_000, 5);
    // Pre-tax drawn from a0 = 10k (cap limit)
    expect(state[0].pre).toBeCloseTo(40_000, 1);
    // Skip-ahead diversion into a1 = 5k
    expect(state[1].post).toBeCloseTo(45_000, 1);
    expect(onPreTaxDrawn).toHaveBeenCalledWith(expect.closeTo(10_000, 1));
    expect(onTierOverrideDollars).toHaveBeenCalledWith(expect.closeTo(5_000, 1));
    expect(onCapBreachDollars).not.toHaveBeenCalled();
  });

  it('should_emit_breach_when_cap_exhausted_and_no_later_taxable_account', () => {
    // Single pre-tax tier, no taxable account in later tiers.
    // capRemainingDollars = 0 → scan finds nothing → breach.
    const state: AccountRunState[] = [
      makeState({ id: 'a0', pre: 50_000, taxTreatment: 'PRE_TAX' }),
    ];
    const trackers = makeTrackers(1);
    const onCapBreachDollars = vi.fn();
    const onTierOverrideDollars = vi.fn();
    const onPreTaxDrawn = vi.fn();

    const magiCapConfig = makeCapConfig(0, 2040, () => undefined);

    const drawn = distributeWithdrawalByCustomTiersWithCap({
      state,
      tiers: [[0]],
      excludedIndices: new Set(),
      target: 5_000,
      ...trackers,
      capRemainingDollars: 0,
      magiCapConfig,
      onCapBreachDollars,
      onTierOverrideDollars,
      onPreTaxDrawn,
    });

    // Engine draws from pre-tax anyway (breach path), so total drawn = 5k.
    expect(drawn).toBeCloseTo(5_000, 5);
    expect(state[0].pre).toBeCloseTo(45_000, 1);
    expect(onCapBreachDollars).toHaveBeenCalledWith(expect.closeTo(5_000, 1));
    expect(onPreTaxDrawn).toHaveBeenCalledWith(expect.closeTo(5_000, 1));
    expect(onTierOverrideDollars).not.toHaveBeenCalled();
  });

  it('should_cap_pretax_and_pull_remainder_from_brokerage_when_preset_strategy_active', () => {
    // PRE_TAX $200k + BROKERAGE $50k; withdrawal $15k/year; cap $10k/year;
    // member age < 65 (cap active). Expect: pre-tax ≤ $10k, remaining from
    // brokerage, magiCapTierOverrideDollars > 0 via onTierOverrideDollars.
    // This tests the preset×cap integration path.
    const state: AccountRunState[] = [
      makeState({ id: 'a0', pre: 200_000, taxTreatment: 'PRE_TAX' }),
      makeState({ id: 'a1', post: 50_000, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }),
    ];
    const trackers = makeTrackers(2);
    const onCapBreachDollars = vi.fn();
    const onTierOverrideDollars = vi.fn();
    const onPreTaxDrawn = vi.fn();

    // Tier 0 = pre-tax; tier 1 = brokerage (later taxable).
    // findLaterTaxableIndex returns index 1 (the brokerage in tier 1).
    const magiCapConfig = makeCapConfig(10_000, 2040, () => 1);

    const drawn = distributeWithdrawalByCustomTiersWithCap({
      state,
      tiers: [[0], [1]],
      excludedIndices: new Set(),
      target: 15_000,
      ...trackers,
      capRemainingDollars: 10_000,
      magiCapConfig,
      onCapBreachDollars,
      onTierOverrideDollars,
      onPreTaxDrawn,
    });

    // Total drawn must equal target.
    expect(drawn).toBeCloseTo(15_000, 5);
    // Pre-tax capped at $10k (cap limit).
    expect(state[0].pre).toBeCloseTo(190_000, 1);
    // Brokerage covers remaining $5k via skip-ahead.
    expect(state[1].post).toBeCloseTo(45_000, 1);
    // onPreTaxDrawn fired for the $10k pre-tax draw.
    expect(onPreTaxDrawn).toHaveBeenCalledWith(expect.closeTo(10_000, 1));
    // onTierOverrideDollars fired for the $5k diversion.
    expect(onTierOverrideDollars).toHaveBeenCalledWith(expect.closeTo(5_000, 1));
    // No breach — brokerage had enough.
    expect(onCapBreachDollars).not.toHaveBeenCalled();
  });

  it('should_draw_only_post_bucket_from_MIXED_account_when_routing_overflow', () => {
    // Regression: cap=$10k, need=$15k, tier 0 = PRE_TAX $50k,
    // tier 1 = MIXED pre:$20k post:$3k. Skip-ahead should pull only from
    // the MIXED post bucket. Residual $2k unmet → breach from pre-tax.
    // The MIXED pre bucket must remain at $20k (pre-tax; must not be drawn
    // beyond cap).
    const state: AccountRunState[] = [
      makeState({ id: 'a0', pre: 50_000, taxTreatment: 'PRE_TAX' }),
      makeState({ id: 'a1', pre: 20_000, post: 3_000, taxTreatment: 'MIXED' }),
    ];
    const trackers = makeTrackers(2);
    const onCapBreachDollars = vi.fn();
    const onTierOverrideDollars = vi.fn();
    const onPreTaxDrawn = vi.fn();

    // findLaterTaxableIndex returns index 1 (the MIXED account).
    const magiCapConfig = makeCapConfig(10_000, 2040, () => 1);

    const drawn = distributeWithdrawalByCustomTiersWithCap({
      state,
      tiers: [[0], [1]],
      excludedIndices: new Set(),
      target: 15_000,
      ...trackers,
      capRemainingDollars: 10_000,
      magiCapConfig,
      onCapBreachDollars,
      onTierOverrideDollars,
      onPreTaxDrawn,
    });

    // Total drawn: 10k (pre) + 3k (MIXED post) + 2k (breach from pre) = 15k.
    expect(drawn).toBeCloseTo(15_000, 5);
    // Pre-tax tier drained 10k (cap limit) + 2k breach = 12k total.
    expect(state[0].pre).toBeCloseTo(38_000, 1);
    // MIXED post bucket fully drained ($3k drawn).
    expect(state[1].post).toBeCloseTo(0, 1);
    // CRITICAL: MIXED pre bucket must NOT be touched (pre-tax; beyond cap).
    expect(state[1].pre).toBeCloseTo(20_000, 1);
    // Skip-ahead fired for $3k.
    expect(onTierOverrideDollars).toHaveBeenCalledWith(expect.closeTo(3_000, 1));
    // Breach fired for the $2k residual.
    expect(onCapBreachDollars).toHaveBeenCalledWith(expect.closeTo(2_000, 1));
  });

  // ——— Regression: MIXED account in active custom-order tier ————————
  it('should_enforce_cap_when_MIXED_account_is_in_active_customOrder_tier', () => {
    // MIXED account (pre:$40k, post:$20k) is the only account in tier 0.
    // Cap = $15k; target = $20k.
    // Expected: post-tax drawn first (no cap impact), then up to $15k from
    // the pre-tax sub-bucket. Total = $20k drawn (post $20k + pre $0k — post
    // covers need); no cap breach.
    // BUG (pre-fix): tierIsPurelyPreTax=false → drops to standard path →
    // draws proportionally (2/3 pre, 1/3 post) → pre draw = $13.3k, ignores
    // cap semantics (no onPreTaxDrawn emitted).
    const state: AccountRunState[] = [
      makeState({ id: 'a0', pre: 40_000, post: 20_000, taxTreatment: 'MIXED' }),
    ];
    const trackers = makeTrackers(1);
    const onCapBreachDollars = vi.fn();
    const onTierOverrideDollars = vi.fn();
    const onPreTaxDrawn = vi.fn();

    const magiCapConfig = makeCapConfig(15_000, 2040, () => undefined);

    const drawn = distributeWithdrawalByCustomTiersWithCap({
      state,
      tiers: [[0]],
      excludedIndices: new Set(),
      target: 20_000,
      ...trackers,
      capRemainingDollars: 15_000,
      magiCapConfig,
      onCapBreachDollars,
      onTierOverrideDollars,
      onPreTaxDrawn,
    });

    expect(drawn).toBeCloseTo(20_000, 5);
    // Post bucket exhausted (drawn first): $0 remaining.
    expect(state[0].post).toBeCloseTo(0, 1);
    // Pre bucket: $20k post covers the full need → pre untouched.
    expect(state[0].pre).toBeCloseTo(40_000, 1);
    // onPreTaxDrawn NOT called (post covered all).
    expect(onPreTaxDrawn).not.toHaveBeenCalled();
    expect(onCapBreachDollars).not.toHaveBeenCalled();
  });

  it('should_draw_pretax_up_to_cap_in_MIXED_tier_then_breach', () => {
    // MIXED account (pre:$40k, post:$5k). Cap = $10k; target = $20k.
    // Expected: post $5k drawn (no cap), then pre up to $10k cap ($10k drawn),
    // then $5k remaining → breach from pre.
    // BUG (pre-fix): proportional draw ignores cap → draws $10k pre + $5k
    // post in one shot, neither onPreTaxDrawn nor onCapBreachDollars emitted.
    const state: AccountRunState[] = [
      makeState({ id: 'a0', pre: 40_000, post: 5_000, taxTreatment: 'MIXED' }),
    ];
    const trackers = makeTrackers(1);
    const onCapBreachDollars = vi.fn();
    const onTierOverrideDollars = vi.fn();
    const onPreTaxDrawn = vi.fn();

    // No later taxable — breach is the only path for the residual.
    const magiCapConfig = makeCapConfig(10_000, 2040, () => undefined);

    const drawn = distributeWithdrawalByCustomTiersWithCap({
      state,
      tiers: [[0]],
      excludedIndices: new Set(),
      target: 20_000,
      ...trackers,
      capRemainingDollars: 10_000,
      magiCapConfig,
      onCapBreachDollars,
      onTierOverrideDollars,
      onPreTaxDrawn,
    });

    expect(drawn).toBeCloseTo(20_000, 5);
    // Post fully drained.
    expect(state[0].post).toBeCloseTo(0, 1);
    // Pre: $40k − $10k (cap) − $5k (breach) = $25k.
    expect(state[0].pre).toBeCloseTo(25_000, 1);
    // onPreTaxDrawn: once for cap portion, once for breach.
    expect(onPreTaxDrawn).toHaveBeenCalledTimes(2);
    expect(onCapBreachDollars).toHaveBeenCalledWith(expect.closeTo(5_000, 1));
    expect(onTierOverrideDollars).not.toHaveBeenCalled();
  });

  it('should_skip_ahead_to_later_taxable_after_MIXED_tier_post_exhausted', () => {
    // Tier 0: MIXED (pre:$30k, post:$5k). Tier 1: brokerage (post:$50k).
    // Cap = $10k; target = $20k.
    // Expected: post $5k from MIXED (no cap), pre $10k from MIXED (cap),
    // remaining $5k → skip-ahead to brokerage tier 1 via onTierOverrideDollars.
    const state: AccountRunState[] = [
      makeState({ id: 'a0', pre: 30_000, post: 5_000, taxTreatment: 'MIXED' }),
      makeState({ id: 'a1', post: 50_000, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }),
    ];
    const trackers = makeTrackers(2);
    const onCapBreachDollars = vi.fn();
    const onTierOverrideDollars = vi.fn();
    const onPreTaxDrawn = vi.fn();

    // findLaterTaxableIndex returns index 1 (brokerage).
    const magiCapConfig = makeCapConfig(10_000, 2040, () => 1);

    const drawn = distributeWithdrawalByCustomTiersWithCap({
      state,
      tiers: [[0], [1]],
      excludedIndices: new Set(),
      target: 20_000,
      ...trackers,
      capRemainingDollars: 10_000,
      magiCapConfig,
      onCapBreachDollars,
      onTierOverrideDollars,
      onPreTaxDrawn,
    });

    expect(drawn).toBeCloseTo(20_000, 5);
    // MIXED post fully drained ($5k).
    expect(state[0].post).toBeCloseTo(0, 1);
    // MIXED pre: $30k − $10k (cap) = $20k.
    expect(state[0].pre).toBeCloseTo(20_000, 1);
    // Brokerage: $50k − $5k (skip-ahead) = $45k.
    expect(state[1].post).toBeCloseTo(45_000, 1);
    expect(onPreTaxDrawn).toHaveBeenCalledWith(expect.closeTo(10_000, 1));
    expect(onTierOverrideDollars).toHaveBeenCalledWith(expect.closeTo(5_000, 1));
    expect(onCapBreachDollars).not.toHaveBeenCalled();
  });

  // ——— Regression: two taxable accounts in the SAME later tier ————————
  it('should_exhaust_all_taxable_accounts_in_same_later_tier_before_breaching', () => {
    // Tier 0: pre-tax $30k. Tier 1: TWO taxable accounts (brokerage $5k,
    // savings $20k). Cap = $10k; target = $30k.
    // Pre-fix bug: after routing $5k to the brokerage, the scan advanced
    // past tier 1, missing the savings account → engine recorded a phantom
    // $15k cap breach even though taxable balance was still available.
    // Post-fix: visited-set lets the resolver return the savings account on
    // the next iteration → full $20k taxable absorption, no breach.
    const state: AccountRunState[] = [
      makeState({ id: 'a0', pre: 30_000, taxTreatment: 'PRE_TAX' }),
      makeState({ id: 'a1', post: 5_000, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }),
      makeState({ id: 'a2', post: 20_000, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }),
    ];
    const trackers = makeTrackers(3);
    const onCapBreachDollars = vi.fn();
    const onTierOverrideDollars = vi.fn();
    const onPreTaxDrawn = vi.fn();

    // Honour the `visited` contract: scan tier 1 first hit, then second.
    const resolver: MagiCapRuntimeConfig['findLaterTaxableIndex'] = (
      _tiers,
      _afterTierIdx,
      _state,
      visited,
    ) => {
      if (!visited.has(1)) return 1;
      if (!visited.has(2)) return 2;
      return undefined;
    };
    const magiCapConfig = makeCapConfig(10_000, 2040, resolver);

    const drawn = distributeWithdrawalByCustomTiersWithCap({
      state,
      tiers: [[0], [1, 2]],
      excludedIndices: new Set(),
      target: 30_000,
      ...trackers,
      capRemainingDollars: 10_000,
      magiCapConfig,
      onCapBreachDollars,
      onTierOverrideDollars,
      onPreTaxDrawn,
    });

    expect(drawn).toBeCloseTo(30_000, 5);
    // Pre-tax drawn = $10k (cap honored).
    expect(state[0].pre).toBeCloseTo(20_000, 1);
    // Brokerage fully drained ($5k).
    expect(state[1].post).toBeCloseTo(0, 1);
    // Savings: $20k − $15k overflow = $5k.
    expect(state[2].post).toBeCloseTo(5_000, 1);
    expect(onPreTaxDrawn).toHaveBeenCalledWith(expect.closeTo(10_000, 1));
    // Two skip-ahead diversions: $5k (brokerage) + $15k (savings).
    expect(onTierOverrideDollars).toHaveBeenCalledTimes(2);
    expect(onTierOverrideDollars).toHaveBeenNthCalledWith(1, expect.closeTo(5_000, 1));
    expect(onTierOverrideDollars).toHaveBeenNthCalledWith(2, expect.closeTo(15_000, 1));
    // No phantom breach — taxable absorbed the full overflow.
    expect(onCapBreachDollars).not.toHaveBeenCalled();
  });

  it('should_decrement_localCapRemaining_across_multiple_pre_tax_tiers', () => {
    // Two pre-tax tiers; cap = 15k; target = 10k (fits within cap).
    // Both tiers pre-tax; cap budget consumed across both without breach.
    const state: AccountRunState[] = [
      makeState({ id: 'a0', pre: 6_000, taxTreatment: 'PRE_TAX' }),
      makeState({ id: 'a1', pre: 6_000, taxTreatment: 'PRE_TAX' }),
    ];
    const trackers = makeTrackers(2);
    const onCapBreachDollars = vi.fn();
    const onTierOverrideDollars = vi.fn();
    const onPreTaxDrawn = vi.fn();

    // findLaterTaxableIndex returns undefined — no taxable anywhere.
    const magiCapConfig = makeCapConfig(15_000, 2040, () => undefined);

    const drawn = distributeWithdrawalByCustomTiersWithCap({
      state,
      tiers: [[0], [1]],
      excludedIndices: new Set(),
      target: 10_000,
      ...trackers,
      capRemainingDollars: 15_000,
      magiCapConfig,
      onCapBreachDollars,
      onTierOverrideDollars,
      onPreTaxDrawn,
    });

    // 6k from tier 0, 4k from tier 1 (total 10k within cap budget)
    expect(drawn).toBeCloseTo(10_000, 5);
    expect(state[0].pre).toBeCloseTo(0, 1);
    expect(state[1].pre).toBeCloseTo(2_000, 1);
    // No breach; no tier override.
    expect(onCapBreachDollars).not.toHaveBeenCalled();
    expect(onTierOverrideDollars).not.toHaveBeenCalled();
    // onPreTaxDrawn called for each tier's pre-tax draw.
    expect(onPreTaxDrawn).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// applyMonthlyDeposits — targeted-deposit bucket routing +
// household-share-stays-after-tax guard
// ---------------------------------------------------------------------------

/** State carrying a single targeted deposit of `amount` at month 0. */
function stateWithTargetedDeposit(
  overrides: Partial<AccountRunState>,
  amount: number,
): AccountRunState {
  const deposits = new Float64Array(1);
  deposits[0] = amount;
  return makeState({ ...overrides, deposits });
}

describe('applyMonthlyDeposits — a targeted deposit lands in the bucket matching the destination', () => {
  it('a rollover into a pre-tax account is held as pre-tax money', () => {
    const state = [
      stateWithTargetedDeposit(
        { id: 'ira', pre: 100_000, post: 0, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' },
        50_000,
      ),
    ];
    applyMonthlyDeposits({ state, stepIdx: 0, householdDepositAmount: 0, yearDepositByAcct: [0] });
    expect(state[0].pre).toBeCloseTo(150_000, 1);
    expect(state[0].post).toBeCloseTo(0, 1);
  });

  it('a rollover into a mixed account is held as pre-tax money', () => {
    const state = [
      stateWithTargetedDeposit(
        { id: 'mix', pre: 60_000, post: 40_000, taxTreatment: 'MIXED', accountType: 'RETIREMENT_401K' },
        50_000,
      ),
    ];
    applyMonthlyDeposits({ state, stepIdx: 0, householdDepositAmount: 0, yearDepositByAcct: [0] });
    expect(state[0].pre).toBeCloseTo(110_000, 1);
    expect(state[0].post).toBeCloseTo(40_000, 1);
  });

  it.each([
    ['a taxable brokerage', 'POST_TAX', 'BROKERAGE'],
    ['a Roth IRA', 'ROTH', 'RETIREMENT_ROTH_IRA'],
    ['an HSA', 'HSA', 'HSA'],
  ] as const)('a deposit into %s is held as after-tax money', (_label, treatment, accountType) => {
    const state = [
      stateWithTargetedDeposit(
        { id: 'dest', pre: 0, post: 100_000, taxTreatment: treatment, accountType },
        50_000,
      ),
    ];
    applyMonthlyDeposits({ state, stepIdx: 0, householdDepositAmount: 0, yearDepositByAcct: [0] });
    expect(state[0].post).toBeCloseTo(150_000, 1);
    expect(state[0].pre).toBeCloseTo(0, 1);
  });

  it('a shared household contribution never adds to a pre-tax account pocket (household-share guard)', () => {
    // The proportional household-share spread is unchanged: even when it
    // flows into a PRE_TAX account it stays in the after-tax pocket, so it never
    // inflates that account's drawable pre-tax balance (and so cannot push its
    // RMD floor above what can be withdrawn).
    const state = [
      makeState({ id: 'ira', pre: 100_000, post: 0, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA', deposits: new Float64Array(1) }),
    ];
    applyMonthlyDeposits({ state, stepIdx: 0, householdDepositAmount: 12_000, yearDepositByAcct: [0] });
    expect(state[0].pre).toBeCloseTo(100_000, 1);
    expect(state[0].post).toBeCloseTo(12_000, 1);
  });

  it('the synthetic RMD-overflow cash carrier keeps its targeted credit in the after-tax pocket', () => {
    const state = [
      stateWithTargetedDeposit(
        { id: RMD_OVERFLOW_CASH_ACCOUNT_ID, pre: 0, post: 5_000, taxTreatment: 'POST_TAX', accountType: 'SAVINGS' },
        3_000,
      ),
    ];
    applyMonthlyDeposits({ state, stepIdx: 0, householdDepositAmount: 0, yearDepositByAcct: [0] });
    expect(state[0].pre).toBeCloseTo(0, 1);
    expect(state[0].post).toBeCloseTo(8_000, 1);
  });
});

// ---------------------------------------------------------------------------
// classifyTrialYearDraw — named-strategy HSA TOTAL surfaced exactly
// ---------------------------------------------------------------------------

/** Build a single-month within-year context (no growth, no deposits/income):
 *  all need + medical demand land in month 0 of `yearIndex` 0. */
function singleMonthWithin(args: {
  readonly need: number;
  readonly medical: number;
  readonly hsaIndices: ReadonlyArray<number>;
}): TrialWithinYearInputs {
  const expense = new Float64Array(12);
  expense[0] = args.need;
  const medicalDemand = new Float64Array(12);
  medicalDemand[0] = args.medical;
  return {
    yearIndex: 0,
    expense,
    income: new Float64Array(12),
    householdDeposit: new Float64Array(12),
    yearNetNeed: args.need,
    hsaIndices: args.hsaIndices,
    medicalDemand,
  };
}

/** The balance-share fallback `buildSolverPenaltyAccountsForYear` would use when
 *  the classifier omits the exact HSA total: cash-like draw × HSA's balance
 *  share of all cash-like ledger balances (`hsaShareOfCashLike`). */
function balanceShareFallback(
  cashLikeDraw: number,
  hsaBalance: number,
  otherCashLikeBalance: number,
): number {
  return cashLikeDraw * (hsaBalance / (hsaBalance + otherCashLikeBalance));
}

describe('classifyTrialYearDraw — named strategy surfaces the EXACT HSA total', () => {
  // Zero-growth HSA + a larger SAVINGS account in the cash-like bucket, plus a
  // pre-tax account for the ordinary draw. taxEfficient holds HSA out of the
  // strategy tiers, so the HSA is drawn ONLY via the medical-first / emergency
  // two-pass — the exact total the committing path produces.
  const HSA_IDX = 0;

  it('feeds the exact medical-first HSA total, not the balance-share proportion', () => {
    const state: AccountRunState[] = [
      makeState({ id: 'hsa', post: 10_000, taxTreatment: 'HSA', accountType: 'HSA', monthlyRate: 0 }),
      makeState({ id: 'sav', post: 90_000, taxTreatment: 'POST_TAX', accountType: 'SAVINGS', monthlyRate: 0 }),
      makeState({ id: 'ira', pre: 100_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA', monthlyRate: 0 }),
    ];
    // Need $20k, medical demand $4k. Medical-first HSA = $4k; the ordinary router
    // funds the remaining $16k from SAVINGS (HSA held out) → no emergency HSA.
    const cls = classifyTrialYearDraw({
      state,
      strategyKind: 'taxEfficient',
      rmdForcedTotal: 0,
      totalTargetDollars: 20_000,
      capRemainingDollars: null,
      within: singleMonthWithin({ need: 20_000, medical: 4_000, hsaIndices: [HSA_IDX] }),
    });
    // Exact HSA total = the $4k medical-first draw (no emergency this year).
    expect(cls.hsaWithdrawalDollars).toBeCloseTo(4_000, 6);
    expect(cls.hsaMedicalQualifiedDollars).toBeCloseTo(4_000, 6);
    // The cash-like bucket carries the HSA total + the $16k savings draw = $20k.
    expect(cls.postTaxCashLikeDollars).toBeCloseTo(20_000, 6);
    // The balance-share fallback would have under-stated the HSA total ($2k) —
    // the exact surfaced total ($4k) does NOT equal the fallback.
    const fallback = balanceShareFallback(cls.postTaxCashLikeDollars, 10_000, 90_000);
    expect(fallback).toBeCloseTo(2_000, 6);
    expect(cls.hsaWithdrawalDollars).not.toBeCloseTo(fallback, 2);
  });

  it('includes the emergency residual in the exact HSA total when the non-HSA pool is exhausted', () => {
    const state: AccountRunState[] = [
      makeState({ id: 'hsa', post: 10_000, taxTreatment: 'HSA', accountType: 'HSA', monthlyRate: 0 }),
      makeState({ id: 'sav', post: 5_000, taxTreatment: 'POST_TAX', accountType: 'SAVINGS', monthlyRate: 0 }),
    ];
    // Need $12k, medical demand $3k. Medical-first HSA = $3k; the router drains
    // the $5k SAVINGS; the $4k residual is funded from HSA (emergency). So the
    // exact HSA total = $3k medical + $4k emergency = $7k.
    const cls = classifyTrialYearDraw({
      state,
      strategyKind: 'taxEfficient',
      rmdForcedTotal: 0,
      totalTargetDollars: 12_000,
      capRemainingDollars: null,
      within: singleMonthWithin({ need: 12_000, medical: 3_000, hsaIndices: [HSA_IDX] }),
    });
    expect(cls.hsaWithdrawalDollars).toBeCloseTo(7_000, 6);
    expect(cls.hsaMedicalQualifiedDollars).toBeCloseTo(3_000, 6);
    // The §223 emergency basis the solver derives = total − medical = $4k.
    expect((cls.hsaWithdrawalDollars ?? 0) - (cls.hsaMedicalQualifiedDollars ?? 0)).toBeCloseTo(
      4_000,
      6,
    );
    // The balance-share fallback would have over-stated the HSA total ($8k) and
    // thus mis-stated the emergency basis — the exact total ($7k) differs.
    const fallback = balanceShareFallback(cls.postTaxCashLikeDollars, 10_000, 5_000);
    expect(fallback).toBeCloseTo(8_000, 6);
    expect(cls.hsaWithdrawalDollars).not.toBeCloseTo(fallback, 2);
  });
});

describe('classifyCommittedYearDraw — inherited Roth IRA subset', () => {
  // The COMMITTED classifier is the one the Fill-mode conversion probe reads
  // (`drawdown-engine-roth-conversion.ts`), so it needs its own coverage: the
  // trial classifier's tests cannot fail for it.
  const ROTH_IRA_DRAW = 12_000;
  const PRE_TAX_DRAW = 30_000;

  function classify(rothIraState: Partial<AccountRunState>): ReturnType<
    typeof classifyCommittedYearDraw
  > {
    const state: AccountRunState[] = [
      makeState({ id: 'ira', pre: 100_000, taxTreatment: 'PRE_TAX', accountType: 'RETIREMENT_IRA' }),
      makeState({
        id: 'roth',
        post: 100_000,
        taxTreatment: 'ROTH',
        accountType: 'RETIREMENT_ROTH_IRA',
        ...rothIraState,
      }),
    ];
    return classifyCommittedYearDraw(state, [PRE_TAX_DRAW, 0], [0, ROTH_IRA_DRAW]);
  }

  it('reports an inherited Roth IRA draw as a SUBSET of the Roth tranche', () => {
    const cls = classify({ inheritedAccount: true });
    expect(cls.rothInheritedTaxFreeDollars).toBeCloseTo(ROTH_IRA_DRAW, 6);
    // A subset, never a deduction: the Roth and funded totals do not move.
    expect(cls.rothDollars).toBeCloseTo(ROTH_IRA_DRAW, 6);
    expect(cls.fundedDollars).toBeCloseTo(PRE_TAX_DRAW + ROTH_IRA_DRAW, 6);
  });

  it('emits nothing for an inherited DESIGNATED-Roth plan (§402A unchanged)', () => {
    const cls = classify({ accountType: 'RETIREMENT_ROTH_401K', inheritedAccount: true });
    expect(cls.rothInheritedTaxFreeDollars).toBeUndefined();
    expect(cls.rothDollars).toBeCloseTo(ROTH_IRA_DRAW, 6);
  });

  it('emits nothing when the Roth IRA carries no inherited marker', () => {
    const cls = classify({});
    expect(cls.rothInheritedTaxFreeDollars).toBeUndefined();
    expect(cls.rothDollars).toBeCloseTo(ROTH_IRA_DRAW, 6);
  });

  it('attributes each stateful Roth slice to the ACCOUNT it left (per-owner funding)', () => {
    // The aggregate subsets carry no owner information; the funding solver maps
    // these account ids to their real owners so each owner's basis/lots are
    // charged with that owner's own drawn dollars.
    const state: AccountRunState[] = [
      makeState({ id: 'roth-ira-a', post: 100_000, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }),
      makeState({ id: 'roth-401k-b', post: 100_000, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_401K' }),
      makeState({
        id: 'roth-403b-inh',
        post: 100_000,
        taxTreatment: 'ROTH',
        accountType: 'RETIREMENT_ROTH_403B',
        inheritedAccount: true,
      }),
    ];
    const cls = classifyCommittedYearDraw(state, [0, 0, 0], [5_000, 7_000, 3_000]);
    expect([...(cls.rothIraDollarsByAccountId ?? new Map())]).toEqual([['roth-ira-a', 5_000]]);
    expect([...(cls.rothDesignatedDollarsByAccountId ?? new Map())]).toEqual([
      ['roth-401k-b', 7_000],
    ]);
    expect([...(cls.rothInheritedDesignatedDollarsByAccountId ?? new Map())]).toEqual([
      ['roth-403b-inh', 3_000],
    ]);
    // The attribution maps are per-slice detail; the aggregate totals stand.
    expect(cls.rothDollars).toBeCloseTo(15_000, 6);
    expect(cls.rothDesignatedDollars).toBeCloseTo(7_000, 6);
    expect(cls.rothInheritedDesignatedDollars).toBeCloseTo(3_000, 6);
  });
});

describe('isMagiNeutralPostBucket — MIXED Roth-designated', () => {
  it('returns true for HSA', () => {
    expect(isMagiNeutralPostBucket(makeState({ taxTreatment: 'HSA', accountType: 'HSA' }))).toBe(true);
  });

  it('returns true for RETIREMENT_ROTH_IRA and pure employer Roth types', () => {
    for (const accountType of [
      'RETIREMENT_ROTH_IRA',
      'RETIREMENT_ROTH_401K',
      'RETIREMENT_ROTH_403B',
      'RETIREMENT_ROTH_457B',
      'RETIREMENT_ROTH_TSP',
    ] as const) {
      expect(isMagiNeutralPostBucket(makeState({ taxTreatment: 'ROTH', accountType }))).toBe(true);
    }
  });

  it('returns true for MIXED Roth-designated types (401K/403B/457B/TSP)', () => {
    for (const accountType of [
      'RETIREMENT_401K',
      'RETIREMENT_403B',
      'RETIREMENT_457B',
      'RETIREMENT_TSP',
    ] as const) {
      expect(
        isMagiNeutralPostBucket(makeState({ taxTreatment: 'MIXED', accountType })),
      ).toBe(true);
    }
  });

  it('returns false for MIXED IRA (non-Roth-designated)', () => {
    expect(
      isMagiNeutralPostBucket(makeState({ taxTreatment: 'MIXED', accountType: 'RETIREMENT_IRA' })),
    ).toBe(false);
  });

  it('returns true for cash-like POST_TAX types (SAVINGS/MM/CD)', () => {
    for (const accountType of ['SAVINGS', 'MONEY_MARKET', 'CD'] as const) {
      expect(
        isMagiNeutralPostBucket(makeState({ taxTreatment: 'POST_TAX', accountType })),
      ).toBe(true);
    }
  });

  it('returns false for brokerage POST_TAX', () => {
    expect(
      isMagiNeutralPostBucket(makeState({ taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' })),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Per-account balance floors — cap distributor respects them
// ---------------------------------------------------------------------------

describe('account floors — MAGI-cap distributor', () => {
  function capCfg(capDollars: number): MagiCapRuntimeConfig {
    return {
      capDollars,
      capOffYear: 2040,
      capMode: 'minimize',
      capMagiLine: 'irmaa',
      findTargetRothIndex: () => undefined,
      findLaterTaxableIndex: () => undefined,
    };
  }

  it('caps a floored POST_TAX tier draw at its drawable above the floor (committing draw)', () => {
    // Brokerage $100k with a $40k floor in tier 0; cap inactive for post-tax.
    const state: AccountRunState[] = [
      makeState({
        id: 'broker', post: 100_000, taxTreatment: 'POST_TAX',
        accountType: 'BROKERAGE', floorDollars: 40_000,
      }),
    ];
    const trackers = makeTrackers(1);
    const drawn = distributeWithdrawalByCustomTiersWithCap({
      state,
      tiers: [[0]],
      excludedIndices: new Set(),
      target: 80_000,
      ...trackers,
      capRemainingDollars: 50_000,
      magiCapConfig: capCfg(50_000),
      onCapBreachDollars: vi.fn(),
      onTierOverrideDollars: vi.fn(),
      onPreTaxDrawn: vi.fn(),
    });
    // Only $60k is drawable (above the $40k floor); the rest is unmet.
    expect(drawn).toBeCloseTo(60_000, 4);
    expect(state[0].post).toBeCloseTo(40_000, 4);
  });

  it('skip-ahead diverts a LATER-tier POST_TAX floor reserve before a pre-tax breach', () => {
    // Tier 0 pre-tax (cap exhausted at $0), tier 1 floored brokerage below cap.
    // The skip-ahead diverts the
    // brokerage's BELOW-floor reserve too, so the whole need is cap-safe and NO
    // breach is recorded (the reserve drains before an avoidable breach).
    const state: AccountRunState[] = [
      makeState({ id: 'pre', pre: 50_000, taxTreatment: 'PRE_TAX' }),
      makeState({
        id: 'broker', post: 30_000, taxTreatment: 'POST_TAX',
        accountType: 'BROKERAGE', floorDollars: 25_000,
      }),
    ];
    const trackers = makeTrackers(2);
    const onTierOverrideDollars = vi.fn();
    const onCapBreachDollars = vi.fn();
    const cfg: MagiCapRuntimeConfig = { ...capCfg(0), findLaterTaxableIndex: () => 1 };
    distributeWithdrawalByCustomTiersWithCap({
      state,
      tiers: [[0], [1]],
      excludedIndices: new Set(),
      target: 20_000,
      ...trackers,
      capRemainingDollars: 0,
      magiCapConfig: cfg,
      onCapBreachDollars,
      onTierOverrideDollars,
      onPreTaxDrawn: vi.fn(),
    });
    // Brokerage diverts the full $20k (incl. $5k below the $25k floor); no breach.
    expect(state[1].post).toBeCloseTo(10_000, 4);
    expect(onTierOverrideDollars).toHaveBeenCalledWith(expect.closeTo(20_000, 1));
    expect(onCapBreachDollars).not.toHaveBeenCalled();
    expect(state[0].pre).toBeCloseTo(50_000, 4); // pre-tax untouched (cap-safe funded)
  });

  it('negative: once POST_TAX cap-safe reserves are exhausted a pre-tax breach still records', () => {
    // Tier 0 pre-tax (cap exhausted), tier 1 floored brokerage with only $30k. The
    // reserve fully drains ($30k) but the need is $50k → the $20k residual breaches
    // the pre-tax tier via the EXISTING (unchanged) path. Pre-tax is never a
    // reserve (floor eligibility is POST_TAX/HSA only).
    const state: AccountRunState[] = [
      makeState({ id: 'pre', pre: 50_000, taxTreatment: 'PRE_TAX' }),
      makeState({
        id: 'broker', post: 30_000, taxTreatment: 'POST_TAX',
        accountType: 'BROKERAGE', floorDollars: 25_000,
      }),
    ];
    const trackers = makeTrackers(2);
    const onTierOverrideDollars = vi.fn();
    const onCapBreachDollars = vi.fn();
    const cfg: MagiCapRuntimeConfig = { ...capCfg(0), findLaterTaxableIndex: () => 1 };
    distributeWithdrawalByCustomTiersWithCap({
      state,
      tiers: [[0], [1]],
      excludedIndices: new Set(),
      target: 50_000,
      ...trackers,
      capRemainingDollars: 0,
      magiCapConfig: cfg,
      onCapBreachDollars,
      onTierOverrideDollars,
      onPreTaxDrawn: vi.fn(),
    });
    expect(state[1].post).toBeCloseTo(0, 4); // reserve fully drained
    expect(onTierOverrideDollars).toHaveBeenCalledWith(expect.closeTo(30_000, 1));
    expect(onCapBreachDollars).toHaveBeenCalledWith(expect.closeTo(20_000, 1));
    expect(state[0].pre).toBeCloseTo(30_000, 4); // $20k breached from pre-tax
  });

  it('a LATER-tier HSA below its floor is NEVER diverted as cap-safe (breach records)', () => {
    // Tier 0 pre-tax (cap exhausted), tier 1 floored HSA below its floor. The
    // resolver `findLaterTaxableIndex` returns the HSA (any post>0), but the
    // reserve fallback is POST_TAX-ONLY — an HSA below-floor reserve is
    // nonqualified ordinary income, NOT cap-safe. So only the $2k above the floor
    // diverts and the $18k residual breaches the pre-tax tier.
    const state: AccountRunState[] = [
      makeState({ id: 'pre', pre: 50_000, taxTreatment: 'PRE_TAX' }),
      makeState({
        id: 'hsa', post: 30_000, taxTreatment: 'HSA',
        accountType: 'HSA', floorDollars: 28_000,
      }),
    ];
    const trackers = makeTrackers(2);
    const onTierOverrideDollars = vi.fn();
    const onCapBreachDollars = vi.fn();
    const cfg: MagiCapRuntimeConfig = { ...capCfg(0), findLaterTaxableIndex: () => 1 };
    distributeWithdrawalByCustomTiersWithCap({
      state,
      tiers: [[0], [1]],
      excludedIndices: new Set(),
      target: 20_000,
      ...trackers,
      capRemainingDollars: 0,
      magiCapConfig: cfg,
      onCapBreachDollars,
      onTierOverrideDollars,
      onPreTaxDrawn: vi.fn(),
    });
    expect(state[1].post).toBeCloseTo(28_000, 4); // HSA stops at its floor (not cap-safe below)
    expect(onTierOverrideDollars).toHaveBeenCalledWith(expect.closeTo(2_000, 1));
    expect(onCapBreachDollars).toHaveBeenCalledWith(expect.closeTo(18_000, 1));
  });

  it('an EARLIER-tier POST_TAX reserve is out of forward-only skip-ahead reach (breach records)', () => {
    // Tier 0 floored brokerage (already drawn to its ordinary floor), tier 1
    // pre-tax cap-blocked with NO later cap-safe tier. `findLaterTaxableIndex`
    // scans tiers AFTER the current one only, so the earlier-tier POST_TAX reserve
    // is unreachable here — a breach is still recorded. The general
    // last-resort drawFloorReserve pass drains that earlier reserve later, not
    // through this before-breach path.
    const state: AccountRunState[] = [
      makeState({
        id: 'broker', post: 25_000, taxTreatment: 'POST_TAX',
        accountType: 'BROKERAGE', floorDollars: 25_000, // sitting AT its floor
      }),
      makeState({ id: 'pre', pre: 50_000, taxTreatment: 'PRE_TAX' }),
    ];
    const trackers = makeTrackers(2);
    const onTierOverrideDollars = vi.fn();
    const onCapBreachDollars = vi.fn();
    // No later cap-safe tier after the pre-tax tier.
    const cfg: MagiCapRuntimeConfig = { ...capCfg(0), findLaterTaxableIndex: () => undefined };
    distributeWithdrawalByCustomTiersWithCap({
      state,
      tiers: [[0], [1]],
      excludedIndices: new Set(),
      target: 15_000,
      ...trackers,
      capRemainingDollars: 0,
      magiCapConfig: cfg,
      onCapBreachDollars,
      onTierOverrideDollars,
      onPreTaxDrawn: vi.fn(),
    });
    // Brokerage at its floor supplies its $0 above-floor drawable in tier 0; the
    // pre-tax tier then breaches for the full $15k. The earlier reserve is NOT
    // reached by the skip-ahead.
    expect(state[0].post).toBeCloseTo(25_000, 4); // earlier reserve untouched by skip-ahead
    expect(onTierOverrideDollars).not.toHaveBeenCalled();
    expect(onCapBreachDollars).toHaveBeenCalledWith(expect.closeTo(15_000, 1));
    expect(state[1].pre).toBeCloseTo(35_000, 4);
  });

  it('trial classifier and committing draw produce the same floor-constrained pre/post split', () => {
    // Floored brokerage (tier 0, floor $40k) + pre-tax (tier 1). Target $70k:
    // brokerage supplies $60k (down to floor), pre-tax supplies $10k. The trial
    // classifier must see the SAME split so the MAGI gross-up is consistent.
    const within: TrialWithinYearInputs = {
      yearIndex: 0,
      expense: new Float64Array(12).fill(70_000 / 12),
      income: new Float64Array(12),
      householdDeposit: new Float64Array(12),
      yearNetNeed: 70_000,
    };
    const mkState = (): AccountRunState[] => [
      makeState({
        id: 'broker', post: 100_000, taxTreatment: 'POST_TAX',
        accountType: 'BROKERAGE', floorDollars: 40_000,
        // 0% growth so the trial within-year sim's drawable is exactly the
        // floor-constrained $60k (no growth re-opening more above the floor).
        annualRatePct: 0, monthlyRate: 0,
      }),
      makeState({ id: 'pre', pre: 100_000, taxTreatment: 'PRE_TAX', annualRatePct: 0, monthlyRate: 0 }),
    ];
    const cls = classifyTrialYearDraw({
      state: mkState(),
      strategyKind: 'taxEfficient',
      rmdForcedTotal: 0,
      totalTargetDollars: 70_000,
      capRemainingDollars: null,
      within,
    });
    // Brokerage (cash-like POST_TAX brokerage → postTaxNonRoth) supplies $60k;
    // pre-tax supplies $10k — the floor-constrained split.
    expect(cls.postTaxNonRothDollars).toBeCloseTo(60_000, 3);
    expect(cls.preTaxDollars).toBeCloseTo(10_000, 3);
    expect(cls.fundedDollars).toBeCloseTo(70_000, 3);
  });

  it('the trial classifier reaches the floor RESERVE for a floored-only year', () => {
    // Floored-only brokerage: $100k, floor $40k, target $80k. The trial sim runs
    // the SAME drawFloorReserve the committing path does — ordinary $60k above the
    // floor + $20k reserve below it = the full $80k, all POST_TAX brokerage
    // (postTaxNonRoth). This is the tax-bucket total the committing year produces
    // for the reserve-funded year (matching split → matching gross-up).
    const within: TrialWithinYearInputs = {
      yearIndex: 0,
      expense: new Float64Array(12).fill(80_000 / 12),
      income: new Float64Array(12),
      householdDeposit: new Float64Array(12),
      yearNetNeed: 80_000,
    };
    const cls = classifyTrialYearDraw({
      state: [
        makeState({
          id: 'broker', post: 100_000, taxTreatment: 'POST_TAX',
          accountType: 'BROKERAGE', floorDollars: 40_000, annualRatePct: 0, monthlyRate: 0,
        }),
      ],
      strategyKind: 'taxEfficient',
      rmdForcedTotal: 0,
      totalTargetDollars: 80_000,
      capRemainingDollars: null,
      within,
    });
    expect(cls.postTaxNonRothDollars).toBeCloseTo(80_000, 3); // reserve included
    expect(cls.fundedDollars).toBeCloseTo(80_000, 3);
  });

  it('does NOT floor an ineligible PRE_TAX account with a stray floor in the cap path', () => {
    const state: AccountRunState[] = [
      makeState({
        id: 'pre', pre: 100_000, taxTreatment: 'PRE_TAX', floorDollars: 40_000,
      }),
    ];
    const trackers = makeTrackers(1);
    const drawn = distributeWithdrawalByCustomTiersWithCap({
      state,
      tiers: [[0]],
      excludedIndices: new Set(),
      target: 80_000,
      ...trackers,
      capRemainingDollars: 100_000,
      magiCapConfig: capCfg(100_000),
      onCapBreachDollars: vi.fn(),
      onTierOverrideDollars: vi.fn(),
      onPreTaxDrawn: vi.fn(),
    });
    // PRE_TAX is floor-ineligible → full $80k drawn despite the stray floor.
    expect(drawn).toBeCloseTo(80_000, 4);
    expect(state[0].pre).toBeCloseTo(20_000, 4);
  });
});
