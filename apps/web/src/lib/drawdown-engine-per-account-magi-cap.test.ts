/**
 * Unit tests for `drawdown-engine-per-account-magi-cap.ts`.
 *
 * Covers the `findLaterTaxableIndex` resolver built by `buildMagiCapConfig`:
 * which later-tier accounts count as cap-safe overflow targets (POST_TAX
 * non-Roth, MIXED, AND Roth — all zero-added-MAGI buckets, per the
 * tax-funding sourcing precedence). End-to-end the same precedence is proven
 * against `distributeWithdrawalByCustomTiersWithCap` (taxable depleted, Roth
 * available → no breach; Roth also depleted → breach). The precedence is
 * taxable / Roth before capped pre-tax.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildMagiCapConfig } from './drawdown-engine-per-account-magi-cap';
import { distributeWithdrawalByCustomTiersWithCap } from './drawdown-engine-per-account-strategy-cap';
import type { AccountRunState } from './drawdown-engine-per-account-strategy-helpers';
import type { MagiCapWindow } from '../db/types';

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

const CAP: MagiCapWindow = {
  start: { kind: 'retirementStart' },
  end: { kind: 'age', memberId: 'primary', years: 65, months: 0 },
  magiCeilingAnnualDollars: 10_000,
  capMode: 'minimize',
  capMagiLine: 'irmaa',
};

describe('buildMagiCapConfig — capMode / capMagiLine defaults', () => {
  it('should_default_capMode_to_minimize_and_capMagiLine_to_irmaa_when_absent', () => {
    const cfg = buildMagiCapConfig(CAP, 2040);
    expect(cfg.capMode).toBe('minimize');
    expect(cfg.capMagiLine).toBe('irmaa');
    expect(cfg.targetRothAccountId).toBeUndefined();
  });

  it('should_thread_explicit_Fill_mode_keys_onto_the_runtime_config', () => {
    const cfg = buildMagiCapConfig(
      { ...CAP, capMode: 'fill', capMagiLine: 'aca', targetRothAccountId: 'roth-1' },
      2040,
    );
    expect(cfg.capMode).toBe('fill');
    expect(cfg.capMagiLine).toBe('aca');
    expect(cfg.targetRothAccountId).toBe('roth-1');
  });
});

describe('buildMagiCapConfig — findTargetRothIndex resolver', () => {
  const ROTH = makeState({
    id: 'roth-1',
    post: 50_000,
    taxTreatment: 'ROTH',
    accountType: 'RETIREMENT_ROTH_IRA',
  });
  const PRE = makeState({ id: 'pre-1', pre: 50_000, taxTreatment: 'PRE_TAX' });

  it('should_resolve_the_target_Roth_by_equality_to_an_own_household_live_Roth', () => {
    const cfg = buildMagiCapConfig({ ...CAP, targetRothAccountId: 'roth-1' }, 2040);
    expect(cfg.findTargetRothIndex([PRE, ROTH])).toBe(1);
  });

  it('should_resolve_undefined_when_no_target_is_configured', () => {
    const cfg = buildMagiCapConfig(CAP, 2040);
    expect(cfg.findTargetRothIndex([PRE, ROTH])).toBeUndefined();
  });

  it('should_degrade_to_undefined_when_the_target_id_is_dangling_or_deleted', () => {
    const cfg = buildMagiCapConfig({ ...CAP, targetRothAccountId: 'gone' }, 2040);
    expect(cfg.findTargetRothIndex([PRE, ROTH])).toBeUndefined();
  });

  it('should_degrade_to_undefined_when_the_target_id_resolves_to_a_non_Roth_account', () => {
    // Guards a stale id: a user-designated id that points at a pre-tax account (e.g.
    // the Roth was deleted and the id reused) must NOT receive conversions.
    const cfg = buildMagiCapConfig({ ...CAP, targetRothAccountId: 'pre-1' }, 2040);
    expect(cfg.findTargetRothIndex([PRE, ROTH])).toBeUndefined();
  });

  it('should_degrade_to_undefined_when_the_target_is_a_designated_Roth_employer_type', () => {
    // Employer Roth accounts are not valid conversion targets: routing a
    // pre-tax → designated-Roth employer conversion would silently no-op the
    // at-retirement basis fold and re-tax the principal.
    for (const accountType of [
      'RETIREMENT_ROTH_401K',
      'RETIREMENT_ROTH_403B',
      'RETIREMENT_ROTH_457B',
      'RETIREMENT_ROTH_TSP',
    ] as const) {
      const empRoth = makeState({
        id: 'emp-roth',
        post: 50_000,
        taxTreatment: 'ROTH',
        accountType,
      });
      const cfg = buildMagiCapConfig({ ...CAP, targetRothAccountId: 'emp-roth' }, 2040);
      expect(cfg.findTargetRothIndex([PRE, empRoth])).toBeUndefined();
    }
  });

  it('should_degrade_to_undefined_when_the_target_Roth_IRA_is_inherited', () => {
    // A beneficiary cannot roll into an inherited IRA, and the basis credit
    // (`creditRothConversionToBasisCarrier`) keys on the BENEFICIARY's own §408A
    // pool — converting into one would buy tax-free basis on their own Roth IRAs.
    const inheritedRoth = makeState({
      id: 'roth-inh',
      post: 50_000,
      taxTreatment: 'ROTH',
      accountType: 'RETIREMENT_ROTH_IRA',
      inheritedAccount: true,
    });
    const cfg = buildMagiCapConfig({ ...CAP, targetRothAccountId: 'roth-inh' }, 2040);
    expect(cfg.findTargetRothIndex([PRE, inheritedRoth])).toBeUndefined();
    // The same account without the marker still resolves — the marker is what
    // rejects it, not the id or the type.
    expect(
      cfg.findTargetRothIndex([PRE, { ...inheritedRoth, inheritedAccount: false }]),
    ).toBe(1);
  });
});

describe('buildMagiCapConfig — findLaterTaxableIndex', () => {
  it('should_treat_a_later_Roth_account_as_a_cap_safe_overflow_target', () => {
    // Paying the over-cap draw from already-taxed buckets (taxable AND
    // Roth) avoids inflating MAGI. A Roth account in a later tier (ROTH
    // treatment, balance in `post`) is a zero-added-MAGI target — must be
    // selected.
    const { findLaterTaxableIndex } = buildMagiCapConfig(CAP, 2040);
    const state: AccountRunState[] = [
      makeState({ id: 'a0', pre: 50_000, taxTreatment: 'PRE_TAX' }),
      makeState({
        id: 'a1',
        post: 50_000,
        taxTreatment: 'ROTH',
        accountType: 'RETIREMENT_ROTH_IRA',
      }),
    ];

    const idx = findLaterTaxableIndex([[0], [1]], 0, state, new Set());

    expect(idx).toBe(1);
  });

  it('should_skip_a_later_Roth_account_with_no_post_balance', () => {
    const { findLaterTaxableIndex } = buildMagiCapConfig(CAP, 2040);
    const state: AccountRunState[] = [
      makeState({ id: 'a0', pre: 50_000, taxTreatment: 'PRE_TAX' }),
      makeState({
        id: 'a1',
        post: 0,
        taxTreatment: 'ROTH',
        accountType: 'RETIREMENT_ROTH_IRA',
      }),
    ];

    const idx = findLaterTaxableIndex([[0], [1]], 0, state, new Set());

    expect(idx).toBeUndefined();
  });
});

describe('MAGI-cap tax-funding precedence — Roth before breach', () => {
  // taxEfficient tier layout: tier0 = taxable, tier1 = pre-tax, tier2 = Roth.
  // With taxable already depleted, the over-cap draw must source the Roth
  // tier before breaching the pre-tax cap — magiCapBreachDollars stays 0.
  it('should_draw_Roth_before_breaching_when_taxable_depleted_and_Roth_available', () => {
    const state: AccountRunState[] = [
      makeState({ id: 'taxable', post: 0, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }),
      makeState({ id: 'pre', pre: 50_000, taxTreatment: 'PRE_TAX' }),
      makeState({ id: 'roth', post: 50_000, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }),
    ];
    const trackers = makeTrackers(3);
    const onCapBreachDollars = vi.fn();
    const onTierOverrideDollars = vi.fn();
    const onPreTaxDrawn = vi.fn();
    const magiCapConfig = buildMagiCapConfig(CAP, 2040);

    // Cap = $10k; target = $15k → $10k pre-tax (cap), $5k must come from Roth.
    const drawn = distributeWithdrawalByCustomTiersWithCap({
      state,
      tiers: [[0], [1], [2]],
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
    // Pre-tax capped at $10k.
    expect(state[1].pre).toBeCloseTo(40_000, 1);
    // Roth absorbs the $5k over-cap remainder (zero added MAGI).
    expect(state[2].post).toBeCloseTo(45_000, 1);
    expect(onTierOverrideDollars).toHaveBeenCalledWith(expect.closeTo(5_000, 1));
    // No breach — Roth covered the overflow.
    expect(onCapBreachDollars).not.toHaveBeenCalled();
  });

  it('should_breach_only_after_both_taxable_and_Roth_are_exhausted', () => {
    const state: AccountRunState[] = [
      makeState({ id: 'taxable', post: 0, taxTreatment: 'POST_TAX', accountType: 'BROKERAGE' }),
      makeState({ id: 'pre', pre: 50_000, taxTreatment: 'PRE_TAX' }),
      makeState({ id: 'roth', post: 3_000, taxTreatment: 'ROTH', accountType: 'RETIREMENT_ROTH_IRA' }),
    ];
    const trackers = makeTrackers(3);
    const onCapBreachDollars = vi.fn();
    const onTierOverrideDollars = vi.fn();
    const onPreTaxDrawn = vi.fn();
    const magiCapConfig = buildMagiCapConfig(CAP, 2040);

    // Cap = $10k; target = $15k → $10k pre-tax (cap), $3k Roth, $2k breach.
    const drawn = distributeWithdrawalByCustomTiersWithCap({
      state,
      tiers: [[0], [1], [2]],
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
    // Roth fully drained ($3k).
    expect(state[2].post).toBeCloseTo(0, 1);
    // Pre-tax: $10k cap + $2k breach = $12k.
    expect(state[1].pre).toBeCloseTo(38_000, 1);
    expect(onTierOverrideDollars).toHaveBeenCalledWith(expect.closeTo(3_000, 1));
    // Breach fires only after taxable AND Roth deplete.
    expect(onCapBreachDollars).toHaveBeenCalledWith(expect.closeTo(2_000, 1));
  });
});
