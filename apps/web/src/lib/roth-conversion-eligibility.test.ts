/**
 * Predicate matrix for all eligibility helpers.
 *
 * Covers:
 *  - PRE_TAX 401k source kept
 *  - MIXED 401k/403b/457b/TSP source kept
 *  - PRE_TAX/MIXED OTHER source kept (has real pre-tax sub-bucket)
 *  - CBP source excluded
 *  - Inactive source excluded
 *  - Roth IRA target kept for any valid source
 *  - Same-account MIXED Roth-designated target kept only when ids match
 *  - Same-account MIXED OTHER target excluded (post bucket is taxable)
 *  - Dedicated Roth 401k/403b/457b/TSP excluded as pair target
 *  - Cross-owner denied pair (IRC §408A is per-individual)
 *  - Same-owner accepted pair
 *  - shouldCreditWorkingYearsConversionBasisSeparately: Roth IRA → true; MIXED → false
 */
import { describe, it, expect } from 'vitest';
import {
  isConvertibleRothConversionSource,
  isWorkingYearsRothConversionTarget,
  isSameAccountMixedInPlanConversion,
  isValidWorkingYearsRothConversionPair,
  shouldCreditWorkingYearsConversionBasisSeparately,
  type AccountEligibilityRecord,
} from './roth-conversion-eligibility';
import type { AccountPayload, AccountType } from '../db/types';

function rec(
  id: string,
  type: AccountType,
  taxTreatment: AccountPayload['taxTreatment'],
  ownerId: string,
  active = true,
): AccountEligibilityRecord {
  return {
    id,
    payload: { active, type, taxTreatment, ownerId },
  };
}

// ── isConvertibleRothConversionSource ────────────────────────────────────────

describe('isConvertibleRothConversionSource', () => {
  it('accepts an active PRE_TAX 401k', () => {
    expect(
      isConvertibleRothConversionSource(
        rec('a', 'RETIREMENT_401K', 'PRE_TAX', 'o1').payload,
      ),
    ).toBe(true);
  });

  it('accepts an active PRE_TAX 403b', () => {
    expect(
      isConvertibleRothConversionSource(
        rec('a', 'RETIREMENT_403B', 'PRE_TAX', 'o1').payload,
      ),
    ).toBe(true);
  });

  it('accepts an active PRE_TAX 457b', () => {
    expect(
      isConvertibleRothConversionSource(
        rec('a', 'RETIREMENT_457B', 'PRE_TAX', 'o1').payload,
      ),
    ).toBe(true);
  });

  it('accepts an active PRE_TAX TSP', () => {
    expect(
      isConvertibleRothConversionSource(
        rec('a', 'RETIREMENT_TSP', 'PRE_TAX', 'o1').payload,
      ),
    ).toBe(true);
  });

  it('accepts an active MIXED 401k', () => {
    expect(
      isConvertibleRothConversionSource(
        rec('a', 'RETIREMENT_401K', 'MIXED', 'o1').payload,
      ),
    ).toBe(true);
  });

  it('accepts an active MIXED 403b', () => {
    expect(
      isConvertibleRothConversionSource(
        rec('a', 'RETIREMENT_403B', 'MIXED', 'o1').payload,
      ),
    ).toBe(true);
  });

  it('accepts an active MIXED 457b', () => {
    expect(
      isConvertibleRothConversionSource(
        rec('a', 'RETIREMENT_457B', 'MIXED', 'o1').payload,
      ),
    ).toBe(true);
  });

  it('accepts an active MIXED TSP', () => {
    expect(
      isConvertibleRothConversionSource(
        rec('a', 'RETIREMENT_TSP', 'MIXED', 'o1').payload,
      ),
    ).toBe(true);
  });

  it('accepts an active PRE_TAX OTHER (has real pre-tax sub-bucket)', () => {
    expect(
      isConvertibleRothConversionSource(
        rec('a', 'OTHER', 'PRE_TAX', 'o1').payload,
      ),
    ).toBe(true);
  });

  it('accepts an active MIXED OTHER (has real pre-tax sub-bucket)', () => {
    expect(
      isConvertibleRothConversionSource(
        rec('a', 'OTHER', 'MIXED', 'o1').payload,
      ),
    ).toBe(true);
  });

  it('rejects an inactive PRE_TAX 401k', () => {
    expect(
      isConvertibleRothConversionSource(
        rec('a', 'RETIREMENT_401K', 'PRE_TAX', 'o1', false).payload,
      ),
    ).toBe(false);
  });

  it('rejects RETIREMENT_CASH_BALANCE regardless of treatment', () => {
    expect(
      isConvertibleRothConversionSource(
        rec('a', 'RETIREMENT_CASH_BALANCE', 'PRE_TAX', 'o1').payload,
      ),
    ).toBe(false);
  });

  it('rejects a ROTH account as source (pure Roth, no pre-tax sub-bucket)', () => {
    expect(
      isConvertibleRothConversionSource(
        rec('a', 'RETIREMENT_ROTH_IRA', 'ROTH', 'o1').payload,
      ),
    ).toBe(false);
  });

  it('rejects a POST_TAX account as source', () => {
    expect(
      isConvertibleRothConversionSource(
        rec('a', 'BROKERAGE', 'POST_TAX', 'o1').payload,
      ),
    ).toBe(false);
  });
});

// ── isWorkingYearsRothConversionTarget ────────────────────────────────────────

describe('isWorkingYearsRothConversionTarget', () => {
  it('accepts an active RETIREMENT_ROTH_IRA', () => {
    expect(
      isWorkingYearsRothConversionTarget(
        rec('r', 'RETIREMENT_ROTH_IRA', 'ROTH', 'o1').payload,
      ),
    ).toBe(true);
  });

  it('rejects an inactive Roth IRA', () => {
    expect(
      isWorkingYearsRothConversionTarget(
        rec('r', 'RETIREMENT_ROTH_IRA', 'ROTH', 'o1', false).payload,
      ),
    ).toBe(false);
  });

  it('rejects a dedicated Roth 401k (separate employer-plan target; Plan C deferral)', () => {
    expect(
      isWorkingYearsRothConversionTarget(
        rec('r', 'RETIREMENT_ROTH_401K', 'ROTH', 'o1').payload,
      ),
    ).toBe(false);
  });

  it('rejects a dedicated Roth 403b', () => {
    expect(
      isWorkingYearsRothConversionTarget(
        rec('r', 'RETIREMENT_ROTH_403B', 'ROTH', 'o1').payload,
      ),
    ).toBe(false);
  });

  it('rejects a dedicated Roth 457b', () => {
    expect(
      isWorkingYearsRothConversionTarget(
        rec('r', 'RETIREMENT_ROTH_457B', 'ROTH', 'o1').payload,
      ),
    ).toBe(false);
  });

  it('rejects a dedicated Roth TSP', () => {
    expect(
      isWorkingYearsRothConversionTarget(
        rec('r', 'RETIREMENT_ROTH_TSP', 'ROTH', 'o1').payload,
      ),
    ).toBe(false);
  });

  it('rejects a PRE_TAX account as target', () => {
    expect(
      isWorkingYearsRothConversionTarget(
        rec('r', 'RETIREMENT_401K', 'PRE_TAX', 'o1').payload,
      ),
    ).toBe(false);
  });

  it('rejects an INHERITED Roth IRA (a beneficiary cannot roll into one)', () => {
    expect(
      isWorkingYearsRothConversionTarget({
        ...rec('r', 'RETIREMENT_ROTH_IRA', 'ROTH', 'o1').payload,
        rmdInheritedAccount: true,
      }),
    ).toBe(false);
  });
});

// ── isSameAccountMixedInPlanConversion ────────────────────────────────────────

describe('isSameAccountMixedInPlanConversion', () => {
  it('accepts same-id active MIXED 401k (Roth-designated post bucket)', () => {
    const r = rec('x', 'RETIREMENT_401K', 'MIXED', 'o1');
    expect(isSameAccountMixedInPlanConversion(r, r)).toBe(true);
  });

  it('accepts same-id active MIXED 403b', () => {
    const r = rec('x', 'RETIREMENT_403B', 'MIXED', 'o1');
    expect(isSameAccountMixedInPlanConversion(r, r)).toBe(true);
  });

  it('accepts same-id active MIXED 457b', () => {
    const r = rec('x', 'RETIREMENT_457B', 'MIXED', 'o1');
    expect(isSameAccountMixedInPlanConversion(r, r)).toBe(true);
  });

  it('accepts same-id active MIXED TSP', () => {
    const r = rec('x', 'RETIREMENT_TSP', 'MIXED', 'o1');
    expect(isSameAccountMixedInPlanConversion(r, r)).toBe(true);
  });

  it('rejects same-id MIXED OTHER (post bucket is plain taxable, not Roth-designated)', () => {
    const r = rec('x', 'OTHER', 'MIXED', 'o1');
    expect(isSameAccountMixedInPlanConversion(r, r)).toBe(false);
  });

  it('rejects cross-account MIXED 401k (different ids)', () => {
    const src = rec('x', 'RETIREMENT_401K', 'MIXED', 'o1');
    const tgt = rec('y', 'RETIREMENT_401K', 'MIXED', 'o1');
    expect(isSameAccountMixedInPlanConversion(src, tgt)).toBe(false);
  });

  it('rejects same-id inactive MIXED 401k', () => {
    const r = rec('x', 'RETIREMENT_401K', 'MIXED', 'o1', false);
    expect(isSameAccountMixedInPlanConversion(r, r)).toBe(false);
  });

  it('rejects same-id PRE_TAX 401k (not MIXED)', () => {
    const r = rec('x', 'RETIREMENT_401K', 'PRE_TAX', 'o1');
    expect(isSameAccountMixedInPlanConversion(r, r)).toBe(false);
  });
});

// ── isValidWorkingYearsRothConversionPair ─────────────────────────────────────

describe('isValidWorkingYearsRothConversionPair', () => {
  // Valid source + Roth IRA target, same owner
  it('accepts PRE_TAX 401k → Roth IRA (same owner)', () => {
    const src = rec('s', 'RETIREMENT_401K', 'PRE_TAX', 'o1');
    const tgt = rec('t', 'RETIREMENT_ROTH_IRA', 'ROTH', 'o1');
    expect(isValidWorkingYearsRothConversionPair(src, tgt)).toBe(true);
  });

  it('accepts MIXED 401k → Roth IRA (same owner)', () => {
    const src = rec('s', 'RETIREMENT_401K', 'MIXED', 'o1');
    const tgt = rec('t', 'RETIREMENT_ROTH_IRA', 'ROTH', 'o1');
    expect(isValidWorkingYearsRothConversionPair(src, tgt)).toBe(true);
  });

  it('accepts MIXED 401k → same-account MIXED in-plan', () => {
    const src = rec('s', 'RETIREMENT_401K', 'MIXED', 'o1');
    expect(isValidWorkingYearsRothConversionPair(src, src)).toBe(true);
  });

  // Cross-owner guard (IRC §408A)
  it('rejects PRE_TAX 401k → Roth IRA when owners differ (cross-owner)', () => {
    const src = rec('s', 'RETIREMENT_401K', 'PRE_TAX', 'o1');
    const tgt = rec('t', 'RETIREMENT_ROTH_IRA', 'ROTH', 'o2');
    expect(isValidWorkingYearsRothConversionPair(src, tgt)).toBe(false);
  });

  it('rejects MIXED 401k → Roth IRA when owners differ', () => {
    const src = rec('s', 'RETIREMENT_401K', 'MIXED', 'o1');
    const tgt = rec('t', 'RETIREMENT_ROTH_IRA', 'ROTH', 'o2');
    expect(isValidWorkingYearsRothConversionPair(src, tgt)).toBe(false);
  });

  // Invalid source
  it('rejects inactive PRE_TAX source', () => {
    const src = rec('s', 'RETIREMENT_401K', 'PRE_TAX', 'o1', false);
    const tgt = rec('t', 'RETIREMENT_ROTH_IRA', 'ROTH', 'o1');
    expect(isValidWorkingYearsRothConversionPair(src, tgt)).toBe(false);
  });

  it('rejects CBP source', () => {
    const src = rec('s', 'RETIREMENT_CASH_BALANCE', 'PRE_TAX', 'o1');
    const tgt = rec('t', 'RETIREMENT_ROTH_IRA', 'ROTH', 'o1');
    expect(isValidWorkingYearsRothConversionPair(src, tgt)).toBe(false);
  });

  // Denied pair: MIXED source + cross-account dedicated-Roth target
  it('rejects MIXED source + separate dedicated Roth 401k target (deferral)', () => {
    const src = rec('s', 'RETIREMENT_401K', 'MIXED', 'o1');
    const tgt = rec('t', 'RETIREMENT_ROTH_401K', 'ROTH', 'o1');
    expect(isValidWorkingYearsRothConversionPair(src, tgt)).toBe(false);
  });

  it('rejects MIXED source + separate dedicated Roth 403b target', () => {
    const src = rec('s', 'RETIREMENT_403B', 'MIXED', 'o1');
    const tgt = rec('t', 'RETIREMENT_ROTH_403B', 'ROTH', 'o1');
    expect(isValidWorkingYearsRothConversionPair(src, tgt)).toBe(false);
  });

  // Denied pair: MIXED source + MIXED OTHER cross-account target
  it('rejects MIXED 401k source + MIXED OTHER cross-account target', () => {
    const src = rec('s', 'RETIREMENT_401K', 'MIXED', 'o1');
    const tgt = rec('t', 'OTHER', 'MIXED', 'o1');
    expect(isValidWorkingYearsRothConversionPair(src, tgt)).toBe(false);
  });

  // An inherited Roth IRA can never be a target — the converted principal
  // would credit the beneficiary's OWN §408A pool.
  it('rejects PRE_TAX 401k → INHERITED Roth IRA (same owner)', () => {
    const src = rec('s', 'RETIREMENT_401K', 'PRE_TAX', 'o1');
    const base = rec('t', 'RETIREMENT_ROTH_IRA', 'ROTH', 'o1');
    const tgt = {
      id: base.id,
      payload: { ...base.payload, rmdInheritedAccount: true },
    };
    expect(isValidWorkingYearsRothConversionPair(src, tgt)).toBe(false);
  });

  // PRE_TAX employer plan source → same-account in-plan is invalid (not MIXED)
  it('rejects PRE_TAX 401k → same-account in-plan (not MIXED, so the MIXED rule does not apply)', () => {
    const src = rec('s', 'RETIREMENT_401K', 'PRE_TAX', 'o1');
    expect(isValidWorkingYearsRothConversionPair(src, src)).toBe(false);
  });
});

// ── shouldCreditWorkingYearsConversionBasisSeparately ─────────────────────────

describe('shouldCreditWorkingYearsConversionBasisSeparately', () => {
  it('returns true for a Roth IRA target', () => {
    const tgt = rec('t', 'RETIREMENT_ROTH_IRA', 'ROTH', 'o1');
    expect(shouldCreditWorkingYearsConversionBasisSeparately(tgt)).toBe(true);
  });

  it('returns false for a same-account MIXED 401k target (no double-credit)', () => {
    const tgt = rec('t', 'RETIREMENT_401K', 'MIXED', 'o1');
    expect(shouldCreditWorkingYearsConversionBasisSeparately(tgt)).toBe(false);
  });

  it('returns false for a MIXED 403b target', () => {
    const tgt = rec('t', 'RETIREMENT_403B', 'MIXED', 'o1');
    expect(shouldCreditWorkingYearsConversionBasisSeparately(tgt)).toBe(false);
  });

  it('returns false for a PRE_TAX 401k (not a Roth target at all)', () => {
    const tgt = rec('t', 'RETIREMENT_401K', 'PRE_TAX', 'o1');
    expect(shouldCreditWorkingYearsConversionBasisSeparately(tgt)).toBe(false);
  });
});
